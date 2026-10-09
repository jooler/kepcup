import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { AppError } from '@kepcup/shared';
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
  const deps: EffectRecorderDeps = {
    store,
    redact: (text) => text.split(SECRET).join('«secret»'),
    logger: { warn: (_obj, msg) => warnings.push(msg) },
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
