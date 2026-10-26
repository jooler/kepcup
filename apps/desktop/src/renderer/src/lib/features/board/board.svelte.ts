import type { BoardCard, BoardColumn, BoardChangedPayload, BoardSummary } from '@kepcup/shared';
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
 * it before the RPC promise resolves) is applied after the write settles,
 * unless a drag is in progress. A temp id is swapped for the server id even
 * when a later edit bumped the epoch, and text saved against that temp id
 * waits for the real id so the open dialog is not closed or reverted.
 * Scroll position and the open card stay here so a tab switch, which
 * unmounts the view, can restore them.
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

/** Text saved against a temp id, replayed once the server id exists. */
interface QueuedText {
  text: string;
  waiters: Array<(ok: boolean) => void>;
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
  const keys: Record<string, string> = {};
  for (const column of previous) {
    keys[column.id] = column.localKey;
    for (const card of column.cards) keys[card.id] = card.localKey;
  }
  const sortedColumns = [...columns].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  );
  const buckets: Record<string, BoardCard[]> = {};
  for (const column of sortedColumns) buckets[column.id] = [];
  const sortedCards = [...cards].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  );
  for (const card of sortedCards) buckets[card.columnId]?.push(card);
  return sortedColumns.map((column) => ({
    ...column,
    localKey: keys[column.id] ?? column.id,
    cards: (buckets[column.id] ?? []).map((card) => ({
      ...card,
      todo: { ...card.todo },
      localKey: keys[card.id] ?? card.id,
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
  /**
   * Tab-badge counts. Updated while a project shell is open, even when the
   * board tab itself is not mounted.
   */
  summary = $state<BoardSummary>({ unread: 0, pendingApprovals: 0, delivered: 0 });

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
  /** A `board.changed` arrived and has not been applied yet. */
  #reloadPending = false;
  /** Optimistic ids whose create RPC has not finished. A snapshot must not drop them. */
  #inflightTemps: Record<string, true> = {};
  #queuedCardText: Record<string, QueuedText> = {};
  #queuedColumnTitle: Record<string, QueuedText> = {};
  #needsSeed = true;
  #moveChain: Promise<void> = Promise.resolve();
  #summaryCount = 0;
  #summaryProjectId: string | null = null;
  #summaryOffs: Array<() => void> = [];
  #summaryTimer: ReturnType<typeof setTimeout> | undefined;
  #summarySeq = 0;
  /** Card conversation ids from the last summary-side `board.get`. */
  #summaryConversations: Record<string, true> = {};
  /** Latest not-yet-sent card move, keyed by card id. Coalesces keyboard steps. */
  #pendingCardMoves: Record<string, CardMove> = {};
  #cardMoveOrigin: Record<string, BoardColumnView[]> = {};
  #pendingColumnMoves: Record<string, ColumnMove> = {};
  #columnMoveOrigin: Record<string, BoardColumnView[]> = {};

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
    if (!dragging && this.#reloadPending) this.#scheduleReload();
  }

  openCard(id: string): void {
    this.openCardId = id;
  }

  closeCard(): void {
    this.openCardId = null;
  }

  /**
   * Keep `summary` current for a project shell. Message and approval events
   * reload only when the conversation is one of this project's cards.
   * `board.changed` and `todos.changed` always reload. Debounced like the board.
   */
  watchSummary(projectId: string): () => void {
    if (this.#summaryProjectId !== projectId) {
      this.#unsubscribeSummary();
      this.#summaryCount = 0;
      this.#summaryProjectId = projectId;
      this.summary = { unread: 0, pendingApprovals: 0, delivered: 0 };
      this.#summaryConversations = {};
    }
    this.#summaryCount += 1;
    if (this.#summaryCount === 1) this.#subscribeSummary();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#summaryCount -= 1;
      if (this.#summaryCount === 0) this.#unsubscribeSummary();
    };
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
    this.#inflightTemps[id] = true;
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        try {
          const result = (await core.call('board.columns.create', {
            projectId,
            title: column.title,
          })) as { column: BoardColumn };
          return this.#finishColumnCreate(id, epoch, projectId, result.column);
        } catch (error) {
          delete this.#inflightTemps[id];
          this.#rejectQueue(this.#queuedColumnTitle, id);
          throw error;
        }
      },
      t('board.error.saveFailed'),
    );
  }

  async renameColumn(columnId: string, title: string): Promise<boolean> {
    const column = this.#columnById(columnId);
    if (column === undefined) return false;
    const next = title.trim();
    if (next.length === 0) return false;
    if (column.id.startsWith('tmp_')) {
      if (next === column.title && this.#queuedColumnTitle[column.id] === undefined) return true;
      return this.#enqueue(this.#queuedColumnTitle, column.id, next);
    }
    if (next === column.title) return true;
    const projectId = this.projectId;
    if (projectId === null) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.#patchColumn(columnId, { title: next });
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        const result = (await core.call('board.columns.update', {
          columnId,
          title: next,
        })) as { column: BoardColumn };
        if (this.projectId === projectId && this.#epoch === epoch) {
          this.#patchColumn(columnId, result.column);
        }
        return true;
      },
      t('board.error.saveFailed'),
    );
  }

  /**
   * Move a column before `beforeId` (`null` = end). Keyboard steps queue
   * serially and only the latest position is sent.
   */
  moveColumn(columnId: string, beforeId: string | null): void {
    if (this.#columnAlreadyThere(columnId, beforeId)) return;
    if (this.#pendingColumnMoves[columnId] === undefined) {
      this.#columnMoveOrigin[columnId] = cloneColumns(this.columns);
    }
    const epoch = ++this.#epoch;
    this.#moveColumnLocal(columnId, beforeId);
    this.#pendingColumnMoves[columnId] = { beforeId, epoch };
    this.#moveChain = this.#moveChain.then(() => this.#drainColumnMove(columnId));
  }

  async deleteColumn(columnId: string, deleteCards = false): Promise<boolean> {
    if (this.#columnById(columnId) === undefined) return false;
    const projectId = this.projectId;
    if (projectId === null) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.columns = this.columns.filter((column) => column.id !== columnId);
    if (
      this.focusColumnId !== null &&
      !this.columns.some((column) => column.localKey === this.focusColumnId)
    ) {
      this.focusColumnId = null;
    }
    this.#rejectQueue(this.#queuedColumnTitle, columnId);
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        await core.call('board.columns.delete', { columnId, deleteCards });
        return true;
      },
      t('board.error.saveFailed'),
    );
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
    this.#inflightTemps[id] = true;
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        try {
          const result = (await core.call('board.cards.create', {
            projectId,
            columnId,
            text: body,
          })) as { card: BoardCard };
          return this.#finishCardCreate(id, epoch, projectId, result.card);
        } catch (error) {
          delete this.#inflightTemps[id];
          this.#rejectQueue(this.#queuedCardText, id);
          throw error;
        }
      },
      t('board.error.saveFailed'),
    );
  }

  async updateCardText(cardId: string, text: string): Promise<boolean> {
    const card = this.#cardById(cardId);
    if (card === undefined) return false;
    const body = text.trim();
    if (body.length === 0) return false;
    if (card.id.startsWith('tmp_')) {
      if (body === card.text && this.#queuedCardText[card.id] === undefined) return true;
      return this.#enqueue(this.#queuedCardText, card.id, body);
    }
    if (body === card.text) return true;
    const projectId = this.projectId;
    if (projectId === null) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.#patchCard(cardId, { text: body, updatedAt: Date.now() });
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        const result = (await core.call('board.cards.update', {
          cardId,
          text: body,
        })) as { card: BoardCard };
        if (this.projectId === projectId && this.#epoch === epoch) {
          this.#patchCard(cardId, result.card);
        }
        return true;
      },
      t('board.error.saveFailed'),
    );
  }

  /** Move a card before `beforeId` in `columnId` (`null` = end of that column). */
  moveCard(cardId: string, columnId: string, beforeId: string | null): void {
    if (this.#cardAlreadyThere(cardId, columnId, beforeId)) return;
    if (this.#pendingCardMoves[cardId] === undefined) {
      this.#cardMoveOrigin[cardId] = cloneColumns(this.columns);
    }
    const epoch = ++this.#epoch;
    this.#moveCardLocal(cardId, columnId, beforeId);
    this.#pendingCardMoves[cardId] = { columnId, beforeId, epoch };
    this.#moveChain = this.#moveChain.then(() => this.#drainCardMove(cardId));
  }

  /**
   * Apply an execution RPC. Keeps text that is still queued for save.
   * `BOARD_CRON_TOO_FREQUENT` is returned instead of toasted so the time
   * popover can show it in place.
   */
  async mutateCard(
    method: string,
    input: { cardId: string } & Record<string, unknown>,
  ): Promise<{ ok: true; warnings: string[] } | { ok: false; code: string | undefined }> {
    try {
      const result = (await core.call(method, input)) as {
        card?: BoardCard;
        warnings?: string[];
        conversationId?: string;
      };
      if (result.card !== undefined) {
        this.#replaceCard(
          result.card.id,
          result.card,
          this.#queuedCardText[result.card.id] !== undefined,
        );
      } else if (typeof result.conversationId === 'string') {
        this.#patchCard(input.cardId, { conversationId: result.conversationId });
      }
      for (const warning of result.warnings ?? []) toast.warning(warning);
      return { ok: true, warnings: result.warnings ?? [] };
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'BOARD_CRON_TOO_FREQUENT') {
        toast.error(errorText(code, t('board.error.saveFailed')));
      }
      return { ok: false, code };
    }
  }

  /**
   * The dialog marked this card's thread read. Zero the face and take the
   * same count off the tab badge. A snapshot already in flight was read
   * before the mark and must not put either badge back; the next snapshot
   * sees the server's cursor.
   */
  noteCardRead(cardId: string): void {
    const card = this.#cardById(cardId);
    if (card === undefined || card.unreadCount <= 0) return;
    const unread = card.unreadCount;
    this.#patchCard(cardId, { unreadCount: 0 });
    this.summary = {
      ...this.summary,
      unread: Math.max(0, this.summary.unread - unread),
    };
    this.#fetchSeq += 1;
    this.#summarySeq += 1;
    this.#reloadPending = true;
    this.#scheduleReload();
    if (this.#summaryCount > 0) this.#scheduleSummary();
  }

  async deleteCard(cardId: string): Promise<boolean> {
    if (this.#cardById(cardId) === undefined) return false;
    const projectId = this.projectId;
    if (projectId === null) return false;
    const epoch = ++this.#epoch;
    const snapshot = cloneColumns(this.columns);
    this.#rejectQueue(this.#queuedCardText, cardId);
    this.columns = this.columns.map((column) => ({
      ...column,
      cards: column.cards.filter((card) => card.id !== cardId),
    }));
    if (this.openCardId === cardId) this.openCardId = null;
    return this.#write(
      epoch,
      snapshot,
      projectId,
      async () => {
        await core.call('board.cards.delete', { cardId });
        return true;
      },
      t('board.error.saveFailed'),
    );
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
    this.#reloadPending = false;
    this.#inflightTemps = {};
    this.#rejectAllQueues();
    this.#pendingCardMoves = {};
    this.#cardMoveOrigin = {};
    this.#pendingColumnMoves = {};
    this.#columnMoveOrigin = {};
  }

  #subscribe(): void {
    const onCardConversation = (conversationId: string | null | undefined): void => {
      if (conversationId == null || this.#cardConversations()[conversationId] !== true) return;
      this.#reloadPending = true;
      this.#scheduleReload();
    };
    this.#offs = [
      core.onEvent('board.changed', (payload) => {
        const event = payload as BoardChangedPayload;
        if (event.projectId !== this.projectId) return;
        this.#reloadPending = true;
        this.#scheduleReload();
      }),
      // Card-face counts follow the open card conversation. A reload replaces
      // the stored text; the dialog editor keeps an unsaved draft itself.
      core.onEvent('message.created', (payload) => {
        onCardConversation((payload as { conversationId?: string }).conversationId);
      }),
      core.onEvent('run.status', (payload) => {
        const run = (payload as { run?: { conversationId?: string | null } }).run;
        onCardConversation(run?.conversationId);
      }),
      core.onEvent('approval.created', (payload) => {
        onCardConversation((payload as { conversationId?: string | null }).conversationId);
      }),
      core.onEvent('approval.resolved', (payload) => {
        onCardConversation((payload as { conversationId?: string | null }).conversationId);
      }),
    ];
    void this.load();
  }

  /** Open card conversations, from the last `board.get`. */
  #cardConversations(): Record<string, true> {
    const map: Record<string, true> = {};
    for (const column of this.columns) {
      for (const card of column.cards) {
        if (card.conversationId !== null) map[card.conversationId] = true;
      }
    }
    return map;
  }

  #subscribeSummary(): void {
    const onCard = (conversationId: string | null | undefined): void => {
      if (conversationId == null || this.#summaryConversations[conversationId] !== true) return;
      this.#scheduleSummary();
    };
    this.#summaryOffs = [
      core.onEvent('message.created', (payload) => {
        onCard((payload as { conversationId?: string }).conversationId);
      }),
      core.onEvent('approval.created', (payload) => {
        onCard((payload as { conversationId?: string | null }).conversationId);
      }),
      core.onEvent('approval.resolved', (payload) => {
        onCard((payload as { conversationId?: string | null }).conversationId);
      }),
      core.onEvent('board.changed', (payload) => {
        const event = payload as BoardChangedPayload;
        if (event.projectId !== this.#summaryProjectId) return;
        this.#scheduleSummary();
      }),
      core.onEvent('todos.changed', () => {
        this.#scheduleSummary();
      }),
    ];
    void this.#loadSummary();
  }

  #unsubscribeSummary(): void {
    for (const off of this.#summaryOffs) off();
    this.#summaryOffs = [];
    if (this.#summaryTimer !== undefined) clearTimeout(this.#summaryTimer);
    this.#summaryTimer = undefined;
    this.#summarySeq += 1;
  }

  #scheduleSummary(): void {
    if (this.#summaryProjectId === null || this.#summaryCount === 0) return;
    if (this.#summaryTimer !== undefined) clearTimeout(this.#summaryTimer);
    this.#summaryTimer = setTimeout(() => {
      this.#summaryTimer = undefined;
      void this.#loadSummary();
    }, BOARD_REFRESH_DEBOUNCE_MS);
  }

  async #loadSummary(): Promise<void> {
    const projectId = this.#summaryProjectId;
    if (projectId === null) return;
    const seq = (this.#summarySeq += 1);
    try {
      const [summary, boardResult] = await Promise.all([
        core.call('board.summary', { projectId }) as Promise<BoardSummary>,
        core.call('board.get', { projectId }) as Promise<{ cards: BoardCard[] }>,
      ]);
      if (seq !== this.#summarySeq || this.#summaryProjectId !== projectId) return;
      this.summary = summary;
      const map: Record<string, true> = {};
      for (const card of boardResult.cards) {
        if (card.conversationId !== null) map[card.conversationId] = true;
      }
      this.#summaryConversations = map;
    } catch {
      // The tab badge stays at the last good counts. The board view surfaces
      // its own load error.
    }
  }

  #unsubscribe(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#clearTimer();
    this.dragging = false;
    this.#reloadPending = false;
    this.#fetchSeq += 1;
  }

  #scheduleReload(): void {
    if (this.projectId === null || this.#attachCount === 0) return;
    if (this.dragging) return;
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
      if (this.dragging) {
        this.#reloadPending = true;
        return;
      }
      if (this.#inflightWrites > 0) {
        this.#reloadPending = true;
        this.#scheduleReload();
        return;
      }
      this.#firstPending = undefined;
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
      if (this.dragging || this.#epoch !== epoch || this.#inflightWrites !== writes) {
        // The response predates a drag or a newer edit. Keep it pending and
        // take the next snapshot once that settles.
        this.#reloadPending = true;
        if (!this.dragging) this.#scheduleReload();
        return;
      }
      const previous = this.columns;
      this.columns = this.#retainInflightTemps(
        previous,
        groupBoard(result.columns, result.cards, previous),
      );
      this.#closeMissingCard();
      this.loading = false;
      this.error = null;
      if (seed) this.#needsSeed = false;
      if (this.#timer === undefined && this.#inflightWrites === 0 && !this.dragging) {
        this.#reloadPending = false;
      }
    } catch (error) {
      if (seq !== this.#fetchSeq || this.projectId !== projectId) return;
      this.loading = false;
      this.error = errorText(errorCode(error), t('board.error.saveFailed'));
    }
  }

  async #write(
    epoch: number,
    snapshot: BoardColumnView[],
    projectId: string,
    run: () => Promise<boolean>,
    fallback: string,
  ): Promise<boolean> {
    this.#inflightWrites += 1;
    try {
      return await run();
    } catch (error) {
      if (this.#epoch === epoch && this.projectId === projectId) this.columns = snapshot;
      toast.error(errorText(errorCode(error), fallback));
      return false;
    } finally {
      this.#inflightWrites -= 1;
      if (this.#inflightWrites === 0 && this.#reloadPending && !this.dragging) {
        this.#scheduleReload();
      }
    }
  }

  async #drainCardMove(cardId: string): Promise<void> {
    const pending = this.#pendingCardMoves[cardId];
    if (pending === undefined) return;
    delete this.#pendingCardMoves[cardId];
    const origin = this.#cardMoveOrigin[cardId];
    const projectId = this.projectId;
    this.#inflightWrites += 1;
    try {
      const result = (await core.call('board.cards.move', {
        cardId,
        columnId: pending.columnId,
        beforeCardId: pending.beforeId,
      })) as { card: BoardCard; renumbered?: BoardCard[] };
      if (
        this.projectId === projectId &&
        this.#pendingCardMoves[cardId] === undefined &&
        this.#epoch === pending.epoch
      ) {
        this.#applyCardMoveResult(result);
      }
    } catch (error) {
      if (this.projectId === projectId && this.#pendingCardMoves[cardId] === undefined) {
        if (origin !== undefined) this.columns = origin;
        toast.error(errorText(errorCode(error), t('board.error.moveFailed')));
      }
    } finally {
      this.#inflightWrites -= 1;
      if (this.#inflightWrites === 0 && this.#reloadPending && !this.dragging) {
        this.#scheduleReload();
      }
      if (this.#pendingCardMoves[cardId] !== undefined) await this.#drainCardMove(cardId);
      else delete this.#cardMoveOrigin[cardId];
    }
  }

  async #drainColumnMove(columnId: string): Promise<void> {
    const pending = this.#pendingColumnMoves[columnId];
    if (pending === undefined) return;
    delete this.#pendingColumnMoves[columnId];
    const origin = this.#columnMoveOrigin[columnId];
    const projectId = this.projectId;
    this.#inflightWrites += 1;
    try {
      const result = (await core.call('board.columns.move', {
        columnId,
        beforeColumnId: pending.beforeId,
      })) as { columns: BoardColumn[] };
      if (
        this.projectId === projectId &&
        this.#pendingColumnMoves[columnId] === undefined &&
        this.#epoch === pending.epoch
      ) {
        this.#applyColumnOrder(result.columns);
      }
    } catch (error) {
      if (this.projectId === projectId && this.#pendingColumnMoves[columnId] === undefined) {
        if (origin !== undefined) this.columns = origin;
        toast.error(errorText(errorCode(error), t('board.error.moveFailed')));
      }
    } finally {
      this.#inflightWrites -= 1;
      if (this.#inflightWrites === 0 && this.#reloadPending && !this.dragging) {
        this.#scheduleReload();
      }
      if (this.#pendingColumnMoves[columnId] !== undefined) await this.#drainColumnMove(columnId);
      else delete this.#columnMoveOrigin[columnId];
    }
  }

  /** Reorder columns from a move response without re-sorting cards by stale positions. */
  #applyColumnOrder(columns: readonly BoardColumn[]): void {
    const order: Record<string, { column: BoardColumn; index: number }> = {};
    columns.forEach((column, index) => {
      order[column.id] = { column, index };
    });
    this.columns = this.columns
      .map((column) => {
        const fresh = order[column.id];
        if (fresh === undefined) return column;
        return {
          ...column,
          ...fresh.column,
          localKey: column.localKey,
          cards: column.cards,
        };
      })
      .sort((a, b) => (order[a.id]?.index ?? 0) - (order[b.id]?.index ?? 0));
  }

  #applyCardMoveResult(result: { card: BoardCard; renumbered?: BoardCard[] }): void {
    if (result.renumbered !== undefined && result.renumbered.length > 0) {
      const columnId = result.card.columnId;
      const previous: Record<string, BoardCardView> = {};
      for (const column of this.columns) {
        for (const card of column.cards) previous[card.id] = card;
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
            const prior = previous[card.id];
            return { ...card, todo: { ...card.todo }, localKey: prior?.localKey ?? card.id };
          }),
        };
      });
      return;
    }
    this.#replaceCard(result.card.id, result.card, false);
  }

  /**
   * Swap a temp column id for the server row. `keepTitle` holds a rename that
   * landed locally while the create was still in flight.
   */
  #replaceColumn(localKeyOrId: string, column: BoardColumn, keepTitle: boolean): void {
    let replaced = false;
    this.columns = this.columns.flatMap((item) => {
      const matches = item.localKey === localKeyOrId || item.id === localKeyOrId;
      if (item.id === column.id && !matches) return [];
      if (!matches) return [item];
      replaced = true;
      if (this.focusColumnId === item.localKey || this.focusColumnId === item.id) {
        this.focusColumnId = item.localKey;
      }
      return [
        {
          ...item,
          ...column,
          title: keepTitle ? item.title : column.title,
          localKey: item.localKey,
          id: column.id,
          cards: item.cards,
        },
      ];
    });
    if (!replaced && this.focusColumnId === localKeyOrId) this.focusColumnId = column.id;
  }

  /**
   * Swap a temp card id for the server row. `keepText` holds a draft that
   * landed locally while the create was still in flight. A server copy of
   * the same id (an early snapshot) is dropped so the card is not doubled.
   */
  #replaceCard(localKeyOrId: string, card: BoardCard, keepText: boolean): void {
    let replaced = false;
    this.columns = this.columns.map((column) => ({
      ...column,
      cards: column.cards.flatMap((item) => {
        const matches = item.localKey === localKeyOrId || item.id === localKeyOrId;
        if (item.id === card.id && !matches) return [];
        if (!matches) return [item];
        replaced = true;
        if (this.openCardId === item.id || this.openCardId === item.localKey) {
          this.openCardId = card.id;
        }
        return [
          {
            ...item,
            ...card,
            text: keepText ? item.text : card.text,
            todo: { ...card.todo },
            localKey: item.localKey,
          },
        ];
      }),
    }));
    if (replaced) return;
    if (this.openCardId === localKeyOrId) this.openCardId = card.id;
    const column = this.#columnById(card.columnId);
    if (column === undefined) return;
    if (column.cards.some((item) => item.id === card.id)) return;
    this.#patchColumn(card.columnId, {
      cards: [{ ...card, todo: { ...card.todo }, localKey: localKeyOrId }, ...column.cards],
    });
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
    const beforeIndex =
      beforeId === null ? next.length : next.findIndex((item) => item.id === beforeId);
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
      const beforeIndex =
        beforeId === null ? cards.length : cards.findIndex((item) => item.id === beforeId);
      cards.splice(beforeIndex < 0 ? cards.length : beforeIndex, 0, card);
      return { ...column, cards };
    });
  }

  #finishColumnCreate(
    tempIdValue: string,
    epoch: number,
    projectId: string,
    column: BoardColumn,
  ): boolean {
    const queued = this.#takeQueue(this.#queuedColumnTitle, tempIdValue);
    delete this.#inflightTemps[tempIdValue];
    if (this.projectId !== projectId) {
      this.#resolveQueue(queued, false);
      return true;
    }
    const stillThere = this.#columnById(tempIdValue) !== undefined;
    if (stillThere) {
      // A queued rename is sent after the swap, so the create title can land
      // first. Any other newer edit keeps the local title.
      this.#replaceColumn(tempIdValue, column, queued === undefined && this.#epoch !== epoch);
    }
    if (queued === undefined) return true;
    if (!stillThere && this.#columnById(column.id) === undefined) {
      this.#resolveQueue(queued, false);
      return true;
    }
    void this.renameColumn(column.id, queued.text).then((ok) => {
      this.#resolveQueue(queued, ok);
    });
    return true;
  }

  #finishCardCreate(
    tempIdValue: string,
    epoch: number,
    projectId: string,
    card: BoardCard,
  ): boolean {
    const queued = this.#takeQueue(this.#queuedCardText, tempIdValue);
    delete this.#inflightTemps[tempIdValue];
    if (this.projectId !== projectId) {
      this.#resolveQueue(queued, false);
      return true;
    }
    const stillThere = this.#cardById(tempIdValue) !== undefined;
    if (stillThere) {
      // A queued text save is sent after the swap. Keeping the create text
      // here makes that save see a real change. Any other newer edit stays.
      this.#replaceCard(tempIdValue, card, queued === undefined && this.#epoch !== epoch);
    }
    if (queued === undefined) return true;
    if (!stillThere && this.#cardById(card.id) === undefined) {
      this.#resolveQueue(queued, false);
      return true;
    }
    void this.updateCardText(card.id, queued.text).then((ok) => {
      this.#resolveQueue(queued, ok);
    });
    return true;
  }

  /** Keep creates that have not received their server id yet. */
  #retainInflightTemps(
    previous: readonly BoardColumnView[],
    next: BoardColumnView[],
  ): BoardColumnView[] {
    if (Object.keys(this.#inflightTemps).length === 0) return next;
    const seenColumns: Record<string, true> = {};
    for (const column of next) seenColumns[column.id] = true;
    let columns = next;
    for (const column of previous) {
      if (this.#inflightTemps[column.id] !== true || seenColumns[column.id] === true) continue;
      columns = [...columns, { ...column, cards: column.cards.map((card) => ({ ...card })) }];
      seenColumns[column.id] = true;
    }
    return columns.map((column) => {
      const local = previous.find((item) => item.id === column.id);
      if (local === undefined) return column;
      const present: Record<string, true> = {};
      for (const card of column.cards) present[card.id] = true;
      const missing = local.cards.filter(
        (card) => this.#inflightTemps[card.id] === true && present[card.id] !== true,
      );
      if (missing.length === 0) return column;
      return { ...column, cards: [...missing, ...column.cards] };
    });
  }

  #enqueue(bucket: Record<string, QueuedText>, id: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const existing = bucket[id];
      if (existing !== undefined) {
        existing.text = text;
        existing.waiters.push(resolve);
        return;
      }
      bucket[id] = { text, waiters: [resolve] };
    });
  }

  #takeQueue(bucket: Record<string, QueuedText>, id: string): QueuedText | undefined {
    const queued = bucket[id];
    if (queued !== undefined) delete bucket[id];
    return queued;
  }

  #rejectQueue(bucket: Record<string, QueuedText>, id: string): void {
    this.#resolveQueue(this.#takeQueue(bucket, id), false);
  }

  #resolveQueue(queued: QueuedText | undefined, ok: boolean): void {
    if (queued === undefined) return;
    for (const waiter of queued.waiters) waiter(ok);
  }

  #rejectAllQueues(): void {
    for (const bucket of [this.#queuedCardText, this.#queuedColumnTitle]) {
      for (const queued of Object.values(bucket)) this.#resolveQueue(queued, false);
      for (const id of Object.keys(bucket)) delete bucket[id];
    }
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
