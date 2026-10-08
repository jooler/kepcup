import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Message, Run } from '@kepcup/shared';

import { canonicalPath, resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { ProjectRuntime } from '../../src/project/service.js';
import { GrantsService } from '../../src/permissions/grants.js';
import { buildCodingTools } from '../../src/tools/coding-tools.js';
import { buildResponseTools } from '../../src/tools/index.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';
import { UnavailableSandboxBackend } from '../../src/sandbox/types.js';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';

/**
 * D75 W2 审查修复（工具面）：send_message 只上传当前可读的附件（越界 / 敏感
 * 路径不经审批绝不读取）；get_run 只看本 Bot 的执行；任务不 @ 群成员；对话轮
 * 的越界读取当场失败、不发起审批（不占住 mailbox）。网关是真的，其余为桩。
 */

const BOT = 'bot_x';
const OTHER = 'bot_y';
const CONV = 'conv_x';
const turn: RunIdentity = { runId: 'run_turn', botId: BOT, conversationId: CONV, loopType: 'turn' };
const task: RunIdentity = { runId: 'run_task', botId: BOT, conversationId: CONV, loopType: 'task' };

let home: string;
let outside: string;
let sensitive: string;
let approvalRequests: Array<{ kind: string; payload: Record<string, unknown> }>;

function workspace(): string {
  return workspacePathFor(resolvePaths(home), BOT, CONV);
}

function makeGateway(): ToolGateway {
  const db = new Database(':memory:');
  db.exec(`
    create table grants (
      id text primary key, bot_id text not null, conversation_id text not null,
      path text not null, access text not null, duration text not null,
      run_id text, approval_id text, created_at integer not null, revoked_at integer
    );
  `);
  const grants = new GrantsService({ db: db as never, clock: { now: () => Date.now() } });
  const runRows = new Map<string, { id: string; loopType: string; taskWrites: boolean | null; parentRunId: null; status: string }>([
    ['run_turn', { id: 'run_turn', loopType: 'turn', taskWrites: null, parentRunId: null, status: 'running' }],
    ['run_task', { id: 'run_task', loopType: 'task', taskWrites: false, parentRunId: null, status: 'running' }],
  ]);
  const projects = new ProjectRuntime({
    runs: { get: (id: string) => runRows.get(id) ?? null },
    conversations: { get: () => null },
    leases: { keyOf: () => null },
  } as never);
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox: new UnavailableSandboxBackend('test'),
    audit: { record: () => {} } as unknown as GatewayDeps['audit'],
    secrets: { redact: (text: string) => text } as unknown as GatewayDeps['secrets'],
    logger: { info() {}, warn() {}, error() {} } as unknown as GatewayDeps['logger'],
    approvals: {
      noteGrantUsed: () => {},
      publishEvent: () => {},
      request: async (_identity: unknown, kind: string, payload: Record<string, unknown>) => {
        approvalRequests.push({ kind, payload });
        return {
          approval: { id: `apr_${approvalRequests.length}`, decision: { duration: 'once' } },
          decision: 'approved',
        };
      },
    } as unknown as GatewayDeps['approvals'],
    grants,
    allowlist: { match: () => ({ exempt: false, reason: 'stub' }) } as unknown as GatewayDeps['allowlist'],
    unattended: {} as GatewayDeps['unattended'],
    projects,
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [sensitive],
  };
  return new ToolGateway(deps);
}

function ctxFor(identity: RunIdentity): ToolContext {
  return { identity, signal: new AbortController().signal, terminate: () => {}, progress: () => {} };
}

interface Harness {
  tools: Map<string, ToolDefinition>;
  uploads: string[];
  appended: Array<{ mentions: string[]; text: string }>;
  mentioned: string[][];
}

function responseTools(identity: RunIdentity, runs: Run[] = []): Harness {
  const uploads: string[] = [];
  const appended: Harness['appended'] = [];
  const mentioned: string[][] = [];
  const tools = buildResponseTools({
    identity,
    deps: {
      messages: {
        append: (input: { text: string; mentions: string[] }) => {
          appended.push({ mentions: input.mentions, text: input.text });
          return { id: `msg_${appended.length}`, conversationId: CONV } as unknown as Message;
        },
      },
      attachments: {
        upload: (input: { fileName: string }) => {
          uploads.push(input.fileName);
          return { id: `att_${uploads.length}` };
        },
        attachToMessage: () => {},
      },
      runs: {
        get: (id: string) => runs.find((run) => run.id === id) ?? null,
        stepsFor: () => [],
      },
      secrets: { redact: (text: string) => text },
      renderOptions: {},
      gateway: makeGateway(),
      workspacePath: workspace(),
      projectPath: null,
      projects: {},
      network: { mode: 'none', allowDomains: [] },
      fsState: new FileReadState(),
      onBotMessage: () => {},
      onMentionBots: (ids: string[]) => {
        mentioned.push(ids);
        return '';
      },
      environment: { request: async () => ({ status: 'installing', item: 'x' }), offeredItems: () => [] },
    } as never,
  });
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), uploads, appended, mentioned };
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'kepcup-turn-tools-'));
  home = path.join(base, 'data-home');
  outside = canonicalPath(path.join(base, 'outside'));
  sensitive = canonicalPath(path.join(base, 'secrets'));
  mkdirSync(outside, { recursive: true });
  mkdirSync(sensitive, { recursive: true });
  writeFileSync(path.join(outside, 'data.txt'), 'outside-data');
  writeFileSync(path.join(sensitive, 'id_rsa'), 'PRIVATE KEY');
  mkdirSync(workspace(), { recursive: true });
  writeFileSync(path.join(workspace(), 'report.md'), 'report');
  approvalRequests = [];
});

