import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_MAX_WALL_MS, type Message, type Run, type TaskEventContent } from '@kepcup/shared';
import {
  createTestCore,
  createTestStack,
  makeBot,
  makeProject,
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
  return { runId, botId, conversationId, loopType: 'turn' };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} missing`);
  return found;
}

async function call(t: ToolDefinition, params: unknown): Promise<ToolResult> {
  return t.execute(params, {
    identity: { runId: 'x', botId: null, conversationId: null, loopType: 'turn' },
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
    .filter((r) => r.loopType === 'turn' && r.triggerReason === 'task');
}

describe('D75 task layer (TaskHost)', () => {
  it('start → execute → private result entry, no visible final message, status overlay cleared on success, wake + consume', async () => {
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

    // No visible final message; interim is a status overlay (cleared on success), not chat bubbles.
    const visible = domain(stack).messages.listVisible(conv.id, { limit: 100 });
    expect(
      visible.some((m) => 'text' in m.content && m.content.text.includes('RESULT-ALPHA')),
    ).toBe(false);
    expect(
      visible.some((m) => 'text' in m.content && m.content.text.includes('INTERIM-ALPHA')),
    ).toBe(false);
    expect(runOf(stack, taskId!).lastProgress ?? null).toBeNull();

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

  it('执行任务的模型用量按 run_id = task.id 记账，任务详情页的用量聚合能读到', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const source = userMessage(stack, conv.id, '跑一下 USAGE-ONE');

    llm.script('mock-main', [
      step()
        .expect(isTaskRequest('USAGE-ONE'))
        .replyText('USAGE-ONE-DONE', { prompt_tokens: 4_000, completion_tokens: 120 }),
      step().expect(isWakeRequest).replyText('好'),
    ]);

    const tools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id),
      tasks: tasksOf(stack),
    });
    const started = await call(tool(tools, 'start_task'), {
      title: '用量核对',
      instruction: 'USAGE-ONE 只回复一句话',
      source_message_ids: [source.id],
      writes: false,
    });
    expect(started.ok).toBe(true);
    const taskId = /"task_id":"(run_[^"]+)"/.exec(started.content)?.[1];
    await waitRun(stack, taskId!, ['completed'], 'task completed');

    // tasks.usage 按 run_id 查账本：能读到这次调用的聚合，说明任务的账本行
    // 就记在 task.id 下（TaskHost 建 run 与 agent 记账同一条 run）。
    const usage = domain(stack).usage.usageForRun(taskId!);
    expect(usage).not.toBeNull();
    expect(usage?.calls).toBeGreaterThanOrEqual(1);
    expect(usage?.contextTokens).toBe(4_000);
    expect(usage?.inputTokens).toBe(4_000);
    // mock 不报缓存字段 → cache_read 为 0：加权命中率是 0%（prompt token 全部
    // 没命中缓存），不是 null（分母 input 有值）。
    expect(usage?.cacheHitRate).toBe(0);
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

  it('two write tasks on the same cwd: the second stays submitted until the first settles', async () => {
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
    // W1 still takes its write lease when start returns: its true state is
    // submitted (审查 LOW-7); w2 waits behind w1.
    expect(w1.state).toBe('submitted');
    // W1's queue reason is the lease-layer waiting string; w2 waits behind w1
    // at the task layer with the D123 write-domain reason.
    expect(w1.queueReason).toContain('写入租约');
    expect(w2.state).toBe('submitted');
    expect(w2.queueReason).toContain(`等写域（任务 ${w1.taskId} 持有 整目录）`);
    expect(runOf(stack, w1.taskId).taskCwd).toBe(runOf(stack, w2.taskId).taskCwd);
    await waitRun(stack, w1.taskId, ['running'], 'w1 running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'w1 request held',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runOf(stack, w2.taskId).status).toBe('queued');
    expect(llm.requests().some(isTaskRequest('TASK-W2'))).toBe(false);
    held.release();
    const w2Done = await waitRun(stack, w2.taskId, ['completed'], 'w2 completed after w1');
    const w1Done = runOf(stack, w1.taskId);
    expect(w1Done.status).toBe('completed');
    expect(w2Done.startedAt ?? 0).toBeGreaterThanOrEqual(w1Done.endedAt ?? Infinity);
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
    // The slot frees once the aborted execution has unwound.
    await waitFor(() => (tasksOf(stack).launchedCount() === 0 ? true : null), {
      label: 'slot freed',
    });

    // Cancelling again is refused; nothing woke the bot.
    const again = await call(tool(tools, 'cancel_task'), { task_id: started.taskId, reason: 'x' });
    expect(again).toMatchObject({ ok: false, errorCode: 'RUN_ALREADY_FINISHED' });
    llm.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakeRuns(stack, conv.id)).toHaveLength(0);
    expect(runOf(stack, started.taskId).status).toBe('cancelled');
  }, 30_000);

  it('cancelById without userInitiated (update gate / delegation) never wakes the bot', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小系统');
    const conv = await openDirect(core, bot.id);
    const held = step().expect(isTaskRequest('TASK-SYS-CANCEL')).hold().replyText('不会到达');
    llm.script('mock-main', [held]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '系统取消',
      instruction: 'TASK-SYS-CANCEL',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    tasksOf(stack).cancelById(started.taskId, '更新闸门');
    await waitRun(stack, started.taskId, ['cancelled'], 'task cancelled');
    expect(runOf(stack, started.taskId).errorReason).toBeNull();
    expect(wakeRuns(stack, conv.id)).toEqual([]);
    held.release();
    llm.releaseAll();
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

  it('a settled task exposes its report on the task view, never as a chat message', async () => {
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
    // §6.1 2026-11 修订：the report is read on the task page (tasks.get), not
    // forwarded verbatim into the conversation.
    const view = (await core.rpc.call('tasks.get', { taskId: started.taskId })) as {
      task: { result: { text: string; status: string } | null } | null;
    };
    expect(view.task?.result).toEqual({
      text: 'REPORT-F 第一行\n第二行',
      status: 'completed',
    });
    const visible = domain(stack).messages.listVisible(conv.id, { limit: 100 });
    expect(
      visible.some((m) => 'text' in m.content && m.content.text.includes('REPORT-F')),
    ).toBe(false);
    // The turn's toolset no longer has a verbatim-forward tool.
    const tools = buildTaskTools({
      identity: turnIdentity(bot.id, conv.id, 'run_turn_2'),
      tasks: tasksOf(stack),
    });
    expect(tools.map((entry) => entry.name)).not.toContain('forward_task_result');
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
      // `now` far ahead also makes the reconciliation re-deliver (the first
      // delivery looks stale) — at-least-once, so allow extra turns.
      step().replyText('知道了'),
      step().replyText('知道了'),
      step().replyText('知道了'),
    ]);
    // D93: the wall-clock test disables the no-progress watchdog so the
    // total-time path is the one under test.
    const current = domain(stack).settings.get();
    domain(stack).settings.update({
      taskLoop: { ...current.taskLoop, stallTimeoutMinutes: 0, maxWallMinutes: 240 },
    });
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
    const later = Date.now() + TASK_MAX_WALL_MS + 60_000;
    tasksOf(stack).sweep(later);
    const run = runOf(stack, started.taskId);
    expect(run.status).toBe('failed');
    expect(run.errorReason).toBe('wall_timeout');
    expect(run.error).toContain('超过时限');
    const failure = entries(stack, started.taskId).at(-1);
    expect(failure).toMatchObject({ phase: 'failure', status: 'failed' });
    const entryId = domain(stack).messages.terminalTaskEvent(started.taskId)!.id;
    const wake = await waitFor(
      () => wakeRuns(stack, conv.id).find((r) => r.triggerMessageIds[0] === entryId) ?? null,
      { label: 'wake run', timeoutMs: 15_000 },
    );
    expect(wake.triggerMessageIds).toEqual([entryId]);

    // The hung execution still holds its slot; a later sweep evicts it.
    expect(tasksOf(stack).launchedCount()).toBe(1);
    tasksOf(stack).sweep(later + 2 * 60_000);
    expect(tasksOf(stack).launchedCount()).toBe(0);
    llm.releaseAll();
  }, 30_000);

  it('maxWallMinutes=0 removes the fixed 4-hour cap (the task keeps running)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小长');
    const conv = await openDirect(core, bot.id);
    const held = step().expect(isTaskRequest('TASK-NO-WALL')).hold().replyText('');
    llm.script('mock-main', [held]);
    const current = domain(stack).settings.get();
    domain(stack).settings.update({
      taskLoop: { ...current.taskLoop, stallTimeoutMinutes: 0, maxWallMinutes: 0 },
    });
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '长跑',
      instruction: 'TASK-NO-WALL',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });
    tasksOf(stack).sweep(Date.now() + TASK_MAX_WALL_MS + 60_000);
    expect(runOf(stack, started.taskId).status).toBe('running');
    held.release();
    llm.releaseAll();
  }, 30_000);

  it('a built-in task with no engine activity over the stall timeout fails and wakes the bot', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小停');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-STALL')).hold().replyText('不会到达'),
      step().expect(isWakeRequest).replyText('那个任务卡住了'),
    ]);
    const current = domain(stack).settings.get();
    domain(stack).settings.update({
      taskLoop: { ...current.taskLoop, stallTimeoutMinutes: 20, maxWallMinutes: 0 },
    });
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '卡住',
      instruction: 'TASK-STALL',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });
    tasksOf(stack).sweep(Date.now() + 21 * 60_000);
    const run = runOf(stack, started.taskId);
    expect(run.status).toBe('failed');
    expect(run.errorReason).toBe('stalled');
    expect(run.error).toContain('长时间没有进展');
    const failure = entries(stack, started.taskId).at(-1);
    expect(failure).toMatchObject({ phase: 'failure', status: 'failed' });
    const entryId = domain(stack).messages.terminalTaskEvent(started.taskId)!.id;
    const wake = await waitFor(
      () => wakeRuns(stack, conv.id).find((r) => r.triggerMessageIds[0] === entryId) ?? null,
      { label: 'wake run', timeoutMs: 15_000 },
    );
    expect(wake.triggerMessageIds).toEqual([entryId]);
    llm.releaseAll();
  }, 30_000);

  it('a model length stop fails the task instead of silently completing empty', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小截');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-LENGTH')).replyFinish('length', '写到一半'),
      step().expect(isWakeRequest).replyText('那个任务被截断了'),
    ]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '截断',
      instruction: 'TASK-LENGTH',
      sourceMessageIds: [],
      writes: false,
    });
    const run = await waitRun(stack, started.taskId, ['failed'], 'task failed');
    expect(run.error).toContain('输出达到上限');
    const failure = entries(stack, started.taskId).at(-1);
    expect(failure).toMatchObject({ phase: 'failure', status: 'failed' });
    const entryId = domain(stack).messages.terminalTaskEvent(started.taskId)!.id;
    await waitFor(
      () => wakeRuns(stack, conv.id).find((r) => r.triggerMessageIds[0] === entryId) ?? null,
      { label: 'wake run', timeoutMs: 15_000 },
    );
  }, 30_000);

  it('deleting the conversation or the bot aborts its tasks', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const bot2 = await makeBot(core, '小贝');
    const conv2 = await openDirect(core, bot2.id);
    const heldD1 = step().expect(isTaskRequest('TASK-D1')).hold().replyText('不会到达');
    const heldD2 = step().expect(isTaskRequest('TASK-D2')).hold().replyText('不会到达');
    llm.script('mock-main', [heldD1, heldD2]);
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
    // The engine's abort lands when the in-flight model call returns, and an
    // execution whose run rows were deleted under it may never come back:
    // the stopped execution keeps its slot until the reaper evicts it.
    expect(tasksOf(stack).launchedCount()).toBe(2);
    heldD1.release();
    tasksOf(stack).sweep(Date.now() + 2 * 60_000);
    expect(tasksOf(stack).launchedCount()).toBe(1);

    await core.rpc.call('bots.delete', { id: bot2.id });
    expect(statuses.get(d2.taskId)).toBe('cancelled');
    heldD2.release();
    tasksOf(stack).sweep(Date.now() + 2 * 60_000);
    expect(tasksOf(stack).launchedCount()).toBe(0);
    llm.releaseAll();
    // Cancelled tasks never wake anyone (and the deleted bot has no runs left).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(wakeRuns(stack, conv2.id)).toHaveLength(0);
    expect(llm.requests().filter(isWakeRequest)).toHaveLength(0);
  }, 30_000);
});

describe('D75 task recovery (§3.2 修复, §7.4)', () => {
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
        loopType: 'turn',
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

describe('D115/D116 用户直注与每 Bot 任务列表（docs/design/56）', () => {
  it('injectById：运行中任务直注 delivered，条目照写 Bot 私有时间线，不产生对话消息', async () => {
    const stack = await start();
    const { llm } = stack;
    const bot = await makeBot(stack.core, '小艾');
    const conv = await openDirect(stack.core, bot.id);
    const held = step().expect(isTaskRequest('TASK-USER-INJECT')).hold().replyText('不会到达');
    llm.script('mock-main', [held]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '用户直注',
      instruction: 'TASK-USER-INJECT',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });

    // 身份从 run 行取（不经过对话轮）：与 inject_task 同一注入路径。
    const injected = tasksOf(stack).injectById(started.taskId, '顺便看看 README');
    expect(injected.delivery).toBe('delivered');
    const phases = entries(stack, started.taskId);
    expect(phases.map((e) => e.phase)).toEqual(['brief', 'inject']);
    expect(phases[1]).toMatchObject({ delivery: 'delivered', text: '顺便看看 README' });
    // 直注不产生对话消息：条目是 Bot 私有的 task_event，可见消息里没有它。
    const visible = domain(stack).messages.listVisible(conv.id, { limit: 100 });
    expect(
      visible.some((m) => 'text' in m.content && m.content.text.includes('顺便看看 README')),
    ).toBe(false);
    held.release();
    llm.releaseAll();
  }, 30_000);

  it('injectById：终态任务拒绝（RUN_ALREADY_FINISHED）；任务不存在 / 非 task loop → NOT_FOUND', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-INJECT-DONE')).replyText('DONE'),
      step().expect(isWakeRequest).replyText('好'),
    ]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '已完成',
      instruction: 'TASK-INJECT-DONE',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['completed'], 'task completed');
    try {
      tasksOf(stack).injectById(started.taskId, '晚了一步');
      expect.unreachable('终态任务必须拒绝');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('RUN_ALREADY_FINISHED');
    }
    // 任务 id 不存在 → NOT_FOUND（对话轮身份 run_turn_1 只是伪 identity，无 runs 行）。
    expect(() => tasksOf(stack).injectById('run_missing', 'x')).toThrow(/找不到任务/);
    expect(() => tasksOf(stack).injectById('run_turn_1', 'x')).toThrow(/找不到任务/);
  }, 30_000);

  it('injectById 附件直注：运行中 steer 携附件元数据并 claim 到注入条目，模型收到 image blocks', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const att = (await core.rpc.call('attachments.upload', {
      conversationId: conv.id,
      fileName: 'photo.png',
      mime: 'image/png',
      bytesBase64: 'aGVsbG8=',
    })) as { attachment: { id: string; size: number } };

    const held = step().expect(isTaskRequest('TASK-INJECT-ATTACH')).hold().replyText('不会到达');
    llm.script('mock-main', [held, step().replyText('收到附件')]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '附件直注',
      instruction: 'TASK-INJECT-ATTACH',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });

    const injected = tasksOf(stack).injectById(started.taskId, '顺便看看这张图', [
      att.attachment.id,
    ]);
    expect(injected.delivery).toBe('delivered');

    // steer 步骤携带附件元数据（任务时间线 chip 的数据源）。
    const { steps } = (await core.rpc.call('runs.steps', { runId: started.taskId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const steer = steps.filter((s) => s.type === 'steer').at(-1);
    expect(steer).toBeDefined();
    expect(String(steer!.payload['text'])).toContain('顺便看看这张图');
    expect(steer!.payload['attachments']).toEqual([
      {
        id: att.attachment.id,
        fileName: 'photo.png',
        mime: 'image/png',
        size: att.attachment.size,
      },
    ]);

    // 附件已 claim 到注入条目（status 'sent'），任务卡 injects 带附件元数据与模型 ref。
    const status = (await core.rpc.call('attachments.status', {
      conversationId: conv.id,
      ids: [att.attachment.id],
    })) as { statuses: Array<{ id: string; state: string }> };
    expect(status.statuses[0]).toEqual({ id: att.attachment.id, state: 'sent' });
    const view = tasksOf(stack).view(started.taskId);
    expect(view?.injects[0]?.attachments).toEqual([
      {
        id: att.attachment.id,
        fileName: 'photo.png',
        mime: 'image/png',
        size: att.attachment.size,
      },
    ]);
    expect(view?.model).not.toBeNull();

    // 放行后注入进入下一请求：image block 到达模型（mock-main 声明 input image）。
    held.release();
    await waitFor(() => (llm.requestsFor('mock-main').length >= 2 ? true : null), {
      label: 'steered request',
    });
    const bodies = JSON.stringify(llm.requestsFor('mock-main').map((q) => q.body));
    expect(bodies).toContain('aGVsbG8=');
  }, 30_000);

  it('injectById 附件直注：他人会话 / 已占用的附件 → INVALID_INPUT', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const other = await makeBot(core, '小丁');
    const conv = await openDirect(core, bot.id);
    const otherConv = await openDirect(core, other.id);
    const foreign = (await core.rpc.call('attachments.upload', {
      conversationId: otherConv.id,
      fileName: 'x.png',
      mime: 'image/png',
      bytesBase64: 'aGVsbG8=',
    })) as { attachment: { id: string } };
    const mine = (await core.rpc.call('attachments.upload', {
      conversationId: conv.id,
      fileName: 'mine.png',
      mime: 'image/png',
      bytesBase64: 'aGVsbG8=',
    })) as { attachment: { id: string } };

    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-INJECT-GUARD')).hold().replyText('不会到达'),
    ]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '附件校验',
      instruction: 'TASK-INJECT-GUARD',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');

    await expect(
      stack.core.rpc.call('tasks.inject', {
        taskId: started.taskId,
        text: '拿别人的附件',
        attachmentIds: [foreign.attachment.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 先把 mine 占用掉（直发对话消息），再注入 → 已被占用。
    await stack.core.rpc.call('messages.send', {
      conversationId: conv.id,
      text: '先占用',
      attachmentIds: [mine.attachment.id],
    });
    await expect(
      stack.core.rpc.call('tasks.inject', {
        taskId: started.taskId,
        text: '再次占用同一附件',
        attachmentIds: [mine.attachment.id],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    stack.llm.releaseAll();
  }, 30_000);

  it('未启动任务的附件直注：入简报 <later_instructions>（附件行），启动时图片进视觉通道', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-tasks-'));
    const keystore = createMemoryKeystore();
    try {
      const first = await boot(home, keystore);
      const bot = await makeBot(first.core, '小艾');
      const conv = await openDirect(first.core, bot.id);
      const att = (await first.core.rpc.call('attachments.upload', {
        conversationId: conv.id,
        fileName: 'photo.png',
        mime: 'image/png',
        bytesBase64: 'aGVsbG8=',
      })) as { attachment: { id: string } };
      const runs = domain(first).runs;
      const task = runs.create({
        botId: bot.id,
        conversationId: conv.id,
        loopType: 'task',
        triggerReason: null,
        triggerMessageIds: [],
        taskTitle: 'TASK-INJECT-BRIEF',
        taskWrites: false,
        originRunId: 'run_turn_old',
      });
      domain(first).messages.appendTaskEvent({
        conversationId: conv.id,
        ownerBotId: bot.id,
        taskId: task.id,
        phase: 'brief',
        text: 'TASK-INJECT-BRIEF',
        title: 'TASK-INJECT-BRIEF',
        writes: false,
      });
      const injected = tasksOf(first).injectById(task.id, '再补一张截图', [att.attachment.id]);
      expect(injected.delivery).toBe('delivered');
      await first.close();

      const second = await boot(home, keystore, (llm) =>
        llm.script('mock-main', [
          step().expect(isTaskRequest('TASK-INJECT-BRIEF')).replyToolCall('skip_reply', { reason: 'x' }),
        ]),
      );
      try {
        await waitFor(
          () => {
            const run = second.core.services.domain!.runs.get(task.id);
            return run !== null && run.status !== 'queued' && run.status !== 'running'
              ? run
              : null;
          },
          { label: 'brief-attachment task settled', timeoutMs: 15_000 },
        );
        // 简报的 later_instructions 带附件行；图片本体走视觉通道（image block）。
        const seen = JSON.stringify(second.llm.requestsFor('mock-main').map((q) => q.body));
        expect(seen).toContain('<later_instructions>');
        expect(seen).toContain('再补一张截图');
        expect(seen).toContain('photo.png [image/png]');
        expect(seen).toContain('aGVsbG8=');
      } finally {
        await second.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('injectById 附件直注：重复 id 去重不自毁；纯附件（text 空）可注入；>4 张只前 4 张进视觉通道', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const upload = async (name: string) =>
      (await core.rpc.call('attachments.upload', {
        conversationId: conv.id,
        fileName: name,
        mime: 'image/png',
        bytesBase64: 'aGVsbG8=',
      })) as { attachment: { id: string; size: number } };

    const held = step().expect(isTaskRequest('TASK-INJECT-EDGE')).hold().replyText('不会到达');
    llm.script('mock-main', [held, step().replyText('收到')]);
    const started = tasksOf(stack).start(turnIdentity(bot.id, conv.id), {
      title: '附件边界',
      instruction: 'TASK-INJECT-EDGE',
      sourceMessageIds: [],
      writes: false,
    });
    await waitRun(stack, started.taskId, ['running'], 'task running');
    await waitFor(() => (llm.requestsFor('mock-main').length >= 1 ? true : null), {
      label: 'task request held',
    });

    // 重复 id：去重后同一附件只 claim 一次，不触发「已被占用」自毁。
    const dup = await upload('dup.png');
    const injected = tasksOf(stack).injectById(started.taskId, '同一张图说两遍', [
      dup.attachment.id,
      dup.attachment.id,
    ]);
    expect(injected.delivery).toBe('delivered');

    // 纯附件（text 空）注入：steer 文本只有附件行。
    const pure = await upload('pure.png');
    const pureInject = tasksOf(stack).injectById(started.taskId, '', [pure.attachment.id]);
    expect(pureInject.delivery).toBe('delivered');

    // >4 张：视觉通道只取前 4 张（全部 6 张仍进文本行 / claim）。
    const many = await Promise.all(
      ['1', '2', '3', '4', '5', '6'].map((n) => upload(`many-${n}.png`)),
    );
    const manyInject = tasksOf(stack).injectById(started.taskId, '六张图', [
      ...many.map((m) => m.attachment.id),
    ]);
    expect(manyInject.delivery).toBe('delivered');

    held.release();
    await waitFor(() => (llm.requestsFor('mock-main').length >= 2 ? true : null), {
      label: 'steered requests',
    });
    // 放行后的请求体（可能多条，也可能把排队 steer 合并进一条）：视觉通道的
    // image block 合计 = 重复 id 1 张 + 纯附件 1 张 + 六张里前 4 张。
    const afterStart = llm.requestsFor('mock-main')
      .slice(1)
      .map((q) => JSON.stringify(q.body))
      .join('');
    expect(afterStart.split('aGVsbG8=').length - 1).toBe(6);
    // 纯附件注入的 steer 文本只有附件行（无正文指令）。
    const { steps } = (await core.rpc.call('runs.steps', { runId: started.taskId })) as {
      steps: Array<{ type: string; payload: Record<string, unknown> }>;
    };
    const steers = steps.filter((s) => s.type === 'steer');
    const pureSteerText = String(steers[1]!.payload['text']);
    expect(pureSteerText).toContain('pure.png [image/png]');
    expect(pureSteerText).not.toContain('<source_messages>');
  }, 30_000);

  it('listByBotViews：跨对话全集、按 created_at 倒序、不混入其它 Bot 的任务；limit 截断', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const other = await makeBot(core, '小丁');
    const conv = await openDirect(core, bot.id);
    const otherConv = await openDirect(core, other.id);
    const project = await makeProject(core, '直注项目', [bot.id, other.id], { leadBotId: bot.id });
    llm.script('mock-main', [
      step().expect(isTaskRequest('TASK-BYBOT-A1')).replyText('A1 完成'),
      step().expect(isTaskRequest('TASK-BYBOT-O1')).replyText('O1 完成'),
      step().expect(isTaskRequest('TASK-BYBOT-A2')).replyText('A2 完成'),
      step().expect(isTaskRequest('TASK-BYBOT-P1')).replyText('P1 完成'),
      step().expect(isWakeRequest).replyText('好'),
      step().expect(isWakeRequest).replyText('好'),
      step().expect(isWakeRequest).replyText('好'),
      step().expect(isWakeRequest).replyText('好'),
    ]);
    const startAs = (identity: RunIdentity, instruction: string, title: string) =>
      tasksOf(stack).start(identity, {
        title,
        instruction,
        sourceMessageIds: [],
        writes: false,
      });
    const a1 = startAs(turnIdentity(bot.id, conv.id, 'run_turn_a1'), 'TASK-BYBOT-A1', '直聊一');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const o1 = startAs(
      { runId: 'run_turn_o1', botId: other.id, conversationId: otherConv.id, loopType: 'turn' },
      'TASK-BYBOT-O1',
      '别人的',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const a2 = startAs(turnIdentity(bot.id, conv.id, 'run_turn_a2'), 'TASK-BYBOT-A2', '直聊二');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const p1 = startAs(
      { runId: 'run_turn_p1', botId: bot.id, conversationId: project.id, loopType: 'turn' },
      'TASK-BYBOT-P1',
      '项目里的',
    );
    for (const id of [a1.taskId, o1.taskId, a2.taskId, p1.taskId]) {
      await waitRun(stack, id, ['completed'], `task ${id} completed`);
    }

    const views = tasksOf(stack).listByBotViews(bot.id, 100);
    // 直聊两条 + 项目一条，跨对话全集；created_at 间隔 5ms → 严格倒序。
    expect(views.map((view) => view.taskId)).toEqual([p1.taskId, a2.taskId, a1.taskId]);
    expect(views.some((view) => view.taskId === o1.taskId)).toBe(false);
    // limit 截断取最新。
    const limited = tasksOf(stack).listByBotViews(bot.id, 2);
    expect(limited.map((view) => view.taskId)).toEqual([p1.taskId, a2.taskId]);
    // 其它 Bot 只看到自己的。
    expect(tasksOf(stack).listByBotViews(other.id, 100).map((view) => view.taskId)).toEqual([
      o1.taskId,
    ]);
  }, 30_000);
});
