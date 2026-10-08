import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_MAX_WALL_MS, type Message, type Run, type TaskEventContent } from '@kepcup/shared';
import {
  createTestCore,
  createTestStack,
  makeBot,
  startMockLlm,
  openDirect,
  step,
  waitFor,
  type CoreHarness,
  type MockChatRequest,
  type MockLlmServer,
  type TestStack,
} from '@kepcup/testkit';
import { createMemoryKeystore } from '@kepcup/core';
import { buildTaskTools } from '../../src/tools/task-tools.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../../src/agent/types.js';

/**
 * D75 W1-A 任务层（docs/design/30-supervisor-and-tasks.md §3、§4.1、§2.4.5）：
 * 派出 → 执行 → 私有结果条目 → 唤醒；配额排队；取消；崩溃修复与对账；
 * reaper；深度 1；删除对话 / Bot 中止任务。本波任务工具尚未注册进工具面，
 * 用例经 TaskHost 与 buildTaskTools 直接驱动（模拟一个对话轮的身份）。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(options: Parameters<typeof createTestStack>[0] = {}): Promise<TestStack> {
  const stack = await createTestStack(options);
  stacks.push(stack);
  return stack;
}

function domain(stack: { core: CoreHarness }) {
  return stack.core.services.domain!;
}

function tasksOf(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

/** A user message written straight to the table (no response run triggered). */
function userMessage(stack: TestStack, conversationId: string, text: string): Message {
  return domain(stack).messages.append({
    conversationId,
    senderType: 'user',
    kind: 'text',
    text,
  });
}

function turnIdentity(botId: string, conversationId: string, runId = 'run_turn_1'): RunIdentity {
  return { runId, botId, conversationId, loopType: 'response' };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

async function call(t: ToolDefinition, params: unknown): Promise<ToolResult> {
  return t.execute(params, {
    identity: { runId: 'x', botId: null, conversationId: null, loopType: 'response' },
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  });
}

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function entries(stack: TestStack, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((m) => m.content as TaskEventContent);
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);
const isWakeRequest = (req: MockChatRequest) =>
  req.lastUserText().includes('<trigger reason="task"');

function waitRun(stack: TestStack, id: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 15_000 },
  );
}

function wakeRuns(stack: { core: CoreHarness }, conversationId: string): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 50)
    .filter((r) => r.loopType === 'response' && r.triggerReason === 'task');
}

