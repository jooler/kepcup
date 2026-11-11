import { afterEach, describe, expect, it } from 'vitest';
import { TASK_PEER_SEND_MAX_PER_RUN, type Run, type TaskEventContent } from '@kepcup/shared';
import {
  createTestStack,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';

/**
 * D123 W4: task-to-task coordination (docs/design/59 §4). Sibling tasks share
 * one (bot, conversation); a task may message and wait for another, but a
 * message never answers an `ask_user` card and waiting never deadlocks
 * silently (cycle detection).
 */

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

function domain(stack: TestStack) {
  return stack.core.services.domain!;
}

function host(stack: TestStack) {
  return stack.core.services.orchestrator!.tasks;
}

function runOf(stack: TestStack, id: string): Run {
  return domain(stack).runs.getOrThrow(id);
}

function taskIdentity(taskId: string, botId: string, conversationId: string): RunIdentity {
  return { runId: taskId, botId, conversationId, loopType: 'task' };
}

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_1', botId, conversationId, loopType: 'turn' };
}

const isTaskRequest = (marker: string) => (req: MockChatRequest) =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(marker);

function taskEntries(stack: TestStack, taskId: string): TaskEventContent[] {
  return domain(stack)
    .messages.taskEvents(taskId)
    .map((message) => message.content as TaskEventContent);
}

