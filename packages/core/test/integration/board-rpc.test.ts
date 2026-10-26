import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardCard, BoardChangedPayload, BoardColumn } from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';
import { ScheduleAdapter } from '../../src/handover/adapters/schedule.js';

/**
 * P1 board RPC methods (modeled on wiki-rpc.test.ts). Execution methods stay unbound.
 */

let stack: TestStack;
let projectId: string;
let leadId: string;
let memberId: string;

beforeAll(async () => {
  stack = await createTestStack();
  const lead = await makeBot(stack.core, 'Lead');
  const member = await makeBot(stack.core, 'Member');
  leadId = lead.id;
  memberId = member.id;
  projectId = (await makeProject(stack.core, 'RPC board', [lead.id, member.id])).id;
}, 60_000);

afterAll(() => stack.cleanup());

async function call<T>(method: string, input: unknown): Promise<T> {
  return (await stack.core.rpc.call(method, input)) as T;
}

async function expectCode(method: string, input: unknown, code: string): Promise<void> {
  await expect(stack.core.rpc.call(method, input)).rejects.toMatchObject({ code });
}

function watch(): { events: BoardChangedPayload[]; stop: () => void } {
  const events: BoardChangedPayload[] = [];
  const stop = stack.core.onEvent('board.changed', (payload) => {
    events.push(payload);
  });
  return { events, stop };
}