describe('D75 task layer (TaskHost)', () => {
  it('start → execute → private result entry, no visible final message, interim origin:task, wake + consume', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const source = userMessage(stack, conv.id, '帮我把 parser 的测试补全 SRC-ALPHA');

    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('TASK-ALPHA'))
        .replyTextAndToolCall('INTERIM-ALPHA 先看一下现有的执行记录', 'list_my_runs', {}),
      step().expect(isTaskRequest('TASK-ALPHA')).replyText('RESULT-ALPHA 新增 14 个用例'),
      step().expect(isWakeRequest).replyText('补测试做完了：新增 14 个用例'),
    ]);

    const tools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id),
      tasks: tasksOf(stack),
    });
    const started = await call(tool(tools, 'start_task'), {
      title: '补全测试',
      instruction: 'TASK-ALPHA 为 parser 补单测',
      source_message_ids: [source.id],
      writes: false,
    });
    expect(started.ok).toBe(true);
    const taskId = /"task_id":"(run_[^"]+)"/.exec(started.content)?.[1];
    expect(taskId).toBeDefined();

    const task = await waitRun(stack, taskId!, ['completed'], 'task completed');
    expect(task.loopType).toBe('task');
    expect(task.taskTitle).toBe('补全测试');
    expect(task.taskWrites).toBe(false);
    expect(task.originRunId).toBe('run_turn_1');
    expect(task.triggerMessageIds).toEqual([source.id]);

    // The brief carried the instruction and the user's original message.
    const firstTaskRequest = llm.requestsFor('mock-main').find(isTaskRequest('TASK-ALPHA'));
    expect(firstTaskRequest?.lastUserText()).toContain('SRC-ALPHA');

    // brief → result entries, private to the bot.
    const events = entries(stack, taskId!);
    expect(events.map((e) => e.phase)).toEqual(['brief', 'result']);
    expect(events[1]).toMatchObject({ text: 'RESULT-ALPHA 新增 14 个用例', status: 'completed' });
    const resultEntry = domain(stack).messages.terminalTaskEvent(taskId!)!;
    expect(resultEntry.ownerBotId).toBe(bot.id);

    // No visible final message; the interim note is visible with origin 'task'.
    const visible = domain(stack).messages.listVisible(conv.id, { limit: 100 });
    expect(
      visible.some((m) => 'text' in m.content && m.content.text.includes('RESULT-ALPHA')),
    ).toBe(false);
    const interim = visible.find(
      (m) => 'text' in m.content && m.content.text.includes('INTERIM-ALPHA'),
    );
    expect(interim?.content).toMatchObject({ origin: 'task', taskId });
    expect(interim?.senderBotId).toBe(bot.id);

    // The wake hook delivered the entry as a reason:'task' trigger batch …
    const wake = await waitFor(
      () => wakeRuns(stack, conv.id).find((r) => r.status === 'completed') ?? null,
      { label: 'wake run completed', timeoutMs: 15_000 },
    );
    expect(wake.triggerMessageIds).toEqual([resultEntry.id]);
    // … and its terminal state consumed the result.
    await waitFor(() => (runOf(stack, taskId!).resultConsumedAt !== null ? true : null), {
      label: 'result consumed',
    });
  }, 30_000);

  it('quota overflow returns submitted with a reason and starts automatically when a slot frees; per-turn cap rejects', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const host = tasksOf(stack);

    const held = step().expect(isTaskRequest('TASK-Q1')).hold().replyToolCall('skip_reply', {
      reason: 'done',
    });
    llm.script('mock-main', [
      held,
      step().expect(isTaskRequest('TASK-Q2')).hold().replyToolCall('skip_reply', { reason: 'x' }),
      step().expect(isTaskRequest('TASK-Q3')).hold().replyToolCall('skip_reply', { reason: 'x' }),
      step().expect(isTaskRequest('TASK-Q4')).replyToolCall('skip_reply', { reason: 'x' }),
    ]);
    const turn1 = turnIdentity(bot.id, conv.id, 'run_turn_q1');
    const turn2 = turnIdentity(bot.id, conv.id, 'run_turn_q2');
    const base = { sourceMessageIds: [], writes: false };
    const t1 = host.start(turn1, { ...base, title: 'q1', instruction: 'TASK-Q1' });
    const t2 = host.start(turn1, { ...base, title: 'q2', instruction: 'TASK-Q2' });
    expect(t1.state).toBe('running');
    expect(t2.state).toBe('running');
    // TASK_START_MAX_PER_TURN = 2
    expect(() => host.start(turn1, { ...base, title: 'q9', instruction: 'TASK-Q9' })).toThrow(
      /本轮最多派出 2 个任务/,
    );
    const t3 = host.start(turn2, { ...base, title: 'q3', instruction: 'TASK-Q3' });
    expect(t3.state).toBe('running');
    // TASK_CONCURRENCY_PER_CONVERSATION = 3 → the 4th waits.
    const t4 = host.start(turn2, { ...base, title: 'q4', instruction: 'TASK-Q4' });
    expect(t4.state).toBe('submitted');
    expect(t4.queueReason).toContain('本对话 3/3');
    expect(runOf(stack, t4.taskId).status).toBe('queued');
    const listed = host.list(turn2).find((s) => s.taskId === t4.taskId);
    expect(listed).toMatchObject({ state: 'submitted', injectable: true });
    expect(listed?.queueReason).toContain('本对话');

    // Free one slot: q1 finishes (skip_reply → empty result, no wake) → q4 starts.
    await waitFor(() => (llm.requestsFor('mock-main').length >= 3 ? true : null), {
      label: 'three task requests held',
    });
    held.release();
    const q1 = await waitRun(stack, t1.taskId, ['completed'], 'q1 completed');
    expect(q1.resultConsumedAt).not.toBeNull(); // empty result: consumed, never woken
    await waitRun(stack, t4.taskId, ['completed'], 'q4 auto-started and completed');
    expect(entries(stack, t1.taskId).at(-1)).toMatchObject({ phase: 'result', text: '' });
    llm.releaseAll();
    await waitRun(stack, t2.taskId, ['completed'], 'q2 completed');
    await waitRun(stack, t3.taskId, ['completed'], 'q3 completed');
    expect(wakeRuns(stack, conv.id)).toHaveLength(0);
  }, 30_000);

  it('two write tasks on the same workdir: the second stays submitted until the first settles', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const host = tasksOf(stack);
    const held = step().expect(isTaskRequest('TASK-W1')).hold().replyToolCall('skip_reply', {
      reason: 'x',
    });
    llm.script('mock-main', [
      held,
      step().expect(isTaskRequest('TASK-W2')).replyToolCall('skip_reply', { reason: 'x' }),
    ]);
    const turn = turnIdentity(bot.id, conv.id);
    const w1 = host.start(turn, {
      title: 'w1',
      instruction: 'TASK-W1',
      sourceMessageIds: [],
      writes: true,
    });
    const w2 = host.start(turn, {
      title: 'w2',
      instruction: 'TASK-W2',
      sourceMessageIds: [],
      writes: true,
    });
    expect(w1.state).toBe('running');
    expect(w2.state).toBe('submitted');
    expect(w2.queueReason).toContain(`等写入租约（任务 ${w1.taskId} 持有）`);
    expect(runOf(stack, w1.taskId).taskWorkdir).toBe(runOf(stack, w2.taskId).taskWorkdir);
    await waitRun(stack, w1.taskId, ['running'], 'w1 running');
    held.release();
    await waitRun(stack, w2.taskId, ['completed'], 'w2 completed after w1');
  }, 30_000);

  it('cancel_task writes cancel + failure(status=cancelled) entries and never wakes', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().expect(isTaskRequest('TASK-C')).hold().replyText('不会到达')]);
    const tools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id),
      tasks: tasksOf(stack),
    });
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '会被取消',
      instruction: 'TASK-C',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });

    // Inject into the running task is delivered (steered).
    const injected = await call(tool(tools, 'inject_task'), {
      task_id: started.taskId,
      text: '顺便看看 README',
    });
    expect(injected.ok).toBe(true);
    expect(injected.content).toContain('已转给任务');

    const cancelled = await call(tool(tools, 'cancel_task'), {
      task_id: started.taskId,
      reason: '用户改主意了',
    });
    expect(cancelled.ok).toBe(true);
    const run = runOf(stack, started.taskId);
    expect(run.status).toBe('cancelled');
    expect(run.resultConsumedAt).not.toBeNull();
    const phases = entries(stack, started.taskId);
    expect(phases.map((e) => e.phase)).toEqual(['brief', 'inject', 'cancel', 'failure']);
    expect(phases[1]).toMatchObject({ delivery: 'delivered' });
    expect(phases[3]).toMatchObject({ status: 'cancelled' });
    expect(tasksOf(stack).launchedCount()).toBe(0);

    // Cancelling again is refused; nothing woke the bot.
    const again = await call(tool(tools, 'cancel_task'), { task_id: started.taskId, reason: 'x' });
    expect(again).toMatchObject({ ok: false, errorCode: 'RUN_ALREADY_FINISHED' });
    llm.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakeRuns(stack, conv.id)).toHaveLength(0);
    expect(runOf(stack, started.taskId).status).toBe('cancelled');
  }, 30_000);

  it('start_task inside a task is rejected (depth 1), by the tool and by the host', async () => {
    const stack = await start();
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const taskIdentity: RunIdentity = {
      runId: 'run_task_x',
      botId: bot.id,
      conversationId: conv.id,
      loopType: 'task',
    };
    const tools = buildTaskTools({ identity: taskIdentity, tasks: tasksOf(stack) });
    const result = await call(tool(tools, 'start_task'), {
      title: 't',
      instruction: 'i',
      source_message_ids: [],
      writes: false,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_SUPPORTED' });
    expect(() =>
      tasksOf(stack).start(taskIdentity, {
        title: 't',
        instruction: 'i',
        sourceMessageIds: [],
        writes: false,
      }),
    ).toThrow(/深度 1/);
    expect(domain(stack).runs.listTasks({ conversationId: conv.id })).toHaveLength(0);

    // Parameter validation: a foreign message id is refused.
    const other = await openDirect(stack.core, (await makeBot(stack.core, '别人')).id);
    const foreign = userMessage(stack, other.id, '别的对话');
    const turnTools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id),
      tasks: tasksOf(stack),
    });
    const refused = await call(tool(turnTools, 'start_task'), {
      title: 't',
      instruction: 'i',
      source_message_ids: [foreign.id],
      writes: false,
    });
    expect(refused).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });

  it('forward_task_result posts the result verbatim once, with task attribution', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-F')).replyText('REPORT-F 第一行\n第二行'),
      step().expect(isWakeRequest).replyText('报告好了'),
    ]);
    const identity = turnIdentity(bot.id, conv.id);
    const started = tasksOf(stack).start(identity, {
      title: '报告',
      instruction: 'TASK-F',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['completed'], 'task completed');
    const tools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id, 'run_turn_2'),
      tasks: tasksOf(stack),
    });
    const forwarded = await call(tool(tools, 'forward_task_result'), { task_id: started.taskId });
    expect(forwarded.ok).toBe(true);
    const visible = domain(stack).messages.listVisible(conv.id, { limit: 100 });
    const message = visible.find(
      (m) => 'text' in m.content && m.content.text.startsWith('REPORT-F'),
    );
    expect(message?.content).toMatchObject({
      text: 'REPORT-F 第一行\n第二行',
      origin: 'task',
      taskId: started.taskId,
    });
    expect(message?.senderBotId).toBe(bot.id);
    const twice = await call(tool(tools, 'forward_task_result'), { task_id: started.taskId });
    expect(twice).toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
    const listed = await call(tool(tools, 'list_tasks'), {});
    expect(listed.content).toContain(`[${started.taskId}] 报告  completed`);
  }, 30_000);

  it('the reaper forces a task over TASK_MAX_WALL_MS to failed (failure entry first) and wakes the bot', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-R')).hold().replyText('不会到达'),
      step().expect(isWakeRequest).replyText('那个任务超时了'),
    ]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '挂死',
      instruction: 'TASK-R',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });
    tasksOf(stack).sweep(Date.now() + TASK_MAX_WALL_MS + 60_000);
    const run = runOf(stack, started.taskId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('超过时限');
    const failure = entries(stack, started.taskId).at(-1);
    expect(failure).toMatchObject({ phase: 'failure', status: 'failed' });
    const wake = await waitFor(
      () => wakeRuns(stack, conv.id).find((r) => r.status === 'completed') ?? null,
      { label: 'wake run', timeoutMs: 15_000 },
    );
    expect(wake.triggerMessageIds).toEqual([
      domain(stack).messages.terminalTaskEvent(started.taskId)!.id,
    ]);
    llm.releaseAll();
  }, 30_000);

  it('deleting the conversation or the bot aborts its tasks', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const bot2 = await makeBot(core, '小贝');
    const conv2 = await openDirect(core, bot2.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-D1')).hold().replyText('不会到达'),
      step().expect(isTaskRequest('TASK-D2')).hold().replyText('不会到达'),
    ]);
    const statuses = new Map<string, string>();
    core.onEvent('run.status', ({ run }) => {
      statuses.set(run.id, run.status);
    });
    const d1 = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: 'd1',
      instruction: 'TASK-D1',
      sourceMessageIds: [],
      writes: false,
    });
    const d2 = tasksOf(stack).start(turnIdentity(bot2.id, conv2.id), {
      title: 'd2',
      instruction: 'TASK-D2',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, d1.taskId, ['running'], 'd1 running');
    await waitRun(stack, d2.taskId, ['running'], 'd2 running');
    expect(tasksOf(stack).launchedCount()).toBe(2);

    await core.rpc.call('conversations.delete', { id: conv.id });
    expect(statuses.get(d1.taskId)).toBe('cancelled');
    expect(tasksOf(stack).launchedCount()).toBe(1);

    await core.rpc.call('bots.delete', { id: bot2.id });
    expect(statuses.get(d2.taskId)).toBe('cancelled');
    expect(tasksOf(stack).launchedCount()).toBe(0);
    llm.releaseAll();
  }, 30_000);
});

