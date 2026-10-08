import { afterEach, describe, expect, it } from 'vitest';
import type { Message, Run } from '@kepcup/shared';
import {
  createTestStack,
  isTaskRequest,
  listMessages,
  makeBot,
  openDirect,
  sendBatch,
  step,
  waitFor,
  type CoreHarness,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';

/**
 * D75 W2 审查修复（对话轮 / mailbox / 消费）：
 * - M1 对话轮开始执行时吸收 mailbox 已缓冲的批（排在繁忙名额后的对话轮；
 *   同一拍内结算 / 对账的多个任务只唤醒一轮），上下文不再与下一轮的触发重复；
 * - M2 只有真正处理了触发的对话轮（引擎已启动，completed / failed）才消费任务
 *   结果：启动前被取消、更新闸门取消都不消费；
 * - L3 重试合并批的对话轮保留各段 reason；
 * - L6 重试的对话轮不重复派出被重试那一轮已派出的任务。
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

function domain(stack: { core: CoreHarness }) {
  return stack.core.services.domain!;
}

function orchestrator(stack: { core: CoreHarness }) {
  return stack.core.services.orchestrator!;
}

function runsOf(stack: TestStack, conversationId: string, loopType: Run['loopType']): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === loopType)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

const isTerminal = (run: Run): boolean =>
  run.status === 'completed' ||
  run.status === 'failed' ||
  run.status === 'cancelled' ||
  run.status === 'interrupted';

function textOf(message: Message): string {
  return 'text' in message.content ? message.content.text : '';
}

function waitVisible(stack: TestStack, conversationId: string, fragment: string): Promise<Message> {
  return waitFor(
    async () =>
      (await listMessages(stack.core, conversationId)).find((m) => textOf(m).includes(fragment)) ??
      null,
    { label: `visible message containing ${fragment}`, timeoutMs: 20_000 },
  );
}

function waitRequest(
  stack: TestStack,
  predicate: (req: MockChatRequest) => boolean,
  label: string,
): Promise<MockChatRequest> {
  return waitFor(() => stack.llm.requestsFor('mock-main').find(predicate) ?? null, {
    label,
    timeoutMs: 20_000,
  });
}

function waitIdle(stack: TestStack, botId: string, conversationId: string): Promise<true> {
  return waitFor(() => (orchestrator(stack).isMailboxIdle(botId, conversationId) ? true : null), {
    label: 'mailbox idle',
    timeoutMs: 20_000,
  });
}

const turnWith = (fragment: string) => (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes(fragment);

/**
 * A task of `botId` that settled with `text` as its result and was never
 * consumed (the state the reconciliation re-delivers, design 30 §3.2).
 */
function settledTask(stack: TestStack, botId: string, conversationId: string, text: string): string {
  const d = domain(stack);
  const task = d.runs.create({
    botId,
    conversationId,
    loopType: 'task',
    triggerReason: null,
    triggerMessageIds: [],
    taskTitle: `任务-${text.length}`,
    taskWrites: false,
    taskWorkdir: null,
    originRunId: null,
  });
  d.messages.appendTaskEvent({
    conversationId,
    ownerBotId: botId,
    taskId: task.id,
    phase: 'brief',
    text: '去做这件事',
    title: `任务-${text.length}`,
    writes: false,
  });
  d.messages.appendTaskEvent({
    conversationId,
    ownerBotId: botId,
    taskId: task.id,
    phase: 'result',
    text,
    status: 'completed',
  });
  d.runs.update(task.id, { status: 'completed' });
  return task.id;
}

/** Limits the mock provider to one concurrent model call. */
async function oneSlot(stack: TestStack): Promise<void> {
  await stack.core.rpc.call('settings.update', {
    providerConcurrency: { default: 4, 'custom:mock': 1 },
  });
}

describe('M1: a turn absorbs what was buffered for it before it began', () => {
  it('a turn queued behind a busy provider slot takes the messages that arrived meanwhile (one turn, no duplicate)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await oneSlot(stack);
    const blocker = await makeBot(core, '占位');
    const bot = await makeBot(core, '小艾');
    const blockConv = await openDirect(core, blocker.id);
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect(turnWith('占住名额')).hold().replyText('BLOCK-DONE');
    llm.script('mock-main', [
      held,
      step()
        .inTurn()
        .expect((req) => turnWith('第一条')(req) && req.lastUserText().includes('第二条'))
        .replyText('BOTH 两条都看到了'),
    ]);
    await sendBatch(core, blockConv.id, ['占住名额']);
    await waitRequest(stack, turnWith('占住名额'), 'blocker holds the slot');

    const [first] = await sendBatch(core, conv.id, ['第一条']);
    const [second] = await sendBatch(core, conv.id, ['第二条']);
    // The turn of the first message waits for the slot; the second is buffered.
    expect(runsOf(stack, conv.id, 'turn')).toHaveLength(1);
    held.release();

    await waitVisible(stack, conv.id, 'BOTH');
    await waitIdle(stack, bot.id, conv.id);
    const turns = runsOf(stack, conv.id, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.triggerMessageIds).toEqual([first!.id, second!.id]);
    // Both are trigger messages, not context (the context layer excludes them).
    const request = llm.requestsFor('mock-main').find(turnWith('第一条'))!;
    const text = request.lastUserText();
    expect(text.indexOf('第二条')).toBeGreaterThan(text.indexOf('<trigger'));
  }, 40_000);

  it('a message edited while its turn waits for a slot reaches that turn as edited (M3, one turn)', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await oneSlot(stack);
    const blocker = await makeBot(core, '占位');
    const bot = await makeBot(core, '小艾');
    const blockConv = await openDirect(core, blocker.id);
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect(turnWith('占住名额')).hold().replyText('BLOCK-DONE');
    llm.script('mock-main', [
      held,
      step()
        .inTurn()
        .expect((req) => turnWith('改过的问题')(req) && !req.lastUserText().includes('原来的问题'))
        .replyText('EDITED-SEEN'),
    ]);
    await sendBatch(core, blockConv.id, ['占住名额']);
    await waitRequest(stack, turnWith('占住名额'), 'blocker holds the slot');
    const [question] = await sendBatch(core, conv.id, ['原来的问题']);
    await core.rpc.call('messages.edit', { id: question!.id, text: '改过的问题' });
    held.release();
    await waitVisible(stack, conv.id, 'EDITED-SEEN');
    await waitIdle(stack, bot.id, conv.id);
    expect(runsOf(stack, conv.id, 'turn')).toHaveLength(1);
  }, 40_000);

  it('task results re-delivered in one pass wake one turn whose context does not repeat them', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      step()
        .inTurn()
        .expect(
          (req) =>
            req.lastUserText().includes('RESULT-A') && req.lastUserText().includes('RESULT-B'),
        )
        .replyText('RELAY 两个结果'),
    ]);
    const taskA = settledTask(stack, bot.id, conv.id, 'RESULT-A 甲');
    const taskB = settledTask(stack, bot.id, conv.id, 'RESULT-B 乙');
    orchestrator(stack).tasks.sweep();

    await waitVisible(stack, conv.id, 'RELAY');
    await waitIdle(stack, bot.id, conv.id);
    const turns = runsOf(stack, conv.id, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.triggerReason).toBe('task');
    const entries = [taskA, taskB].map((id) => domain(stack).messages.terminalTaskEvent(id)!.id);
    expect([...turns[0]!.triggerMessageIds].sort()).toEqual([...entries].sort());
    // Each result appears once in the request: in the trigger, not the context.
    const request = llm.requestsFor('mock-main')[0]!;
    expect(request.lastUserText().split('RESULT-A').length - 1).toBe(1);
    expect(request.lastUserText().split('RESULT-B').length - 1).toBe(1);
    await waitFor(
      () =>
        [taskA, taskB].every((id) => domain(stack).runs.getOrThrow(id).resultConsumedAt !== null)
          ? true
          : null,
      { label: 'both consumed' },
    );
  }, 40_000);
});

