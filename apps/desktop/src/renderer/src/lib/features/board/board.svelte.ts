import type { BoardCard, BoardColumn, BoardChangedPayload } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';

/**
 * Project board data (D103). One singleton, mounted with a count like the
 * workbench: subscribe to `board.changed` only while a board view is open,
 * debounce a full refetch, and drop responses that lost the race with a
 * newer fetch, a newer local edit, or an in-flight drag.
 *
 * Writes are optimistic. A synchronous `board.changed` (the server publishes
 * it before the RPC promise resolves) must not replace a newer draft or a
 * drag that has not finished. Scroll position and the open card stay here
 * so a tab switch, which unmounts the view, can restore them.
 */

/** Quiet period after the latest event before a refetch. */
export const BOARD_REFRESH_DEBOUNCE_MS = 200;
/** Upper bound: a stream of events still refetches at least this often. */
export const BOARD_REFRESH_MAX_WAIT_MS = 1000;

export interface BoardCardView extends BoardCard {
  /** Stable `{#each}` key. Survives the temp id → server id swap. */
  localKey: string;
  isDndShadowItem?: boolean;
}

export interface BoardColumnView extends BoardColumn {
  localKey: string;
  cards: BoardCardView[];
  isDndShadowItem?: boolean;
}

interface CardMove {
  columnId: string;
  beforeId: string | null;
  epoch: number;
}

interface ColumnMove {
  beforeId: string | null;
  epoch: number;
}

let tempSeq = 0;

