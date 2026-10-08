import { afterEach, describe, expect, it } from 'vitest';
import type { Message, Run, TaskEventContent, TaskView } from '@kepcup/shared';
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
 * D75 W3 消息与界面（docs/design/30-supervisor-and-tasks.md §4.3、§6.1、
 * §2.4.6）：任务卡（对话中的可见卡片 + `task.updated` 视图）、追加行（含
 * 降级）、取消卡的改动摘要（工作区如实说明没有回退）、问题卡绑定任务且
 * 点选直注、失败任务重试出新卡；卡片在 Bot 上下文里的渲染行。
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

function tasksOf(stack: TestStack, conversationId: string): Run[] {
  return domain(stack)
    .runs.listByConversation(conversationId, 100)
    .filter((run) => run.loopType === 'task')
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function onlyTaskId(stack: TestStack, conversationId: string): string {
  const tasks = tasksOf(stack, conversationId);
  if (tasks.length !== 1) throw new Error(`expected one task, got ${tasks.length}`);
  return tasks[0]!.id;
}

function waitRun(stack: TestStack, id: string, statuses: Run['status'][], label: string) {
  return waitFor(
    () => {
      const run = domain(stack).runs.get(id);
      return run !== null && statuses.includes(run.status) ? run : null;
    },
    { label, timeoutMs: 20_000 },
  );
}

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

function recordTaskViews(stack: TestStack): TaskView[] {
  const views: TaskView[] = [];
  stack.core.onEvent('task.updated', (payload) => views.push(payload.task));
  return views;
}

async function taskView(stack: TestStack, taskId: string): Promise<TaskView> {
  const result = (await stack.core.rpc.call('tasks.get', { taskId })) as { task: TaskView | null };
  if (result.task === null) throw new Error(`no view for ${taskId}`);
  return result.task;
}

const turnWith = (fragment: string) => (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes(fragment);
const isWake = (req: MockChatRequest) =>
  !isTaskRequest(req) && req.lastUserText().includes('<trigger reason="task"');

function contextText(req: MockChatRequest): string {
  return JSON.stringify(req.body.messages ?? []);
}

describe('D75 task cards (W3)', () => {
  it('start → card + task.updated; inject line; user cancel from the card → cancelled view with the workspace "no revert" summary', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const views = recordTaskViews(stack);
    const bot = await makeBot(core, '小卡');
    const conv = await openDirect(core, bot.id);

    const taskHeld = step().inTask().hold().replyText('不会走到这里');
    llm.script('mock-main', [
      step().inTurn().expect(turnWith('写两个文件')).replyToolCall('start_task', {
        title: '写文件',
        instruction: '在工作区写 notes/a.txt',
        source_message_ids: [],
        writes: true,
      }),
      step().inTurn().replyText('ACK 我去写'),
      step().inTask().replyTextAndToolCall('PROGRESS 先写第一个', 'write', {
        path: 'notes/a.txt',
        content: 'A',
      }),
      taskHeld,
      step()
        .inTurn()
        .expect(turnWith('顺便写上日期'))
        .replyToolCall('inject_task', () => ({
          task_id: onlyTaskId(stack, conv.id),
          text: 'INJECT 顺便写上日期',
        })),
      step().inTurn().replyText('REPLY-2 已转给任务'),
    ]);

    await sendBatch(core, conv.id, ['帮我写两个文件']);
    await waitVisible(stack, conv.id, 'ACK');
    const taskId = onlyTaskId(stack, conv.id);

    // The visible card is a shared card row bound to the task, before the ack.
    const visible = await listMessages(core, conv.id);
    const card = visible.find((m) => m.kind === 'card');
    expect(card).toMatchObject({ senderType: 'system', taskId });
    expect(card?.content).toMatchObject({ cardType: 'task', runId: taskId });
    const ack = visible.find((m) => textOf(m).includes('ACK'))!;
    expect(card!.seq).toBeLessThan(ack.seq);
    expect(views.some((view) => view.taskId === taskId)).toBe(true);

    // Running, with its progress attributed to the task.
    await waitFor(() => (taskHeld.consumed ? true : null), { label: 'task held' });
    const progress = await waitVisible(stack, conv.id, 'PROGRESS');
    expect(progress.content).toMatchObject({ origin: 'task', taskId });
    expect(progress.runId).toBe(taskId);
    const running = await waitFor(
      () => views.find((view) => view.taskId === taskId && view.state === 'running') ?? null,
      { label: 'running view' },
    );
    expect(running).toMatchObject({ title: '写文件', writes: true, workdirKind: 'workspace' });
    const active = (await core.rpc.call('tasks.active', { conversationId: conv.id })) as {
      tasks: TaskView[];
    };
    expect(active.tasks.map((view) => view.taskId)).toEqual([taskId]);

    // A new message: the turn injects; the card gets the inject line.
    await sendBatch(core, conv.id, ['顺便写上日期']);
    await waitVisible(stack, conv.id, 'REPLY-2');
    const injected = await waitFor(
      () => views.find((view) => view.taskId === taskId && view.injects.length === 1) ?? null,
      { label: 'inject view' },
    );
    expect(injected.injects[0]).toMatchObject({
      text: 'INJECT 顺便写上日期',
      delivery: 'delivered',
    });
    // The bot's context renders the card as one status line (never the brief).
    const turn2 = llm.requestsFor('mock-main').find(turnWith('顺便写上日期'))!;
    expect(contextText(turn2)).toContain(`任务卡 ${taskId}（小卡）「写文件」：进行中`);

    // The user cancels from the card (runs.cancel): no wake, cancel summary.
    await core.rpc.call('runs.cancel', { runId: taskId });
    await waitRun(stack, taskId, ['cancelled'], 'task cancelled');
    const cancelled = await waitFor(
      () => views.find((view) => view.taskId === taskId && view.state === 'cancelled') ?? null,
      { label: 'cancelled view' },
    );
    expect(cancelled).toMatchObject({
      cancelReason: '用户取消',
      changes: { kind: 'workspace', files: ['notes/a.txt'], more: 0 },
      queueReason: null,
    });
    expect((await taskView(stack, taskId)).state).toBe('cancelled');
    expect(
      ((await core.rpc.call('tasks.active', { conversationId: conv.id })) as { tasks: TaskView[] })
        .tasks,
    ).toEqual([]);
  }, 60_000);

  it('a task asks on a question card bound to it; the picked option goes straight into the task', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const views = recordTaskViews(stack);
    const bot = await makeBot(core, '小问');
    const conv = await openDirect(core, bot.id);
    const updated: Message[] = [];
    core.onEvent('message.updated', (payload) => updated.push(payload.message));

    const final = step()
      .inTask()
      .expect((req) => contextText(req).includes('用户的回答：B 方案'))
      .replyText('RESULT 按 B 方案完成');
    llm.script('mock-main', [
      step().inTurn().expect(turnWith('部署一下')).replyToolCall('start_task', {
        title: '部署',
        instruction: '部署预览环境',
        source_message_ids: [],
        writes: false,
      }),
      step().inTurn().replyText('ACK 开始部署'),
      step()
        .inTask()
        .replyToolCall('ask_user', { question: '用哪个方案？', options: ['A 方案', 'B 方案'] }),
      final,
      step().inTurn().expect(isWake).replyText('RELAY 部署好了（B 方案）'),
    ]);

    await sendBatch(core, conv.id, ['部署一下']);
    const taskId = await waitFor(() => tasksOf(stack, conv.id)[0]?.id ?? null, { label: 'task' });
    const question = await waitFor(
      async () =>
        (await listMessages(core, conv.id)).find(
          (m) =>
            m.kind === 'system_event' &&
            'event' in m.content &&
            m.content.event === 'task_question',
        ) ?? null,
      { label: 'question card' },
    );
    expect(question).toMatchObject({ taskId, senderType: 'system' });
    expect(question.content).toMatchObject({ text: '用哪个方案？', options: ['A 方案', 'B 方案'] });
    const waiting = await waitFor(
      () => views.find((view) => view.taskId === taskId && view.awaitingInput) ?? null,
      { label: 'awaiting view' },
    );
    expect(waiting.questionMessageId).toBe(question.id);
    expect(domain(stack).runs.getOrThrow(taskId).awaitingInput).toBe(true);
    const phases = domain(stack)
      .messages.taskEvents(taskId)
      .map((m) => (m.content as TaskEventContent).phase);
    expect(phases).toContain('question');

    await core.rpc.call('tasks.answer', { messageId: question.id, answer: 'B 方案' });
    await waitRun(stack, taskId, ['completed'], 'task completed');
    expect(final.consumed).toBe(true);
    // The card shows the answer; the task recorded it as an inject (no turn ran for it).
    const answered = updated.find((m) => m.id === question.id);
    expect(answered?.content).toMatchObject({ answer: 'B 方案' });
    const inject = domain(stack)
      .messages.taskEvents(taskId)
      .map((m) => m.content as TaskEventContent)
      .find((c) => c.phase === 'inject');
    expect(inject).toMatchObject({ delivery: 'delivered' });
    expect(inject?.text).toContain('B 方案');
    expect(domain(stack).runs.getOrThrow(taskId).awaitingInput).toBe(false);
    await waitVisible(stack, conv.id, 'RELAY');
    // A second answer is refused.
    await expect(
      core.rpc.call('tasks.answer', { messageId: question.id, answer: 'A 方案' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 60_000);

  it("a free-text answer relayed by the turn's inject_task answers the open question", async () => {
    const stack = await start();
    const { core, llm } = stack;
    const bot = await makeBot(core, '小答');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().inTurn().expect(turnWith('整理照片')).replyToolCall('start_task', {
        title: '整理照片',
        instruction: '整理照片',
        source_message_ids: [],
        writes: false,
      }),
      step().inTurn().replyText('ACK 开始整理'),
      step()
        .inTask()
        .replyToolCall('ask_user', { question: '按什么分组？', options: ['按日期'] }),
      step()
        .inTurn()
        .expect(turnWith('按地点'))
        .replyToolCall('inject_task', () => ({
          task_id: onlyTaskId(stack, conv.id),
          text: '用户说：按地点分组',
        })),
      step().inTurn().replyText('REPLY 已转告任务'),
      step()
        .inTask()
        .expect((req) => contextText(req).includes('用户的回答：用户说：按地点分组'))
        .replyText(''),
    ]);

    await sendBatch(core, conv.id, ['帮我整理照片']);
    const taskId = await waitFor(() => tasksOf(stack, conv.id)[0]?.id ?? null, { label: 'task' });
    await waitFor(() => (domain(stack).runs.get(taskId)?.awaitingInput ? true : null), {
      label: 'awaiting input',
    });
    await sendBatch(core, conv.id, ['按地点吧']);
    await waitRun(stack, taskId, ['completed'], 'task completed');
    const card = (await listMessages(core, conv.id)).find(
      (m) => m.kind === 'system_event' && m.taskId === taskId,
    );
    expect(card?.content).toMatchObject({ answer: '用户说：按地点分组' });
  }, 60_000);

  it('a failed task is retried from its card: a new task with its own card continues it', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const views = recordTaskViews(stack);
    const bot = await makeBot(core, '小重');
    const conv = await openDirect(core, bot.id);

    llm.script('mock-main', [
      step().inTurn().expect(turnWith('查一下')).replyToolCall('start_task', {
        title: '查资料',
        instruction: '查资料',
        source_message_ids: [],
        writes: false,
      }),
      step().inTurn().replyText('ACK 去查'),
      step().inTask().failWith(400, 'bad request'),
      step().inTurn().expect(isWake).replyText('WAKE 任务失败了'),
      step().inTask().replyText(''),
    ]);

    await sendBatch(core, conv.id, ['帮我查一下']);
    const taskId = await waitFor(() => tasksOf(stack, conv.id)[0]?.id ?? null, { label: 'task' });
    await waitRun(stack, taskId, ['failed'], 'task failed');
    await waitVisible(stack, conv.id, 'WAKE');
    const failedView = await taskView(stack, taskId);
    expect(failedView).toMatchObject({ state: 'failed', continuedByTaskId: null, changes: null });

    const retried = (await core.rpc.call('runs.retry', { runId: taskId })) as { run: Run | null };
    expect(retried.run).toMatchObject({ loopType: 'task', continuedFromRunIds: [taskId] });
    const newId = retried.run!.id;
    await waitRun(stack, newId, ['completed'], 'retried task completed');
    const cards = (await listMessages(core, conv.id)).filter((m) => m.kind === 'card');
    expect(cards.map((m) => m.taskId)).toEqual([taskId, newId]);
    await waitFor(
      () =>
        views.find((view) => view.taskId === taskId && view.continuedByTaskId === newId) ?? null,
      { label: 'old card points at the retry' },
    );
    expect((await taskView(stack, newId)).continuesTaskId).toBe(taskId);
  }, 60_000);
});
