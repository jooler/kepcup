import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import { workspacePathFor } from '../../src/infra/paths.js';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D75 审查 H1：只读任务经 delegate_task 派出的子代理（loop_type='subagent'）
 * 沿 parent_run_id 继承所属任务的只读规则——子代理的 bash 不能写 workspace；
 * 写任务的子代理在任务进行中可写。真实 core + 模拟模型，任务经 TaskHost 直接
 * 派出（本波任务工具尚未注册进对话轮工具面）。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
const isSubRequest = (marker: string) => (req: MockChatRequest) =>
  !req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_h1', botId, conversationId, loopType: 'turn' };
}

function subIdentity(sub: Run): RunIdentity {
  return { runId: sub.id, botId: sub.botId, conversationId: sub.conversationId, loopType: 'subagent' };
}

async function subRunOf(stack: TestStack, taskId: string): Promise<Run> {
  return waitFor(
    () =>
      stack.core.services
        .domain!.runs.listByConversation(stack.core.services.domain!.runs.getOrThrow(taskId).conversationId!, 50)
        .find((r) => r.loopType === 'subagent' && r.parentRunId === taskId) ?? null,
    { label: 'sub run of the task', timeoutMs: 15_000 },
  );
}

describe('delegate_task inside a task follows the task write rule (D75 review H1)', () => {
  it("a read-only task's sub run cannot write the workspace through bash", async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-RO')).replyToolCall('delegate_task', { task: 'SUB-RO 写文件' }),
      step().expect(isSubRequest('SUB-RO')).replyToolCall('bash', { command: 'echo x > ro-proof.txt' }),
      step().replyText('子代理完成'),
      step().expect(isTaskRequest('TASK-RO')).replyText('RESULT-RO'),
      step().replyText('任务结果已知悉'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('<process_record>'))
        .replyText('压缩后的结论'),
    ]);

    const started = core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '只读调研',
      instruction: 'TASK-RO 调研一下',
      sourceMessageIds: [],
      writes: false,
    });
    const sub = await subRunOf(stack, started.taskId);
    await waitFor(
      () => {
        const run = core.services.domain!.runs.get(started.taskId);
        return run !== null && run.status === 'completed' ? run : null;
      },
      { label: 'task completed', timeoutMs: 20_000 },
    );

    // The rule resolves through parent_run_id to the read-only task.
    expect(core.services.projectRuntime!.writeDenial(subIdentity(sub))).toContain('只读任务');
    // The sub run's bash wrote nothing (RUN_READ_ONLY without a sandbox, or a
    // read-only mount with one).
    const workspace = workspacePathFor(core.services.paths, bot.id, conv.id);
    expect(existsSync(path.join(workspace, 'ro-proof.txt'))).toBe(false);
    const bashResult = core.services
      .domain!.runs.stepsFor(sub.id)
      .find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'bash');
    expect(bashResult).toBeDefined();
  }, 40_000);

  it("a write task's sub run may write while the task runs, and not after it ended", async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);

    const held = step().expect(isSubRequest('SUB-RW')).hold().replyText('子代理完成');
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-RW')).replyToolCall('delegate_task', { task: 'SUB-RW 改文件' }),
      held,
      step().expect(isTaskRequest('TASK-RW')).replyText('RESULT-RW'),
      step().replyText('任务结果已知悉'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('<process_record>'))
        .replyText('压缩后的结论'),
    ]);

    const started = core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '写任务',
      instruction: 'TASK-RW 改一下',
      sourceMessageIds: [],
      writes: true,
    });
    const sub = await subRunOf(stack, started.taskId);
    await waitFor(() => (llm.requestsFor('mock-main').some(isSubRequest('SUB-RW')) ? true : null), {
      label: 'sub run request held',
    });
    expect(core.services.projectRuntime!.writeDenial(subIdentity(sub))).toBeNull();
    held.release();
    await waitFor(
      () => {
        const run = core.services.domain!.runs.get(started.taskId);
        return run !== null && run.status === 'completed' ? run : null;
      },
      { label: 'task completed', timeoutMs: 20_000 },
    );
    expect(core.services.projectRuntime!.writeDenial(subIdentity(sub))).toContain('写任务已经结束');
  }, 40_000);
});

// --- W5: read-only MCP tools on the read-only subagent surface ----------------

const NOTES_SERVER_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'notes', version: '1.0.0' } } });
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
      content: [{ type: 'text', text: 'SUB-NOTES:' + String(msg.params?.name ?? '') }], isError: false } });
  }
});
`;

describe('read-only MCP tools on the subagent surface (W5)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a sub run of a task can call a read-only MCP tool; write tools are not on its surface', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mcp-sub-'));
    dirs.push(dir);
    const scriptPath = path.join(dir, 'server.cjs');
    await writeFile(scriptPath, NOTES_SERVER_SCRIPT);
    const stack = await createTestStack();
    stacks.push(stack);
    const { core, llm } = stack;
    await core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'srv1',
          name: '笔记服务器',
          transport: 'stdio',
          command: process.execPath,
          args: [scriptPath],
          env: {},
          enabled: true,
          autoApprove: false,
        },
      ],
    });
    const bot = await makeBot(core, '小艾');
    await core.rpc.call('bots.update', {
      id: bot.id,
      profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] } },
    });
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-MCP')).replyToolCall('delegate_task', { task: 'SUB-MCP 查笔记' }),
      step().expect(isSubRequest('SUB-MCP')).replyToolCall('mcp_srv1_list_notes', {}),
      step().replyText('子代理查到了'),
      step().expect(isTaskRequest('TASK-MCP')).replyText('RESULT-MCP'),
      step().replyText('任务结果已知悉'),
    ]);
    llm.script('mock-light', [
      step()
        .expect((req) => req.lastUserText().includes('<process_record>'))
        .replyText('压缩后的结论'),
    ]);

    const started = core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '只读调研',
      instruction: 'TASK-MCP 查一下笔记',
      sourceMessageIds: [],
      writes: false,
    });
    const sub = await subRunOf(stack, started.taskId);
    await waitFor(
      () => {
        const run = core.services.domain!.runs.get(started.taskId);
        return run !== null && run.status === 'completed' ? run : null;
      },
      { label: 'task completed', timeoutMs: 20_000 },
    );

    const subRequest = llm.requestsFor('mock-main').find(isSubRequest('SUB-MCP'))!;
    const subTools = JSON.stringify(subRequest.body.tools ?? []);
    expect(subTools).toContain('mcp_srv1_list_notes');
    expect(subTools).not.toContain('mcp_srv1_create_note');
    // The task itself has both.
    const taskTools = JSON.stringify(
      llm.requestsFor('mock-main').find(isTaskRequest('TASK-MCP'))!.body.tools ?? [],
    );
    expect(taskTools).toContain('mcp_srv1_create_note');

    const result = core.services
      .domain!.runs.stepsFor(sub.id)
      .find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'mcp_srv1_list_notes');
    expect(result?.payload['ok']).toBe(true);
    expect(String(result?.payload['content'])).toContain('SUB-NOTES:list_notes');
    expect(String(result?.payload['content']).startsWith('<untrusted>')).toBe(true);

  }, 40_000);
});