function tempId(prefix: string): string {
  tempSeq += 1;
  return `tmp_${prefix}_${tempSeq}`;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function cloneColumns(columns: readonly BoardColumnView[]): BoardColumnView[] {
  return columns.map((column) => ({
    ...column,
    cards: column.cards.map((card) => ({ ...card, todo: { ...card.todo } })),
  }));
}

function blankCard(
  id: string,
  projectId: string,
  columnId: string,
  text: string,
  position: number,
): BoardCardView {
  const now = Date.now();
  return {
    id,
    localKey: id,
    projectId,
    columnId,
    position,
    text,
    createdAt: now,
    updatedAt: now,
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

/** Group a `board.get` payload. Order follows position; array order is what the UI renders. */
export function groupBoard(
  columns: readonly BoardColumn[],
  cards: readonly BoardCard[],
  previous: readonly BoardColumnView[] = [],
): BoardColumnView[] {
  const keys = new Map<string, string>();
  for (const column of previous) {
    keys.set(column.id, column.localKey);
    for (const card of column.cards) keys.set(card.id, card.localKey);
  }
  const sortedColumns = [...columns].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  );
  const buckets = new Map<string, BoardCard[]>();
  for (const column of sortedColumns) buckets.set(column.id, []);
  const sortedCards = [...cards].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  );
  for (const card of sortedCards) buckets.get(card.columnId)?.push(card);
  return sortedColumns.map((column) => ({
    ...column,
    localKey: keys.get(column.id) ?? column.id,
    cards: (buckets.get(column.id) ?? []).map((card) => ({
      ...card,
      todo: { ...card.todo },
      localKey: keys.get(card.id) ?? card.id,
    })),
  }));
}

function seedTitles(): string[] {
  return [
    t('board.defaultColumns.todo'),
    t('board.defaultColumns.doing'),
    t('board.defaultColumns.done'),
  ];
}

export class BoardState {
  projectId = $state<string | null>(null);
  columns = $state<BoardColumnView[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Open card dialog. Survives tab switches; `chat.select()` clears it. */
  openCardId = $state<string | null>(null);
  /**
   * True from the first `consider` until the pointer drop or the keyboard
   * drag's `dragStopped`. Events received in between wait.
   */
  dragging = $state(false);
  /** Column whose title should be focused after it is created. Stable local key. */
  focusColumnId = $state<string | null>(null);

  /** Horizontal track position, restored when the board remounts. Not reactive. */
  scrollLeft = 0;
  /** Per-column card-list scroll offsets, keyed by column id. Not reactive. */
  columnScrollTop: Record<string, number> = {};

  #attachCount = 0;
  #offs: Array<() => void> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #firstPending: number | undefined;
  #fetchSeq = 0;
  #epoch = 0;
  #inflightWrites = 0;
  #needsSeed = true;
  #reloadAfterDrag = false;
  #moveChain: Promise<void> = Promise.resolve();
  /** Latest not-yet-sent card move, keyed by card id. Coalesces keyboard steps. */
  #pendingCardMoves = new Map<string, CardMove>();
  #cardMoveOrigin = new Map<string, BoardColumnView[]>();
  #pendingColumnMoves = new Map<string, ColumnMove>();
  #columnMoveOrigin = new Map<string, BoardColumnView[]>();

  /**
   * Mount the board for a project. The first mount loads and subscribes;
   * the last unmount drops the subscription but keeps scroll and the open
   * card. Returns a detach function.
   */
  attach(projectId: string): () => void {
    if (this.projectId !== projectId) {
      if (this.#attachCount > 0) this.#unsubscribe();
      this.#switchProject(projectId);
    }
    this.#attachCount += 1;
    if (this.#attachCount === 1) this.#subscribe();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#attachCount -= 1;
      if (this.#attachCount === 0) this.#unsubscribe();
    };
  }

  setScrollLeft(value: number): void {
    this.scrollLeft = value;
  }

  setColumnScroll(columnId: string, top: number): void {
    this.columnScrollTop[columnId] = top;
  }

  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return;
    this.dragging = dragging;
    if (!dragging) {
      this.#reloadAfterDrag = false;
      this.#scheduleReload();
    }
  }

  openCard(id: string): void {
    this.openCardId = id;
  }

  closeCard(): void {
    this.openCardId = null;
  }

  /** Full refetch. The first successful load of a mount passes seed titles. */
  load(): Promise<void> {
    return this.#fetch(this.#needsSeed);
  }

  async createColumn(title: string): Promise<boolean> {
    const projectId = this.projectId;
    if (projectId === null) return false;
    const id = tempId('bcol');
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    const column: BoardColumnView = {
      id,
      localKey: id,
      projectId,
      title: title.trim(),
      position: (this.columns.at(-1)?.position ?? 0) + 1,
      createdAt: Date.now(),
      cards: [],
    };
    this.columns = [...this.columns, column];
    this.focusColumnId = id;
    return this.#write(epoch, snapshot, async () => {
      const result = (await core.call('board.columns.create', {
        projectId,
        title: column.title,
      })) as { column: BoardColumn };
      if (this.#epoch === epoch) this.#replaceColumn(id, result.column);
      return true;
    }, t('board.error.saveFailed'));
  }

  async renameColumn(columnId: string, title: string): Promise<boolean> {
    const column = this.#columnById(columnId);
    if (column === undefined) return false;
    const next = title.trim();
    if (next.length === 0) return false;
    if (next === column.title) return true;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.#patchColumn(columnId, { title: next });
    return this.#write(epoch, snapshot, async () => {
      const result = (await core.call('board.columns.update', {
        columnId,
        title: next,
      })) as { column: BoardColumn };
      if (this.#epoch === epoch) this.#patchColumn(columnId, result.column);
      return true;
    }, t('board.error.saveFailed'));
  }

  /**
   * Move a column before `beforeId` (`null` = end). Keyboard steps queue
   * serially and only the latest position is sent.
   */
  moveColumn(columnId: string, beforeId: string | null): void {
    if (this.#columnAlreadyThere(columnId, beforeId)) return;
    if (!this.#pendingColumnMoves.has(columnId)) {
      this.#columnMoveOrigin.set(columnId, cloneColumns(this.columns));
    }
    const epoch = ++this.#epoch;
    this.#moveColumnLocal(columnId, beforeId);
    this.#pendingColumnMoves.set(columnId, { beforeId, epoch });
    this.#moveChain = this.#moveChain.then(() => this.#drainColumnMove(columnId));
  }

  async deleteColumn(columnId: string, deleteCards = false): Promise<boolean> {
    if (this.#columnById(columnId) === undefined) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.columns = this.columns.filter((column) => column.id !== columnId);
    if (
      this.focusColumnId !== null &&
      !this.columns.some((column) => column.localKey === this.focusColumnId)
    ) {
      this.focusColumnId = null;
    }
    return this.#write(epoch, snapshot, async () => {
      await core.call('board.columns.delete', { columnId, deleteCards });
      return true;
    }, t('board.error.saveFailed'));
  }

  async createCard(columnId: string, text: string): Promise<boolean> {
    const projectId = this.projectId;
    const column = this.#columnById(columnId);
    if (projectId === null || column === undefined) return false;
    const body = text.trim();
    if (body.length === 0) return false;
    const id = tempId('card');
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    const card = blankCard(id, projectId, columnId, body, (column.cards[0]?.position ?? 1) - 1);
    this.#patchColumn(columnId, { cards: [card, ...column.cards] });
    return this.#write(epoch, snapshot, async () => {
      const result = (await core.call('board.cards.create', {
        projectId,
        columnId,
        text: body,
      })) as { card: BoardCard };
      if (this.#epoch === epoch) this.#replaceCard(id, result.card);
      return true;
    }, t('board.error.saveFailed'));
  }

  async updateCardText(cardId: string, text: string): Promise<boolean> {
    const card = this.#cardById(cardId);
    if (card === undefined) return false;
    const body = text.trim();
    if (body.length === 0) return false;
    if (body === card.text) return true;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.#patchCard(cardId, { text: body, updatedAt: Date.now() });
    return this.#write(epoch, snapshot, async () => {
      const result = (await core.call('board.cards.update', {
        cardId,
        text: body,
      })) as { card: BoardCard };
      if (this.#epoch === epoch) this.#patchCard(cardId, result.card);
      return true;
    }, t('board.error.saveFailed'));
  }

  /** Move a card before `beforeId` in `columnId` (`null` = end of that column). */
  moveCard(cardId: string, columnId: string, beforeId: string | null): void {
    if (this.#cardAlreadyThere(cardId, columnId, beforeId)) return;
    if (!this.#pendingCardMoves.has(cardId)) {
      this.#cardMoveOrigin.set(cardId, cloneColumns(this.columns));
    }
    const epoch = ++this.#epoch;
    this.#moveCardLocal(cardId, columnId, beforeId);
    this.#pendingCardMoves.set(cardId, { columnId, beforeId, epoch });
    this.#moveChain = this.#moveChain.then(() => this.#drainCardMove(cardId));
  }

  async deleteCard(cardId: string): Promise<boolean> {
    if (this.#cardById(cardId) === undefined) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.columns = this.columns.map((column) => ({
      ...column,
      cards: column.cards.filter((card) => card.id !== cardId),
    }));
    if (this.openCardId === cardId) this.openCardId = null;
    return this.#write(epoch, snapshot, async () => {
      await core.call('board.cards.delete', { cardId });
      return true;
    }, t('board.error.saveFailed'));
  }

  #switchProject(projectId: string): void {
    this.#fetchSeq += 1;
    this.projectId = projectId;
    this.columns = [];
    this.openCardId = null;
    this.focusColumnId = null;
    this.error = null;
    this.loading = false;
    this.dragging = false;
    this.scrollLeft = 0;
    for (const key of Object.keys(this.columnScrollTop)) delete this.columnScrollTop[key];
    this.#needsSeed = true;
    this.#reloadAfterDrag = false;
    this.#pendingCardMoves.clear();
    this.#cardMoveOrigin.clear();
    this.#pendingColumnMoves.clear();
    this.#columnMoveOrigin.clear();
  }

  #subscribe(): void {
    this.#offs = [
      core.onEvent('board.changed', (payload) => {
        const event = payload as BoardChangedPayload;
        if (event.projectId !== this.projectId) return;
        this.#scheduleReload();
      }),
    ];
    void this.load();
  }

  #unsubscribe(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#clearTimer();
    this.dragging = false;
    this.#reloadAfterDrag = false;
    this.#fetchSeq += 1;
  }

  #scheduleReload(): void {
    if (this.projectId === null || this.#attachCount === 0) return;
    if (this.dragging) {
      this.#reloadAfterDrag = true;
      return;
    }
    const now = Date.now();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const first = this.#firstPending ?? now;
    this.#firstPending = first;
    const delay = Math.max(
      0,
      Math.min(BOARD_REFRESH_DEBOUNCE_MS, first + BOARD_REFRESH_MAX_WAIT_MS - now),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#firstPending = undefined;
      if (this.dragging) {
        this.#reloadAfterDrag = true;
        return;
      }
      if (this.#inflightWrites > 0) {
        this.#scheduleReload();
        return;
      }
      void this.#fetch(false);
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#firstPending = undefined;
  }

  async #fetch(seed: boolean): Promise<void> {
    const projectId = this.projectId;
    if (projectId === null) return;
    const seq = (this.#fetchSeq += 1);
    const epoch = this.#epoch;
    const writes = this.#inflightWrites;
    if (this.columns.length === 0) this.loading = true;
    try {
      const result = (await core.call('board.get', {
        projectId,
        ...(seed ? { seedTitles: seedTitles() } : {}),
      })) as { columns: BoardColumn[]; cards: BoardCard[] };
      if (seq !== this.#fetchSeq || this.projectId !== projectId) return;
      if (this.dragging) {
        this.#reloadAfterDrag = true;
        return;
      }
      if (this.#epoch !== epoch || this.#inflightWrites !== writes) {
        this.#scheduleReload();
        return;
      }
      this.columns = groupBoard(result.columns, result.cards, this.columns);
      this.#closeMissingCard();
      this.loading = false;
      this.error = null;
      if (seed) this.#needsSeed = false;
    } catch (error) {
      if (seq !== this.#fetchSeq || this.projectId !== projectId) return;
      this.loading = false;
      this.error = errorText(errorCode(error), t('board.error.saveFailed'));
    }
  }

  async #write(
    epoch: number,
    snapshot: BoardColumnView[],
    run: () => Promise<boolean>,
    fallback: string,
  ): Promise<boolean> {
    this.#inflightWrites += 1;
    try {
      return await run();
    } catch (error) {
      if (this.#epoch === epoch) this.columns = snapshot;
      toast.error(errorText(errorCode(error), fallback));
      return false;
    } finally {
      this.#inflightWrites -= 1;
    }
  }

  async #drainCardMove(cardId: string): Promise<void> {
    const pending = this.#pendingCardMoves.get(cardId);
    if (pending === undefined) return;
    this.#pendingCardMoves.delete(cardId);
    const origin = this.#cardMoveOrigin.get(cardId);
    this.#inflightWrites += 1;
    try {
      const result = (await core.call('board.cards.move', {
        cardId,
        columnId: pending.columnId,
        beforeCardId: pending.beforeId,
      })) as { card: BoardCard; renumbered?: BoardCard[] };
      if (!this.#pendingCardMoves.has(cardId) && this.#epoch === pending.epoch) {
        this.#applyCardMoveResult(result);
      }
    } catch (error) {
      if (!this.#pendingCardMoves.has(cardId)) {
        if (origin !== undefined) this.columns = origin;
        toast.error(errorText(errorCode(error), t('board.error.moveFailed')));
      }
    } finally {
      this.#inflightWrites -= 1;
      if (this.#pendingCardMoves.has(cardId)) await this.#drainCardMove(cardId);
      else this.#cardMoveOrigin.delete(cardId);
    }
  }

  async #drainColumnMove(columnId: string): Promise<void> {
    const pending = this.#pendingColumnMoves.get(columnId);
    if (pending === undefined) return;
    this.#pendingColumnMoves.delete(columnId);
    const origin = this.#columnMoveOrigin.get(columnId);
    this.#inflightWrites += 1;
    try {
      const result = (await core.call('board.columns.move', {
        columnId,
        beforeColumnId: pending.beforeId,
      })) as { columns: BoardColumn[] };
      if (!this.#pendingColumnMoves.has(columnId) && this.#epoch === pending.epoch) {
        this.#applyColumnOrder(result.columns);
      }
    } catch (error) {
      if (!this.#pendingColumnMoves.has(columnId)) {
        if (origin !== undefined) this.columns = origin;
        toast.error(errorText(errorCode(error), t('board.error.moveFailed')));
      }
    } finally {
      this.#inflightWrites -= 1;
      if (this.#pendingColumnMoves.has(columnId)) await this.#drainColumnMove(columnId);
      else this.#columnMoveOrigin.delete(columnId);
    }
  }

  /** Reorder columns from a move response without re-sorting cards by stale positions. */
  #applyColumnOrder(columns: readonly BoardColumn[]): void {
    const order = new Map(columns.map((column, index) => [column.id, { column, index }]));
    this.columns = this.columns
      .map((column) => {
        const fresh = order.get(column.id);
        if (fresh === undefined) return column;
        return {
          ...column,
          ...fresh.column,
          localKey: column.localKey,
          cards: column.cards,
        };
      })
      .sort((a, b) => (order.get(a.id)?.index ?? 0) - (order.get(b.id)?.index ?? 0));
  }

  #applyCardMoveResult(result: { card: BoardCard; renumbered?: BoardCard[] }): void {
    if (result.renumbered !== undefined && result.renumbered.length > 0) {
      const columnId = result.card.columnId;
      const previous = new Map<string, BoardCardView>();
      for (const column of this.columns) {
        for (const card of column.cards) previous.set(card.id, card);
      }
      const renumbered = [...result.renumbered].sort((a, b) => a.position - b.position);
      this.columns = this.columns.map((column) => {
        if (column.id !== columnId) {
          return {
            ...column,
            cards: column.cards.filter((card) => card.id !== result.card.id),
          };
        }
        return {
          ...column,
          cards: renumbered.map((card) => {
            const prior = previous.get(card.id);
            return { ...card, todo: { ...card.todo }, localKey: prior?.localKey ?? card.id };
          }),
        };
      });
      return;
    }
    this.#replaceCard(result.card.id, result.card);
  }

  #replaceColumn(localKeyOrId: string, column: BoardColumn): void {
    this.columns = this.columns.map((item) => {
      if (item.localKey !== localKeyOrId && item.id !== localKeyOrId) return item;
      const nextId = column.id;
      if (this.focusColumnId === item.localKey || this.focusColumnId === item.id) {
        this.focusColumnId = item.localKey;
      }
      return { ...item, ...column, localKey: item.localKey, id: nextId, cards: item.cards };
    });
  }

  #replaceCard(localKeyOrId: string, card: BoardCard): void {
    let replaced = false;
    this.columns = this.columns.map((column) => ({
      ...column,
      cards: column.cards.map((item) => {
        if (item.localKey !== localKeyOrId && item.id !== localKeyOrId) return item;
        replaced = true;
        if (this.openCardId === item.id) this.openCardId = card.id;
        return { ...item, ...card, todo: { ...card.todo }, localKey: item.localKey };
      }),
    }));
    if (!replaced) {
      this.#patchColumn(card.columnId, {
        cards: [
          { ...card, todo: { ...card.todo }, localKey: card.id },
          ...(this.#columnById(card.columnId)?.cards ?? []),
        ],
      });
    }
  }

  #patchColumn(columnId: string, patch: Partial<BoardColumnView>): void {
    this.columns = this.columns.map((column) =>
      column.id === columnId || column.localKey === columnId ? { ...column, ...patch } : column,
    );
  }

  #patchCard(cardId: string, patch: Partial<BoardCardView>): void {
    this.columns = this.columns.map((column) => ({
      ...column,
      cards: column.cards.map((card) =>
        card.id === cardId || card.localKey === cardId ? { ...card, ...patch } : card,
      ),
    }));
  }

  #moveColumnLocal(columnId: string, beforeId: string | null): void {
    const index = this.columns.findIndex((column) => column.id === columnId);
    if (index < 0) return;
    const next = this.columns.slice();
    const [column] = next.splice(index, 1);
    if (column === undefined) return;
    const beforeIndex = beforeId === null ? next.length : next.findIndex((item) => item.id === beforeId);
    next.splice(beforeIndex < 0 ? next.length : beforeIndex, 0, column);
    this.columns = next;
  }

  #moveCardLocal(cardId: string, columnId: string, beforeId: string | null): void {
    let moved: BoardCardView | undefined;
    const stripped = this.columns.map((column) => {
      const index = column.cards.findIndex((card) => card.id === cardId);
      if (index < 0) return column;
      const cards = column.cards.slice();
      moved = cards[index];
      cards.splice(index, 1);
      return { ...column, cards };
    });
    if (moved === undefined) return;
    const card: BoardCardView = { ...moved, columnId };
    this.columns = stripped.map((column) => {
      if (column.id !== columnId) return column;
      const cards = column.cards.slice();
      const beforeIndex = beforeId === null ? cards.length : cards.findIndex((item) => item.id === beforeId);
      cards.splice(beforeIndex < 0 ? cards.length : beforeIndex, 0, card);
      return { ...column, cards };
    });
  }

  #columnById(columnId: string): BoardColumnView | undefined {
    return this.columns.find((column) => column.id === columnId || column.localKey === columnId);
  }

  #cardById(cardId: string): BoardCardView | undefined {
    for (const column of this.columns) {
      const card = column.cards.find((item) => item.id === cardId || item.localKey === cardId);
      if (card !== undefined) return card;
    }
    return undefined;
  }

  #columnAlreadyThere(columnId: string, beforeId: string | null): boolean {
    const index = this.columns.findIndex((column) => column.id === columnId);
    if (index < 0) return false;
    const next = this.columns[index + 1]?.id ?? null;
    return next === beforeId;
  }

  #cardAlreadyThere(cardId: string, columnId: string, beforeId: string | null): boolean {
    const column = this.columns.find((item) => item.id === columnId);
    if (column === undefined) return false;
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index < 0) return false;
    return (column.cards[index + 1]?.id ?? null) === beforeId;
  }

  #closeMissingCard(): void {
    if (this.openCardId === null) return;
    const open = this.openCardId;
    if (!this.columns.some((column) => column.cards.some((card) => card.id === open))) {
      this.openCardId = null;
    }
  }
}

export const board = new BoardState();