describe('D75 task recovery (§3.2 修复, §7.4)', () => {
  /** Restarts on `home` with a mock model scripted BEFORE boot (recovery runs at boot). */
  async function boot(
    home: string,
    keystore: ReturnType<typeof createMemoryKeystore>,
    script: (llm: MockLlmServer) => void = () => {},
  ): Promise<{ core: CoreHarness; llm: MockLlmServer; close(): Promise<void> }> {
    const llm = await startMockLlm();
    script(llm);
    const core = await createTestCore({ home, keystore, env: { KEPCUP_MOCK_LLM_URL: llm.url } });
    return {
      core,
      llm,
      async close() {
        llm.releaseAll();
        await core.close();
        await llm.stop();
      },
    };
  }

  function seedTask(
    core: CoreHarness,
    input: { botId: string; conversationId: string; title: string; status: Run['status'] },
  ): Run {
    const { runs, messages } = core.services.domain!;
    const task = runs.create({
      botId: input.botId,
      conversationId: input.conversationId,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: [],
      taskTitle: input.title,
      taskWrites: false,
      originRunId: 'run_turn_old',
    });
    messages.appendTaskEvent({
      conversationId: input.conversationId,
      ownerBotId: input.botId,
      taskId: task.id,
      phase: 'brief',
      text: input.title,
      title: input.title,
      writes: false,
    });
    return input.status === 'queued' ? task : runs.update(task.id, { status: input.status });
  }

  it('repairs unsettled tasks before the blanket interruption and re-delivers unconsumed results', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-tasks-'));
    const keystore = createMemoryKeystore();
    try {
      const first = await boot(home, keystore);
      const bot = await makeBot(first.core, '小艾');
      const conv = await openDirect(first.core, bot.id);
      const { runs, messages } = first.core.services.domain!;
      const scope = { botId: bot.id, conversationId: conv.id };
      // A: crashed after the result entry, before the terminal row.
      const a = seedTask(first.core, { ...scope, title: 'TASK-A', status: 'running' });
      messages.appendTaskEvent({
        ...scope,
        ownerBotId: bot.id,
        taskId: a.id,
        phase: 'result',
        text: 'RESULT-A',
        status: 'completed',
      });
      // B: crashed mid-run (waiting for an approval), no entry.
      const b = seedTask(first.core, { ...scope, title: 'TASK-B', status: 'waiting_approval' });
      // C: fully settled but never consumed (crash before delivery).
      const c = seedTask(first.core, { ...scope, title: 'TASK-C', status: 'running' });
      messages.appendTaskEvent({
        ...scope,
        ownerBotId: bot.id,
        taskId: c.id,
        phase: 'failure',
        text: '任务失败：FAILED-C',
        status: 'failed',
        error: 'FAILED-C',
      });
      runs.update(c.id, { status: 'failed', error: 'FAILED-C' });
      // A plain response run left running is still blanket-interrupted.
      const r = runs.create({
        ...scope,
        loopType: 'response',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      runs.update(r.id, { status: 'running' });
      await first.close();

      const second = await boot(home, keystore, (llm) =>
        llm.script('mock-main', [
          step().expect(isWakeRequest).replyText('收到 1'),
          step().expect(isWakeRequest).replyText('收到 2'),
          step().expect(isWakeRequest).replyText('收到 3'),
          step().replyText('收到 4'),
        ]),
      );
      try {
        const after = (id: string) => second.core.services.domain!.runs.getOrThrow(id);
        const phases = (id: string) =>
          second.core.services
            .domain!.messages.taskEvents(id)
            .map((m) => m.content as TaskEventContent);
        // A adopts its entry's status — not interrupted — and keeps one terminal entry.
        expect(after(a.id).status).toBe('completed');
        expect(phases(a.id).map((e) => e.phase)).toEqual(['brief', 'result']);
        // B: failure entry first, then interrupted.
        expect(after(b.id).status).toBe('interrupted');
        expect(phases(b.id).map((e) => e.phase)).toEqual(['brief', 'failure']);
        expect(phases(b.id)[1]).toMatchObject({ status: 'interrupted' });
        expect(after(c.id).status).toBe('failed');
        expect(after(r.id).status).toBe('interrupted');

        // Reconciliation woke the bot with A, B and C; all end up consumed.
        for (const id of [a.id, b.id, c.id]) {
          await waitFor(() => (after(id).resultConsumedAt !== null ? true : null), {
            label: `task ${id} consumed`,
            timeoutMs: 20_000,
          });
        }
        expect(wakeRuns(second, conv.id).length).toBeGreaterThan(0);
        const seen = JSON.stringify(second.llm.requestsFor('mock-main').map((q) => q.body));
        expect(seen).toContain('RESULT-A');
        expect(seen).toContain('FAILED-C');
        expect(seen).toContain('应用退出，任务中断');
      } finally {
        await second.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('a submitted task survives a restart and is re-queued', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-tasks-'));
    const keystore = createMemoryKeystore();
    try {
      const first = await boot(home, keystore);
      const bot = await makeBot(first.core, '小艾');
      const conv = await openDirect(first.core, bot.id);
      const task = seedTask(first.core, {
        botId: bot.id,
        conversationId: conv.id,
        title: 'TASK-REQUEUE',
        status: 'queued',
      });
      await first.close();

      const second = await boot(home, keystore, (llm) =>
        llm.script('mock-main', [
          step().expect(isTaskRequest('TASK-REQUEUE')).replyToolCall('skip_reply', { reason: 'x' }),
        ]),
      );
      try {
        const settled = await waitFor(
          () => {
            const run = second.core.services.domain!.runs.get(task.id);
            return run !== null && run.status !== 'queued' && run.status !== 'running' ? run : null;
          },
          { label: 're-queued task settled', timeoutMs: 15_000 },
        );
        expect(settled.status).toBe('completed');
        expect(settled.resultConsumedAt).not.toBeNull();
      } finally {
        await second.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