describe('M2: only a turn that handled its trigger consumes task results', () => {
  it('a turn cancelled before it started leaves its results unconsumed', async () => {
    const stack = await start();
    const { core, llm } = stack;
    await oneSlot(stack);
    const blocker = await makeBot(core, '占位');
    const bot = await makeBot(core, '小艾');
    const blockConv = await openDirect(core, blocker.id);
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect(turnWith('占住名额')).hold().replyText('BLOCK-DONE');
    llm.script('mock-main', [held]);
    await sendBatch(core, blockConv.id, ['占住名额']);
    await waitRequest(stack, turnWith('占住名额'), 'blocker holds the slot');

    const taskId = settledTask(stack, bot.id, conv.id, 'RESULT-Q 结果');
    orchestrator(stack).tasks.sweep();
    const [turn] = runsOf(stack, conv.id, 'turn');
    expect(turn).toMatchObject({ status: 'queued', triggerReason: 'task' });
    orchestrator(stack).cancelRun(turn!.id);
    held.release();
    await waitIdle(stack, bot.id, conv.id);
    expect(domain(stack).runs.getOrThrow(turn!.id).status).toBe('cancelled');
    expect(domain(stack).runs.getOrThrow(taskId).resultConsumedAt).toBeNull();
  }, 40_000);

  it('the update gate (cancelAllActive) cancelling a running turn does not consume its results', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect((req) => req.lastUserText().includes('RESULT-U')).hold().replyText('never');
    llm.script('mock-main', [held]);
    const taskId = settledTask(stack, bot.id, conv.id, 'RESULT-U 结果');
    orchestrator(stack).tasks.sweep();
    await waitRequest(stack, (req) => req.lastUserText().includes('RESULT-U'), 'turn running');

    const { cancelled } = orchestrator(stack).cancelAllActive('update');
    expect(cancelled.length).toBeGreaterThan(0);
    await waitIdle(stack, bot.id, conv.id);
    const [turn] = runsOf(stack, conv.id, 'turn');
    expect(turn!.status).toBe('cancelled');
    expect(domain(stack).runs.getOrThrow(taskId).resultConsumedAt).toBeNull();
  }, 40_000);

  it('a completed turn consumes them', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [step().inTurn().replyText('RELAY 好了')]);
    const taskId = settledTask(stack, bot.id, conv.id, 'RESULT-C 结果');
    orchestrator(stack).tasks.sweep();
    await waitVisible(stack, conv.id, 'RELAY');
    await waitFor(
      () => (domain(stack).runs.getOrThrow(taskId).resultConsumedAt !== null ? true : null),
      { label: 'consumed' },
    );
  }, 40_000);
});

