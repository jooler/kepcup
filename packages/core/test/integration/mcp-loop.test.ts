import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  isTaskRequest,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type TestStack,
} from '@kepcup/testkit';

/**
 * MCP（D65）响应 loop 集成（真实 stdio server + mock 模型）：
 * 工具进 loop → 阻塞审批卡 → 批准后返回 <untrusted> 结果；拒绝返回
 * APPROVAL_DENIED 且模型能继续；Bot 未勾选时工具不出现。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

const SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' } } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: '回显输入',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'echo:' + String(msg.params?.arguments?.text ?? '') }],
      isError: false } });
  }
});
`;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeServerConfig(overrides?: { autoApprove?: boolean; enabled?: boolean }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-loop-'));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, SERVER_SCRIPT);
  return {
    id: 'srv1',
    name: '测试服务器',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [scriptPath],
    env: {},
    enabled: overrides?.enabled ?? true,
    autoApprove: overrides?.autoApprove ?? false,
  };
}

describe('mcp response loop', () => {
  it('registers the tool for a selected bot, blocks on approval, and returns the untrusted result', async () => {
    const server = await makeServerConfig();
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    await core.rpc.call('settings.update', { mcpServers: [server] });
    const bot = await makeBot(core, '小马');
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] },
      },
    });
    const conv = await openDirect(core, bot.id);

    // D75 W2: MCP tools are a task's (a turn has none) — the turn starts a
    // task that calls the tool.
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_srv1_echo', { text: '审批测试' }),
          step().replyText('工具结果已收到'),
        ],
        relay: '收到了',
      }),
    );
    await sendBatch(core, conv.id, ['调用那个工具']);

    // 阻塞审批卡出现（mcp_tool）。
    const approval = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Array<{ id: string; kind: string; status: string }>;
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool approval', timeoutMs: 20_000 },
    );
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });

    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000, loopType: 'task' });
    // The turn was not offered the MCP tool; the (read-only) task was.
    const [turnRequest] = llm.requestsFor('mock-main').filter((r) => !isTaskRequest(r));
    expect(JSON.stringify(turnRequest!.body.tools ?? [])).not.toContain('mcp_srv1_echo');
    const taskRequest = llm.requestsFor('mock-main').find(isTaskRequest);
    expect(JSON.stringify(taskRequest!.body.tools ?? [])).toContain('mcp_srv1_echo');
    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const toolResult = steps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_echo',
    );
    expect(toolResult).toBeDefined();
    const content = String(toolResult!.payload['content']);
    expect(content).toContain('echo:审批测试');
    expect(content.startsWith('<untrusted>')).toBe(true);
    void llm;
  }, 60_000);

  it('returns APPROVAL_DENIED on rejection and the loop continues', async () => {
    const server = await makeServerConfig();
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    await core.rpc.call('settings.update', { mcpServers: [server] });
    const bot = await makeBot(core, '小拒');
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] },
      },
    });
    const conv = await openDirect(core, bot.id);

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_srv1_echo', { text: '再试' }),
          step().replyText('好的，我不调用它了'),
        ],
        relay: '没调用成',
      }),
    );
    await sendBatch(core, conv.id, ['再调用一次']);

    const approval = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Array<{ id: string; kind: string; status: string }>;
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool approval', timeoutMs: 20_000 },
    );
    await core.rpc.call('approvals.decide', { id: approval.id, approve: false });

    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000, loopType: 'task' });
    const steps = (await core.rpc.call('runs.steps', {
      runId: ((await listRuns(core, conv.id)) as Run[]).find((r) => r.loopType === 'task')!.id,
    })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const toolResult = steps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_echo',
    );
    expect(toolResult!.payload['ok']).toBe(false);
    expect(String(toolResult!.payload['errorCode'])).toBe('APPROVAL_DENIED');
  }, 60_000);

  it('does not register the tool when the bot does not select the server', async () => {
    const server = await makeServerConfig();
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    await core.rpc.call('settings.update', { mcpServers: [server] });
    const bot = await makeBot(core, '小无');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [step().replyText('没有工具可用')]);
    await sendBatch(core, conv.id, ['你有哪些工具？']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });

    const requests = llm.requestsFor('mock-main');
    const tools = JSON.stringify(requests[0]!.body.tools ?? []);
    expect(tools).not.toContain('mcp_srv1_echo');
    void llm;
  }, 60_000);

  it('autoApprove server skips the approval card', async () => {
    const server = await makeServerConfig({ autoApprove: true });
    const { core, llm, cleanup } = await createTestStack();
    stacks.push({ cleanup });
    await core.rpc.call('settings.update', { mcpServers: [server] });
    const bot = await makeBot(core, '小免');
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] },
      },
    });
    const conv = await openDirect(core, bot.id);

    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [
          step().replyToolCall('mcp_srv1_echo', { text: '免审批' }),
          step().replyText('完成'),
        ],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['直接调用']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000, loopType: 'task' });
    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(
      steps.steps.find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_echo')
        ?.payload['ok'],
    ).toBe(true);

    const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string }>;
    };
    expect(list.approvals.filter((a) => a.kind === 'mcp_tool')).toHaveLength(0);
    void llm;
  }, 60_000);
});

// --- W5: read-only MCP tools on the supervisor turn ----------------------------

const ANNOTATED_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'annotated', version: '1.0.0' } } });
    return;
  }
  if (String(msg.method).startsWith('notifications/')) return;
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return; }
  if (msg.method === 'tools/list') {
    const empty = { type: 'object', properties: {} };
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'list_notes', description: '列出笔记', inputSchema: empty, annotations: { readOnlyHint: true } },
      { name: 'create_note', description: '新建笔记', inputSchema: empty, annotations: { destructiveHint: false } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'NOTES:' + String(msg.params?.name ?? '') }], isError: false } });
  }
});
`;

async function makeAnnotatedConfig(toolPolicies?: Record<string, { approval?: 'auto' | 'ask'; enabled?: boolean }>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-loop-ann-'));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, ANNOTATED_SERVER_SCRIPT);
  return {
    id: 'srv1',
    name: '笔记服务器',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [scriptPath],
    env: {},
    enabled: true,
    autoApprove: false,
    ...(toolPolicies !== undefined ? { toolPolicies } : {}),
  };
}

async function annotatedStack(toolPolicies?: Record<string, { approval?: 'auto' | 'ask'; enabled?: boolean }>) {
  const server = await makeAnnotatedConfig(toolPolicies);
  const stack = await createTestStack();
  stacks.push({ cleanup: stack.cleanup });
  await stack.core.rpc.call('settings.update', { mcpServers: [server] });
  // Pre-warm the stdio connection so the turn-side resolution (bounded by
  // TURN_MCP_RESOLVE_TIMEOUT_MS) never depends on a slow CI spawn.
  const mcp = stack.core.services.mcp!;
  await mcp.listTools(mcp.listServers()[0]!);
  const bot = await makeBot(stack.core, '小笔');
  await stack.core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] } },
  });
  const conv = await openDirect(stack.core, bot.id);
  return { ...stack, server, bot, conv };
}

function systemText(req: { body: { messages?: Array<{ role: string; content?: unknown }> } }): string {
  return JSON.stringify((req.body.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer'));
}

describe('read-only MCP tools on the turn (W5)', () => {
  it('a turn calls a read-only MCP tool directly — no task, no approval, untrusted result', async () => {
    const { core, llm, conv } = await annotatedStack();
    llm.script('mock-main', [
      step().replyToolCall('mcp_srv1_list_notes', {}),
      step().replyText('你有这些笔记'),
    ]);
    await sendBatch(core, conv.id, ['我有哪些笔记？']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    expect(run.loopType).toBe('turn');

    const [turnRequest] = llm.requestsFor('mock-main');
    const tools = JSON.stringify(turnRequest!.body.tools ?? []);
    expect(tools).toContain('mcp_srv1_list_notes');
    // The write tool stays a task's; the prompt says so.
    expect(tools).not.toContain('mcp_srv1_create_note');
    expect(systemText(turnRequest!)).toContain('<mcp_tools>');
    expect(systemText(turnRequest!)).toContain('start_task');

    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const result = steps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_list_notes',
    );
    expect(result?.payload['ok']).toBe(true);
    expect(String(result!.payload['content']).startsWith('<untrusted>')).toBe(true);
    expect(String(result!.payload['content'])).toContain('NOTES:list_notes');
    expect((await listRuns(core, conv.id)).some((r: Run) => r.loopType === 'task')).toBe(false);
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string }>;
    };
    expect(approvals.approvals).toHaveLength(0);
    const audit = core.services.domain!.audit.listByConversation(conv.id, 50);
    const call = audit.find((a) => a.action === 'mcp_tool_call');
    expect(call?.detail).toMatchObject({ toolName: 'list_notes', risk: 'read', approval: 'auto' });
  }, 60_000);

  it('a read tool switched to ask is not on the turn surface', async () => {
    const { core, llm, conv } = await annotatedStack({ list_notes: { approval: 'ask' } });
    llm.script('mock-main', [step().replyText('我去派个任务查')]);
    await sendBatch(core, conv.id, ['我有哪些笔记？']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const [turnRequest] = llm.requestsFor('mock-main');
    expect(JSON.stringify(turnRequest!.body.tools ?? [])).not.toContain('mcp_srv1_');
    expect(systemText(turnRequest!)).toContain('另有 2 个 MCP 工具只在任务中可用');
  }, 60_000);

  it('the turn re-checks at call time: a tool switched to ask mid-turn returns RUN_READ_ONLY', async () => {
    const { core, llm, conv, server } = await annotatedStack();
    const held = step().hold().replyToolCall('mcp_srv1_list_notes', {});
    llm.script('mock-main', [held, step().replyText('那我派任务')]);
    await sendBatch(core, conv.id, ['我有哪些笔记？']);
    await waitFor(() => (llm.requestsFor('mock-main').length > 0 ? true : null), {
      label: 'turn request held',
      timeoutMs: 20_000,
    });
    // The surface was built with list_notes; the user switches it to ask now.
    await core.rpc.call('settings.update', {
      mcpServers: [{ ...server, toolPolicies: { list_notes: { approval: 'ask' } } }],
    });
    held.release();
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const result = steps.steps.find(
      (s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_list_notes',
    );
    expect(result?.payload['ok']).toBe(false);
    expect(result?.payload['errorCode']).toBe('RUN_READ_ONLY');
    expect(String(result?.payload['content'])).toContain('该工具需要在任务中执行，请用 start_task');
    const approvals = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string }>;
    };
    expect(approvals.approvals).toHaveLength(0);
  }, 60_000);

  it('unattended: a write MCP tool runs through the real gateway + approvals, auto-approved with risk + audit note', async () => {
    const { core, llm, conv } = await annotatedStack();
    await core.rpc.call('unattended.enable', { hours: null, acknowledgeRisk: true });
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('mcp_srv1_create_note', {}), step().replyText('建好了')],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['新建一条笔记']);
    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000, loopType: 'task' });
    const steps = (await core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    expect(
      steps.steps.find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_create_note')
        ?.payload['ok'],
    ).toBe(true);
    const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string; status: string; autoApproved: boolean; payload: Record<string, unknown> }>;
    };
    const mcpApprovals = list.approvals.filter((a) => a.kind === 'mcp_tool');
    expect(mcpApprovals).toHaveLength(1);
    expect(mcpApprovals[0]).toMatchObject({ status: 'approved', autoApproved: true });
    expect(mcpApprovals[0]!.payload['risk']).toBe('write');
    const audit = core.services.domain!.audit.listByConversation(conv.id, 100);
    expect(audit.find((a) => a.action === 'mcp_tool_call')?.detail).toMatchObject({
      toolName: 'create_note',
      risk: 'write',
      approval: 'unattended',
      unattendedAutoApproved: true,
      note: '无人值守自动批准（写入）',
    });
    expect(
      audit.find((a) => a.action === 'approval_auto' && a.detail['kind'] === 'mcp_tool')?.detail['risk'],
    ).toBe('write');
  }, 60_000);

  it('a task still gets the write tool, behind a card carrying the risk', async () => {
    const { core, llm, conv } = await annotatedStack();
    llm.script(
      'mock-main',
      viaTask({
        writes: false,
        taskSteps: [step().replyToolCall('mcp_srv1_create_note', {}), step().replyText('建好了')],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['新建一条笔记']);
    const approval = await waitFor(
      async () => {
        const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Array<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>;
        };
        return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
      },
      { label: 'mcp_tool approval', timeoutMs: 20_000 },
    );
    expect(approval.payload['risk']).toBe('write');
    await core.rpc.call('approvals.decide', { id: approval.id, approve: true });
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000, loopType: 'task' });
  }, 60_000);
});
