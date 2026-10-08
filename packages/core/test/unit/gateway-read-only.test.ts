import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';

import { canonicalPath, resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { ProjectRuntime } from '../../src/project/service.js';
import { GrantsService } from '../../src/permissions/grants.js';
import { buildCodingTools } from '../../src/tools/coding-tools.js';
import { FileReadState } from '../../src/tools/fs-state.js';
import { executeToolSafely } from '../../src/agent/tool-execution.js';
import { runInToolCall } from '../../src/permissions/tool-call-scope.js';
import { UnavailableSandboxBackend, type SandboxBackend, type SandboxExecRequest } from '../../src/sandbox/types.js';
import type { RunIdentity, ToolContext, ToolDefinition } from '../../src/agent/types.js';

/**
 * D75 W1-C：执行期只读（docs/design/30 §2.1、§5.1）与「仅这一次」= 单次工具
 * 调用（§7.3）。网关是真的（ToolGateway + ProjectRuntime.writeDenial +
 * GrantsService），其余依赖为桩。
 */

const BOT = 'bot_ro';
const CONV = 'conv_ro';

const ids = {
  turn: { runId: 'run_turn', botId: BOT, conversationId: CONV, loopType: 'turn' },
  readTask: { runId: 'run_read_task', botId: BOT, conversationId: CONV, loopType: 'task' },
  writeTask: { runId: 'run_write_task', botId: BOT, conversationId: CONV, loopType: 'task' },
  unknownTask: { runId: 'run_missing', botId: BOT, conversationId: CONV, loopType: 'task' },
  response: { runId: 'run_resp', botId: BOT, conversationId: CONV, loopType: 'response' },
} satisfies Record<string, RunIdentity>;

const runRows = new Map<string, { taskWrites: boolean | null }>([
  ['run_turn', { taskWrites: null }],
  ['run_read_task', { taskWrites: false }],
  ['run_write_task', { taskWrites: true }],
  ['run_resp', { taskWrites: null }],
]);

let home: string;
let outside: string;
let grants: GrantsService;
let approvalRequests: Array<{ kind: string; payload: Record<string, unknown> }>;
let approvalAnswer: 'approved' | 'denied';

function makeGrants(): GrantsService {
  const db = new Database(':memory:');
  db.exec(`
    create table grants (
      id text primary key, bot_id text not null, conversation_id text not null,
      path text not null, access text not null, duration text not null,
      run_id text, approval_id text, created_at integer not null, revoked_at integer
    );
  `);
  return new GrantsService({ db: db as never, clock: { now: () => Date.now() } });
}

function makeGateway(sandbox: SandboxBackend = new UnavailableSandboxBackend('test')): ToolGateway {
  const projects = new ProjectRuntime({
    runs: { get: (id: string) => runRows.get(id) ?? null },
    conversations: { get: () => null },
  } as never);
  const deps: GatewayDeps = {
    paths: resolvePaths(home),
    sandbox,
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
          decision: approvalAnswer,
        };
      },
    } as unknown as GatewayDeps['approvals'],
    grants,
    allowlist: {
      match: (command: string) => ({ exempt: command.startsWith('ls'), reason: 'stub' }),
    } as unknown as GatewayDeps['allowlist'],
    unattended: {} as GatewayDeps['unattended'],
    projects,
    platform: 'linux',
    readOnlyRootsOverride: [],
    sensitiveOverride: [],
  };
  return new ToolGateway(deps);
}

function workspace(): string {
  return workspacePathFor(resolvePaths(home), BOT, CONV);
}

function ctxFor(identity: RunIdentity): ToolContext {
  return {
    identity,
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };
}

function codingTools(gateway: ToolGateway, identity: RunIdentity): Map<string, ToolDefinition> {
  const tools = buildCodingTools(identity, {
    gateway,
    workspacePath: workspace(),
    projectPath: null,
    network: { mode: 'none', allowDomains: [] },
    secrets: { redact: (text: string) => text } as never,
    fsState: new FileReadState(),
  });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/** Records the policy of every sandboxed command. */
function recordingSandbox(): SandboxBackend & { requests: SandboxExecRequest[] } {
  const requests: SandboxExecRequest[] = [];
  return {
    kind: 'srt',
    requests,
    probe: async () => ({ backend: 'srt', available: true }),
    exec: async (req) => {
      requests.push(req);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, violations: [] };
    },
  } as SandboxBackend & { requests: SandboxExecRequest[] };
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'kepcup-ro-'));
  home = path.join(base, 'data-home');
  outside = canonicalPath(path.join(base, 'outside'));
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'data.txt'), 'outside-data');
  mkdirSync(workspace(), { recursive: true });
  writeFileSync(path.join(workspace(), 'notes.txt'), 'hello');
  grants = makeGrants();
  approvalRequests = [];
  approvalAnswer = 'approved';
});