function waitStatus(stack: TestStack, taskId: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(taskId);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

async function startHeld(
  stack: TestStack,
  botId: string,
  conversationId: string,
  marker: string,
): Promise<{ taskId: string; identity: RunIdentity }> {
  const started = host(stack).start(turnIdentity(botId, conversationId), {
    title: 'peer',
    instruction: marker,
    sourceMessageIds: [],
    writes: false,
  });
  await waitStatus(stack, started.taskId, ['running'], `${marker} running`);
  return { taskId: started.taskId, identity: taskIdentity(started.taskId, botId, conversationId) };
}

describe('D123 peer coordination', () => {
  it('send_to_task steers a running sibling and records a peer_message entry', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '协作');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');

    const result = host(stack).send(a.identity, {
      taskId: b.taskId,
      text: '我要动 shared，你在改吗？',
    });
    expect(result.delivery).toBe('delivered');
    const peer = taskEntries(stack, b.taskId).find((entry) => entry.phase === 'peer_message');
    expect(peer).toMatchObject({
      fromTaskId: a.taskId,
      fromTitle: 'peer',
      text: '我要动 shared，你在改吗？',
    });
    // The receiving task owns the entry (its bot sees it, the user does not).
    const raw = domain(stack)
      .messages.taskEvents(b.taskId)
      .find((message) => (message.content as TaskEventContent).phase === 'peer_message');
    expect(raw?.ownerBotId).toBe(bot.id);

    stepA.release();
    stepB.release();
  }, 30_000);

  it('send_to_task refuses a finished sibling and an unknown task', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '拒绝');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: 'peer',
      instruction: 'TASK-B',
      sourceMessageIds: [],
      writes: false,
    });
    await waitStatus(stack, b.taskId, ['completed'], 'B completed');

    expect(() => host(stack).send(a.identity, { taskId: b.taskId, text: '还在吗' })).toThrow(
      /已结束/,
    );
    expect(() =>
      host(stack).send(a.identity, { taskId: 'run_missing', text: '在吗' }),
    ).toThrow(/没有任务/);
    stepA.release();
  }, 30_000);

  it('send_to_task queues to a sibling blocked on ask_user without answering it', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '提问者');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step()
      .expect(isTaskRequest('TASK-B'))
      .replyToolCall('ask_user', { question: '用哪个方案？', options: ['甲', '乙'] });
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: 'peer',
      instruction: 'TASK-B',
      sourceMessageIds: [],
      writes: false,
    });
    await waitFor(
      () => (domain(stack).runs.get(b.taskId)?.awaitingInput === true ? true : null),
      { label: 'B waiting on the user' },
    );

    host(stack).send(a.identity, { taskId: b.taskId, text: '这不是答案' });
    // The question is still open — a peer message never answers it.
    expect(domain(stack).runs.getOrThrow(b.taskId).awaitingInput).toBe(true);
    expect(taskEntries(stack, b.taskId).some((entry) => entry.phase === 'peer_message')).toBe(
      true,
    );
    expect(taskEntries(stack, b.taskId).some((entry) => entry.phase === 'inject')).toBe(false);
    stepA.release();
  }, 30_000);

  it('send_to_task is rate-limited per run', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '刷屏');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    for (let index = 0; index < TASK_PEER_SEND_MAX_PER_RUN; index += 1) {
      host(stack).send(a.identity, { taskId: b.taskId, text: `第 ${index + 1} 条` });
    }
    expect(() => host(stack).send(a.identity, { taskId: b.taskId, text: '超限' })).toThrow(
      /最多发送/,
    );
    stepA.release();
    stepB.release();
  }, 30_000);

  it('wait_for_task returns the terminal digest when the sibling completes', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '等待');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 的结果 WRAP-UP');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    const signal = new AbortController().signal;
    const waiting = host(stack).wait(a.identity, { taskId: b.taskId }, signal);
    stepB.release();
    const result = await waiting;
    expect(result.status).toBe('completed');
    expect(result.resultDigest).toContain('B 的结果 WRAP-UP');
    stepA.release();
  }, 30_000);

  it('wait_for_task times out as still_running', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '超时');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    const result = await host(stack).wait(
      a.identity,
      { taskId: b.taskId, timeoutMinutes: 1 / 60 },
      new AbortController().signal,
    );
    expect(result.status).toBe('still_running');
    stepA.release();
    stepB.release();
  }, 30_000);

  it('wait_for_task refuses a waiting cycle', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '成环');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    const signal = new AbortController().signal;
    const first = host(stack).wait(a.identity, { taskId: b.taskId }, signal);
    await expect(host(stack).wait(b.identity, { taskId: a.taskId }, signal)).rejects.toMatchObject(
      { code: 'TASK_WAIT_CYCLE' },
    );
    stepB.release();
    expect((await first).status).toBe('completed');
    stepA.release();
  }, 30_000);

  it('wait_for_task called inside a task blocks on the sibling and resumes with its result', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '工具等待');
    const conv = await openDirect(core, bot.id);
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 的结果 WRAP-UP');
    llm.script('mock-main', [stepB]);
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    await waitFor(() => (stepB.consumed ? true : null), { label: 'B request in flight' });
    const stepA1 = step()
      .expect(isTaskRequest('TASK-A'))
      .replyToolCall('wait_for_task', { task_id: b.taskId });
    const stepA2 = step().expect(isTaskRequest('TASK-A')).replyText('A 完成了');
    llm.script('mock-main', [stepA1, stepA2]);
    const a = host(stack).start(turnIdentity(bot.id, conv.id), {
      title: 'peer',
      instruction: 'TASK-A',
      sourceMessageIds: [],
      writes: false,
    });
    await waitStatus(stack, a.taskId, ['running'], 'A running');
    // A is parked inside wait_for_task (its tool call is in flight); B finishes.
    await waitFor(() => (stepA1.consumed ? true : null), { label: 'A wait tool call' });
    expect(domain(stack).runs.getOrThrow(a.taskId).status).toBe('running');
    stepB.release();
    await waitStatus(stack, b.taskId, ['completed'], 'B completed');
    await waitStatus(stack, a.taskId, ['completed'], 'A completed');
    const terminal = taskEntries(stack, a.taskId).find((entry) => entry.phase === 'result');
    expect(terminal?.text ?? '').toContain('A 完成了');
  }, 30_000);

  it('cancelling the waiting task aborts wait_for_task and unregisters it', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '取消等待');
    const conv = await openDirect(core, bot.id);
    const stepA = step().expect(isTaskRequest('TASK-A')).hold().replyText('A 完成');
    const stepB = step().expect(isTaskRequest('TASK-B')).hold().replyText('B 完成');
    llm.script('mock-main', [stepA, stepB]);
    const a = await startHeld(stack, bot.id, conv.id, 'TASK-A');
    const b = await startHeld(stack, bot.id, conv.id, 'TASK-B');
    const waiting = host(stack).wait(a.identity, { taskId: b.taskId }, new AbortController().signal);
    host(stack).cancel(turnIdentity(bot.id, conv.id), { taskId: a.taskId, reason: '不等了' });
    await expect(waiting).rejects.toMatchObject({ code: 'RUN_ALREADY_FINISHED' });
    expect(runOf(stack, b.taskId).status).toBe('running');
    stepB.release();
  }, 30_000);
});
