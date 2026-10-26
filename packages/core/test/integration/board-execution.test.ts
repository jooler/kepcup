import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type Message } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  listRuns,
  makeBot,
  makeProject,
  step,
  TestClock,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';
import type { BoardService } from '../../src/board/board-service.js';
import { BOARD_DISPATCH_TAG, BOARD_UNDISPATCHED_NOTE } from '../../src/workbench/todo-service.js';

/**
 * Board dispatch (P2 B6): a card is sent to its own conversation as 【看板】,
 * and the bot's direct chat and the project chat are left alone.
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(clock?: TestClock): Promise<TestStack> {
  const stack = await createTestStack(
    clock === undefined ? {} : { clock, timers: clock },
  );
  stacks.push(stack);
  return stack;
}

function board(stack: TestStack): BoardService {
  return stack.core.services.board!;
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof AppError ? String(error.code) : 'OTHER';
  }
}

function textOf(message: Message): string {
  const content = message.content as { text?: string };
  return content.text ?? '';
}

async function scaffold(stack: TestStack, text = '写发布说明'): Promise<{
  projectId: string;
  leadId: string;
  memberId: string;
  cardId: string;
  directId: string;
}> {
  const leadId = (await makeBot(stack.core, 'Lead')).id;
  const memberId = (await makeBot(stack.core, 'Member')).id;
  const projectId = (await makeProject(stack.core, '执行项目', [leadId, memberId], { leadBotId: leadId }))
    .id;
  const columnId = board(stack).get(projectId, ['Todo'], 'user').columns[0]!.id;
  const cardId = board(stack).createCard(projectId, columnId, text, undefined, 'user').id;
  const directId = (
    (await stack.core.rpc.call('conversations.openDirect', { botId: memberId })) as {
      conversation: { id: string };
    }
  ).conversation.id;
  return { projectId, leadId, memberId, cardId, directId };
}

function cardOf(stack: TestStack, projectId: string, cardId: string) {
  return board(stack).get(projectId, undefined, 'user').cards.find((card) => card.id === cardId)!;
}

function activeSchedule(stack: TestStack, todoId: string) {
  return stack.core.services.schedules!.store.listActiveForTodo(todoId)[0] ?? null;
}

describe('board execution', () => {
  it('dispatches 【看板】 into the card chat and delivers there', async () => {
    const stack = await start();
    const { projectId, memberId, cardId, directId } = await scaffold(stack, '写发布说明');
    stack.llm.script('mock-main', [
      step()
        .inTurn()
        .expect((req) => req.lastUserText().includes(`${BOARD_DISPATCH_TAG}写发布说明`))
        .replyText('发布说明写好了。'),
    ]);
    stack.llm.script('mock-light', [step().replyJson({ runSummary: '无', memories: [], profileProposals: [], wikiSuggestions: [], skillSuggestion: null })]);

    const assigned = board(stack).assign(cardId, memberId, 'user');
    expect(assigned.card.todo.assignee).toEqual({ botId: memberId, name: 'Member' });
    expect(assigned.card.conversationId).toBeTruthy();
    const conversationId = assigned.card.conversationId!;

    board(stack).start(cardId, 'user');
    const message = await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).find((row) =>
          textOf(row).includes(`${BOARD_DISPATCH_TAG}写发布说明`),
        ) ?? null,
      { label: 'board dispatch' },
    );
    expect(message.mentions).toEqual([]);
    expect((message.content as { origin?: string }).origin).toBe('workbench');

    await waitFor(
      async () => (cardOf(stack, projectId, cardId).todo.status === 'delivered' ? true : null),
      { label: 'card delivered' },
    );
    const runs = (await listRuns(stack.core, conversationId)).filter((run) => run.loopType === 'turn');
    expect(runs.map((run) => run.botId)).toEqual([memberId]);
    expect(runs.every((run) => run.triggerReason === 'direct')).toBe(true);

    const projectTexts = (await listAllMessages(stack.core, projectId)).map(textOf).join('\n');
    const directTexts = (await listAllMessages(stack.core, directId)).map(textOf).join('\n');
    expect(projectTexts).not.toContain(BOARD_DISPATCH_TAG);
    expect(directTexts).not.toContain(BOARD_DISPATCH_TAG);
  }, 60_000);

  it('appends the undelivered note when a cron fire overlaps a dispatched run', async () => {
    const stack = await start();
    const { memberId, cardId } = await scaffold(stack, '周期核对');
    const held = step()
      .inTurn()
      .expect((req) => req.lastUserText().includes(`${BOARD_DISPATCH_TAG}周期核对`))
      .hold()
      .replyText('还在核对。');
    stack.llm.script('mock-main', [held, step().inTurn().replyText('第二次收到了。')]);
    stack.llm.script('mock-light', [step().replyJson({ runSummary: '无', memories: [], profileProposals: [], wikiSuggestions: [], skillSuggestion: null })]);

    const assigned = board(stack).assign(cardId, memberId, 'user');
    const conversationId = assigned.card.conversationId!;
    board(stack).schedule(cardId, '0 * * * *', 'user');
    board(stack).start(cardId, 'user');
    await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).some((row) =>
          textOf(row).includes(`${BOARD_DISPATCH_TAG}周期核对`),
        )
          ? true
          : null,
      { label: 'first board dispatch' },
    );

    const schedule = activeSchedule(stack, cardId);
    expect(schedule?.conversationId).toBe(conversationId);
    stack.core.services.todos!.dispatchScheduled({
      todoId: cardId,
      scheduleId: schedule!.id,
      fireAt: schedule!.nextFireAt ?? Date.now(),
      lateByMs: null,
    });
    const noted = await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).find((row) =>
          textOf(row).includes(BOARD_UNDISPATCHED_NOTE),
        ) ?? null,
      { label: 'undelivered note' },
    );
    expect(textOf(noted)).toContain(`${BOARD_DISPATCH_TAG}周期核对`);
    held.release();
  }, 60_000);

  it('reassigns onto a new conversation, then clears the assignee', async () => {
    const stack = await start();
    const { projectId, leadId, memberId, cardId } = await scaffold(stack);
    const first = board(stack).assign(cardId, memberId, 'user');
    const firstId = first.card.conversationId!;
    board(stack).schedule(cardId, '2099-01-01T00:00:00.000Z', 'user');
    const second = board(stack).assign(cardId, leadId, 'user');
    expect(second.card.conversationId).not.toBe(firstId);
    expect(stack.core.services.domain!.conversations.get(firstId)?.readOnly).toBe(true);
    expect(stack.core.services.domain!.conversations.get(second.card.conversationId!)?.readOnly).toBe(
      false,
    );
    expect(activeSchedule(stack, cardId)?.conversationId).toBe(second.card.conversationId);

    const duringUnassign: Array<string | null> = [];
    const stopUnassign = stack.core.onEvent('board.changed', () => {
      duringUnassign.push(cardOf(stack, projectId, cardId).conversationId);
    });
    const cleared = board(stack).assign(cardId, null, 'user');
    await Promise.resolve();
    stopUnassign();
    expect(duringUnassign).toEqual([null]);
    expect(cleared.card.todo.assignee).toBeNull();
    expect(cleared.card.todo.status).toBe('draft');
    expect(cleared.card.conversationId).toBeNull();
    expect(stack.core.services.domain!.conversations.get(second.card.conversationId!)?.readOnly).toBe(
      true,
    );
    expect(activeSchedule(stack, cardId)).toBeNull();
    expect(cardOf(stack, projectId, cardId).todo.status).toBe('draft');
  }, 60_000);

  it('refuses to change the assignee while the card is in progress', async () => {
    const stack = await start();
    const { projectId, leadId, memberId, cardId } = await scaffold(stack, '执行中的卡');
    const held = step().inTurn().hold().replyText('还在做。');
    stack.llm.script('mock-main', [held]);
    stack.llm.script('mock-light', [
      step().replyJson({
        runSummary: '无',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [],
        skillSuggestion: null,
      }),
    ]);
    const assigned = board(stack).assign(cardId, memberId, 'user');
    board(stack).start(cardId, 'user');
    await waitFor(
      async () =>
        (await listAllMessages(stack.core, assigned.card.conversationId!)).some((row) =>
          textOf(row).includes(BOARD_DISPATCH_TAG),
        )
          ? true
          : null,
      { label: 'dispatch started' },
    );
    expect(cardOf(stack, projectId, cardId).todo.status).toBe('in_progress');
    expect(codeOf(() => board(stack).assign(cardId, leadId, 'user'))).toBe('BOARD_LOCKED');
    expect(codeOf(() => board(stack).schedule(cardId, '2099-08-01T00:00:00.000Z', 'user'))).toBe(
      'BOARD_LOCKED',
    );
    held.release();
  }, 60_000);

  it('rejects a cron that fires more than once an hour', async () => {
    const stack = await start();
    const { memberId, cardId } = await scaffold(stack);
    board(stack).assign(cardId, memberId, 'user');
    expect(codeOf(() => board(stack).schedule(cardId, '* * * * *', 'user'))).toBe(
      'BOARD_CRON_TOO_FREQUENT',
    );
    expect(codeOf(() => board(stack).schedule(cardId, '0 * * * *', 'user'))).toBe('NO_ERROR');
  }, 60_000);

  it('clears the assignee when the member leaves or the bot is deleted', async () => {
    const stack = await start();
    const left = await scaffold(stack, '成员要离开');
    board(stack).assign(left.cardId, left.memberId, 'user');
    board(stack).schedule(left.cardId, '2099-06-01T00:00:00.000Z', 'user');
    const leftConversation = cardOf(stack, left.projectId, left.cardId).conversationId!;
    await stack.core.rpc.call('projects.removeMember', {
      conversationId: left.projectId,
      botId: left.memberId,
    });
    const afterLeave = cardOf(stack, left.projectId, left.cardId);
    expect(afterLeave.todo.assignee).toBeNull();
    expect(afterLeave.todo.status).toBe('draft');
    expect(afterLeave.todo.blockedReason).toBe('执行成员已移出项目组');
    expect(afterLeave.conversationId).toBe(leftConversation);
    expect(stack.core.services.domain!.conversations.get(leftConversation)?.readOnly).toBe(true);
    expect(activeSchedule(stack, left.cardId)).toBeNull();

    const gone = await scaffold(stack, '成员要删除');
    board(stack).assign(gone.cardId, gone.memberId, 'user');
    board(stack).schedule(gone.cardId, '2099-06-02T00:00:00.000Z', 'user');
    const goneConversation = cardOf(stack, gone.projectId, gone.cardId).conversationId!;
    await stack.core.rpc.call('bots.delete', { id: gone.memberId });
    const afterDelete = cardOf(stack, gone.projectId, gone.cardId);
    expect(afterDelete.todo.assignee).toBeNull();
    expect(afterDelete.todo.status).toBe('draft');
    expect(afterDelete.todo.blockedReason).toBe('执行成员已删除');
    expect(afterDelete.conversationId).toBe(goneConversation);
    expect(stack.core.services.domain!.conversations.get(goneConversation)?.readOnly).toBe(true);
    expect(activeSchedule(stack, gone.cardId)).toBeNull();
  }, 60_000);

  it('rejects assign and schedule when the project is read-only', async () => {
    const stack = await start();
    const { projectId, memberId, cardId } = await scaffold(stack);
    stack.core.services.domain!.conversations.setReadOnly(projectId, true);
    expect(codeOf(() => board(stack).assign(cardId, memberId, 'user'))).toBe(
      'BOARD_PROJECT_READ_ONLY',
    );
    expect(codeOf(() => board(stack).schedule(cardId, '2099-01-01T00:00:00.000Z', 'user'))).toBe(
      'BOARD_PROJECT_READ_ONLY',
    );
  }, 60_000);

  it('posts a text edit into the card thread while the card is in progress', async () => {
    const clock = new TestClock();
    const stack = await start(clock);
    const { projectId, memberId, cardId } = await scaffold(stack, '原来的说明');
    const held = step().inTurn().hold().replyText('还在做。');
    stack.llm.script('mock-main', [held, step().inTurn().replyText('看到更新了。')]);
    stack.llm.script('mock-light', [step().replyJson({ runSummary: '无', memories: [], profileProposals: [], wikiSuggestions: [], skillSuggestion: null })]);
    const assigned = board(stack).assign(cardId, memberId, 'user');
    const conversationId = assigned.card.conversationId!;
    board(stack).start(cardId, 'user');
    await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).some((row) =>
          textOf(row).includes(BOARD_DISPATCH_TAG),
        )
          ? true
          : null,
      { label: 'dispatch before edit' },
    );
    board(stack).updateCard(cardId, '补充了验收标准', 'user');
    clock.advance(10_000);
    const notice = await waitFor(
      async () =>
        (await listAllMessages(stack.core, conversationId)).find((row) =>
          textOf(row).includes('补充了验收标准'),
        ) ?? null,
      { label: 'todo update notice' },
    );
    expect(textOf(notice)).toContain('事项更新');
    expect(cardOf(stack, projectId, cardId).text).toBe('补充了验收标准');
    held.release();
  }, 60_000);

  it('exposes queueReason for a queued task in the card conversation', async () => {
    const stack = await start();
    const { projectId, memberId, cardId } = await scaffold(stack);
    const assigned = board(stack).assign(cardId, memberId, 'user');
    const conversationId = assigned.card.conversationId!;
    stack.core.services.domain!.runs.create({
      botId: memberId,
      conversationId,
      loopType: 'task',
      triggerReason: 'task',
      triggerMessageIds: [],
      taskTitle: '排队的写任务',
      taskWrites: true,
      taskCwd: '/tmp/kepcup-card-queue',
    });
    const card = cardOf(stack, projectId, cardId);
    expect(card.task).not.toBeNull();
    expect(card.task!.queued).toBeGreaterThanOrEqual(1);
    expect(card.task!.queueReason).toEqual(expect.any(String));
    expect(card.task!.queueReason!.length).toBeGreaterThan(0);
    expect(card.task!.awaitingInput).toBe(false);
  }, 60_000);

  it('publishes one board.changed after a one-off start cancels the schedule', async () => {
    const stack = await start();
    const { memberId, cardId } = await scaffold(stack, '马上做');
    stack.llm.script('mock-main', [step().inTurn().replyText('做完了。')]);
    stack.llm.script('mock-light', [
      step().replyJson({
        runSummary: '无',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [],
        skillSuggestion: null,
      }),
    ]);
    board(stack).assign(cardId, memberId, 'user');
    board(stack).schedule(cardId, '2099-09-01T00:00:00.000Z', 'user');
    expect(activeSchedule(stack, cardId)).not.toBeNull();

    const events: boolean[] = [];
    const stop = stack.core.onEvent('board.changed', () => {
      events.push(activeSchedule(stack, cardId) === null);
    });
    board(stack).start(cardId, 'user');
    await Promise.resolve();
    stop();
    expect(events).toEqual([true]);
  }, 60_000);

  it('publishes one board.changed for an immediate schedule', async () => {
    const stack = await start();
    const { memberId, cardId } = await scaffold(stack, '立即排期');
    stack.llm.script('mock-main', [step().inTurn().replyText('收到。')]);
    stack.llm.script('mock-light', [
      step().replyJson({
        runSummary: '无',
        memories: [],
        profileProposals: [],
        wikiSuggestions: [],
        skillSuggestion: null,
      }),
    ]);
    board(stack).assign(cardId, memberId, 'user');
    const events: unknown[] = [];
    const stop = stack.core.onEvent('board.changed', () => {
      events.push(true);
    });
    board(stack).schedule(cardId, 'now', 'user');
    await Promise.resolve();
    stop();
    expect(events).toHaveLength(1);
    expect(activeSchedule(stack, cardId)).toBeNull();
  }, 60_000);

  it('lists a card schedule from the project and not from an unrelated chat', async () => {
    const stack = await start();
    const { projectId, memberId, cardId, directId } = await scaffold(stack, '周五核对');
    board(stack).assign(cardId, memberId, 'user');
    board(stack).schedule(cardId, '2099-01-01T00:00:00.000Z', 'user');
    const onProject = stack.core.services.schedules!.listEntries(projectId);
    expect(onProject.some((row) => row.todoId === cardId && row.origin === 'workbench')).toBe(true);
    expect(onProject.find((row) => row.todoId === cardId)?.title.length).toBeGreaterThan(0);
    expect(
      stack.core.services.schedules!.listEntries(directId).some((row) => row.todoId === cardId),
    ).toBe(false);
  });

  it('projects awaitingInput when the card task is waiting on the user', async () => {
    const stack = await start();
    const { projectId, memberId, cardId } = await scaffold(stack);
    const assigned = board(stack).assign(cardId, memberId, 'user');
    const run = stack.core.services.domain!.runs.create({
      botId: memberId,
      conversationId: assigned.card.conversationId!,
      loopType: 'task',
      triggerReason: 'task',
      triggerMessageIds: [],
      taskTitle: '等你回答',
      taskWrites: false,
    });
    expect(cardOf(stack, projectId, cardId).task?.awaitingInput).toBe(false);
    stack.core.services.domain!.runs.update(run.id, { awaitingInput: true });
    expect(cardOf(stack, projectId, cardId).task?.awaitingInput).toBe(true);
  });

  it('keeps the blocked card’s latest thread and still counts a second card', async () => {
    const stack = await start();
    const { projectId, leadId, memberId, cardId } = await scaffold(stack, '离开后还能看');
    const assigned = board(stack).assign(cardId, memberId, 'user');
    const conversationId = assigned.card.conversationId!;
    const message = stack.core.services.domain!.messages.append({
      conversationId,
      senderType: 'bot',
      senderBotId: memberId,
      kind: 'text',
      text: '还没看',
    });
    await stack.core.rpc.call('projects.removeMember', {
      conversationId: projectId,
      botId: memberId,
    });
    const blocked = cardOf(stack, projectId, cardId);
    expect(blocked.todo.assignee).toBeNull();
    expect(blocked.conversationId).toBe(conversationId);
    expect(blocked.unreadCount).toBeGreaterThan(0);
    expect(board(stack).summary(projectId).unread).toBe(blocked.unreadCount);

    const columnId = board(stack).get(projectId, undefined, 'user').columns[0]!.id;
    const otherId = board(stack).createCard(projectId, columnId, '另一张', undefined, 'user').id;
    const other = board(stack).assign(otherId, leadId, 'user');
    stack.core.services.domain!.messages.append({
      conversationId: other.card.conversationId!,
      senderType: 'bot',
      senderBotId: leadId,
      kind: 'text',
      text: '另一张的未读',
    });
    const before = board(stack).summary(projectId).unread;
    expect(before).toBeGreaterThan(blocked.unreadCount);
    stack.core.services.domain!.conversations.markRead(conversationId, message.seq);
    expect(cardOf(stack, projectId, cardId).unreadCount).toBe(0);
    expect(cardOf(stack, projectId, cardId).conversationId).toBe(conversationId);
    expect(board(stack).summary(projectId).unread).toBe(before - blocked.unreadCount);
    expect(board(stack).summary(projectId).unread).toBeGreaterThan(0);
  });

  it('summary counts the open card conversation and not read-only history', async () => {
    const stack = await start();
    const { projectId, leadId, memberId, cardId } = await scaffold(stack);
    const first = board(stack).assign(cardId, memberId, 'user');
    stack.core.services.domain!.messages.append({
      conversationId: first.card.conversationId!,
      senderType: 'bot',
      senderBotId: memberId,
      kind: 'text',
      text: '还没看',
    });
    expect(board(stack).summary(projectId).unread).toBeGreaterThan(0);
    board(stack).assign(cardId, leadId, 'user');
    expect(board(stack).summary(projectId).unread).toBe(0);
    expect(cardOf(stack, projectId, cardId).unreadCount).toBe(0);
  });
});
