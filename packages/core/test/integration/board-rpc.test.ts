import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardCard, BoardChangedPayload, BoardColumn } from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';

/**
 * P1 board RPC methods (modeled on wiki-rpc.test.ts). Execution methods stay unbound.
 */

let stack: TestStack;
let projectId: string;

beforeAll(async () => {
  stack = await createTestStack();
  const lead = await makeBot(stack.core, 'Lead');
  const member = await makeBot(stack.core, 'Member');
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
  it('does not bind the P2 execution methods', () => {
    const methods = stack.core.services.appMethods;
    expect(methods['board.get']).toBeDefined();
    expect(methods['board.columns.create']).toBeDefined();
    expect(methods['board.cards.delete']).toBeDefined();
    for (const name of [
      'board.summary',
      'board.cards.assign',
      'board.cards.schedule',
      'board.cards.start',
      'board.cards.complete',
      'board.cards.cancel',
      'board.cards.reopen',
      'board.cards.conversation',
      'board.cards.reject',
    ]) {
      expect(methods[name]).toBeUndefined();
    }
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
    expect(seeded.events).toContainEqual({ projectId });

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
    expect(createdColumn.events).toContainEqual({ projectId, columnId: column.id });
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
    expect(renamed.events).toContainEqual({ projectId, columnId: column.id });
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
    expect(movedColumns.events).toContainEqual({ projectId, columnId: column.id });

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
    expect(createdCard.events).toContainEqual({
      projectId,
      cardId: card.id,
      columnId: column.id,
    });
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
    expect(updatedCard.events).toContainEqual({
      projectId,
      cardId: card.id,
      columnId: column.id,
    });

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
    expect(movedCard.events).toContainEqual({ projectId, cardId: card.id, columnId: doing });

    await expectCode('board.cards.delete', {}, 'INVALID_INPUT');
    const deleted = watch();
    expect(await call<Record<string, never>>('board.cards.delete', { cardId: card.id })).toEqual(
      {},
    );
    deleted.stop();
    expect(deleted.events).toContainEqual({ projectId, cardId: card.id, columnId: doing });
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
});
