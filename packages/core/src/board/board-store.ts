import type { TodoSource, TodoStatus } from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ColumnRow {
  id: string;
  project_id: string;
  title: string;
  position: number;
  created_at: number;
}

interface CardJoinRow {
  todo_id: string;
  project_id: string;
  column_id: string;
  position: number;
  notes: string;
  status: TodoStatus;
  blocked_reason: string | null;
  source: TodoSource;
  created_at: number;
  updated_at: number;
}

export interface BoardColumnRecord {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: number;
}

/** A board card joined to its todo. Execution fields are filled by the service. */
export interface BoardCardRecord {
  todoId: string;
  projectId: string;
  columnId: string;
  position: number;
  notes: string;
  status: TodoStatus;
  blockedReason: string | null;
  source: TodoSource;
  createdAt: number;
  updatedAt: number;
}

function columnFromRow(row: ColumnRow): BoardColumnRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
  };
}

function cardFromRow(row: CardJoinRow): BoardCardRecord {
  return {
    todoId: row.todo_id,
    projectId: row.project_id,
    columnId: row.column_id,
    position: row.position,
    notes: row.notes,
    status: row.status,
    blockedReason: row.blocked_reason,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CARD_SELECT = `select c.todo_id, c.project_id, c.column_id, c.position,
            t.notes, t.status, t.blocked_reason, t.source, t.created_at, t.updated_at
       from board_cards c
       join todos t on t.id = c.todo_id`;

/**
 * Persistence for board_columns / board_cards. No service dependencies, so
 * TodoService can look cards up without a cycle.
 */
export class BoardStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /** Board location of a todo, or null when it is not a card. */
  locationOf(todoId: string): { projectId: string; columnId: string } | null {
    const row = this.db
      .prepare('select project_id, column_id from board_cards where todo_id = ?')
      .get(todoId) as { project_id: string; column_id: string } | undefined;
    if (row === undefined) return null;
    return { projectId: row.project_id, columnId: row.column_id };
  }

  listColumns(projectId: string): BoardColumnRecord[] {
    return (
      this.db
        .prepare('select * from board_columns where project_id = ? order by position asc, id asc')
        .all(projectId) as ColumnRow[]
    ).map(columnFromRow);
  }

  getColumn(id: string): BoardColumnRecord | null {
    const row = this.db.prepare('select * from board_columns where id = ?').get(id) as
      ColumnRow | undefined;
    return row === undefined ? null : columnFromRow(row);
  }

  countColumns(projectId: string): number {
    const row = this.db
      .prepare('select count(*) as n from board_columns where project_id = ?')
      .get(projectId) as { n: number };
    return row.n;
  }

  insertColumn(input: {
    id?: string | undefined;
    projectId: string;
    title: string;
    position: number;
  }): BoardColumnRecord {
    const id = input.id ?? newId('bcol');
    const now = this.clock.now();
    this.db
      .prepare(
        'insert into board_columns (id, project_id, title, position, created_at) values (?, ?, ?, ?, ?)',
      )
      .run(id, input.projectId, input.title, input.position, now);
    return this.getColumn(id)!;
  }

  updateColumnTitle(id: string, title: string): void {
    this.db.prepare('update board_columns set title = ? where id = ?').run(title, id);
  }

  setColumnPosition(id: string, position: number): void {
    this.db.prepare('update board_columns set position = ? where id = ?').run(position, id);
  }

  deleteColumn(id: string): void {
    this.db.prepare('delete from board_columns where id = ?').run(id);
  }

  listCards(projectId: string): BoardCardRecord[] {
    return (
      this.db
        .prepare(`${CARD_SELECT} where c.project_id = ? order by c.position asc, c.todo_id asc`)
        .all(projectId) as CardJoinRow[]
    ).map(cardFromRow);
  }

  listCardsInColumn(columnId: string): BoardCardRecord[] {
    return (
      this.db
        .prepare(`${CARD_SELECT} where c.column_id = ? order by c.position asc, c.todo_id asc`)
        .all(columnId) as CardJoinRow[]
    ).map(cardFromRow);
  }

  getCard(todoId: string): BoardCardRecord | null {
    const row = this.db.prepare(`${CARD_SELECT} where c.todo_id = ?`).get(todoId) as
      CardJoinRow | undefined;
    return row === undefined ? null : cardFromRow(row);
  }

  countCards(projectId: string): number {
    const row = this.db
      .prepare('select count(*) as n from board_cards where project_id = ?')
      .get(projectId) as { n: number };
    return row.n;
  }

  listCardIdsByProject(projectId: string): string[] {
    return (
      this.db
        .prepare(
          'select todo_id from board_cards where project_id = ? order by created_at asc, todo_id asc',
        )
        .all(projectId) as Array<{ todo_id: string }>
    ).map((row) => row.todo_id);
  }

  insertCard(input: {
    todoId: string;
    projectId: string;
    columnId: string;
    position: number;
  }): void {
    this.db
      .prepare(
        'insert into board_cards (todo_id, project_id, column_id, position, created_at) values (?, ?, ?, ?, ?)',
      )
      .run(input.todoId, input.projectId, input.columnId, input.position, this.clock.now());
  }

  setCardPosition(todoId: string, position: number): void {
    this.db.prepare('update board_cards set position = ? where todo_id = ?').run(position, todoId);
  }

  moveCard(todoId: string, columnId: string, position: number): void {
    this.db
      .prepare('update board_cards set column_id = ?, position = ? where todo_id = ?')
      .run(columnId, position, todoId);
  }
}
