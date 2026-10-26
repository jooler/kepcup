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
const hangMethods = new Set<string>();
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
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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
      if ((method === 'board.get' && hangGets) || hangMethods.has(method)) {
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
        const existing = columns.find((item) => item.id === input.columnId);
        const updated = column(input.columnId, input.title, existing?.position ?? 1);
        const index = columns.findIndex((item) => item.id === input.columnId);
        if (index >= 0) columns[index] = updated;
        return Promise.resolve({ column: updated });
      }
      if (method === 'board.cards.create') {
        const input = params as { columnId: string; text: string; projectId: string };
        return Promise.resolve({ card: card('card_real', input.columnId, input.text, 1) });
      }
      if (method === 'board.cards.update') {
        const input = params as { cardId: string; text: string };
        const existing = cards.find((item) => item.id === input.cardId);
        const updated = card(
          input.cardId,
          existing?.columnId ?? 'bcol_a',
          input.text,
          existing?.position ?? 1,
        );
        const index = cards.findIndex((item) => item.id === input.cardId);
        if (index >= 0) cards[index] = updated;
        return Promise.resolve({ card: updated });
      }
      if (method === 'board.cards.move') {
        const input = params as { cardId: string; columnId: string; beforeCardId: string | null };
        const existing = cards.find((item) => item.id === input.cardId);
        return Promise.resolve({
          card: card(input.cardId, input.columnId, existing?.text ?? '', existing?.position ?? 1),
        });
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
  emitEvent('board.changed', payload);
};
const emitEvent = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let detach: (() => void) | null = null;