describe('send_message attachments need an allowed path (审查 pre-existing HIGH)', () => {
  for (const identity of [turn, task]) {
    it(`${identity.loopType}: a path outside the workspace or a sensitive one is never read and uploaded`, async () => {
      const { tools, uploads, appended } = responseTools(identity);
      const send = tools.get('send_message')!;
      for (const file of [path.join(outside, 'data.txt'), path.join(sensitive, 'id_rsa')]) {
        const result = await executeToolSafely(
          send,
          { text: '给你文件', attachment_paths: [file] },
          ctxFor(identity),
        );
        expect(result.ok).toBe(false);
        expect(result.errorCode).toBe('PATH_OUT_OF_SCOPE');
        expect(result.content).toContain('授权范围');
      }
      expect(uploads).toEqual([]);
      expect(appended).toEqual([]);
      expect(approvalRequests).toEqual([]);
      // A workspace file still goes out.
      const ok = await executeToolSafely(
        send,
        { text: '报告', attachment_paths: ['report.md'] },
        ctxFor(identity),
      );
      expect(ok.ok).toBe(true);
      expect(uploads).toEqual(['report.md']);
    });
  }
});

describe('tasks never @-mention group members (审查 L1)', () => {
  it('a task send_message has no mention_bot_ids and drops any it is given; a turn keeps them', async () => {
    const taskHarness = responseTools(task);
    const taskSend = taskHarness.tools.get('send_message')!;
    expect(Object.keys((taskSend.parameters as { properties: object }).properties)).not.toContain(
      'mention_bot_ids',
    );
    const sent = await executeToolSafely(
      taskSend,
      { text: '进展', mention_bot_ids: [OTHER] },
      ctxFor(task),
    );
    expect(sent.ok).toBe(true);
    expect(taskHarness.appended).toEqual([{ text: '进展', mentions: [] }]);
    expect(taskHarness.mentioned).toEqual([]);

    const turnHarness = responseTools(turn);
    const turnSend = turnHarness.tools.get('send_message')!;
    expect(Object.keys((turnSend.parameters as { properties: object }).properties)).toContain(
      'mention_bot_ids',
    );
    await executeToolSafely(turnSend, { text: '请接力', mention_bot_ids: [OTHER] }, ctxFor(turn));
    expect(turnHarness.appended).toEqual([{ text: '请接力', mentions: [OTHER] }]);
    expect(turnHarness.mentioned).toEqual([[OTHER]]);
  });
});

describe('get_run is scoped to the bot (审查 L2)', () => {
  it("another member's run in the same conversation answers like a missing one", async () => {
    const runs = [
      { id: 'run_mine', botId: BOT, conversationId: CONV },
      { id: 'run_theirs', botId: OTHER, conversationId: CONV },
      { id: 'run_elsewhere', botId: BOT, conversationId: 'conv_other' },
    ] as Run[];
    const { tools } = responseTools(turn, runs);
    const getRun = tools.get('get_run')!;
    expect((await executeToolSafely(getRun, { run_id: 'run_mine' }, ctxFor(turn))).ok).toBe(true);
    for (const id of ['run_theirs', 'run_elsewhere']) {
      const result = await executeToolSafely(getRun, { run_id: id }, ctxFor(turn));
      expect(result).toMatchObject({ ok: false, errorCode: 'RUN_NOT_FOUND' });
    }
  });
});

describe('a turn never waits for an access approval (审查 M4)', () => {
  function codingTools(identity: RunIdentity): Map<string, ToolDefinition> {
    const tools = buildCodingTools(identity, {
      gateway: makeGateway(),
      workspacePath: workspace(),
      projectPath: null,
      network: { mode: 'none', allowDomains: [] },
      secrets: { redact: (text: string) => text } as never,
      fsState: new FileReadState(),
    });
    return new Map(tools.map((tool) => [tool.name, tool]));
  }

  it('read / ls outside the authorized range fail fast in a turn; a task still asks', async () => {
    const turnTools = codingTools(turn);
    for (const [name, args] of [
      ['read', { path: path.join(outside, 'data.txt') }],
      ['ls', { path: outside }],
      ['read', { path: path.join(sensitive, 'id_rsa') }],
    ] as const) {
      const result = await executeToolSafely(turnTools.get(name)!, args, ctxFor(turn));
      expect(result.ok).toBe(false);
      expect(result.content).toContain('start_task');
    }
    expect(approvalRequests).toEqual([]);

    const taskTools = codingTools(task);
    const read = await executeToolSafely(
      taskTools.get('read')!,
      { path: path.join(outside, 'data.txt') },
      ctxFor(task),
    );
    expect(read.ok).toBe(true);
    expect(read.content).toContain('outside-data');
    expect(approvalRequests.map((request) => request.kind)).toEqual(['access']);
  });
});
