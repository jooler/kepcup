import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError, type ToolEffect } from '@kepcup/shared';
import { closeDatabase, openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { RunsService } from '../../src/domain/runs.js';
import type { Clock } from '../../src/infra/clock.js';
import { CLASSIFIED_BUILTIN_TOOLS, effectClassOf } from '../../src/agent/effects/classify.js';
import { effectKeyOf, sha256Hex, stableJson } from '../../src/agent/effects/key.js';
import { ToolEffectsStore } from '../../src/agent/effects/store.js';
import {
  createEffectRecorder,
  duplicateVerdict,
  effectStatusOf,
  EFFECT_SUMMARY_MAX_CHARS,
  ledgerArgsText,
  type EffectRecorder,
  type EffectRecorderDeps,
} from '../../src/agent/effects/recorder.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';
import {
  activeEffectHooks,
  currentToolCall,
  runInToolCall,
} from '../../src/permissions/tool-call-scope.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { READ_ONLY_TOOLS } from '../../src/agent/external/capabilities.js';
import type {
  RunIdentity,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/agent/types.js';

/**
 * W2 外部副作用台账（todo/borrowings-from-personal-agents.md W2）单测：稳定键
 * （键序无关、occurrence 递增）、分类表（全部内置工具已登记、与外部智能体
 * 只读注解一致）、recorder 状态转移（成功 / 失败 / 抛错 / uncertain / 拒绝 /
 * 中止、escalate、审批关联、脱敏、记录失败不影响执行）、store 恢复与续接链。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'tool-effects-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'sk-SECRET-1234567890';

function rig() {
  const db = openDatabase({
    path: path.join(dir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 5), KEY_INFO.runsDb),
  });
  runMigrations(db, migrationsUrl('runs'));
  let tick = 0;
  const clock: Clock = { now: () => 1_000_000 + tick++ };
  const runs = new RunsService(db, clock);
  const store = new ToolEffectsStore(db, clock);
  const warnings: string[] = [];
  /** W4 复查 B1: approvals the "user" refused by hand (ApprovalsService.userDeniedIds). */
  const userDenied = new Set<string>();
  const deps: EffectRecorderDeps = {
    store,
    redact: (text) => text.split(SECRET).join('«secret»'),
    logger: { warn: (_obj, msg) => warnings.push(msg) },
    userDeniedApprovals: (ids) => new Set(ids.filter((id) => userDenied.has(id))),
  };
  const recorder = createEffectRecorder(deps);
  const run = runs.create({
    botId: 'bot_x',
    conversationId: 'conv_a',
    loopType: 'task',
    triggerReason: null,
    triggerMessageIds: [],
    taskTitle: 'T',
    taskWrites: true,
  });
  const identity: RunIdentity = {
    runId: run.id,
    botId: 'bot_x',
    conversationId: 'conv_a',
    loopType: 'task',
  };
  let callSeq = 0;
  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    identity,
    toolCallId: `call_${++callSeq}`,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
    ...overrides,
  });
  return {
    db,
    runs,
    store,
    deps,
    recorder,
    run,
    identity,
    ctx,
    warnings,
    userDenied,
    close: () => closeDatabase(db),
  };
}

function fakeTool(
  name: string,
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>,
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return { name, description: name, parameters: {}, execute, ...extra };
}

const ok = (content = 'done'): ToolResult => ({ ok: true, content });

// ---------------------------------------------------------------------------

describe('effect key', () => {
  it('stableJson ignores key order (nested) and drops undefined like JSON', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(
      stableJson({ a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(stableJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(stableJson([undefined, 1])).toBe('[null,1]');
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: '1' }));
  });

  it('effect key = runId:tool:hash16:occurrence', () => {
    const hash = sha256Hex('{"ref":"e1"}');
    expect(
      effectKeyOf({ runId: 'run_1', toolName: 'browser_click', argsHash: hash, occurrence: 2 }),
    ).toBe(`run_1:browser_click:${hash.slice(0, 16)}:2`);
  });
});

// ---------------------------------------------------------------------------

/** Every built-in ToolDefinition name, scanned from the tool sources. */
function scannedBuiltinToolNames(): string[] {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const files = [
    ...[
      'browser.ts',
      'butler-tools.ts',
      'delegate-tools.ts',
      'delegation-tools.ts',
      'image-tools.ts',
      'index.ts',
      'memory-tools.ts',
      'schedule-tools.ts',
      'setup-tools.ts',
      'skill-tools.ts',
      'speech-tools.ts',
      'task-tools.ts',
      'web-tools.ts',
      'wiki-tools.ts',
    ].map((file) => path.join(root, 'tools', file)),
    path.join(root, 'wiki', 'maintenance-tools.ts'),
    path.join(root, 'skills', 'authoring-tools.ts'),
  ];
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s+name: '([a-z_]+)',$/gm)) {
      names.add(match[1]!);
    }
  }
  // pi-coding-agent factories (coding-tools.ts / wiki maintenance / authoring).
  for (const name of ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash']) names.add(name);
  return [...names].sort();
}

