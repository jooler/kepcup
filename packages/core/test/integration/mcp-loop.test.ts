import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  step,
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

    llm.script('mock-main', [
      step().replyToolCall('mcp_srv1_echo', { text: '审批测试' }),
      step().replyText('工具结果已收到'),
    ]);
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

    const run = await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
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

    llm.script('mock-main', [
      step().replyToolCall('mcp_srv1_echo', { text: '再试' }),
      step().replyText('好的，我不调用它了'),
    ]);
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

    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });
    const steps = (await core.rpc.call('runs.steps', {
      runId: ((await listRuns(core, conv.id)) as Run[]).find((r) => r.loopType === 'turn')!.id,
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

    llm.script('mock-main', [
      step().replyToolCall('mcp_srv1_echo', { text: '免审批' }),
      step().replyText('完成'),
    ]);
    await sendBatch(core, conv.id, ['直接调用']);
    await waitForRun(core, conv.id, 'completed', { timeoutMs: 30_000 });

    const list = (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
      approvals: Array<{ kind: string }>;
    };
    expect(list.approvals.filter((a) => a.kind === 'mcp_tool')).toHaveLength(0);
    void llm;
  }, 60_000);
});