describe('board RPC', () => {
  it('binds the execution methods and leaves reject unbound', () => {
    const methods = stack.core.services.appMethods;
    for (const name of [
      'board.summary',
      'board.cards.assign',
      'board.cards.schedule',
      'board.cards.start',
      'board.cards.complete',
      'board.cards.cancel',
      'board.cards.reopen',
      'board.cards.conversation',
    ]) {
      expect(methods[name]).toBeDefined();
    }
    expect(methods['board.cards.reject']).toBeUndefined();
  });

  it('assigns, summarizes, and rejects a too-frequent cron', async () => {
    const ownProjectId = (await makeProject(stack.core, 'RPC exec', [leadId, memberId])).id;
    const column = (
      await call<{ column: BoardColumn }>('board.columns.create', {
        projectId: ownProjectId,
        title: 'Exec',
      })
    ).column;
    const created = await call<{ card: BoardCard }>('board.cards.create', {
      projectId: ownProjectId,
      columnId: column.id,
      text: 'RPC 执行',
    });
    await expectCode('board.cards.assign', { cardId: created.card.id, botId: 'bot_missing' }, 'BOARD_ASSIGNEE_INVALID');
    const assigned = await call<{ card: BoardCard; warnings: string[] }>('board.cards.assign', {
      cardId: created.card.id,
      botId: memberId,
    });
    expect(assigned.card.todo.assignee?.botId).toBe(memberId);
    expect(assigned.card.conversationId).not.toBeNull();
    const conversation = await call<{ conversationId: string }>('board.cards.conversation', {
      cardId: created.card.id,
    });
    expect(conversation.conversationId).toBe(assigned.card.conversationId);
    await expectCode(
      'board.cards.schedule',
      { cardId: created.card.id, when: '* * * * *' },
      'BOARD_CRON_TOO_FREQUENT',
    );
    const summary = await call<{ unread: number; pendingApprovals: number; delivered: number }>(
      'board.summary',
      { projectId: ownProjectId },
    );
    expect(summary).toEqual({ unread: 0, pendingApprovals: 0, delivered: 0 });
    await expectCode('board.cards.assign', { cardId: 'missing' }, 'INVALID_INPUT');
  });

  it('validates input, succeeds, publishes board.changed, and returns error codes', async () => {
    await expectCode('board.get', {}, 'INVALID_INPUT');
    await expectCode('board.get', { projectId: 'conv_missing' }, 'NOT_FOUND');

    const seeded = watch();
    const got = await call<{ columns: BoardColumn[]; cards: BoardCard[] }>('board.get', {
      projectId,
      seedTitles: ['Todo', 'Doing'],
    });
    seeded.stop();
    expect(got.columns.map((column) => column.title)).toEqual(['Todo', 'Doing']);
    expect(got.cards).toEqual([]);
    expect(seeded.events).toEqual([{ projectId }]);

    await expectCode('board.columns.create', { projectId }, 'INVALID_INPUT');
    const createdColumn = watch();
    const column = (
      await call<{ column: BoardColumn }>('board.columns.create', {
        projectId,
        title: 'Later',
      })
    ).column;
    createdColumn.stop();
    expect(column.title).toBe('Later');
    expect(createdColumn.events).toEqual([{ projectId, columnId: column.id }]);
    await expectCode('board.columns.create', { projectId, title: '   ' }, 'INVALID_INPUT');

    await expectCode('board.columns.update', { columnId: column.id }, 'INVALID_INPUT');
    const renamed = watch();
    const updated = (
      await call<{ column: BoardColumn }>('board.columns.update', {
        columnId: column.id,
        title: 'Later renamed',
      })
    ).column;
    renamed.stop();
    expect(updated.title).toBe('Later renamed');
    expect(renamed.events).toEqual([{ projectId, columnId: column.id }]);
    await expectCode('board.columns.update', { columnId: 'bcol_missing', title: 'x' }, 'NOT_FOUND');

    await expectCode('board.columns.move', { columnId: column.id }, 'INVALID_INPUT');
    const movedColumns = watch();
    const columns = (
      await call<{ columns: BoardColumn[] }>('board.columns.move', {
        columnId: column.id,
        beforeColumnId: got.columns[0]!.id,
      })
    ).columns;
    movedColumns.stop();
    expect(columns[0]?.id).toBe(column.id);
    expect(movedColumns.events).toEqual([{ projectId, columnId: column.id }]);

    await expectCode('board.cards.create', { projectId, columnId: column.id }, 'INVALID_INPUT');
    const createdCard = watch();
    const card = (
      await call<{ card: BoardCard }>('board.cards.create', {
        projectId,
        columnId: column.id,
        text: 'Hello board',
      })
    ).card;
    createdCard.stop();
    expect(card.text).toBe('Hello board');
    expect(card.todo.assignee).toBeNull();
    expect(createdCard.events).toEqual([
      {
        projectId,
        cardId: card.id,
        columnId: column.id,
      },
    ]);
    await expectCode(
      'board.cards.create',
      { projectId, columnId: column.id, text: '   ' },
      'BOARD_TEXT_EMPTY',
    );

    await expectCode('board.cards.update', { cardId: card.id }, 'INVALID_INPUT');
    const updatedCard = watch();
    const next = (
      await call<{ card: BoardCard }>('board.cards.update', {
        cardId: card.id,
        text: 'Hello again',
      })
    ).card;
    updatedCard.stop();
    expect(next.text).toBe('Hello again');
    expect(updatedCard.events).toEqual([
      {
        projectId,
        cardId: card.id,
        columnId: column.id,
      },
    ]);

    const doing = got.columns[1]!.id;
    await expectCode('board.cards.move', { cardId: card.id, columnId: doing }, 'INVALID_INPUT');
    const movedCard = watch();
    const moved = await call<{ card: BoardCard; renumbered?: BoardCard[] }>('board.cards.move', {
      cardId: card.id,
      columnId: doing,
      beforeCardId: null,
    });
    movedCard.stop();
    expect(moved.card.columnId).toBe(doing);
    expect(movedCard.events).toEqual([{ projectId, cardId: card.id, columnId: doing }]);

    await expectCode('board.cards.delete', {}, 'INVALID_INPUT');
    const deleted = watch();
    expect(await call<Record<string, never>>('board.cards.delete', { cardId: card.id })).toEqual(
      {},
    );
    deleted.stop();
    expect(deleted.events).toEqual([{ projectId, cardId: card.id, columnId: doing }]);
    await expectCode('board.cards.delete', { cardId: card.id }, 'NOT_FOUND');

    await expectCode('board.columns.delete', { columnId: 'bcol_missing' }, 'NOT_FOUND');
    const todoColumn = got.columns[0]!.id;
    await call('board.cards.create', { projectId, columnId: todoColumn, text: 'stay' });
    await expectCode('board.columns.delete', { columnId: todoColumn }, 'BOARD_COLUMN_NOT_EMPTY');
    // Three columns exist (Todo, Doing, Later). Deleting down to one must stop.
    await call('board.columns.delete', { columnId: column.id });
    await call('board.columns.delete', { columnId: doing, deleteCards: true });
    await expectCode(
      'board.columns.delete',
      { columnId: todoColumn, deleteCards: true },
      'BOARD_LAST_COLUMN',
    );
  });

  it('does not offer a board schedule for handover', async () => {
    const ownProjectId = (await makeProject(stack.core, 'RPC handover', [leadId, memberId])).id;
    const column = (
      await call<{ column: BoardColumn }>('board.columns.create', {
        projectId: ownProjectId,
        title: 'Exec',
      })
    ).column;
    const created = await call<{ card: BoardCard }>('board.cards.create', {
      projectId: ownProjectId,
      columnId: column.id,
      text: '不要移交',
    });
    await call('board.cards.assign', { cardId: created.card.id, botId: memberId });
    const scheduled = await call<{ card: BoardCard }>('board.cards.schedule', {
      cardId: created.card.id,
      when: '2099-04-01T00:00:00.000Z',
    });
    const boardScheduleId = scheduled.card.todo.schedule?.id;
    expect(boardScheduleId).toBeTruthy();
    const directId = (
      (await stack.core.rpc.call('conversations.openDirect', { botId: memberId })) as {
        conversation: { id: string };
      }
    ).conversation.id;
    const direct = stack.core.services.schedules!.createFromWhen({
      botId: memberId,
      conversationId: directId,
      when: '2099-05-01T00:00:00.000Z',
      note: '私聊提醒',
      title: '私聊提醒',
      origin: 'tool',
    });
    const adapter = new ScheduleAdapter({
      schedules: {
        listActiveForBot: (botId) => stack.core.services.schedules!.listActiveForBot(botId),
        get: (id) => stack.core.services.schedules!.store.get(id),
        transferTo: () => {
          throw new Error('transferred');
        },
        transferredTo: () => false,
        describeWhen: (row) => stack.core.services.schedules!.describeWhen(row),
      },
      conversations: {
        get: (id) => stack.core.services.domain!.conversations.get(id),
        memberBotIds: (id) => stack.core.services.domain!.conversations.memberBotIds(id),
        directIdFor: (botId) =>
          stack.core.services.domain!.conversations.openDirect(botId).conversation.id,
      },
      todos: {
        onScheduleTransferred: () => undefined,
        isBoardTodo: (todoId) => stack.core.services.todos!.isBoardTodo(todoId),
      },
    });
    const keys = adapter.inventory(memberId).map((entry) => entry.key);
    expect(keys).toContain(`schedule:${direct.id}`);
    expect(keys).not.toContain(`schedule:${boardScheduleId}`);
    const from = stack.core.services.domain!.bots.get(memberId)!;
    expect(
      adapter.validate(
        { handoverId: 'hov_test', fromBot: from, toBot: null, toName: '接手' },
        `schedule:${boardScheduleId}`,
        'move',
      ),
    ).toBe('看板卡片的排期不随移交带走');
    await expect(
      adapter.apply(
        { handoverId: 'hov_test', fromBot: from, toBot: from, toName: '接手' },
        `schedule:${boardScheduleId}`,
      ),
    ).rejects.toThrow(/不随移交带走/);
    expect(stack.core.services.schedules!.store.get(boardScheduleId!)?.botId).toBe(memberId);
  });
});