describe('effect classifier', () => {
  it('registers every built-in tool (and nothing stale)', () => {
    const scanned = scannedBuiltinToolNames();
    expect(scanned.length).toBeGreaterThan(60);
    expect(scanned.filter((name) => !CLASSIFIED_BUILTIN_TOOLS.includes(name))).toEqual([]);
    expect(CLASSIFIED_BUILTIN_TOOLS.filter((name) => !scanned.includes(name))).toEqual([]);
  });

  it('classifies the table', () => {
    const cases: Array<[string, unknown, EffectClassOfCtx, string]> = [
      ['browser_click', { ref: 'e1' }, {}, 'external'],
      ['browser_type', { ref: 'e1', text: 'x' }, {}, 'external'],
      ['browser_press', { key: 'Enter' }, {}, 'external'],
      ['browser_open', { url: 'https://a' }, {}, 'none'],
      ['browser_scroll', {}, {}, 'none'],
      ['browser_back', {}, {}, 'none'],
      ['browser_snapshot', {}, {}, 'none'],
      ['browser_screenshot', {}, {}, 'none'],
      ['browser_close', {}, {}, 'none'],
      ['read', { path: 'a' }, {}, 'none'],
      ['write', { path: 'a', content: 'x' }, {}, 'local'],
      ['bash', { command: 'ls' }, {}, 'local'],
      ['bash', { command: 'docker ps' }, { unsandboxed: true }, 'external'],
      ['request_unsandboxed', { command: 'x' }, {}, 'external'],
      ['git_remote', { operation: 'push' }, {}, 'external'],
      ['delegate_to_bot', {}, {}, 'external'],
      ['send_message', { text: 'hi' }, {}, 'local'],
      ['send_message', { text: 'hi', mention_bot_ids: [] }, {}, 'local'],
      ['send_message', { text: 'hi', mention_bot_ids: ['bot_b'] }, {}, 'external'],
      ['web_fetch', { url: 'https://a' }, {}, 'none'],
      ['remember', {}, {}, 'local'],
      ['mcp_srv_get_items', {}, { mcpRisk: 'read' }, 'none'],
      ['mcp_srv_create_item', {}, { mcpRisk: 'write' }, 'external'],
      ['mcp_srv_drop', {}, { mcpRisk: 'destructive' }, 'external'],
      // Unregistered names are external (conservative).
      ['some_new_tool', {}, {}, 'external'],
      ['mcp_srv_unknown', {}, {}, 'external'],
    ];
    for (const [name, params, ctx, expected] of cases) {
      expect([name, effectClassOf(name, params, ctx)]).toEqual([name, expected]);
    }
  });

  it('agrees with the external-agent read-only annotations', () => {
    for (const name of READ_ONLY_TOOLS) {
      expect([name, effectClassOf(name, {})]).toEqual([name, 'none']);
    }
    for (const name of CLASSIFIED_BUILTIN_TOOLS) {
      if (effectClassOf(name, {}) === 'external') expect(READ_ONLY_TOOLS.has(name)).toBe(false);
    }
  });
});

type EffectClassOfCtx = Parameters<typeof effectClassOf>[2];

// ---------------------------------------------------------------------------

describe('effect status mapping', () => {
  it('maps results to ledger statuses', () => {
    expect(effectStatusOf(ok())).toBe('completed');
    expect(effectStatusOf({ ok: false, content: 'x', errorCode: 'COMMAND_FAILED' })).toBe('failed');
    expect(
      effectStatusOf({
        ok: false,
        content: 'x',
        errorCode: 'BROWSER_OUTCOME_UNKNOWN',
        outcome: 'uncertain',
      }),
    ).toBe('uncertain');
    // Old shape (no outcome field) still counts by its error code.
    expect(effectStatusOf({ ok: false, content: 'x', errorCode: 'BROWSER_OUTCOME_UNKNOWN' })).toBe(
      'uncertain',
    );
    expect(
      effectStatusOf({
        ok: false,
        content: 'x',
        errorCode: 'MCP_CALL_FAILED',
        effect: { outcome: 'uncertain' },
      }),
    ).toBe('uncertain');
    expect(effectStatusOf({ ok: false, content: 'x', errorCode: 'APPROVAL_DENIED' })).toBe(
      'denied',
    );
    // A failure while the run was being aborted: unknown — unless not started.
    expect(effectStatusOf({ ok: false, content: 'x', errorCode: 'INTERNAL' }, true)).toBe(
      'uncertain',
    );
    expect(
      effectStatusOf(
        { ok: false, content: 'x', errorCode: 'BROWSER_REF_STALE', outcome: 'not_started' },
        true,
      ),
    ).toBe('failed');
  });
});