describe('L3 / L6: retrying a failed turn', () => {
  it('keeps the merged batch parts (reasons) of the failed turn', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const held = step().inTurn().expect(turnWith('先说一句')).hold().replyText('FIRST');
    const mergedTrigger = (req: MockChatRequest) =>
      !isTaskRequest(req) &&
      req.lastUserText().includes('<trigger reason="direct"') &&
      req.lastUserText().includes('<trigger reason="task"');
    llm.script('mock-main', [
      held,
      step().inTurn().expect(mergedTrigger).failWith(401, 'Incorrect API key provided'),
      step().inTurn().expect(mergedTrigger).replyText('RETRIED 两段都在'),
    ]);
    await sendBatch(core, conv.id, ['先说一句']);
    await waitRequest(stack, turnWith('先说一句'), 'turn 1 running');
    settledTask(stack, bot.id, conv.id, 'RESULT-R 结果');
    orchestrator(stack).tasks.sweep();
    await sendBatch(core, conv.id, ['再补一句']);
    held.release();

    const failed = await waitFor(
      () => runsOf(stack, conv.id, 'turn').find((run) => run.status === 'failed') ?? null,
      { label: 'merged turn failed', timeoutMs: 20_000 },
    );
    await waitIdle(stack, bot.id, conv.id);
    const retried = (await core.rpc.call('runs.retry', { runId: failed.id })) as { run: Run };
    expect(retried.run.id).not.toBe(failed.id);
    await waitVisible(stack, conv.id, 'RETRIED');
    expect([...retried.run.triggerMessageIds].sort()).toEqual([...failed.triggerMessageIds].sort());
  }, 40_000);

  it('a retried turn does not start again the task the failed turn already started', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小艾');
    const conv = await openDirect(core, bot.id);
    const startArgs = {
      title: '整理资料',
      instruction: 'TASK-ORGANIZE 整理资料',
      source_message_ids: [],
      writes: false,
    };
    llm.script('mock-main', [
      step().inTurn().replyToolCall('start_task', startArgs),
      step().inTurn().failWith(401, 'Incorrect API key provided'),
      step().inTask().hold().replyText('never'),
      step().inTurn().replyToolCall('start_task', startArgs),
      step()
        .inTurn()
        .expect((req) => JSON.stringify(req.body.messages).includes('没有重复派出'))
        .replyText('DEDUPED 那条任务已经在做了'),
    ]);
    await sendBatch(core, conv.id, ['帮我整理资料']);
    const failed = await waitFor(
      () => runsOf(stack, conv.id, 'turn').find((run) => run.status === 'failed') ?? null,
      { label: 'turn failed after start_task', timeoutMs: 20_000 },
    );
    await waitIdle(stack, bot.id, conv.id);
    expect(runsOf(stack, conv.id, 'task')).toHaveLength(1);

    await core.rpc.call('runs.retry', { runId: failed.id });
    await waitVisible(stack, conv.id, 'DEDUPED');
    const tasks = runsOf(stack, conv.id, 'task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.originRunId).toBe(failed.id);
    expect(runsOf(stack, conv.id, 'turn').filter(isTerminal)).toHaveLength(2);
  }, 40_000);
});
