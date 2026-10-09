import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type TaskEventContent, type ToolEffect } from '@kepcup/shared';
import {
  createFakeBrowserHost,
  createTestCore,
  createTestStack,
  makeBot,
  openDirect,
  sendBatch,
  startMockLlm,
  step,
  viaTask,
  waitFor,
  waitForRun,
  type CoreHarness,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';

/**
 * W2 外部副作用台账（集成，todo/borrowings-from-personal-agents.md W2 验收）：
 * 真实任务经 PiEngine 调用浏览器（假宿主）与 MCP（真实 stdio server）工具——
 * 外部动作各一行、只读工具不产生行、审批关联、uncertain / denied；进程「崩溃」
 * 后重启 → executing 行变 uncertain、中断任务的失败摘要标「结果未知」；
 * `effects.list` 沿续接链收集。
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
      { name: 'post_note', description: '写一条备注',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'get_notes', description: '读备注', annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} } },
    ] } });
    return;
  }
  if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'ok:' + String(msg.params?.name) }], isError: false } });
  }
});
`;

async function mcpServerConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tool-effects-mcp-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, SERVER_SCRIPT);
  return {
    id: 'srv1',
    name: '备注服务',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [scriptPath],
    env: {},
    enabled: true,
    autoApprove: false,
  };
}

async function startStack() {
  const browser = createFakeBrowserHost();
  browser.setSnapshot({
    title: '下单页',
    url: 'https://shop.example/',
    elements: [
      { ref: 'e1', role: 'button', name: '提交订单' },
      { ref: 'e2', role: 'textbox', name: '备注' },
    ],
    elementsTruncated: false,
    text: '下单页正文',
    textTruncated: false,
  });
  const stack = await createTestStack({ browserRpc: browser });
  cleanups.push(async () => {
    stack.llm.releaseAll();
    await stack.cleanup();
  });
  const { core } = stack;
  await core.rpc.call('settings.update', { mcpServers: [await mcpServerConfig()] });
  const bot = await makeBot(core, '小账');
  await core.rpc.call('bots.update', {
    id: bot.id,
    profile: { ...bot.profile, runtime: { ...bot.profile.runtime, mcp_server_ids: ['srv1'] } },
  });
  const conv = await openDirect(core, bot.id);
  return { ...stack, browser, bot, conv };
}

async function decidePendingMcp(core: CoreHarness, conversationId: string, approve: boolean) {
  const approval = await waitFor(
    async () => {
      const list = (await core.rpc.call('approvals.list', { conversationId })) as {
        approvals: Array<{ id: string; kind: string; status: string }>;
      };
      return list.approvals.find((a) => a.kind === 'mcp_tool' && a.status === 'pending') ?? null;
    },
    { label: 'mcp_tool approval', timeoutMs: 20_000 },
  );
  await core.rpc.call('approvals.decide', { id: approval.id, approve });
  return approval.id;
}

async function effectsOf(core: CoreHarness, taskId: string): Promise<ToolEffect[]> {
  return ((await core.rpc.call('effects.list', { taskId })) as { effects: ToolEffect[] }).effects;
}

describe('W2 tool effect ledger (integration)', () => {
  it('a task clicking twice, typing and calling an MCP write tool → 4 rows; read-only calls → none', async () => {
    const { core, llm, conv, browser } = await startStack();
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('browser_open', { url: 'https://shop.example/' }),
          step().replyToolCall('browser_snapshot', {}),
          step().replyToolCall('browser_click', { ref: 'e1' }),
          step().replyToolCall('browser_click', { ref: 'e1' }),
          step().replyToolCall('browser_type', { ref: 'e2', text: 'hello-private-note' }),
          step().replyToolCall('mcp_srv1_get_notes', {}),
          step().replyToolCall('mcp_srv1_post_note', { text: '已下单' }),
          step().replyText('都做完了'),
        ],
        relay: '好了',
      }),
    );
    await sendBatch(core, conv.id, ['去下单']);
    const approvalId = await decidePendingMcp(core, conv.id, true);
    const task = await waitForRun(core, conv.id, 'completed', {
      timeoutMs: 30_000,
      loopType: 'task',
    });
    expect(browser.calls.filter((c) => c.method === 'browser.click')).toHaveLength(2);

    const effects = await effectsOf(core, task.id);
    expect(effects.map((e) => [e.toolName, e.status])).toEqual([
      ['browser_click', 'completed'],
      ['browser_click', 'completed'],
      ['browser_type', 'completed'],
      ['mcp_srv1_post_note', 'completed'],
    ]);
    expect(effects.every((e) => e.runId === task.id && e.settledAt !== null)).toBe(true);
    // Same args twice: same key prefix, occurrence 1 then 2.
    expect(effects[0]!.effectKey.endsWith(':1')).toBe(true);
    expect(effects[1]!.effectKey).toBe(`${effects[0]!.effectKey.slice(0, -2)}:2`);
    expect(effects[3]!.approvalId).toBe(approvalId);
    expect(effects[0]!.approvalId).toBeNull();
    // Typed text never reaches the ledger.
    expect(JSON.stringify(effects)).not.toContain('hello-private-note');
    // The tool-call ids are the engine's (joinable with run_steps).
    const steps = (await core.rpc.call('runs.steps', { runId: task.id })) as {
      steps: Array<{ type: string; payload: { toolCallId?: string; toolName?: string } }>;
    };
    const clickCallIds = steps.steps
      .filter((s) => s.type === 'tool_call' && s.payload.toolName === 'browser_click')
      .map((s) => s.payload.toolCallId);
    // (The mock model reuses one id for every call — like some providers do —
    // so the second row gets the `#2` suffix instead of failing the insert.)
    expect(effects.slice(0, 2).map((e) => e.toolCallId.replace(/#\d+$/, ''))).toEqual(clickCallIds);
  }, 60_000);

  it('an uncertain click and a denied MCP call settle as uncertain / denied', async () => {
    const { core, llm, conv, browser } = await startStack();
    browser.failWith(
      'browser.click',
      new AppError('INTERNAL', 'debugger detached', { phase: 'post' }),
    );
    llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('browser_open', { url: 'https://shop.example/' }),
          step().replyToolCall('browser_click', { ref: 'e1' }),
          step().replyToolCall('mcp_srv1_post_note', { text: '再来' }),
          step().replyText('停下了'),
        ],
        relay: '有问题',
      }),
    );
    await sendBatch(core, conv.id, ['下单']);
    const approvalId = await decidePendingMcp(core, conv.id, false);
    const task = await waitForRun(core, conv.id, 'completed', {
      timeoutMs: 30_000,
      loopType: 'task',
    });
    const effects = await effectsOf(core, task.id);
    expect(effects.map((e) => [e.toolName, e.status])).toEqual([
      ['browser_click', 'uncertain'],
      ['mcp_srv1_post_note', 'denied'],
    ]);
    expect(effects[1]!.approvalId).toBe(approvalId);
  }, 60_000);

  it('after a crash: executing rows become uncertain, the failure digest flags them, effects.list follows the chain', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-effects-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const keystore = createMemoryKeystore();
    const boot = async () => {
      const llm = await startMockLlm();
      const core = await createTestCore({ home, keystore, env: { KEPCUP_MOCK_LLM_URL: llm.url } });
      return {
        core,
        async close() {
          llm.releaseAll();
          await core.close();
          await llm.stop();
        },
      };
    };

    const first = await boot();
    let taskA: string;
    let taskB: string;
    let botId: string;
    let conversationId: string;
    try {
      const bot = await makeBot(first.core, '小崩');
      const conv = await openDirect(first.core, bot.id);
      botId = bot.id;
      conversationId = conv.id;
      const { runs, messages, effects } = first.core.services.domain!;
      const seed = (title: string, status: 'running' | 'failed', continues?: string) => {
        const task = runs.create({
          botId,
          conversationId,
          loopType: 'task',
          triggerReason: null,
          triggerMessageIds: [],
          taskTitle: title,
          taskWrites: true,
          originRunId: 'run_turn_old',
          ...(continues !== undefined ? { continuedFromRunIds: [continues] } : {}),
        });
        messages.appendTaskEvent({
          conversationId,
          ownerBotId: botId,
          taskId: task.id,
          phase: 'brief',
          text: title,
          title,
          writes: true,
        });
        return runs.update(task.id, { status });
      };
      // A failed earlier attempt (settled rows) continued by B, which crashes mid-click.
      taskA = seed('TASK-A', 'failed').id;
      const a1 = effects.open({
        runId: taskA,
        toolCallId: 'call_a1',
        toolName: 'browser_click',
        argsHash: 'h_a1',
        summary: 'browser_click {"ref":"e1"}',
      });
      effects.settle(a1.id, { status: 'completed' });
      taskB = seed('TASK-B', 'running', taskA).id;
      runs.appendStep({
        runId: taskB,
        type: 'tool_call',
        payload: { toolCallId: 'call_b1', toolName: 'browser_click', args: { ref: 'e7' } },
      });
      effects.open({
        runId: taskB,
        toolCallId: 'call_b1',
        toolName: 'browser_click',
        argsHash: 'h_b1',
        summary: 'browser_click {"ref":"e7"}',
      });
      expect(effects.listForRun(taskB).map((e) => e.status)).toEqual(['executing']);
    } finally {
      // "Crash": the executing row is never settled by this process.
      await first.close();
    }

    const second = await boot();
    try {
      const { runs, messages } = second.core.services.domain!;
      expect(runs.getOrThrow(taskB).status).toBe('interrupted');
      const effects = await effectsOf(second.core, taskB);
      expect(effects.map((e) => [e.runId, e.toolCallId, e.status])).toEqual([
        [taskA, 'call_a1', 'completed'],
        [taskB, 'call_b1', 'uncertain'],
      ]);
      expect(await effectsOf(second.core, taskA)).toHaveLength(1);
      expect(await effectsOf(second.core, 'run_unknown')).toEqual([]);
      // The interrupted task's failure entry carries the 「结果未知」 line.
      const failure = messages
        .taskEvents(taskB)
        .map((m) => m.content as TaskEventContent)
        .find((c) => c.phase === 'failure');
      expect(failure?.text).toContain('[结果未知] browser_click({"ref":"e7"})');
    } finally {
      await second.close();
    }
  }, 60_000);
});
