import type { BoardCard, BoardColumn } from '@kepcup/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Board store: seed on the first fetch, optimistic writes with rollback,
 * stale refetches dropped, events held during a drag, and closeCard when
 * chat.select() settles. Real Svelte runes (desktop-svelte); core is a stub.
 */

const calls: Array<{ method: string; params: unknown }> = [];
const handlers = new Map<string, Set<(payload: unknown) => void>>();
const pending: Array<{
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}> = [];

let hangGets = false;
let failMethod: { method: string; code: string } | null = null;
let columns: BoardColumn[] = [];
let cards: BoardCard[] = [];

function column(id: string, title: string, position: number): BoardColumn {
  return { id, projectId: 'p1', title, position, createdAt: position };
}

function card(id: string, columnId: string, text: string, position: number): BoardCard {
  return {
    id,
    projectId: 'p1',
    columnId,
    position,
    text,
    createdAt: position,
    updatedAt: position,
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
}

vi.mock('svelte-sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    call: (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (failMethod !== null && failMethod.method === method) {
        const failure = failMethod;
        failMethod = null;
        const error = new Error(failure.code) as Error & { code: string };
        error.code = failure.code;
        return Promise.reject(error);
      }
      if (method === 'board.get' && hangGets) {
        return new Promise((resolve, reject) => {
          pending.push({ method, resolve, reject });
        });
      }
      if (method === 'board.get') return Promise.resolve({ columns, cards });
      if (method === 'board.columns.create') {
        const input = params as { title: string; projectId: string };
        const created = column('bcol_real', input.title, 100);
        return Promise.resolve({ column: created });
      }
      if (method === 'board.columns.update') {
        const input = params as { columnId: string; title: string };
        return Promise.resolve({
          column: column(input.columnId, input.title, 1),
        });
      }
      if (method === 'board.cards.create') {
        const input = params as { columnId: string; text: string; projectId: string };
        return Promise.resolve({ card: card('card_real', input.columnId, input.text, 1) });
      }
      if (method === 'conversations.get') {
        const id = (params as { id?: string } | undefined)?.id;
        if (id === 'missing') return Promise.resolve({ conversation: null });
        return Promise.resolve({
          conversation: {
            id,
            type: 'direct',
            title: null,
            directBotId: `bot_${id}`,
            workdirId: null,
            readOnly: false,
            summary: null,
            summaryUptoSeq: 0,
            lastSeq: 0,
            lastReadSeq: 0,
            unreadCount: 0,
            lastMessageAt: null,
            createdAt: 1,
            bot: { id: `bot_${id}`, name: id, status: 'active', avatar: null },
          },
        });
      }
      if (method === 'messages.list') return Promise.resolve({ messages: [] });
      if (method === 'runs.list') return Promise.resolve({ runs: [] });
      if (method === 'tasks.active') return Promise.resolve({ tasks: [] });
      if (method === 'approvals.list') return Promise.resolve({ approvals: [] });
      if (method === 'grants.list') return Promise.resolve({ grants: [] });
      return Promise.resolve({});
    },
  },
}));

const { board, BOARD_REFRESH_DEBOUNCE_MS } = await import('./board.svelte');
const { chat } = await import('$lib/stores/chat.svelte');
const { toast } = await import('svelte-sonner');
const { t, i18n } = await import('$lib/i18n');

const count = (method: string): number => calls.filter((call) => call.method === method).length;
const emit = (payload: unknown): void => {
  for (const handler of handlers.get('board.changed') ?? []) handler(payload);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let detach: (() => void) | null = null;

beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  pending.length = 0;
  hangGets = false;
  failMethod = null;
  columns = [column('bcol_a', 'Old', 1)];
  cards = [card('card_a', 'bcol_a', 'hello', 1)];
  i18n.locale = 'zh-CN';
  board.closeCard();
  board.setDragging(false);
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  detach?.();
  detach = null;
});

