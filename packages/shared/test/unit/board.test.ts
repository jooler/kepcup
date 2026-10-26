import { describe, expect, it } from 'vitest';
import {
  APP_RPC_METHODS,
  BOARD_CARD_TEXT_MAX_CHARS,
  BOARD_COLUMN_TITLE_MAX_CHARS,
  BOARD_CRON_MIN_INTERVAL_MS,
  BOARD_MAX_CARDS,
  BOARD_MAX_COLUMNS,
  BOARD_POSITION_MIN_GAP,
  BOARD_POSITION_STEP,
  ERROR_CODES,
  RPC_EVENT_NAMES,
  boardCardSchema,
  boardColumnSchema,
  boardSummarySchema,
  deriveCardTitle,
  rpcEventSchemas,
  rpcMethodSchemas,
  todoEntrySchema,
  todoRunSchema,
} from '../../src/index.js';

/**
 * Board contract (todo/project-board/README.md §4, P1 step 1).
 * `board.cards.reject` stays out: it is P1 backlog.
 */

const BOARD_METHODS = [
  'board.get',
  'board.summary',
  'board.columns.create',
  'board.columns.update',
  'board.columns.move',
  'board.columns.delete',
  'board.cards.create',
  'board.cards.update',
  'board.cards.move',
  'board.cards.assign',
  'board.cards.schedule',
  'board.cards.start',
  'board.cards.complete',
  'board.cards.cancel',
  'board.cards.reopen',
  'board.cards.delete',
  'board.cards.conversation',
] as const;

const run = {
  id: 'tdr_1',
  todoId: 'todo_1',
  conversationId: 'conv_1',
  messageId: null,
  status: 'dispatched' as const,
  resultMessageId: null,
  dispatchedAt: 2,
  settledAt: null,
};

describe('deriveCardTitle', () => {
  it('uses the first non-empty line and collapses whitespace', () => {
    expect(deriveCardTitle('alpha   beta\tgamma\nsecond')).toBe('alpha beta gamma');
    expect(deriveCardTitle('\n\n  hello  \nworld')).toBe('hello');
    expect(deriveCardTitle('\r\n\r\nfoo   bar\r\nbaz')).toBe('foo bar');
  });

  it('truncates on code points and keeps an emoji whole', () => {
    expect(deriveCardTitle('a'.repeat(120))).toBe('a'.repeat(120));
    expect(deriveCardTitle('a'.repeat(121))).toBe(`${'a'.repeat(119)}…`);
    const emoji = '😀';
    const kept = `${'a'.repeat(118)}${emoji}…`;
    expect(deriveCardTitle(`${'a'.repeat(118)}${emoji}bcdef`)).toBe(kept);
    expect(Array.from(kept)).toHaveLength(120);
    // The emoji is the 120th code point, so it is dropped rather than split.
    expect(deriveCardTitle(`${'a'.repeat(119)}${emoji}tail`)).toBe(`${'a'.repeat(119)}…`);
    expect(deriveCardTitle(`${emoji.repeat(130)}`)).toBe(`${emoji.repeat(119)}…`);
  });

  it('returns an empty string for blank text', () => {
    expect(deriveCardTitle('')).toBe('');
    expect(deriveCardTitle('   \r\n \t \n')).toBe('');
  });
});