beforeEach(() => {
  calls.length = 0;
  handlers.clear();
  pending.length = 0;
  hangGets = false;
  hangMethods.clear();
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

  it('swaps a temp card id when a later edit landed, and keeps the open card', async () => {
    columns = [column('bcol_a', 'A', 1), column('bcol_b', 'B', 2)];
    cards = [card('card_a', 'bcol_a', 'a', 1), card('card_b', 'bcol_a', 'b', 2)];
    detach = board.attach('p1');
    await wait(20);
    hangMethods.add('board.cards.create');
    const creating = board.createCard('bcol_a', 'new');
    const tempId = board.columns[0]?.cards[0]?.id ?? '';
    expect(tempId.startsWith('tmp_')).toBe(true);
    board.openCard(tempId);
    // Another edit bumps the epoch before the create RPC returns.
    await board.renameColumn('bcol_a', 'Renamed');
    const saving = board.updateCardText(tempId, 'edited later');
    cards = [
      card('card_real', 'bcol_a', 'edited later', 10),
      card('card_a', 'bcol_a', 'a', 100),
      card('card_b', 'bcol_a', 'b', 200),
    ];
    columns = [column('bcol_a', 'Renamed', 1), column('bcol_b', 'B', 2)];
    emit({ projectId: 'p1', cardId: 'card_real' });
    pending.find((call) => call.method === 'board.cards.create')?.resolve({
      card: card('card_real', 'bcol_a', 'new', 10),
    });
    expect(await creating).toBe(true);
    expect(board.openCardId).toBe('card_real');
    expect(await saving).toBe(true);
    const updates = calls.filter((call) => call.method === 'board.cards.update');
    expect(updates.map((call) => (call.params as { cardId: string }).cardId)).toEqual(['card_real']);
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 80);
    const columnA = board.columns.find((column) => column.id === 'bcol_a');
    expect(columnA?.cards.map((card) => card.id)).toEqual(['card_real', 'card_a', 'card_b']);
    expect(columnA?.cards.map((card) => card.position)).toEqual([10, 100, 200]);
    expect(columnA?.cards[0]?.text).toBe('edited later');
    expect(columnA?.cards[0]?.localKey).toBe(tempId);
    expect(board.openCardId).toBe('card_real');
  });

  it('fails a text save queued on a temp id when the create fails', async () => {
    detach = board.attach('p1');
    await wait(20);
    hangMethods.add('board.cards.create');
    const creating = board.createCard('bcol_a', 'new');
    const tempId = board.columns[0]?.cards[0]?.id ?? '';
    const saving = board.updateCardText(tempId, 'doomed');
    const error = new Error('BOARD_LIMIT_CARDS') as Error & { code: string };
    error.code = 'BOARD_LIMIT_CARDS';
    pending.find((call) => call.method === 'board.cards.create')?.reject(error);
    expect(await creating).toBe(false);
    expect(await saving).toBe(false);
    expect(board.columns[0]?.cards.map((card) => card.id)).toEqual(['card_a']);
    expect(calls.some((call) => call.method === 'board.cards.update')).toBe(false);
  });

  it('replays a column rename that was saved against a temp id', async () => {
    detach = board.attach('p1');
    await wait(20);
    hangMethods.add('board.columns.create');
    const creating = board.createColumn('Placeholder');
    const tempId = board.columns.at(-1)?.id ?? '';
    const renaming = board.renameColumn(tempId, 'Archive');
    pending.find((call) => call.method === 'board.columns.create')?.resolve({
      column: column('bcol_real', 'Placeholder', 50),
    });
    expect(await creating).toBe(true);
    expect(await renaming).toBe(true);
    const updates = calls.filter((call) => call.method === 'board.columns.update');
    expect(updates.map((call) => (call.params as { columnId: string }).columnId)).toEqual([
      'bcol_real',
    ]);
    expect(board.columns.at(-1)?.id).toBe('bcol_real');
    expect(board.columns.at(-1)?.title).toBe('Archive');
    expect(board.columns.at(-1)?.localKey).toBe(tempId);
  });

  it('sends only the last keyboard position and skips a no-op move', async () => {
    columns = [column('bcol_a', 'A', 1), column('bcol_b', 'B', 2)];
    cards = [card('card_a', 'bcol_a', 'a', 1), card('card_b', 'bcol_a', 'b', 2)];
    detach = board.attach('p1');
    await wait(20);
    const before = count('board.cards.move');
    board.moveCard('card_a', 'bcol_a', 'card_b');
    expect(count('board.cards.move')).toBe(before);

    hangMethods.add('board.cards.move');
    board.moveCard('card_a', 'bcol_a', null);
    await wait(0);
    expect(calls.filter((call) => call.method === 'board.cards.move')).toHaveLength(1);
    // A step that lands while that RPC is in flight is not sent until it
    // finishes, and only the latest position goes out.
    board.moveCard('card_a', 'bcol_b', null);
    board.moveCard('card_a', 'bcol_b', 'card_b');
    expect(calls.filter((call) => call.method === 'board.cards.move')).toHaveLength(1);
    pending.find((call) => call.method === 'board.cards.move')?.resolve({
      card: card('card_a', 'bcol_a', 'a', 3),
    });
    await wait(20);
    const moves = calls.filter((call) => call.method === 'board.cards.move');
    expect(moves).toHaveLength(2);
    expect(moves[1]?.params).toMatchObject({
      cardId: 'card_a',
      columnId: 'bcol_b',
      beforeCardId: 'card_b',
    });
    pending.filter((call) => call.method === 'board.cards.move').at(-1)?.resolve({
      card: card('card_a', 'bcol_b', 'a', 1),
    });
    await wait(20);
  });

  it('shows a read-only seed error once and does not retry', async () => {
    failMethod = { method: 'board.get', code: 'BOARD_PROJECT_READ_ONLY' };
    detach = board.attach('readonly');
    await wait(20);
    expect(board.loading).toBe(false);
    expect(board.error).toBe(t('chats.errorCode.BOARD_PROJECT_READ_ONLY'));
    expect(board.columns).toEqual([]);
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(1);
  });

  it('restores the last column and surfaces BOARD_LAST_COLUMN', async () => {
    detach = board.attach('p1');
    await wait(20);
    failMethod = { method: 'board.columns.delete', code: 'BOARD_LAST_COLUMN' };
    expect(await board.deleteColumn('bcol_a', false)).toBe(false);
    expect(board.columns.map((column) => column.id)).toEqual(['bcol_a']);
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('card conversation events reload only mapped cards', () => {
  it('refetches when a mapped conversation changes and ignores the rest', async () => {
    cards = [{ ...card('card_a', 'bcol_a', 'hello', 1), conversationId: 'conv_card' }];
    detach = board.attach('p1');
    await wait(20);
    const before = count('board.get');

    emitEvent('message.created', { conversationId: 'conv_other' });
    emitEvent('run.status', { run: { conversationId: 'conv_other' } });
    emitEvent('approval.created', { conversationId: 'conv_other' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before);

    emitEvent('message.created', { conversationId: 'conv_card' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before + 1);

    emitEvent('run.status', { run: { conversationId: 'conv_card' } });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before + 2);

    emitEvent('approval.resolved', { conversationId: 'conv_card' });
    await wait(BOARD_REFRESH_DEBOUNCE_MS + 40);
    expect(count('board.get')).toBe(before + 3);
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
