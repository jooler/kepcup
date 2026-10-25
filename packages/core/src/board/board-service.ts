import {
  AppError,
  BOARD_CARD_TEXT_MAX_CHARS,
  BOARD_COLUMN_TITLE_MAX_CHARS,
  BOARD_MAX_CARDS,
  BOARD_MAX_COLUMNS,
  BOARD_POSITION_STEP,
  canWriteModule,
  deriveCardTitle,
  newId,
  type BoardCard,
  type BoardChangedPayload,
  type BoardColumn,
  type Conversation,
  type ProjectActor,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { TodoService } from '../workbench/todo-service.js';
import type { BoardCardRecord, BoardColumnRecord, BoardStore } from './board-store.js';
import { placeItem } from './positions.js';

export interface BoardServiceDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  store: BoardStore;
  todos: TodoService;
  conversations: ConversationsService;
}

/**
 * Single board per project (D103, docs/design/50-project-board.md). P1 is the
 * thinking tool: columns and cards, no assignment or card conversations.
 * Execution fields on {@link BoardCard} stay at their empty defaults.
 */
export class BoardService {
  readonly #deps: BoardServiceDeps;

  constructor(deps: BoardServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Columns and cards ordered by position. When the board has no columns and
   * `seedTitles` yields at least one title, seeds them in one transaction.
   */
  get(
    projectId: string,
    seedTitles: readonly string[] | undefined,
    actor: ProjectActor,
  ): { columns: BoardColumn[]; cards: BoardCard[] } {
    this.#project(projectId);
    if (
      this.#deps.store.countColumns(projectId) === 0 &&
      seedTitles !== undefined &&
      seedTitles.length > 0
    ) {
      const titles = cleanSeedTitles(seedTitles);
      if (titles.length > 0) {
        this.#write(projectId, actor);
        let seeded = false;
        this.#deps.db.transaction(() => {
          if (this.#deps.store.countColumns(projectId) > 0) return;
          titles.forEach((title, index) => {
            this.#deps.store.insertColumn({
              projectId,
              title,
              position: BOARD_POSITION_STEP * (index + 1),
            });
          });
          seeded = true;
        })();
        if (seeded) this.#changed({ projectId });
      }
    }
    return this.#snapshot(projectId);
  }

  createColumn(
    projectId: string,
    title: string,
    beforeColumnId: string | null | undefined,
    actor: ProjectActor,
  ): BoardColumn {
    this.#write(projectId, actor);
    const cleaned = normalizeColumnTitle(title);
    const anchor = beforeColumnId ?? null;
    const column = this.#deps.db.transaction(() => {
      if (this.#deps.store.countColumns(projectId) >= BOARD_MAX_COLUMNS) {
        throw new AppError(
          'BOARD_LIMIT_COLUMNS',
          'This board already has the maximum number of columns',
        );
      }
      const columns = this.#deps.store.listColumns(projectId);
      this.#assertAnchor(columns, anchor, 'Anchor column is not in this project');
      const id = newId('bcol');
      const placed = placeItem(
        columns.map((item) => ({ id: item.id, position: item.position })),
        id,
        anchor,
      );
      const position = placed.items.find((item) => item.id === id)!.position;
      const created = this.#deps.store.insertColumn({
        id,
        projectId,
        title: cleaned,
        position,
      });
      if (placed.renumbered) this.#writeColumnPositions(placed.items, id);
      return created;
    })();
    this.#changed({ projectId, columnId: column.id });
    return toColumn(column);
  }

  updateColumn(columnId: string, title: string, actor: ProjectActor): BoardColumn {
    const column = this.#requireColumn(columnId);
    this.#write(column.projectId, actor);
    const cleaned = normalizeColumnTitle(title);
    this.#deps.store.updateColumnTitle(columnId, cleaned);
    this.#changed({ projectId: column.projectId, columnId });
    return toColumn(this.#requireColumn(columnId));
  }

  /**
   * Move a column before `beforeColumnId` (`null` = end). Returns every column
   * in order. A no-op move does not publish.
   */
  moveColumn(columnId: string, beforeColumnId: string | null, actor: ProjectActor): BoardColumn[] {
    const column = this.#requireColumn(columnId);
    this.#write(column.projectId, actor);
    if (beforeColumnId === columnId) {
      throw new AppError('INVALID_INPUT', 'A column cannot be anchored on itself');
    }
    const changed = this.#deps.db.transaction(() => {
      const columns = this.#deps.store.listColumns(column.projectId);
      this.#assertAnchor(columns, beforeColumnId, 'Anchor column is not in this project');
      const placed = placeItem(
        columns.map((item) => ({ id: item.id, position: item.position })),
        columnId,
        beforeColumnId,
      );
      if (!placed.changed) return false;
      for (const item of placed.items) this.#deps.store.setColumnPosition(item.id, item.position);
      return true;
    })();
    if (changed) this.#changed({ projectId: column.projectId, columnId });
    return this.#deps.store.listColumns(column.projectId).map(toColumn);
  }

  /**
   * Delete a column. The last column is refused. A non-empty column requires
   * `deleteCards`, which purges each card through TodoService.
   */
  deleteColumn(columnId: string, deleteCards: boolean | undefined, actor: ProjectActor): void {
    const column = this.#requireColumn(columnId);
    this.#write(column.projectId, actor);
    // Card purges would each emit board.changed inside this transaction.
    // One column signal after commit is the change listeners can trust.
    this.#deps.todos.withoutBoardEvents(() => {
      this.#deps.todos.withTransaction(() => {
        if (this.#deps.store.countColumns(column.projectId) <= 1) {
          throw new AppError('BOARD_LAST_COLUMN', 'The last column cannot be deleted');
        }
        const cards = this.#deps.store.listCardsInColumn(columnId);
        if (cards.length > 0 && deleteCards !== true) {
          throw new AppError('BOARD_COLUMN_NOT_EMPTY', 'Delete the cards in this column first');
        }
        for (const card of cards) this.#deps.todos.purge(card.todoId, 'board');
        this.#deps.store.deleteColumn(columnId);
      });
    });
    this.#changed({ projectId: column.projectId, columnId });
    this.#deps.logger.info({ projectId: column.projectId, columnId }, 'board column deleted');
  }

  /**
   * Create a card at the top of the column unless `beforeCardId` is set
   * (`null` appends). The todo (`draft`, `source: 'user'`, `actor: 'board'`)
   * and the side row are inserted in one transaction.
   */
  createCard(
    projectId: string,
    columnId: string,
    text: string,
    beforeCardId: string | null | undefined,
    actor: ProjectActor,
  ): BoardCard {
    this.#write(projectId, actor);
    const column = this.#requireColumn(columnId);
    if (column.projectId !== projectId) {
      throw new AppError('INVALID_INPUT', 'Column is not in this project');
    }
    const notes = normalizeCardText(text);
    const title = cardTitle(notes);
    const record = this.#deps.db.transaction(() => {
      if (this.#deps.store.countCards(projectId) >= BOARD_MAX_CARDS) {
        throw new AppError(
          'BOARD_LIMIT_CARDS',
          'This board already has the maximum number of cards',
        );
      }
      const cards = this.#deps.store.listCardsInColumn(columnId);
      const anchor = createAnchor(cards, beforeCardId);
      const todo = this.#deps.todos.insertBoardDraft({ title, notes });
      const placed = placeItem(
        cards.map((item) => ({ id: item.todoId, position: item.position })),
        todo.id,
        anchor,
      );
      const position = placed.items.find((item) => item.id === todo.id)!.position;
      this.#deps.store.insertCard({ todoId: todo.id, projectId, columnId, position });
      if (placed.renumbered) this.#writeCardPositions(placed.items);
      return this.#deps.store.getCard(todo.id)!;
    })();
    this.#changed({ projectId, cardId: record.todoId, columnId });
    return toCard(record);
  }

  updateCard(cardId: string, text: string, actor: ProjectActor): BoardCard {
    const card = this.#requireCard(cardId);
    this.#write(card.projectId, actor);
    const notes = normalizeCardText(text);
    // updateBoardText emits the one board.changed. A second publish here
    // would deliver the same payload twice.
    this.#deps.todos.updateBoardText(cardId, { title: cardTitle(notes), notes });
    return toCard(this.#deps.store.getCard(cardId)!);
  }

  /**
   * Move a card before `beforeCardId` in `columnId` (`null` = end of that
   * column). The target column must belong to the same project. Landing on
   * the current slot does not publish. `renumbered` is the whole target
   * column when the gap was too small to split.
   */
  moveCard(
    cardId: string,
    columnId: string,
    beforeCardId: string | null,
    actor: ProjectActor,
  ): { card: BoardCard; renumbered?: BoardCard[] } {
    const card = this.#requireCard(cardId);
    this.#write(card.projectId, actor);
    const target = this.#requireColumn(columnId);
    if (target.projectId !== card.projectId) {
      throw new AppError('INVALID_INPUT', 'Cannot move a card to another project');
    }
    if (beforeCardId === cardId) {
      throw new AppError('INVALID_INPUT', 'A card cannot be anchored on itself');
    }
    const result = this.#deps.db.transaction(() => {
      const inColumn = this.#deps.store.listCardsInColumn(columnId);
      if (
        beforeCardId !== null &&
        !inColumn.some((item) => item.todoId === beforeCardId && item.todoId !== cardId)
      ) {
        throw new AppError('INVALID_INPUT', 'Anchor card is not in the target column');
      }
      const placed = placeItem(
        inColumn.map((item) => ({ id: item.todoId, position: item.position })),
        cardId,
        beforeCardId,
      );
      if (!placed.changed && card.columnId === columnId) {
        return { changed: false as const };
      }
      const position = placed.items.find((item) => item.id === cardId)!.position;
      this.#deps.store.moveCard(cardId, columnId, position);
      if (placed.renumbered) this.#writeCardPositions(placed.items);
      const renumbered = placed.renumbered
        ? placed.items.map((item) => toCard(this.#deps.store.getCard(item.id)!))
        : undefined;
      return { changed: true as const, renumbered };
    })();
    const fresh = toCard(this.#deps.store.getCard(cardId)!);
    if (!result.changed) return { card: fresh };
    this.#changed({ projectId: card.projectId, cardId, columnId });
    return result.renumbered !== undefined
      ? { card: fresh, renumbered: result.renumbered }
      : { card: fresh };
  }

  /**
   * Hard-delete the todo. The side row leaves with the todo's foreign key.
   * `purge` emits the one `board.changed`; it captured the column before the
   * side row disappeared. Publishing again here would duplicate that event.
   */
  deleteCard(cardId: string, actor: ProjectActor): void {
    const card = this.#requireCard(cardId);
    this.#write(card.projectId, actor);
    const deleted = this.#deps.todos.purge(cardId, 'board');
    if (!deleted) throw new AppError('NOT_FOUND', 'Card not found');
    this.#deps.logger.info({ projectId: card.projectId, cardId }, 'board card deleted');
  }

  /**
   * Purge every board todo of a project that is about to be deleted. Column
   * and side rows then cascade with the conversation; the todos would not.
   */
  onProjectDeleting(projectId: string): void {
    const ids = this.#deps.store.listCardIdsByProject(projectId);
    if (ids.length === 0) return;
    this.#deps.todos.withoutBoardEvents(() => {
      this.#deps.todos.withTransaction(() => {
        for (const id of ids) this.#deps.todos.purge(id, 'board');
      });
    });
    // One project signal after the purges commit. Per-card events would fire
    // inside the transaction and again once for every card.
    this.#changed({ projectId });
  }

  #snapshot(projectId: string): { columns: BoardColumn[]; cards: BoardCard[] } {
    return {
      columns: this.#deps.store.listColumns(projectId).map(toColumn),
      cards: this.#deps.store.listCards(projectId).map(toCard),
    };
  }

  #project(projectId: string): Conversation {
    const project = this.#deps.conversations.get(projectId);
    if (project === null || project.type !== 'project') {
      throw new AppError('NOT_FOUND', 'Project not found');
    }
    return project;
  }

  #write(projectId: string, actor: ProjectActor): Conversation {
    const project = this.#project(projectId);
    if (project.readOnly) {
      throw new AppError('BOARD_PROJECT_READ_ONLY', 'This project is read-only');
    }
    if (!canWriteModule('board', actor)) {
      throw new AppError('INVALID_INPUT', 'This actor cannot edit the board');
    }
    return project;
  }

  #requireColumn(columnId: string): BoardColumnRecord {
    const column = this.#deps.store.getColumn(columnId);
    if (column === null) throw new AppError('NOT_FOUND', 'Column not found');
    return column;
  }

  #requireCard(cardId: string): BoardCardRecord {
    const card = this.#deps.store.getCard(cardId);
    if (card === null) throw new AppError('NOT_FOUND', 'Card not found');
    return card;
  }

  #assertAnchor(
    columns: readonly BoardColumnRecord[],
    beforeColumnId: string | null,
    message: string,
  ): void {
    if (beforeColumnId !== null && !columns.some((column) => column.id === beforeColumnId)) {
      throw new AppError('INVALID_INPUT', message);
    }
  }

  #writeColumnPositions(items: readonly { id: string; position: number }[], skipId?: string): void {
    for (const item of items) {
      if (item.id === skipId) continue;
      this.#deps.store.setColumnPosition(item.id, item.position);
    }
  }

  #writeCardPositions(items: readonly { id: string; position: number }[]): void {
    for (const item of items) this.#deps.store.setCardPosition(item.id, item.position);
  }

  #changed(payload: BoardChangedPayload): void {
    this.#deps.todos.deliverBoardChanged(payload);
  }
}