describe('execution-time read-only (D75 §2.1 / §5.1)', () => {
  it('writeDenial: turn and read-only tasks are read-only; write tasks and other loops are not', () => {
    const gateway = makeGateway();
    expect(gateway.writeDenial(ids.turn)).toContain('对话轮是只读的');
    expect(gateway.writeDenial(ids.readTask)).toContain('只读任务');
    // Fail closed: a task without a run row cannot prove it may write.
    expect(gateway.writeDenial(ids.unknownTask)).toContain('只读任务');
    expect(gateway.writeDenial(ids.writeTask)).toBeNull();
    expect(gateway.writeDenial(ids.response)).toBeNull();
  });

  it('checkPath refuses writes (even inside the workspace) but keeps reads allowed', () => {
    const gateway = makeGateway();
    for (const identity of [ids.turn, ids.readTask]) {
      expect(gateway.checkPath(identity, 'notes.txt', 'read')).toMatchObject({ kind: 'allowed' });
      expect(gateway.checkPath(identity, 'notes.txt', 'write')).toMatchObject({
        kind: 'forbidden',
        readOnlyRun: true,
      });
    }
    expect(gateway.checkPath(ids.writeTask, 'notes.txt', 'write')).toMatchObject({ kind: 'allowed' });
  });

  it('ensurePathAccess throws RUN_READ_ONLY without raising an approval (outside paths too)', async () => {
    const gateway = makeGateway();
    await expect(
      gateway.ensurePathAccess(ids.turn, path.join(outside, 'x.txt'), 'write', '测试'),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    await expect(
      gateway.ensurePathAccess(ids.readTask, 'notes.txt', 'write', '测试'),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    expect(approvalRequests).toEqual([]);
  });

  it('write / edit tools return a RUN_READ_ONLY tool error; read keeps working', async () => {
    const gateway = makeGateway();
    for (const identity of [ids.turn, ids.readTask]) {
      const tools = codingTools(gateway, identity);
      const write = await executeToolSafely(
        tools.get('write')!,
        { path: 'new.txt', content: 'x' },
        ctxFor(identity),
      );
      expect(write.ok).toBe(false);
      expect(write.errorCode).toBe('RUN_READ_ONLY');
      expect(write.content).toMatch(/只读/);
      expect(existsSync(path.join(workspace(), 'new.txt'))).toBe(false);

      const edit = await executeToolSafely(
        tools.get('edit')!,
        { path: 'notes.txt', edits: [{ oldText: 'hello', newText: 'bye' }] },
        ctxFor(identity),
      );
      expect(edit.ok).toBe(false);
      expect(edit.errorCode).toBe('RUN_READ_ONLY');

      const read = await executeToolSafely(tools.get('read')!, { path: 'notes.txt' }, ctxFor(identity));
      expect(read.ok).toBe(true);
      expect(read.content).toContain('hello');
    }
    // A write task still writes.
    const tools = codingTools(gateway, ids.writeTask);
    const write = await executeToolSafely(
      tools.get('write')!,
      { path: 'new.txt', content: 'x' },
      ctxFor(ids.writeTask),
    );
    expect(write.ok).toBe(true);
    expect(existsSync(path.join(workspace(), 'new.txt'))).toBe(true);
  });

  it('sandboxed commands of a read-only run get a read-only workspace and no write grants', async () => {
    const sandbox = recordingSandbox();
    const gateway = makeGateway(sandbox);
    grants.create({
      botId: BOT,
      conversationId: CONV,
      path: outside,
      access: 'write',
      duration: 'conversation',
    });
    await gateway.exec(ids.readTask, { command: 'cat notes.txt', network: { mode: 'none', allowDomains: [] } });
    const ro = sandbox.requests[0]!.policy;
    expect(ro.readWrite).not.toContain(workspace());
    expect(ro.readOnly).toContain(workspace());
    expect(ro.readWrite).not.toContain(outside);
    expect(ro.readOnly).toContain(outside);

    await gateway.exec(ids.writeTask, { command: 'touch a', network: { mode: 'none', allowDomains: [] } });
    const rw = sandbox.requests[1]!.policy;
    expect(rw.readWrite).toContain(workspace());
    expect(rw.readWrite).toContain(outside);
  });

  it('confirm mode: read-only runs may only run allowlisted commands; no approval is raised', async () => {
    const gateway = makeGateway();
    await expect(
      gateway.exec(ids.turn, { command: 'touch x', network: { mode: 'none', allowDomains: [] } }),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    const listed = await gateway.exec(ids.turn, {
      command: 'ls',
      network: { mode: 'none', allowDomains: [] },
    });
    expect(listed.policyApplied).toBe(false);
    expect(approvalRequests).toEqual([]);
  });

  it('request_unsandboxed and git remote operations are refused for read-only runs', async () => {
    const gateway = makeGateway();
    await expect(gateway.requestUnsandboxed(ids.readTask, 'docker ps', '测试')).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
    });
    await expect(
      gateway.gitRemote(ids.turn, { operation: 'fetch', args: [], reason: '测试' }),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    expect(approvalRequests).toEqual([]);
  });
});

describe('「仅这一次」= 单次工具调用 (D75 §7.3)', () => {
  it('an inline once approval covers the rest of its tool call; the next call asks again', async () => {
    const gateway = makeGateway();
    const target = path.join(outside, 'data.txt');
    await runInToolCall(async () => {
      await gateway.ensurePathAccess(ids.response, target, 'read', '读');
      // Same tool call (e.g. edit's access → readFile → writeFile): no new card.
      await gateway.ensurePathAccess(ids.response, target, 'read', '读');
    });
    expect(approvalRequests).toHaveLength(1);
    // The call returned: the grant is consumed.
    expect(grants.listEffective(ids.response)).toEqual([]);
    await runInToolCall(() => gateway.ensurePathAccess(ids.response, target, 'read', '读'));
    expect(approvalRequests).toHaveLength(2);
  });

  it('the read tool asks once per call (two calls → two approvals)', async () => {
    const gateway = makeGateway();
    const tools = codingTools(gateway, ids.response);
    const target = path.join(outside, 'data.txt');
    const first = await executeToolSafely(tools.get('read')!, { path: target }, ctxFor(ids.response));
    expect(first.ok).toBe(true);
    const second = await executeToolSafely(tools.get('read')!, { path: target }, ctxFor(ids.response));
    expect(second.ok).toBe(true);
    expect(approvalRequests).toHaveLength(2);
  });

  it('a pre-authorized once grant (request_access) is consumed by the next call that uses it', async () => {
    const gateway = makeGateway();
    const target = path.join(outside, 'data.txt');
    await runInToolCall(() =>
      gateway.ensurePathAccess(ids.response, outside, 'read', '批量前申请', { preauthorize: true }),
    );
    expect(grants.listEffective(ids.response)).toHaveLength(1);
    // First use: passes without a card, and is consumed when that call ends.
    await runInToolCall(() => gateway.ensurePathAccess(ids.response, target, 'read', '读'));
    expect(approvalRequests).toHaveLength(1);
    expect(grants.listEffective(ids.response)).toEqual([]);
    await runInToolCall(() => gateway.ensurePathAccess(ids.response, target, 'read', '读'));
    expect(approvalRequests).toHaveLength(2);
  });

  it('a once grant joining a sandbox policy is consumed by that command', async () => {
    const sandbox = recordingSandbox();
    const gateway = makeGateway(sandbox);
    await runInToolCall(() =>
      gateway.ensurePathAccess(ids.response, outside, 'write', '申请', { preauthorize: true }),
    );
    const network = { mode: 'none' as const, allowDomains: [] };
    await runInToolCall(() => gateway.exec(ids.response, { command: 'touch a', network }));
    await runInToolCall(() => gateway.exec(ids.response, { command: 'touch b', network }));
    expect(sandbox.requests[0]!.policy.readWrite).toContain(outside);
    expect(sandbox.requests[1]!.policy.readWrite).not.toContain(outside);
  });

  it('conversation grants are never consumed', async () => {
    const gateway = makeGateway();
    grants.create({ botId: BOT, conversationId: CONV, path: outside, access: 'read', duration: 'conversation' });
    const target = path.join(outside, 'data.txt');
    for (let i = 0; i < 3; i++) {
      await runInToolCall(() => gateway.ensurePathAccess(ids.response, target, 'read', '读'));
    }
    expect(approvalRequests).toEqual([]);
  });
});
