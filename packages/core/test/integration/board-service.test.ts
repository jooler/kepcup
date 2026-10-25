import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  BOARD_CARD_TEXT_MAX_CHARS,
  BOARD_MAX_CARDS,
  BOARD_MAX_COLUMNS,
  BOARD_POSITION_MIN_GAP,
  deriveCardTitle,
  type BoardCard,
  type BoardChangedPayload,
} from '@kepcup/shared';
import { createTestStack, makeBot, makeProject, type TestStack } from '@kepcup/testkit';
import type { BoardService } from '../../src/board/board-service.js';

/**
 * BoardService against a real database (P1 step 3 / step 5).
 */

let stack: TestStack;
let members: string[];

beforeAll(async () => {
  stack = await createTestStack();
  const lead = await makeBot(stack.core, 'Lead');
  const member = await makeBot(stack.core, 'Member');
  members = [lead.id, member.id];
}, 60_000);

afterAll(() => stack.cleanup());

function board(): BoardService {
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

async function freshProject(title: string): Promise<string> {
  return (await makeProject(stack.core, title, members)).id;
}

function cardIds(projectId: string): string[] {
  return board()
    .get(projectId, undefined, 'user')
    .cards.map((card) => card.id);
}

describe('BoardService', () => {
  it('seeds once, and an unseeded board stays empty', async () => {
    const projectId = await freshProject('seed');
    expect(board().get(projectId, undefined, 'user')).toEqual({ columns: [], cards: [] });
    const first = board().get(projectId, ['  Todo  ', '', 'Doing', 'Done'], 'user');
    expect(first.columns.map((column) => column.title)).toEqual(['Todo', 'Doing', 'Done']);
    expect(first.cards).toEqual([]);
    const again = board().get(projectId, ['Other'], 'user');
    expect(again.columns.map((column) => column.title)).toEqual(['Todo', 'Doing', 'Done']);
  });

  it('rejects empty and over-long text, and stores a derived title', async () => {
    const projectId = await freshProject('text');
    const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
    expect(
      codeOf(() => board().createCard(projectId, columnId, '   \n  ', undefined, 'user')),
    ).toBe('BOARD_TEXT_EMPTY');
    expect(
      codeOf(() =>
        board().createCard(
          projectId,
          columnId,
          'a'.repeat(BOARD_CARD_TEXT_MAX_CHARS + 1),
          undefined,
          'user',
        ),
      ),
    ).toBe('INVALID_INPUT');
    const emoji = '😀';
    const text = `${'a'.repeat(118)}${emoji}\nsecond line`;
    const card = board().createCard(projectId, columnId, text, undefined, 'user');
    expect(card.text).toBe(text);
    expect(card.todo).toMatchObject({
      status: 'draft',
      source: 'user',
      assignee: null,
      schedule: null,
      lastRun: null,
    });
    expect(card.conversationId).toBeNull();
    expect(card.unreadCount).toBe(0);
    expect(card.pendingApprovals).toBe(0);
    expect(card.task).toBeNull();
    const row = stack.core.services
      .mainDb!.prepare('select title, notes from todos where id = ?')
      .get(card.id) as { title: string; notes: string };
    expect(row.notes).toBe(text);
    expect(row.title).toBe(deriveCardTitle(text));
  });

  it('creates cards at the top by default and honors beforeCardId', async () => {
    const projectId = await freshProject('order');
    const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
    const a = board().createCard(projectId, columnId, 'A', undefined, 'user');
    const b = board().createCard(projectId, columnId, 'B', undefined, 'user');
    const end = board().createCard(projectId, columnId, 'End', null, 'user');
    const mid = board().createCard(projectId, columnId, 'Mid', a.id, 'user');
    expect(cardIds(projectId)).toEqual([b.id, mid.id, a.id, end.id]);
  });

  it('renumbers a column after repeated inserts into the same gap and keeps order', async () => {
    const projectId = await freshProject('gap');
    const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
    const head = board().createCard(projectId, columnId, 'head', undefined, 'user');
    const tail = board().createCard(projectId, columnId, 'tail', null, 'user');
    const inserted: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      inserted.push(board().createCard(projectId, columnId, `n${i}`, tail.id, 'user').id);
    }
    const cards = board().get(projectId, undefined, 'user').cards;
    expect(cards.map((card) => card.id)).toEqual([head.id, ...inserted, tail.id]);
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i]!.position - cards[i - 1]!.position).toBeGreaterThanOrEqual(
        BOARD_POSITION_MIN_GAP,
      );
    }
  }, 30_000);

  it('refuses a move onto another project', async () => {
    const left = await freshProject('left');
    const right = await freshProject('right');
    const leftColumn = board().get(left, ['Todo'], 'user').columns[0]!.id;
    const rightColumn = board().get(right, ['Todo'], 'user').columns[0]!.id;
    const card = board().createCard(left, leftColumn, 'stay', undefined, 'user');
    expect(codeOf(() => board().moveCard(card.id, rightColumn, null, 'user'))).toBe(
      'INVALID_INPUT',
    );
    expect(cardIds(left)).toEqual([card.id]);
  });

  it('refuses the last column and both branches of a non-empty column', async () => {
    const projectId = await freshProject('columns');
    const seeded = board().get(projectId, ['Only'], 'user');
    const only = seeded.columns[0]!.id;
    expect(codeOf(() => board().deleteColumn(only, true, 'user'))).toBe('BOARD_LAST_COLUMN');
    const extra = board().createColumn(projectId, 'Extra', null, 'user');
    const card = board().createCard(projectId, extra.id, 'inside', undefined, 'user');
    expect(codeOf(() => board().deleteColumn(extra.id, undefined, 'user'))).toBe(
      'BOARD_COLUMN_NOT_EMPTY',
    );
    expect(cardIds(projectId)).toEqual([card.id]);
    board().deleteColumn(extra.id, true, 'user');
    expect(cardIds(projectId)).toEqual([]);
    expect(
      stack.core.services.mainDb!.prepare('select id from todos where id = ?').get(card.id),
    ).toBeUndefined();
    expect(
      board()
        .get(projectId, undefined, 'user')
        .columns.map((column) => column.id),
    ).toEqual([only]);
    expect(codeOf(() => board().deleteColumn(only, false, 'user'))).toBe('BOARD_LAST_COLUMN');
  });

  it('rejects every write on a read-only project', async () => {
    const projectId = await freshProject('readonly');
    const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
    const card = board().createCard(projectId, columnId, 'keep', undefined, 'user');
    stack.core.services.domain!.conversations.setReadOnly(projectId, true);
    const writes: Array<() => unknown> = [
      () => board().createColumn(projectId, 'More', null, 'user'),
      () => board().updateColumn(columnId, 'Renamed', 'user'),
      () => board().moveColumn(columnId, null, 'user'),
      () => board().deleteColumn(columnId, true, 'user'),
      () => board().createCard(projectId, columnId, 'nope', undefined, 'user'),
      () => board().updateCard(card.id, 'nope', 'user'),
      () => board().moveCard(card.id, columnId, null, 'user'),
      () => board().deleteCard(card.id, 'user'),
    ];
    for (const write of writes) expect(codeOf(write)).toBe('BOARD_PROJECT_READ_ONLY');
    expect(
      board()
        .get(projectId, undefined, 'user')
        .cards.map((item) => item.id),
    ).toEqual([card.id]);

    const empty = await freshProject('readonly-empty');
    stack.core.services.domain!.conversations.setReadOnly(empty, true);
    expect(codeOf(() => board().get(empty, ['Todo'], 'user'))).toBe('BOARD_PROJECT_READ_ONLY');
    expect(board().get(empty, undefined, 'user').columns).toEqual([]);
  });

  it('enforces column and card limits and the member write check', async () => {
    const projectId = await freshProject('limits');
    for (let i = 0; i < BOARD_MAX_COLUMNS; i += 1) {
      board().createColumn(projectId, `C${i}`, null, 'user');
    }
    expect(codeOf(() => board().createColumn(projectId, 'overflow', null, 'user'))).toBe(
      'BOARD_LIMIT_COLUMNS',
    );
    expect(codeOf(() => board().createColumn(projectId, 'nope', null, 'member'))).toBe(
      'INVALID_INPUT',
    );

    const cardsProject = await freshProject('cards');
    const columnId = board().get(cardsProject, ['Todo'], 'user').columns[0]!.id;
    let last: BoardCard | null = null;
    for (let i = 0; i < BOARD_MAX_CARDS; i += 1) {
      last = board().createCard(cardsProject, columnId, `card ${i}`, undefined, 'user');
    }
    expect(last).not.toBeNull();
    expect(
      codeOf(() => board().createCard(cardsProject, columnId, 'one more', undefined, 'user')),
    ).toBe('BOARD_LIMIT_CARDS');
  }, 60_000);

  it('a no-op move does not publish, and a real move does', async () => {
    const projectId = await freshProject('events');
    const columnId = board().get(projectId, ['Todo', 'Doing'], 'user').columns[0]!.id;
    const card = board().createCard(projectId, columnId, 'card', undefined, 'user');
    const boardEvents: BoardChangedPayload[] = [];
    const todoEvents: unknown[] = [];
    const stopBoard = stack.core.services.events.on('board.changed', (payload) => {
      boardEvents.push(payload);
    });
    const stopTodos = stack.core.services.events.on('todos.changed', (payload) => {
      todoEvents.push(payload);
    });
    board().moveCard(card.id, columnId, null, 'user');
    expect(boardEvents).toEqual([]);
    expect(todoEvents).toEqual([]);
    const doing = board().get(projectId, undefined, 'user').columns[1]!.id;
    board().moveCard(card.id, doing, null, 'user');
    expect(boardEvents).toContainEqual({ projectId, cardId: card.id, columnId: doing });
    expect(todoEvents).toEqual([]);
    stopBoard();
    stopTodos();
  });

  it('lifecycle.deleteConversation purges board todos, side rows, and columns', async () => {
    const projectId = await freshProject('delete-me');
    const columnId = board().get(projectId, ['Todo'], 'user').columns[0]!.id;
    const card = board().createCard(projectId, columnId, 'gone', undefined, 'user');
    await stack.core.services.domain!.lifecycle.deleteConversation(projectId);
    const db = stack.core.services.mainDb!;
    expect(db.prepare('select id from todos where id = ?').get(card.id)).toBeUndefined();
    expect(
      db.prepare('select count(*) as n from board_cards where project_id = ?').get(projectId),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('select count(*) as n from board_columns where project_id = ?').get(projectId),
    ).toEqual({ n: 0 });
  });
});