describe('board schemas', () => {
  it('round-trips a column, a card, and a summary', () => {
    const column = {
      id: 'bcol_1',
      projectId: 'conv_1',
      title: 'Todo',
      position: 1024,
      createdAt: 1,
    };
    expect(boardColumnSchema.parse(column)).toEqual(column);

    const card = {
      id: 'todo_1',
      projectId: 'conv_1',
      columnId: 'bcol_1',
      position: 1024,
      text: 'line one',
      createdAt: 1,
      updatedAt: 2,
      todo: {
        status: 'draft',
        blockedReason: null,
        source: 'user',
        assignee: null,
        schedule: null,
        lastRun: null,
      },
      conversationId: null,
      unreadCount: 0,
      pendingApprovals: 0,
      task: null,
    };
    expect(boardCardSchema.parse(card)).toEqual(card);
    expect(todoRunSchema.parse(run)).toEqual(run);
    const withRun = {
      ...card,
      todo: {
        ...card.todo,
        assignee: { botId: 'bot_1', name: 'Ada' },
        schedule: {
          id: 'sch_1',
          kind: 'once' as const,
          runAt: 5,
          cron: null,
          timezone: 'UTC',
          nextFireAt: 5,
        },
        lastRun: run,
      },
      conversationId: 'conv_card',
      unreadCount: 2,
      pendingApprovals: 1,
      task: { running: 1, queued: 0, queueReason: null },
    };
    expect(boardCardSchema.parse(withRun)).toEqual(withRun);
    expect(boardSummarySchema.parse({ unread: 1, pendingApprovals: 2, delivered: 3 })).toEqual({
      unread: 1,
      pendingApprovals: 2,
      delivered: 3,
    });
  });

  it('rejects a card missing execution fields', () => {
    expect(
      boardCardSchema.safeParse({
        id: 'todo_1',
        projectId: 'conv_1',
        columnId: 'bcol_1',
        position: 1,
        text: 'x',
        createdAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe('board RPC and events', () => {
  it('registers every board method except reject', () => {
    for (const name of BOARD_METHODS) {
      expect(APP_RPC_METHODS).toContain(name);
      expect(rpcMethodSchemas[name]).toBeDefined();
    }
    expect(APP_RPC_METHODS).not.toContain('board.cards.reject');
    expect('board.cards.reject' in rpcMethodSchemas).toBe(false);
  });

  it('parses board.get seed titles and board.changed', () => {
    expect(rpcMethodSchemas['board.get'].input.parse({ projectId: 'conv_1' })).toEqual({
      projectId: 'conv_1',
    });
    expect(
      rpcMethodSchemas['board.get'].input.parse({
        projectId: 'conv_1',
        seedTitles: ['Todo', 'Doing'],
      }).seedTitles,
    ).toEqual(['Todo', 'Doing']);
    expect(rpcMethodSchemas['board.get'].input.safeParse({}).success).toBe(false);
    expect(
      rpcMethodSchemas['board.cards.move'].input.parse({
        cardId: 'todo_1',
        columnId: 'bcol_1',
        beforeCardId: null,
      }),
    ).toEqual({ cardId: 'todo_1', columnId: 'bcol_1', beforeCardId: null });
    // Omitted anchor means "top of the column". A default of null would append.
    expect(
      rpcMethodSchemas['board.cards.create'].input.parse({
        projectId: 'conv_1',
        columnId: 'bcol_1',
        text: 'hi',
      }),
    ).toEqual({ projectId: 'conv_1', columnId: 'bcol_1', text: 'hi' });
    expect(rpcMethodSchemas['board.columns.delete'].input.parse({ columnId: 'bcol_1' })).toEqual({
      columnId: 'bcol_1',
    });
    const entry = {
      id: 'todo_1',
      title: 't',
      notes: '',
      assignee: null,
      status: 'draft' as const,
      source: 'user' as const,
      memoId: null,
      blockedReason: null,
      createdAt: 1,
      updatedAt: 1,
      closedAt: null,
      assigneeName: null,
      leadBotName: null,
      schedule: null,
      lastRun: null,
      board: { projectId: 'conv_1', columnId: 'bcol_1' },
    };
    expect(todoEntrySchema.parse(entry).board).toEqual({ projectId: 'conv_1', columnId: 'bcol_1' });
    const { board: _board, ...withoutBoard } = entry;
    expect(todoEntrySchema.parse(withoutBoard).board).toBeNull();

    expect(RPC_EVENT_NAMES).toContain('board.changed');
    expect(rpcEventSchemas['board.changed'].parse({ projectId: 'conv_1' })).toEqual({
      projectId: 'conv_1',
    });
    expect(
      rpcEventSchemas['board.changed'].parse({
        projectId: 'conv_1',
        cardId: 'todo_1',
        columnId: 'bcol_1',
      }),
    ).toEqual({ projectId: 'conv_1', cardId: 'todo_1', columnId: 'bcol_1' });
    expect(rpcEventSchemas['board.changed'].safeParse({}).success).toBe(false);
  });
});

describe('board constants and error codes', () => {
  it('matches the fixed contract', () => {
    expect(BOARD_MAX_COLUMNS).toBe(20);
    expect(BOARD_MAX_CARDS).toBe(500);
    expect(BOARD_CARD_TEXT_MAX_CHARS).toBe(4000);
    expect(BOARD_COLUMN_TITLE_MAX_CHARS).toBe(60);
    expect(BOARD_POSITION_STEP).toBe(1024);
    expect(BOARD_POSITION_MIN_GAP).toBe(1e-3);
    expect(BOARD_CRON_MIN_INTERVAL_MS).toBe(3_600_000);
    for (const code of [
      'BOARD_MANAGED',
      'BOARD_LIMIT_COLUMNS',
      'BOARD_LIMIT_CARDS',
      'BOARD_LAST_COLUMN',
      'BOARD_COLUMN_NOT_EMPTY',
      'BOARD_TEXT_EMPTY',
      'BOARD_CRON_TOO_FREQUENT',
      'BOARD_PROJECT_READ_ONLY',
      'BOARD_ASSIGNEE_INVALID',
      'BOARD_LOCKED',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