describe('effect recorder via executeToolSafely', () => {
  it('records external calls through their transitions; read-only and local calls leave no row', async () => {
    const r = rig();
    try {
      const click = fakeTool('browser_click', async () => ok('clicked'));
      const failing = fakeTool('browser_press', async () => ({
        ok: false,
        content: 'nope',
        errorCode: 'BROWSER_PAGE_CLOSED',
        outcome: 'not_started',
      }));
      const unknown = fakeTool('browser_type', async () => ({
        ok: false,
        content: '可能已生效',
        errorCode: 'BROWSER_OUTCOME_UNKNOWN',
        outcome: 'uncertain',
      }));
      const thrower = fakeTool('git_remote', async () => {
        throw new Error('boom');
      });
      const denied = fakeTool('request_unsandboxed', async () => ({
        ok: false,
        content: '拒绝',
        errorCode: 'APPROVAL_DENIED',
      }));
      const deniedThrow = fakeTool('delegate_to_bot', async () => {
        throw new AppError('APPROVAL_DENIED', 'no');
      });
      const snapshot = fakeTool('browser_snapshot', async () => ok('page'));
      const write = fakeTool('write', async () => ok());

      let seenDuring: string | undefined;
      const watching = fakeTool('browser_click', async () => {
        seenDuring = r.store.listForRun(r.run.id).at(-1)?.status;
        return ok();
      });

      expect((await executeToolSafely(click, { ref: 'e1' }, r.ctx(), r.recorder)).ok).toBe(true);
      await executeToolSafely(failing, { key: 'Enter' }, r.ctx(), r.recorder);
      await executeToolSafely(unknown, { ref: 'e2', text: 'hello' }, r.ctx(), r.recorder);
      const thrown = await executeToolSafely(thrower, { operation: 'push' }, r.ctx(), r.recorder);
      expect(thrown).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
      await executeToolSafely(denied, { command: 'x', reason: 'y' }, r.ctx(), r.recorder);
      await executeToolSafely(deniedThrow, { bot_id: 'b' }, r.ctx(), r.recorder);
      await executeToolSafely(snapshot, {}, r.ctx(), r.recorder);
      await executeToolSafely(write, { path: 'a', content: 'b' }, r.ctx(), r.recorder);
      await executeToolSafely(watching, { ref: 'e9' }, r.ctx(), r.recorder);

      const rows = r.store.listForRun(r.run.id);
      expect(rows.map((row) => [row.toolName, row.status])).toEqual([
        ['browser_click', 'completed'],
        ['browser_press', 'failed'],
        ['browser_type', 'uncertain'],
        ['git_remote', 'uncertain'],
        ['request_unsandboxed', 'denied'],
        ['delegate_to_bot', 'denied'],
        ['browser_click', 'completed'],
      ]);
      // The row exists (executing) while the tool runs.
      expect(seenDuring).toBe('executing');
      expect(rows.every((row) => row.settledAt !== null)).toBe(true);
      expect(rows[0]!.toolCallId).toBe('call_1');
      expect(rows[0]!.summary).toBe('browser_click {"ref":"e1"}');
      expect(r.warnings).toEqual([]);
    } finally {
      r.close();
    }
  });

  it('a failure while the run is aborted settles as uncertain', async () => {
    const r = rig();
    try {
      const controller = new AbortController();
      const tool = fakeTool(
        'mcp_srv_send',
        async () => {
          controller.abort();
          return { ok: false, content: 'aborted', errorCode: 'INTERNAL' };
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      await executeToolSafely(tool, {}, r.ctx({ signal: controller.signal }), r.recorder);
      expect(r.store.listForRun(r.run.id).map((row) => row.status)).toEqual(['uncertain']);
    } finally {
      r.close();
    }
  });

  it('occurrence counts identical args (any key order) per tool within the run', async () => {
    const r = rig();
    try {
      const click = fakeTool('browser_click', async () => ok());
      await executeToolSafely(click, { ref: 'e1', note: 'a' }, r.ctx(), r.recorder);
      await executeToolSafely(click, { note: 'a', ref: 'e1' }, r.ctx(), r.recorder);
      await executeToolSafely(click, { ref: 'e2' }, r.ctx(), r.recorder);
      const rows = r.store.listForRun(r.run.id);
      expect(rows[0]!.argsHash).toBe(rows[1]!.argsHash);
      expect(rows[0]!.effectKey.endsWith(':1')).toBe(true);
      expect(rows[1]!.effectKey.endsWith(':2')).toBe(true);
      expect(rows[0]!.effectKey.slice(0, -2)).toBe(rows[1]!.effectKey.slice(0, -2));
      expect(rows[2]!.effectKey.endsWith(':1')).toBe(true);
      expect(rows[0]!.effectKey.startsWith(`${r.run.id}:browser_click:`)).toBe(true);
    } finally {
      r.close();
    }
  });

  it('a reused tool-call id gets a suffix instead of failing', async () => {
    const r = rig();
    try {
      const click = fakeTool('browser_click', async () => ok());
      await executeToolSafely(click, { ref: 'e1' }, r.ctx({ toolCallId: 'call_0' }), r.recorder);
      await executeToolSafely(click, { ref: 'e2' }, r.ctx({ toolCallId: 'call_0' }), r.recorder);
      expect(r.store.listForRun(r.run.id).map((row) => row.toolCallId)).toEqual([
        'call_0',
        'call_0#2',
      ]);
    } finally {
      r.close();
    }
  });

  it('never stores typed text, sensitive params or stored secrets; summary ≤ 200 chars', async () => {
    const r = rig();
    try {
      const type = fakeTool('browser_type', async () => ok());
      await executeToolSafely(type, { ref: 'e3', text: 'hunter2-password' }, r.ctx(), r.recorder);
      const git = fakeTool('git_remote', async () => ok());
      await executeToolSafely(
        git,
        { operation: 'push', args: [`https://x:${SECRET}@h/r.git`], reason: 'x'.repeat(400) },
        r.ctx(),
        r.recorder,
      );
      const [typed, pushed] = r.store.listForRun(r.run.id);
      expect(typed!.summary).toBe('browser_type {"ref":"e3","text":"«redacted:16 chars»"}');
      const dump = JSON.stringify(r.db.prepare('select * from tool_effects').all());
      expect(dump).not.toContain('hunter2');
      expect(dump).not.toContain(SECRET);
      // The hash is over the redacted form, not the clear text.
      expect(typed!.argsHash).toBe(
        sha256Hex(
          ledgerArgsText('browser_type', { ref: 'e3', text: 'other-text-16chr' }, r.deps.redact),
        ),
      );
      expect(pushed!.summary.length).toBeLessThanOrEqual(EFFECT_SUMMARY_MAX_CHARS);
      expect(pushed!.summary).toContain('«secret»');
    } finally {
      r.close();
    }
  });

  it('escalates a local call that leaves the sandbox and links its approval', async () => {
    const r = rig();
    try {
      const bash = fakeTool('bash', async () => {
        currentToolCall()?.effect?.noteApproval('apr_1');
        currentToolCall()?.effect?.escalate('unsandboxed');
        return ok();
      });
      const sandboxed = fakeTool('bash', async () => {
        currentToolCall()?.effect?.noteApproval('apr_ignored');
        return ok();
      });
      await executeToolSafely(bash, { command: 'docker ps' }, r.ctx(), r.recorder);
      await executeToolSafely(sandboxed, { command: 'ls' }, r.ctx(), r.recorder);
      const rows = r.store.listForRun(r.run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        toolName: 'bash',
        status: 'completed',
        approvalId: 'apr_1',
        summary: 'bash（沙箱外执行） {"command":"docker ps"}',
      });

      const mcpTool = fakeTool(
        'mcp_srv_post',
        async () => {
          currentToolCall()?.effect?.noteApproval('apr_2');
          return ok();
        },
        { mcp: { serverId: 'srv', toolName: 'post', risk: 'write' } },
      );
      await executeToolSafely(mcpTool, { body: 'x' }, r.ctx(), r.recorder);
      expect(r.store.listForRun(r.run.id).at(-1)).toMatchObject({
        toolName: 'mcp_srv_post',
        approvalId: 'apr_2',
      });
    } finally {
      r.close();
    }
  });

  it('MCP tools: read → no row; the severer of build-time and live risk counts', async () => {
    const r = rig();
    try {
      const live = createEffectRecorder({ ...r.deps, mcpRiskOf: () => 'destructive' });
      const read = fakeTool('mcp_srv_get', async () => ok(), {
        mcp: { serverId: 'srv', toolName: 'get', risk: 'read' },
      });
      await executeToolSafely(read, {}, r.ctx(), r.recorder);
      expect(r.store.listForRun(r.run.id)).toHaveLength(0);
      await executeToolSafely(read, {}, r.ctx(), live);
      expect(r.store.listForRun(r.run.id)).toHaveLength(1);
    } finally {
      r.close();
    }
  });

  it('tool-reported effect summary / receipt replace the defaults (redacted)', async () => {
    const r = rig();
    try {
      const tool = fakeTool('git_remote', async () => ({
        ok: true,
        content: 'pushed',
        effect: {
          summary: `git push origin main (${SECRET})`,
          receipt: { note: `exit 0 ${SECRET}`, url: 'https://h/r/commit/1' },
        },
      }));
      await executeToolSafely(tool, { operation: 'push' }, r.ctx(), r.recorder);
      expect(r.store.listForRun(r.run.id)[0]).toMatchObject({
        status: 'completed',
        summary: 'git push origin main («secret»)',
        receipt: { note: 'exit 0 «secret»', url: 'https://h/r/commit/1' },
      });
    } finally {
      r.close();
    }
  });

  it('ledger failures never break the tool call', async () => {
    const r = rig();
    try {
      // Unknown run id → the FK rejects the insert; the tool still runs.
      const tool = fakeTool('browser_click', async () => ok('clicked'));
      const result = await executeToolSafely(
        tool,
        { ref: 'e1' },
        r.ctx({ identity: { ...r.identity, runId: 'run_missing' } }),
        r.recorder,
      );
      expect(result).toEqual(ok('clicked'));
      expect(r.warnings).toEqual(['tool effect ledger: open failed']);

      const broken = createEffectRecorder({
        ...r.deps,
        store: {
          open: () => {
            throw new Error('disk full');
          },
        } as unknown as ToolEffectsStore,
      });
      expect(await executeToolSafely(tool, { ref: 'e1' }, r.ctx(), broken)).toEqual(ok('clicked'));
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('effects store', () => {
  it('recovery marks executing rows uncertain (idempotent); a late real result still settles', () => {
    const r = rig();
    try {
      const a = r.store.open({
        runId: r.run.id,
        toolCallId: 't1',
        toolName: 'browser_click',
        argsHash: 'h1',
        summary: 's',
      });
      const b = r.store.open({
        runId: r.run.id,
        toolCallId: 't2',
        toolName: 'browser_click',
        argsHash: 'h2',
        summary: 's',
      });
      r.store.settle(b.id, { status: 'completed' });
      expect(a.status).toBe('executing');
      expect(r.store.markExecutingUncertain([r.run.id])).toBe(1);
      expect(r.store.markExecutingUncertain()).toBe(0);
      expect(r.store.get(a.id)).toMatchObject({ status: 'uncertain' });
      expect(r.store.get(a.id)!.settledAt).not.toBeNull();
      expect(r.store.get(b.id)).toMatchObject({ status: 'completed' });
      // A settled row does not move again; an uncertain one takes the real result.
      r.store.settle(b.id, { status: 'failed' });
      expect(r.store.get(b.id)!.status).toBe('completed');
      r.store.settle(a.id, { status: 'completed' });
      expect(r.store.get(a.id)!.status).toBe('completed');
    } finally {
      r.close();
    }
  });

  it('listForTask follows the continuation chain and sub runs', () => {
    const r = rig();
    try {
      const create = (extra: Partial<Parameters<RunsService['create']>[0]>) =>
        r.runs.create({
          botId: 'bot_x',
          conversationId: 'conv_a',
          loopType: 'task',
          triggerReason: null,
          triggerMessageIds: [],
          ...extra,
        });
      const first = r.run;
      const sub = create({ loopType: 'subagent', parentRunId: first.id });
      const second = create({ continuedFromRunIds: [first.id] });
      const third = create({ continuedFromRunIds: [second.id] });
      const other = create({});
      const add = (runId: string, id: string) =>
        r.store.open({
          runId,
          toolCallId: id,
          toolName: 'browser_click',
          argsHash: id,
          summary: id,
        });
      add(first.id, 'a');
      add(sub.id, 'b');
      add(second.id, 'c');
      add(third.id, 'd');
      add(other.id, 'e');
      expect(r.store.listForTask(third.id).map((e) => e.toolCallId)).toEqual(['a', 'b', 'c', 'd']);
      expect(r.store.listForTask(second.id).map((e) => e.toolCallId)).toEqual(['a', 'b', 'c']);
      expect(r.store.listForTask('run_unknown')).toEqual([]);
      // Deleting a run cascades to its rows.
      r.runs.remove(other.id);
      expect(r.store.listForRun(other.id)).toEqual([]);
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('W2 复查后修正', () => {
  it('approvals / escalations from another run or after the call ended never touch the row', async () => {
    const r = rig();
    try {
      let late: Promise<void> | null = null;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const tool = fakeTool('delegate_to_bot', async () => {
        // A job of another run started from inside this call (the scheduler
        // case before the root fix) reaching the scope: ignored.
        activeEffectHooks()?.noteApproval('apr_other_run', 'run_other');
        activeEffectHooks()?.escalate('unsandboxed', 'run_other');
        activeEffectHooks()?.noteApproval('apr_own', r.identity.runId);
        // Background work outliving the call: the scope has ended by then.
        late = gate.then(() => {
          expect(currentToolCall()?.ended).toBe(true);
          activeEffectHooks()?.noteApproval('apr_late', r.identity.runId);
        });
        return ok();
      });
      await executeToolSafely(tool, { bot_id: 'b' }, r.ctx(), r.recorder);
      release();
      await late;
      const [row] = r.store.listForRun(r.run.id);
      expect(row).toMatchObject({ status: 'completed', approvalId: 'apr_own' });
      // The store never relinks a settled row either.
      r.store.noteApproval(row!.id, 'apr_direct');
      expect(r.store.get(row!.id)!.approvalId).toBe('apr_own');
    } finally {
      r.close();
    }
  });

  it('a scheduler job submitted from inside a tool call does not inherit its scope', async () => {
    const scheduler = new Scheduler({ info() {}, warn() {}, error() {}, debug() {} } as never);
    let seen: unknown = 'unset';
    let insideCall: unknown;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    await runInToolCall(async () => {
      insideCall = currentToolCall();
      scheduler.submit({
        priority: 0,
        provider: 'p',
        key: 'k',
        run: async () => {
          seen = currentToolCall();
          done();
        },
      });
    });
    await finished;
    expect(insideCall).toBeDefined();
    expect(seen).toBeUndefined();
  });

  it('the tool_result carries outcome:uncertain when the ledger settles uncertain', async () => {
    const r = rig();
    try {
      const thrower = fakeTool('git_remote', async () => {
        throw new Error('boom');
      });
      expect(await executeToolSafely(thrower, {}, r.ctx(), r.recorder)).toMatchObject({
        ok: false,
        errorCode: 'INTERNAL',
        outcome: 'uncertain',
      });
      // Local / read-only calls have no row: nothing stamped.
      const localThrower = fakeTool('write', async () => {
        throw new Error('disk');
      });
      const local = await executeToolSafely(localThrower, {}, r.ctx(), r.recorder);
      expect(local.outcome).toBeUndefined();
      // Failure during an abort.
      const controller = new AbortController();
      const aborted = fakeTool('browser_click', async () => {
        controller.abort();
        return { ok: false, content: 'aborted', errorCode: 'INTERNAL' };
      });
      expect(
        (
          await executeToolSafely(
            aborted,
            { ref: 'e1' },
            r.ctx({ signal: controller.signal }),
            r.recorder,
          )
        ).outcome,
      ).toBe('uncertain');
      // A tool's own outcome is never overwritten.
      const notStarted = fakeTool('browser_click', async () => ({
        ok: false,
        content: 'stale',
        errorCode: 'BROWSER_REF_STALE',
        outcome: 'not_started',
      }));
      expect(
        (await executeToolSafely(notStarted, { ref: 'e2' }, r.ctx(), r.recorder)).outcome,
      ).toBe('not_started');
    } finally {
      r.close();
    }
  });

  it('a throwing recorder never replaces the real result', async () => {
    const r = rig();
    try {
      const broken: EffectRecorder = {
        begin: () => ({
          escalate: () => {},
          noteApproval: () => {},
          settle: () => {
            throw new Error('ledger bug');
          },
          settleThrown: () => {
            throw new Error('ledger bug');
          },
        }),
      };
      const tool = fakeTool('browser_click', async () => ok('clicked'));
      expect(await executeToolSafely(tool, { ref: 'e1' }, r.ctx(), broken)).toEqual(ok('clicked'));
      const thrower = fakeTool('browser_click', async () => {
        throw new AppError('BROWSER_PAGE_CLOSED', 'closed');
      });
      expect(await executeToolSafely(thrower, { ref: 'e1' }, r.ctx(), broken)).toMatchObject({
        ok: false,
        errorCode: 'BROWSER_PAGE_CLOSED',
      });
    } finally {
      r.close();
    }
  });

  it('a tool-reported summary / receipt gets the sensitive-param scrub too', async () => {
    const r = rig();
    try {
      const type = fakeTool('browser_type', async () => ({
        ok: true,
        content: 'typed',
        effect: {
          summary: '输入了 hunter2-password 到 e3',
          receipt: { note: 'value=hunter2-password' },
        },
      }));
      await executeToolSafely(type, { ref: 'e3', text: 'hunter2-password' }, r.ctx(), r.recorder);
      const mcp = fakeTool(
        'mcp_srv_login',
        async () => ({
          ok: true,
          content: 'ok',
          sensitiveParams: ['token'],
          effect: { summary: `login with tok-ABCDEFGH (${SECRET})` },
        }),
        { mcp: { serverId: 'srv', toolName: 'login', risk: 'write' } },
      );
      await executeToolSafely(mcp, { token: 'tok-ABCDEFGH' }, r.ctx(), r.recorder);
      const [typed, login] = r.store.listForRun(r.run.id);
      expect(typed).toMatchObject({
        summary: '输入了 «redacted» 到 e3',
        receipt: { note: 'value=«redacted»' },
      });
      expect(login!.summary).toBe('login with «redacted» («secret»)');
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------------------
// W4 审批幂等与回执（todo/borrowings-from-personal-agents.md W4）

/**
 * A fake MCP-like external tool that asks for approval the way the gateway
 * does through ApprovalsService.request: gate first, then wait (intended),
 * then run (executing).
 */
function approvingTool(
  identity: RunIdentity,
  answer: () => 'approved' | 'denied',
  seen: Array<{ verdict: string | null; statusWhileWaiting?: string }>,
  store: ToolEffectsStore,
  kind = 'mcp_tool',
): ToolDefinition {
  return fakeTool(
    'mcp_srv_send',
    async (_params, ctx) => {
      const hooks = activeEffectHooks()!;
      const gate = hooks.approvalGate!(identity.runId, kind);
      if (gate !== null && (gate.verdict === 'completed' || gate.verdict === 'denied')) {
        seen.push({ verdict: gate.verdict });
        // The tool's own denial text — executeToolSafely replaces it.
        return { ok: false, content: '工具自己的拒绝文案', errorCode: 'APPROVAL_DENIED' };
      }
      hooks.noteApproval(`apr_${seen.length}`, identity.runId);
      hooks.approvalWaiting!(identity.runId);
      const waiting = store.listForRun(ctx.identity.runId).at(-1)!.status;
      seen.push({ verdict: gate?.verdict ?? null, statusWhileWaiting: waiting });
      if (answer() === 'denied') {
        return { ok: false, content: '拒绝', errorCode: 'APPROVAL_DENIED' };
      }
      hooks.approvalGranted!(identity.runId);
      return {
        ok: true,
        content: 'sent',
        effect: { receipt: { url: 'https://chat.example/m/1' } },
      };
    },
    { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
  );
}

describe('W4 approval dedupe gate', () => {
  const row = (patch: Partial<ToolEffect>): ToolEffect => ({
    id: 'eff_x',
    runId: 'run_1',
    toolCallId: 'c',
    toolName: 'mcp_s_send',
    effectKey: 'k',
    argsHash: 'h',
    summary: 's',
    approvalId: null,
    status: 'completed',
    receipt: null,
    createdAt: 10,
    settledAt: 11,
    ...patch,
  });

  it('duplicateVerdict: completed wins; else the newest user-denied / uncertain; consent clears completed and user denials only', () => {
    const none = new Set<string>();
    const v = (
      rows: ToolEffect[],
      consentAt: number | null = null,
      userDenied = none,
      kind?: string,
    ) => duplicateVerdict(rows, { consentAt, userDenied, ...(kind !== undefined ? { kind } : {}) });
    expect(v([])).toBeNull();
    expect(v([row({ status: 'failed' })])).toBeNull();
    expect(v([row({ status: 'executing', settledAt: null })])).toBeNull();
    expect(v([row({ status: 'intended', settledAt: null })])).toBeNull();
    // A completed row counts whether or not it had an approval.
    expect(v([row({ status: 'completed', approvalId: null })])?.verdict).toBe('completed');
    // S1: only mcp_tool is blocked; other kinds get a flagged card.
    expect(v([row({ status: 'completed' })], null, none, 'git_remote')?.verdict).toBe('repeat');
    expect(v([row({ status: 'completed' })], null, none, 'unsandboxed')?.verdict).toBe('repeat');
    expect(
      v([
        row({ id: 'a', status: 'uncertain' }),
        row({ id: 'b', status: 'completed', createdAt: 5 }),
      ])?.prior.id,
    ).toBe('b');
    // B1: a denied row counts only when the user refused its approval by hand.
    const deniedRows = [
      row({ id: 'a', status: 'uncertain', createdAt: 1 }),
      row({ id: 'b', status: 'denied', createdAt: 2, approvalId: 'apr_b' }),
    ];
    expect(v(deniedRows, null, new Set(['apr_b']))?.verdict).toBe('denied');
    expect(v(deniedRows, null, new Set(['apr_b']))?.prior.approvalId).toBe('apr_b');
    // Cancelled / interrupted / restarted while waiting, or unattended's floor: not a user denial.
    expect(v(deniedRows)?.verdict).toBe('uncertain');
    expect(v([row({ status: 'denied', approvalId: 'apr_x' })])).toBeNull();
    expect(v([row({ status: 'denied', approvalId: null })], null, new Set(['apr_x']))).toBeNull();
    expect(
      v(
        [
          row({ id: 'a', status: 'denied', createdAt: 1, approvalId: 'apr_a' }),
          row({ id: 'b', status: 'uncertain', createdAt: 2 }),
        ],
        null,
        new Set(['apr_a']),
      )?.verdict,
    ).toBe('uncertain');
    // B2: the user's ask_user answer after the row settled clears completed and user-denied rows…
    expect(v([row({ status: 'completed', settledAt: 11 })], 12)).toBeNull();
    expect(v([row({ status: 'completed', settledAt: 13 })], 12)?.verdict).toBe('completed');
    expect(
      v([row({ status: 'denied', approvalId: 'apr_d', settledAt: 11 })], 12, new Set(['apr_d'])),
    ).toBeNull();
    // …but never an uncertain one: it keeps getting the flagged card.
    expect(v([row({ status: 'uncertain', settledAt: 11 })], 12)?.verdict).toBe('uncertain');
  });

  it('completed duplicate → DUPLICATE_EFFECT with the receipt, no new row; different args → asks again', async () => {
    const r = rig();
    try {
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'approved', seen, r.store);
      const first = await executeToolSafely(tool, { to: 'ann', text: 'hi' }, r.ctx(), r.recorder);
      expect(first.ok).toBe(true);
      expect(seen[0]).toEqual({ verdict: null, statusWhileWaiting: 'intended' });
      expect(r.store.listForRun(r.run.id)).toEqual([
        expect.objectContaining({ status: 'completed', approvalId: 'apr_0' }),
      ]);

      // Same args (any key order): no approval, DUPLICATE_EFFECT, row discarded.
      const second = await executeToolSafely(tool, { text: 'hi', to: 'ann' }, r.ctx(), r.recorder);
      expect(second).toMatchObject({ ok: false, errorCode: 'DUPLICATE_EFFECT' });
      expect(second.content).toContain('相同操作已在本任务中完成');
      expect(second.content).toContain('<untrusted>https://chat.example/m/1</untrusted>');
      expect(second.content).toContain('ask_user');
      expect(seen[1]).toEqual({ verdict: 'completed' });
      expect(r.store.listForRun(r.run.id)).toHaveLength(1);

      // Different args: a new approval.
      const third = await executeToolSafely(tool, { to: 'bob', text: 'hi' }, r.ctx(), r.recorder);
      expect(third.ok).toBe(true);
      expect(seen[2]!.verdict).toBeNull();
      expect(r.store.listForRun(r.run.id)).toHaveLength(2);

      // The user agreed through ask_user after it completed: the repeat goes through.
      r.runs.appendStep({
        runId: r.run.id,
        type: 'tool_result',
        payload: {
          toolCallId: 'ask',
          toolName: 'ask_user',
          ok: true,
          content: '用户的回答：再发一次',
        },
      });
      const again = await executeToolSafely(tool, { to: 'ann', text: 'hi' }, r.ctx(), r.recorder);
      expect(again.ok).toBe(true);
      expect(seen[3]!.verdict).toBeNull();
      // …once: the next identical call is a duplicate again.
      const once = await executeToolSafely(tool, { to: 'ann', text: 'hi' }, r.ctx(), r.recorder);
      expect(once.errorCode).toBe('DUPLICATE_EFFECT');
    } finally {
      r.close();
    }
  });

  it('denied duplicate → 用户已拒绝相同操作 (ledger denied); turns and other task chains are never gated', async () => {
    const r = rig();
    try {
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'denied', seen, r.store);
      const first = await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(first.errorCode).toBe('APPROVAL_DENIED');
      // The user refused apr_0 by hand.
      r.userDenied.add('apr_0');
      const second = await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(second).toMatchObject({ ok: false, errorCode: 'APPROVAL_DENIED' });
      expect(second.content).toContain('用户已拒绝相同操作');
      // The gate's own denial carries the user's original approval (stays a user denial).
      expect(r.store.listForRun(r.run.id).map((e) => [e.status, e.approvalId])).toEqual([
        ['denied', 'apr_0'],
        ['denied', 'apr_0'],
      ]);
      const third = await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(third.content).toContain('用户已拒绝相同操作');

      // Another task (not a continuation): its own chain, asks again.
      const other = r.runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'task',
        triggerReason: null,
        triggerMessageIds: [],
      });
      const otherIdentity: RunIdentity = { ...r.identity, runId: other.id };
      const otherSeen: typeof seen = [];
      const otherTool = approvingTool(otherIdentity, () => 'approved', otherSeen, r.store);
      const fresh = await executeToolSafely(
        otherTool,
        { to: 'ann' },
        r.ctx({ identity: otherIdentity }),
        r.recorder,
      );
      expect(fresh.ok).toBe(true);
      expect(otherSeen[0]!.verdict).toBeNull();

      // A continuation of the first task inherits its chain.
      const cont = r.runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'task',
        triggerReason: null,
        triggerMessageIds: [],
        continuedFromRunIds: [r.run.id],
      });
      const contIdentity: RunIdentity = { ...r.identity, runId: cont.id };
      const contSeen: typeof seen = [];
      const contTool = approvingTool(contIdentity, () => 'approved', contSeen, r.store);
      const blocked = await executeToolSafely(
        contTool,
        { to: 'ann' },
        r.ctx({ identity: contIdentity }),
        r.recorder,
      );
      expect(blocked.content).toContain('用户已拒绝相同操作');

      // A turn is never gated.
      const turnIdentity: RunIdentity = { ...r.identity, loopType: 'turn' };
      let turnGate: unknown = 'unset';
      const probe = fakeTool(
        'mcp_srv_send',
        async () => {
          turnGate = activeEffectHooks()?.approvalGate?.(turnIdentity.runId) ?? null;
          return ok();
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      await executeToolSafely(probe, { to: 'ann' }, r.ctx({ identity: turnIdentity }), r.recorder);
      expect(turnGate).toBeNull();
    } finally {
      r.close();
    }
  });

  it('uncertain earlier attempt → gate says uncertain (the card is still created)', async () => {
    const r = rig();
    try {
      const earlier = r.store.open({
        runId: r.run.id,
        toolCallId: 'old',
        toolName: 'mcp_srv_send',
        argsHash: sha256Hex(ledgerArgsText('mcp_srv_send', { to: 'ann' }, (t) => t)),
        summary: 'mcp_srv_send {"to":"ann"}',
      });
      r.store.markExecutingUncertain([r.run.id]);
      expect(r.store.get(earlier.id)!.status).toBe('uncertain');
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'approved', seen, r.store);
      const result = await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(result.ok).toBe(true);
      expect(seen[0]).toEqual({ verdict: 'uncertain', statusWhileWaiting: 'intended' });
    } finally {
      r.close();
    }
  });
});

describe('W4 intended rows', () => {
  it('intended ⇄ executing; interruption / recovery settle intended as denied, never uncertain', () => {
    const r = rig();
    try {
      const open = (id: string) =>
        r.store.open({
          runId: r.run.id,
          toolCallId: id,
          toolName: 'mcp_srv_send',
          argsHash: id,
          summary: id,
        });
      const a = open('a');
      r.store.markIntended(a.id, true);
      expect(r.store.get(a.id)!.status).toBe('intended');
      r.store.noteApproval(a.id, 'apr_a');
      expect(r.store.get(a.id)!.approvalId).toBe('apr_a');
      r.store.markIntended(a.id, false);
      expect(r.store.get(a.id)!.status).toBe('executing');
      r.store.markIntended(a.id, true);

      // W3 interrupt: cancelled approval → denied (intended too).
      expect(r.store.settleUnapproved([r.run.id], ['apr_a'])).toBe(1);
      expect(r.store.get(a.id)!.status).toBe('denied');

      // Recovery: intended → denied, executing → uncertain.
      const b = open('b');
      const c = open('c');
      r.store.markIntended(b.id, true);
      expect(r.store.markExecutingUncertain()).toBe(2);
      expect(r.store.get(b.id)!.status).toBe('denied');
      expect(r.store.get(c.id)!.status).toBe('uncertain');

      // Discard only removes live rows.
      const d = open('d');
      r.store.discard(d.id);
      r.store.discard(c.id);
      expect(r.store.get(d.id)).toBeNull();
      expect(r.store.get(c.id)).not.toBeNull();
    } finally {
      r.close();
    }
  });

  it('a call that returns while still intended settles failed / denied, never uncertain', async () => {
    const r = rig();
    try {
      const waitsThenThrows = fakeTool(
        'mcp_srv_send',
        async () => {
          activeEffectHooks()!.approvalWaiting!(r.identity.runId);
          throw new Error('transport gone while waiting');
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      const result = await executeToolSafely(waitsThenThrows, { to: 'x' }, r.ctx(), r.recorder);
      expect(result.ok).toBe(false);
      expect(result.outcome).toBeUndefined();
      expect(r.store.listForRun(r.run.id).at(-1)!.status).toBe('failed');

      const aborted = new AbortController();
      aborted.abort();
      const waitsThenCancelled = fakeTool(
        'mcp_srv_send',
        async () => {
          activeEffectHooks()!.approvalWaiting!(r.identity.runId);
          return { ok: false, content: 'cancelled', errorCode: 'APPROVAL_DENIED' };
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      await executeToolSafely(
        waitsThenCancelled,
        { to: 'y' },
        r.ctx({ signal: aborted.signal }),
        r.recorder,
      );
      expect(r.store.listForRun(r.run.id).at(-1)!.status).toBe('denied');
    } finally {
      r.close();
    }
  });

  it('forApprovals batches the receipt lookup; onSettled fires for approval-linked rows', async () => {
    const r = rig();
    try {
      const settled: string[] = [];
      const recorder = createEffectRecorder({
        ...r.deps,
        onSettled: (effect) => settled.push(effect.approvalId ?? ''),
      });
      const tool = fakeTool(
        'mcp_srv_send',
        async (params) => {
          const to = (params as { to: string }).to;
          if (to !== 'none') activeEffectHooks()!.noteApproval(`apr_${to}`, r.identity.runId);
          return { ok: true, content: 'ok', effect: { receipt: { externalId: `id-${to}` } } };
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      for (const to of ['a', 'b', 'none']) {
        await executeToolSafely(tool, { to }, r.ctx(), recorder);
      }
      expect(settled).toEqual(['apr_a', 'apr_b']);
      const map = r.store.forApprovals(['apr_a', 'apr_b', 'apr_missing', '']);
      expect([...map.keys()].sort()).toEqual(['apr_a', 'apr_b']);
      expect(map.get('apr_a')).toMatchObject({
        status: 'completed',
        receipt: { externalId: 'id-a' },
      });
      expect(r.store.forApprovals([]).size).toBe(0);
    } finally {
      r.close();
    }
  });
});

describe('W4 复查后修正', () => {
  it('B1: a denial without a user decision (cancelled / interrupted / restart while waiting) never dedupes', async () => {
    const r = rig();
    try {
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'denied', seen, r.store);
      // apr_0 ends "denied" in the ledger, but nobody refused it (cancelled).
      await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(r.store.listForRun(r.run.id)[0]!.status).toBe('denied');
      const again = approvingTool(r.identity, () => 'approved', seen, r.store);
      const second = await executeToolSafely(again, { to: 'ann' }, r.ctx(), r.recorder);
      expect(second.ok).toBe(true);
      expect(seen[1]).toEqual({ verdict: null, statusWhileWaiting: 'intended' });

      // Restart while waiting: intended → denied by recovery; a retry asks again.
      const waiting = r.store.open({
        runId: r.run.id,
        toolCallId: 'w',
        toolName: 'mcp_srv_send',
        argsHash: sha256Hex(ledgerArgsText('mcp_srv_send', { to: 'bob' }, (t) => t)),
        summary: 's',
        approvalId: 'apr_pending',
      });
      r.store.markIntended(waiting.id, true);
      r.store.markExecutingUncertain();
      expect(r.store.get(waiting.id)!.status).toBe('denied');
      const retry = r.runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'task',
        triggerReason: null,
        triggerMessageIds: [],
        continuedFromRunIds: [r.run.id],
      });
      const retryIdentity: RunIdentity = { ...r.identity, runId: retry.id };
      const retrySeen: typeof seen = [];
      const retryTool = approvingTool(retryIdentity, () => 'approved', retrySeen, r.store);
      const retried = await executeToolSafely(
        retryTool,
        { to: 'bob' },
        r.ctx({ identity: retryIdentity }),
        r.recorder,
      );
      expect(retried.ok).toBe(true);
      expect(retrySeen[0]!.verdict).toBeNull();
    } finally {
      r.close();
    }
  });

  it('B2: an expired ask_user is not consent; consent never clears an uncertain attempt', async () => {
    const r = rig();
    try {
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'approved', seen, r.store);
      await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      // The question expired unanswered (ok:false, ASK_USER_UNANSWERED).
      r.runs.appendStep({
        runId: r.run.id,
        type: 'tool_result',
        payload: {
          toolCallId: 'ask',
          toolName: 'ask_user',
          ok: false,
          errorCode: 'ASK_USER_UNANSWERED',
          content: '用户未回答（等了 24 小时）',
        },
      });
      expect(r.store.lastUserAnswerAt([r.run.id])).toBeNull();
      const blocked = await executeToolSafely(tool, { to: 'ann' }, r.ctx(), r.recorder);
      expect(blocked.errorCode).toBe('DUPLICATE_EFFECT');

      // An uncertain attempt + a real answer afterwards: still the flagged card.
      const earlier = r.store.open({
        runId: r.run.id,
        toolCallId: 'u',
        toolName: 'mcp_srv_send',
        argsHash: sha256Hex(ledgerArgsText('mcp_srv_send', { to: 'cat' }, (t) => t)),
        summary: 's',
      });
      r.store.markExecutingUncertain([r.run.id]);
      expect(r.store.get(earlier.id)!.status).toBe('uncertain');
      r.runs.appendStep({
        runId: r.run.id,
        type: 'tool_result',
        payload: {
          toolCallId: 'ask2',
          toolName: 'ask_user',
          ok: true,
          content: '用户的回答：再试',
        },
      });
      expect(r.store.lastUserAnswerAt([r.run.id])).not.toBeNull();
      await executeToolSafely(tool, { to: 'cat' }, r.ctx(), r.recorder);
      expect(seen.at(-1)!.verdict).toBe('uncertain');
    } finally {
      r.close();
    }
  });

  it('S1: a completed git_remote / unsandboxed repeat gets a flagged card (repeat), not a block', async () => {
    const r = rig();
    try {
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const git = (kind: string) =>
        approvingTool(r.identity, () => 'approved', seen, r.store, kind);
      await executeToolSafely(git('git_remote'), { op: 'push' }, r.ctx(), r.recorder);
      const second = await executeToolSafely(
        git('git_remote'),
        { op: 'push' },
        r.ctx(),
        r.recorder,
      );
      expect(second.ok).toBe(true);
      expect(seen[1]).toEqual({ verdict: 'repeat', statusWhileWaiting: 'intended' });
      expect(r.store.listForRun(r.run.id).map((e) => e.status)).toEqual(['completed', 'completed']);
    } finally {
      r.close();
    }
  });

  it('S2: args holding a redaction placeholder are never compared (two secrets must not look the same)', async () => {
    const r = rig();
    try {
      const recorder = createEffectRecorder({
        ...r.deps,
        redact: (text) =>
          text.split('sk-AAAA1111').join('[REDACTED]').split('sk-BBBB2222').join('[REDACTED]'),
      });
      const seen: Array<{ verdict: string | null; statusWhileWaiting?: string }> = [];
      const tool = approvingTool(r.identity, () => 'approved', seen, r.store);
      await executeToolSafely(tool, { to: 'ann', token: 'sk-AAAA1111' }, r.ctx(), recorder);
      const other = await executeToolSafely(
        tool,
        { to: 'ann', token: 'sk-BBBB2222' },
        r.ctx(),
        recorder,
      );
      expect(other.ok).toBe(true);
      expect(seen[1]!.verdict).toBeNull();
      // Same placeholder text — still not compared.
      await executeToolSafely(tool, { to: 'ann', token: 'sk-AAAA1111' }, r.ctx(), recorder);
      expect(seen[2]!.verdict).toBeNull();
    } finally {
      r.close();
    }
  });

  it('nit: once an approval of the call was granted the row never goes back to intended', async () => {
    const r = rig();
    try {
      const statuses: string[] = [];
      const twoApprovals = fakeTool(
        'mcp_srv_send',
        async (_params, ctx) => {
          const hooks = activeEffectHooks()!;
          hooks.approvalWaiting!(r.identity.runId);
          hooks.approvalGranted!(r.identity.runId);
          hooks.approvalWaiting!(r.identity.runId);
          statuses.push(r.store.listForRun(ctx.identity.runId).at(-1)!.status);
          throw new Error('boom');
        },
        { mcp: { serverId: 'srv', toolName: 'send', risk: 'write' } },
      );
      await executeToolSafely(twoApprovals, { to: 'x' }, r.ctx(), r.recorder);
      expect(statuses).toEqual(['executing']);
      // It may have acted: a throw is uncertain, not "never ran".
      expect(r.store.listForRun(r.run.id).at(-1)!.status).toBe('uncertain');
    } finally {
      r.close();
    }
  });
});