describe('attach / seed / refresh', () => {
  it('first fetch passes the current language seed titles; a later refetch does not', async () => {
    detach = board.attach('p1');
    await wait(20);
    emit({ projectId: 'p1' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    const gets = calls.filter((call) => call.method === 'board.get');
    expect(gets.length).toBeGreaterThanOrEqual(2);
    expect((gets[0]?.params as { seedTitles?: string[] }).seedTitles).toEqual([
      t('board.defaultColumns.todo'),
      t('board.defaultColumns.doing'),
      t('board.defaultColumns.done'),
    ]);
    expect((gets[1]?.params as { seedTitles?: string[] }).seedTitles).toBeUndefined();
    expect(board.columns.map((column) => column.id)).toEqual(['bcol_a']);
    expect(board.loading).toBe(false);
  });

  it('ignores board.changed for a different project', async () => {
    detach = board.attach('p1');
    await wait(20);
    const before = count('board.get');
    emit({ projectId: 'other' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before);
  });

  it('drops a stale response when a newer fetch or a newer edit won', async () => {
    hangGets = true;
    detach = board.attach('p1');
    await wait(20);
    expect(pending).toHaveLength(1);
    hangGets = false;
    columns = [column('bcol_a', 'FromSecond', 1)];
    emit({ projectId: 'p1', columnId: 'bcol_a' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(2);
    // The first request is still hanging. Resolve it with older data after the second applied.
    pending[0]?.resolve({ columns: [column('bcol_a', 'Stale', 1)], cards: [] });
    await wait(20);
    expect(board.columns.map((column) => column.title)).toEqual(['FromSecond']);

    hangGets = true;
    emit({ projectId: 'p1' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    const hanging = pending.at(-1);
    expect(hanging).toBeDefined();
    board.renameColumn('bcol_a', 'Newer');
    hanging?.resolve({ columns: [column('bcol_a', 'StaleAgain', 1)], cards: [] });
    await wait(20);
    expect(board.columns.map((column) => column.title)).toEqual(['Newer']);
  });

  it('defers events while dragging and refetches once the drag ends', async () => {
    detach = board.attach('p1');
    await wait(20);
    const before = count('board.get');
    board.setDragging(true);
    emit({ projectId: 'p1', cardId: 'card_a' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before);
    board.setDragging(false);
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before + 1);
  });
});

describe('optimistic writes', () => {
  it('shows a created column immediately and rolls it back when the RPC fails', async () => {
    detach = board.attach('p1');
    await wait(20);
    failMethod = { method: 'board.columns.create', code: 'BOARD_LIMIT_COLUMNS' };
    const pendingCreate = board.createColumn('Overflow');
    expect(board.columns.some((column) => column.title === 'Overflow')).toBe(true);
    expect(await pendingCreate).toBe(false);
    expect(board.columns.map((column) => column.id)).toEqual(['bcol_a']);
    expect(toast.error).toHaveBeenCalled();
  });

  it('keeps an optimistic rename when the synchronous change event refetches', async () => {
    detach = board.attach('p1');
    await wait(20);
    hangGets = true;
    const renamed = board.renameColumn('bcol_a', 'Edited');
    expect(board.columns[0]?.title).toBe('Edited');
    // The server publishes board.changed before the RPC resolves.
    emit({ projectId: 'p1', columnId: 'bcol_a' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(board.columns[0]?.title).toBe('Edited');
    await renamed;
    expect(board.columns[0]?.title).toBe('Edited');
  });
});

describe('closeCard follows chat.select()', () => {
  it('clears the open card when select() resets the project view', async () => {
    board.openCard('card_a');
    await chat.select('c1');
    expect(board.openCardId).toBeNull();
  });

  it('leaves the open card alone when select() cannot find the conversation', async () => {
    board.openCard('card_a');
    await chat.select('missing');
    expect(board.openCardId).toBe('card_a');
  });
});