function toColumn(column: BoardColumnRecord): BoardColumn {
  return {
    id: column.id,
    projectId: column.projectId,
    title: column.title,
    position: column.position,
    createdAt: column.createdAt,
  };
}

/** P1 execution fields are the empty defaults from the contract. */
function toCard(row: BoardCardRecord): BoardCard {
  return {
    id: row.todoId,
    projectId: row.projectId,
    columnId: row.columnId,
    position: row.position,
    text: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    todo: {
      status: row.status,
      blockedReason: row.blockedReason,
      source: row.source,
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

function codePoints(text: string): number {
  return Array.from(text).length;
}

function normalizeColumnTitle(title: string): string {
  assertColumnTitle(title);
  const trimmed = title.trim();
  if (codePoints(trimmed) === 0) throw new AppError('INVALID_INPUT', 'Column title is empty');
  if (codePoints(trimmed) > BOARD_COLUMN_TITLE_MAX_CHARS) {
    throw new AppError(
      'INVALID_INPUT',
      `Column title is at most ${BOARD_COLUMN_TITLE_MAX_CHARS} characters`,
    );
  }
  return trimmed;
}

function cleanSeedTitles(titles: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const raw of titles) {
    assertColumnTitle(raw);
    const title = raw.trim();
    if (codePoints(title) === 0) continue;
    if (codePoints(title) > BOARD_COLUMN_TITLE_MAX_CHARS) {
      throw new AppError(
        'INVALID_INPUT',
        `Column title is at most ${BOARD_COLUMN_TITLE_MAX_CHARS} characters`,
      );
    }
    cleaned.push(title);
    if (cleaned.length === BOARD_MAX_COLUMNS) break;
  }
  return cleaned;
}

/**
 * SQLite `length()` stops at the first NUL, so a title the code-point check
 * accepts can fail the CHECK (leading NUL → length 0) and a title it rejects
 * can still be inserted (NUL then a long tail → length 1). Reject NUL here;
 * the CHECK rejects it too (`instr(title, char(0)) = 0`).
 */
function assertColumnTitle(title: string): void {
  if (title.includes('\0')) {
    throw new AppError('INVALID_INPUT', 'Column title contains a null character');
  }
}

function normalizeCardText(text: string): string {
  const trimmed = text.trim();
  if (codePoints(trimmed) === 0) throw new AppError('BOARD_TEXT_EMPTY', 'Card text is empty');
  if (codePoints(trimmed) > BOARD_CARD_TEXT_MAX_CHARS) {
    throw new AppError(
      'INVALID_INPUT',
      `Card text is at most ${BOARD_CARD_TEXT_MAX_CHARS} characters`,
    );
  }
  return trimmed;
}

function cardTitle(notes: string): string {
  const title = deriveCardTitle(notes);
  if (title.length === 0) throw new AppError('BOARD_TEXT_EMPTY', 'Card text is empty');
  return title;
}

/**
 * Omitted anchor → top of the column (before the first card, or the only slot
 * when the column is empty). Null → end. A string must already be in the column.
 */
function createAnchor(
  cards: readonly BoardCardRecord[],
  beforeCardId: string | null | undefined,
): string | null {
  if (beforeCardId === undefined) return cards[0]?.todoId ?? null;
  if (beforeCardId === null) return null;
  if (!cards.some((card) => card.todoId === beforeCardId)) {
    throw new AppError('INVALID_INPUT', 'Anchor card is not in this column');
  }
  return beforeCardId;
}
