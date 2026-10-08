import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GRANT_ABSOLUTE_TTL_MS } from '@kepcup/shared';
import Database from 'better-sqlite3-multiple-ciphers';

import { canonicalPath, resolvePaths, workspacePathFor } from '../../src/infra/paths.js';
import { ToolGateway, type GatewayDeps } from '../../src/gateway/index.js';
import { ProjectRuntime } from '../../src/project/service.js';
import { GrantsService } from '../../src/permissions/grants.js';
import { buildCodingTools } from '../../src/tools/coding-tools.js';
import { buildResponseTools } from '../../src/tools/index.js';
import { createFakeBrowserHost } from '@kepcup/testkit';
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
  // delegate_task sub runs (loop type subagent) owned by the runs above.
  subOfReadTask: { runId: 'run_sub_read', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOfWriteTask: { runId: 'run_sub_write', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOfEndedWriteTask: { runId: 'run_sub_ended', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOfTurn: { runId: 'run_sub_turn', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOfResponse: { runId: 'run_sub_resp', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOfSubOfReadTask: { runId: 'run_sub_sub', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subOrphan: { runId: 'run_sub_orphan', botId: BOT, conversationId: CONV, loopType: 'subagent' },
  subCycle: { runId: 'run_sub_cycle_a', botId: BOT, conversationId: CONV, loopType: 'subagent' },
} satisfies Record<string, RunIdentity>;

interface RunRow {
  id: string;
  loopType: RunIdentity['loopType'];
  taskWrites: boolean | null;
  parentRunId: string | null;
  status: string;
}

const runRows = new Map<string, RunRow>(
  (
    [
      ['run_turn', 'turn', null, null],
      ['run_read_task', 'task', false, null],
      ['run_write_task', 'task', true, null],
      ['run_ended_write_task', 'task', true, null, 'completed'],
      ['run_resp', 'response', null, null],
      ['run_sub_read', 'subagent', null, 'run_read_task'],
      ['run_sub_write', 'subagent', null, 'run_write_task'],
      ['run_sub_ended', 'subagent', null, 'run_ended_write_task'],
      ['run_sub_turn', 'subagent', null, 'run_turn'],
      ['run_sub_resp', 'subagent', null, 'run_resp'],
      ['run_sub_sub', 'subagent', null, 'run_sub_read'],
      ['run_sub_orphan', 'subagent', null, 'run_gone'],
      ['run_sub_cycle_a', 'subagent', null, 'run_sub_cycle_b'],
      ['run_sub_cycle_b', 'subagent', null, 'run_sub_cycle_a'],
    ] as Array<[string, RunRow['loopType'], boolean | null, string | null, string?]>
  ).map(([id, loopType, taskWrites, parentRunId, status]) => [
    id,
    { id, loopType, taskWrites, parentRunId, status: status ?? 'running' },
  ]),
);

let home: string;
let outside: string;
let grants: GrantsService;
let approvalRequests: Array<{ kind: string; payload: Record<string, unknown> }>;
let approvalAnswer: 'approved' | 'denied';
let clockNow: number;
let events: Array<{ event: string; payload: { conversationId: string; grants: Array<{ id: string }> } }>;

function makeGrants(): GrantsService {
  const db = new Database(':memory:');
  db.exec(`
    create table grants (
      id text primary key, bot_id text not null, conversation_id text not null,
      path text not null, access text not null, duration text not null,
      run_id text, approval_id text, created_at integer not null, revoked_at integer
    );
  `);
  return new GrantsService({ db: db as never, clock: { now: () => clockNow } });
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
      publishEvent: (event: string, payload: never) => {
        events.push({ event, payload });
      },
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
  clockNow = Date.now();
  events = [];
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

describe('sub runs follow the run that owns them (D75 review H1)', () => {
  it('writeDenial resolves a subagent through parent_run_id to the root rule', () => {
    const gateway = makeGateway();
    expect(gateway.writeDenial(ids.subOfReadTask)).toContain('只读任务');
    expect(gateway.writeDenial(ids.subOfSubOfReadTask)).toContain('只读任务');
    expect(gateway.writeDenial(ids.subOfTurn)).toContain('对话轮是只读的');
    expect(gateway.writeDenial(ids.subOfWriteTask)).toBeNull();
    expect(gateway.writeDenial(ids.subOfResponse)).toBeNull();
    // A write task's sub run that outlives the task loses its write rights.
    expect(gateway.writeDenial(ids.subOfEndedWriteTask)).toContain('写任务已经结束');
    // Broken or cyclic chains fail closed (the walk is bounded).
    expect(gateway.writeDenial(ids.subOrphan)).toContain('按只读处理');
    expect(gateway.writeDenial(ids.subCycle)).toContain('按只读处理');
  });

  it("a read-only task's sub run gets a read-only bash policy; a write task's sub run writes", async () => {
    const sandbox = recordingSandbox();
    const gateway = makeGateway(sandbox);
    const network = { mode: 'none' as const, allowDomains: [] };
    await gateway.exec(ids.subOfReadTask, { command: 'echo x > f', network });
    expect(sandbox.requests[0]!.policy.readWrite).not.toContain(workspace());
    expect(sandbox.requests[0]!.policy.readOnly).toContain(workspace());
    await gateway.exec(ids.subOfWriteTask, { command: 'echo x > f', network });
    expect(sandbox.requests[1]!.policy.readWrite).toContain(workspace());
  });

  it("file writes, unsandboxed exec and git of a read-only task's sub run are refused", async () => {
    const gateway = makeGateway();
    expect(gateway.checkPath(ids.subOfReadTask, 'notes.txt', 'write')).toMatchObject({
      kind: 'forbidden',
      readOnlyRun: true,
    });
    expect(gateway.checkPath(ids.subOfReadTask, 'notes.txt', 'read')).toMatchObject({ kind: 'allowed' });
    expect(gateway.checkPath(ids.subOfWriteTask, 'notes.txt', 'write')).toMatchObject({ kind: 'allowed' });
    await expect(gateway.requestUnsandboxed(ids.subOfReadTask, 'touch x', '测试')).rejects.toMatchObject({
      code: 'RUN_READ_ONLY',
    });
    await expect(
      gateway.gitRemote(ids.subOfReadTask, { operation: 'fetch', args: [], reason: '测试' }),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    // Confirm mode: no approval for a non-allowlisted command.
    await expect(
      gateway.exec(ids.subOfReadTask, { command: 'touch x', network: { mode: 'none', allowDomains: [] } }),
    ).rejects.toMatchObject({ code: 'RUN_READ_ONLY' });
    expect(approvalRequests).toEqual([]);
  });
});

describe('host-owned attachment copies (D75 review M4)', () => {
  it('a read-only run may copy into .attachments/ only', () => {
    const gateway = makeGateway();
    const target = path.join(workspace(), '.attachments', 'att_1_report.pdf');
    for (const identity of [ids.turn, ids.readTask, ids.subOfReadTask]) {
      expect(gateway.checkHostCopyPath(identity, target, '.attachments')).toMatchObject({
        kind: 'allowed',
      });
      // Anywhere else stays read-only — including escapes out of .attachments.
      expect(
        gateway.checkHostCopyPath(identity, path.join(workspace(), 'notes.txt'), '.attachments'),
      ).toMatchObject({ kind: 'forbidden', readOnlyRun: true });
      expect(
        gateway.checkHostCopyPath(
          identity,
          path.join(workspace(), '.attachments', '..', 'x.pdf'),
          '.attachments',
        ),
      ).toMatchObject({ kind: 'forbidden', readOnlyRun: true });
      expect(
        gateway.checkHostCopyPath(identity, path.join(workspace(), '.attachments'), '.attachments'),
      ).toMatchObject({ kind: 'forbidden' });
    }
    // Writable runs: the ordinary write check.
    expect(gateway.checkHostCopyPath(ids.writeTask, target, '.attachments')).toMatchObject({
      kind: 'allowed',
    });
  });

  it('a symlinked .attachments pointing outside the workspace is refused', () => {
    const gateway = makeGateway();
    symlinkSync(outside, path.join(workspace(), '.attachments'));
    const decision = gateway.checkHostCopyPath(
      ids.turn,
      path.join(workspace(), '.attachments', 'att_1_x.pdf'),
      '.attachments',
    );
    expect(decision).toMatchObject({ kind: 'forbidden', readOnlyRun: true });
  });

  it('read-only browser downloads go to a host-owned directory outside the workspace', () => {
    const gateway = makeGateway();
    const dir = gateway.readOnlyDownloadsDir(ids.turn);
    expect(dir.startsWith(resolvePaths(home).cacheDir)).toBe(true);
    expect(dir.startsWith(workspace())).toBe(false);
    // Never readable by the model: the data home is off limits.
    expect(gateway.checkPath(ids.turn, path.join(dir, 'file.bin'), 'read')).toMatchObject({
      kind: 'forbidden',
    });
  });
});

describe('once grants are owned by one tool call (D75 review M5 / LOW-6)', () => {
  const network = { mode: 'none' as const, allowDomains: [] };

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('an inline once grant is invisible to a parallel tool call of the same run', async () => {
    const sandbox = recordingSandbox();
    const gateway = makeGateway(sandbox);
    const target = path.join(outside, 'data.txt');
    const hold = deferred();
    const approvedInA = deferred();
    const callA = runInToolCall(async () => {
      await gateway.ensurePathAccess(ids.response, outside, 'write', 'A');
      approvedInA.resolve();
      await hold.promise; // a long-running call A keeps its grant…
      // …and can still use it itself.
      expect(gateway.checkPath(ids.response, target, 'write')).toMatchObject({ kind: 'allowed' });
    });
    await approvedInA.promise;
    await runInToolCall(async () => {
      // Parallel call B: neither the path check nor the bash policy sees A's grant.
      expect(gateway.checkPath(ids.response, target, 'write')).toMatchObject({ kind: 'needs_grant' });
      await gateway.exec(ids.response, { command: 'touch b', network });
    });
    expect(sandbox.requests[0]!.policy.readWrite).not.toContain(outside);
    // B did not consume A's grant either.
    expect(grants.listActive(CONV)).toHaveLength(1);
    hold.resolve();
    await callA;
    expect(grants.listActive(CONV)).toEqual([]);
    expect(approvalRequests).toHaveLength(1);
  });

  it('a request_access pre-authorization is claimed by the first call that uses it', async () => {
    const gateway = makeGateway();
    const target = path.join(outside, 'data.txt');
    await runInToolCall(() =>
      gateway.ensurePathAccess(ids.response, outside, 'read', '批量前申请', { preauthorize: true }),
    );
    const hold = deferred();
    const claimed = deferred();
    const callA = runInToolCall(async () => {
      expect(gateway.checkPath(ids.response, target, 'read')).toMatchObject({ kind: 'allowed' });
      claimed.resolve();
      await hold.promise;
    });
    await claimed.promise;
    await runInToolCall(async () => {
      expect(gateway.checkPath(ids.response, target, 'read')).toMatchObject({ kind: 'needs_grant' });
    });
    hold.resolve();
    await callA;
    expect(grants.listEffective(ids.response)).toEqual([]);
  });

  it('consumption, TTL expiry and run end publish grant.changed', async () => {
    const gateway = makeGateway();
    const target = path.join(outside, 'data.txt');
    const changed = () => events.filter((e) => e.event === 'grant.changed');

    // Consumed when its tool call returns.
    await runInToolCall(() => gateway.ensurePathAccess(ids.response, target, 'read', '读'));
    await Promise.resolve();
    expect(changed().at(-1)?.payload).toEqual({ conversationId: CONV, grants: [] });

    // TTL: an unused pre-authorization expires (lazily, on the next listing).
    await runInToolCall(() =>
      gateway.ensurePathAccess(ids.response, outside, 'read', '申请', { preauthorize: true }),
    );
    expect(changed().at(-1)?.payload.grants).toHaveLength(1);
    const before = changed().length;
    clockNow += GRANT_ABSOLUTE_TTL_MS;
    grants.listActivePaths();
    await Promise.resolve();
    expect(changed()).toHaveLength(before + 1);
    expect(changed().at(-1)?.payload.grants).toEqual([]);

    // Run end.
    await runInToolCall(() =>
      gateway.ensurePathAccess(ids.response, outside, 'read', '申请', { preauthorize: true }),
    );
    const beforeEnd = changed().length;
    expect(grants.expireForRun(ids.response.runId)).toBe(1);
    await Promise.resolve();
    expect(changed()).toHaveLength(beforeEnd + 1);
    expect(changed().at(-1)?.payload.grants).toEqual([]);
  });
});

describe('tools that write behind the gateway refuse for read-only runs (D75 review M4)', () => {
  function responseTools(gateway: ToolGateway, identity: RunIdentity) {
    const called: string[] = [];
    const note = (name: string) => () => {
      called.push(name);
      throw new Error(`${name} must not be reached`);
    };
    const browser = createFakeBrowserHost();
    const tools = buildResponseTools({
      identity,
      deps: {
        messages: {},
        attachments: {
          get: (id: string) =>
            id === 'att_pdf'
              ? { id, conversationId: CONV, mime: 'application/pdf', fileName: 'report.pdf' }
              : null,
          readBytes: () => Buffer.from('%PDF-1.7 fake'),
        },
        runs: {},
        secrets: { redact: (text: string) => text },
        renderOptions: {},
        gateway,
        workspacePath: workspace(),
        projectPath: null,
        projects: {},
        network: { mode: 'none', allowDomains: [] },
        fsState: new FileReadState(),
        onBotMessage: () => {},
        environment: { request: note('environment.request'), offeredItems: () => [] },
        skillInstall: {
          describePreset: note('describePreset'),
          installPreset: note('installPreset'),
          prepareFromUrl: note('prepareFromUrl'),
          commitImport: note('commitImport'),
          discardImport: note('discardImport'),
          requestApproval: note('requestApproval'),
          failApproval: note('failApproval'),
        },
        browser,
        media: {
          generateImage: note('generateImage'),
          understandImage: note('understandImage'),
          synthesizeSpeech: note('synthesizeSpeech'),
          transcribeSpeech: note('transcribeSpeech'),
          generateVideo: note('generateVideo'),
          videoStatus: note('videoStatus'),
        },
      } as never,
    });
    return { tools: new Map(tools.map((t) => [t.name, t])), called, browser };
  }

  it('media generation, install_skill and request_environment return RUN_READ_ONLY before any side effect', async () => {
    const gateway = makeGateway();
    for (const identity of [ids.turn, ids.readTask]) {
      const { tools, called } = responseTools(gateway, identity);
      const cases: Array<[string, unknown]> = [
        ['generate_image', { prompt: '猫' }],
        ['generate_speech', { text: '你好' }],
        ['generate_video', { prompt: '海浪' }],
        ['install_skill', { preset_id: 'pdf', reason: '读 PDF' }],
        ['request_environment', { item: 'python', reason: '跑脚本' }],
      ];
      for (const [name, params] of cases) {
        const result = await executeToolSafely(tools.get(name)!, params, ctxFor(identity));
        expect(result, name).toMatchObject({ ok: false, errorCode: 'RUN_READ_ONLY' });
        expect(result.content, name).toMatch(/只读/);
      }
      expect(called).toEqual([]);
      expect(existsSync(path.join(workspace(), '.generated'))).toBe(false);
    }
    // A run that may write reaches the facades.
    const { tools, called } = responseTools(gateway, ids.writeTask);
    await executeToolSafely(tools.get('generate_image')!, { prompt: '猫' }, ctxFor(ids.writeTask));
    expect(called).toEqual(['generateImage']);
  });

  it('get_attachment still copies a binary attachment for a read-only run (host-owned copy)', async () => {
    const gateway = makeGateway();
    for (const identity of [ids.turn, ids.readTask]) {
      const { tools } = responseTools(gateway, identity);
      const result = await executeToolSafely(
        tools.get('get_attachment')!,
        { attachment_id: 'att_pdf' },
        ctxFor(identity),
      );
      expect(result.ok).toBe(true);
      const copied = path.join(workspace(), '.attachments', 'att_pdf_report.pdf');
      expect(existsSync(copied)).toBe(true);
      // …and the run can read it back.
      const read = await executeToolSafely(
        codingTools(gateway, identity).get('read')!,
        { path: copied },
        ctxFor(identity),
      );
      expect(read.ok).toBe(true);
    }
  });

  it("browser downloads of a read-only run never target the workspace", async () => {
    const gateway = makeGateway();
    const downloadsDirOf = async (identity: RunIdentity) => {
      const { tools, browser } = responseTools(gateway, identity);
      await executeToolSafely(tools.get('browser_open')!, { url: 'https://x.example/' }, ctxFor(identity));
      const ensure = browser.calls.find((c) => c.method === 'browser.ensurePage');
      return (ensure?.input as { downloadsDir: string }).downloadsDir;
    };
    expect(await downloadsDirOf(ids.turn)).toBe(gateway.readOnlyDownloadsDir(ids.turn));
    expect(await downloadsDirOf(ids.readTask)).toBe(gateway.readOnlyDownloadsDir(ids.readTask));
    expect(await downloadsDirOf(ids.writeTask)).toBe(path.join(workspace(), 'downloads'));
  });
});
