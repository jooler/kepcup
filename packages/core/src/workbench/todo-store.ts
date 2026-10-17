import type {
  Todo,
  TodoAssignee,
  TodoRun,
  TodoRunStatus,
  TodoSource,
  TodoStatus,
} from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface TodoRow {
  id: string;
  title: string;
  notes: string;
  assignee_bot_id: string | null;
  assignee_project_id: string | null;
  status: TodoStatus;
  source: TodoSource;
  memo_id: string | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface TodoRunRow {
  id: string;
  todo_id: string;
  conversation_id: string;
  message_id: string | null;
  status: TodoRunStatus;
  result_message_id: string | null;
  dispatched_at: number;
  settled_at: number | null;
}

/**
 * Executor encoding (docs/design/39-workbench.md §4.1; D92 T1a renamed the column): a
 * project assignee has `assignee_project_id` set (`assignee_bot_id` = optional lead
 * override); a bot assignee has only `assignee_bot_id`; both empty = unassigned.
 */
function assigneeFromRow(row: TodoRow): TodoAssignee | null {
  if (row.assignee_project_id !== null) {
    return {
      kind: 'project',
      projectId: row.assignee_project_id,
      leadBotId: row.assignee_bot_id,
    };
  }
  if (row.assignee_bot_id !== null) return { kind: 'bot', botId: row.assignee_bot_id };
  return null;
}

function assigneeToColumns(assignee: TodoAssignee | null): {
  botId: string | null;
  projectId: string | null;
} {
  if (assignee === null) return { botId: null, projectId: null };
  if (assignee.kind === 'bot') return { botId: assignee.botId, projectId: null };
  return { botId: assignee.leadBotId, projectId: assignee.projectId };
}

export function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    assignee: assigneeFromRow(row),
    status: row.status,
    source: row.source,
    memoId: row.memo_id,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export function rowToTodoRun(row: TodoRunRow): TodoRun {
  return {
    id: row.id,
    todoId: row.todo_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    status: row.status,
    resultMessageId: row.result_message_id,
    dispatchedAt: row.dispatched_at,
    settledAt: row.settled_at,
  };
}

export interface InsertTodoInput {
  title: string;
  notes?: string | undefined;
  assignee?: TodoAssignee | null | undefined;
  /** Defaults to 'draft'. */
  status?: TodoStatus | undefined;
  source: TodoSource;
  memoId?: string | null | undefined;
  blockedReason?: string | null | undefined;
}

export interface UpdateTodoPatch {
  title?: string;
  notes?: string;
  /** null = unassigned. */
  assignee?: TodoAssignee | null;
  status?: TodoStatus;
  /** Set to 'butler' once the butler rewrote the title / notes (content provenance, see TodoSource). */
  source?: TodoSource;
  blockedReason?: string | null;
  /** Explicit done / cancelled time; omitted = derived from `status` (set / cleared by the store). */
  closedAt?: number | null;
}

export interface ListTodosFilter {
  statuses?: readonly TodoStatus[] | undefined;
  /** Substring match on title and notes (LIKE; P0 volumes are in the low thousands). */
  query?: string | undefined;
  /**
   * Hide done / cancelled todos closed before this time (UTC ms); omit to list
   * closed todos of any age.
   */
  closedAfter?: number | undefined;
}

export interface InsertTodoRunInput {
  todoId: string;
  conversationId: string;
  messageId?: string | null | undefined;
  /** Defaults to 'dispatched'. */
  status?: TodoRunStatus | undefined;
}

export interface UpdateTodoRunPatch {
  messageId?: string | null;
  status?: TodoRunStatus;
  resultMessageId?: string | null;
  settledAt?: number | null;
}

export const CLOSED_TODO_STATUSES: readonly TodoStatus[] = ['done', 'cancelled'];

/** Escapes LIKE wildcards so user queries match literally (paired with `escape '\\'`). */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Data access for the todos / todo_runs tables (main.db, docs/dev/03-data-model.md
 * "todos"). Pure persistence — the state machine, validation, scheduling and
 * dispatch live in TodoService.
 */
export class TodoStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  insert(input: InsertTodoInput): Todo {
    const id = newId('todo');
    const now = this.clock.now();
    const status = input.status ?? 'draft';
    const { botId, projectId } = assigneeToColumns(input.assignee ?? null);
    this.db
      .prepare(
        `insert into todos
           (id, title, notes, assignee_bot_id, assignee_project_id, status, source,
            memo_id, blocked_reason, created_at, updated_at, closed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.notes ?? '',
        botId,
        projectId,
        status,
        input.source,
        input.memoId ?? null,
        input.blockedReason ?? null,
        now,
        now,
        CLOSED_TODO_STATUSES.includes(status) ? now : null,
      );
    return this.#getOrThrow(id);
  }

  get(id: string): Todo | null {
    const row = this.db.prepare('select * from todos where id = ?').get(id) as TodoRow | undefined;
    return row ? rowToTodo(row) : null;
  }

  #getOrThrow(id: string): Todo {
    const todo = this.get(id);
    if (todo === null) throw new Error(`todo ${id} disappeared after insert`);
    return todo;
  }

  /** Partial update; bumps `updated_at`. Returns null when the todo does not exist. */
  update(id: string, patch: UpdateTodoPatch): Todo | null {
    const current = this.get(id);
    if (current === null) return null;
    const assignee = patch.assignee !== undefined ? patch.assignee : current.assignee;
    const { botId, projectId } = assigneeToColumns(assignee);
    // closed_at follows the status: set on entering done / cancelled, cleared on leaving them
    // (an explicit patch value wins).
    const nextStatus = patch.status ?? current.status;
    const now = this.clock.now();
    const derivedClosedAt = !CLOSED_TODO_STATUSES.includes(nextStatus)
      ? null
      : CLOSED_TODO_STATUSES.includes(current.status)
        ? current.closedAt
        : now;
    const closedAt = patch.closedAt !== undefined ? patch.closedAt : derivedClosedAt;
    this.db
      .prepare(
        `update todos set title = ?, notes = ?, assignee_bot_id = ?, assignee_project_id = ?,
           status = ?, source = ?, blocked_reason = ?, closed_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.notes ?? current.notes,
        botId,
        projectId,
        nextStatus,
        patch.source ?? current.source,
        patch.blockedReason !== undefined ? patch.blockedReason : current.blockedReason,
        closedAt,
        now,
        id,
      );
    return this.get(id);
  }

  /**
   * Who last set the todo's schedule ('user' | 'butler'); null = never scheduled. Kept out of the
   * shared `Todo` — it only decides how a due dispatch is attributed. Does not bump `updated_at`.
   */
  scheduledBy(id: string): TodoSource | null {
    const row = this.db.prepare('select scheduled_by from todos where id = ?').get(id) as
      | { scheduled_by: TodoSource | null }
      | undefined;
    return row?.scheduled_by ?? null;
  }

  setScheduledBy(id: string, actor: TodoSource | null): void {
    this.db.prepare('update todos set scheduled_by = ? where id = ?').run(actor, id);
  }

  /** Hard delete (cascades todo_runs; schedules.todo_id is set null). Tools never call it. */
  delete(id: string): boolean {
    return this.db.prepare('delete from todos where id = ?').run(id).changes > 0;
  }

  /** Most recently updated first. */
  list(filter: ListTodosFilter = {}): Todo[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      where.push(`status in (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    if (filter.query !== undefined && filter.query.trim() !== '') {
      where.push("(title like ? escape '\\' or notes like ? escape '\\')");
      const pattern = likePattern(filter.query.trim());
      params.push(pattern, pattern);
    }
    if (filter.closedAfter !== undefined) {
      where.push("(status not in ('done', 'cancelled') or coalesce(closed_at, updated_at) >= ?)");
      params.push(filter.closedAfter);
    }
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    return (
      this.db
        .prepare(`select * from todos ${clause} order by updated_at desc, id desc`)
        .all(...params) as TodoRow[]
    ).map(rowToTodo);
  }

  /** Todos whose executor is this bot (bot assignee or project lead override). */
  listByAssigneeBot(botId: string): Todo[] {
    return (
      this.db
        .prepare('select * from todos where assignee_bot_id = ? order by updated_at desc, id desc')
        .all(botId) as TodoRow[]
    ).map(rowToTodo);
  }

  /** Todos assigned to this project conversation. */
  listByAssigneeProject(projectId: string): Todo[] {
    return (
      this.db
        .prepare(
          'select * from todos where assignee_project_id = ? order by updated_at desc, id desc',
        )
        .all(projectId) as TodoRow[]
    ).map(rowToTodo);
  }

  /**
   * D88 handover: move every open todo of `fromBotId` (bot executor or lead override) to `toBotId`.
   * Closed (done / cancelled) todos keep their historical executor.
   */
  reassignBot(fromBotId: string, toBotId: string): number {
    return this.db
      .prepare(
        `update todos set assignee_bot_id = ?, updated_at = ?
         where assignee_bot_id = ? and status not in ('done', 'cancelled')`,
      )
      .run(toBotId, this.clock.now(), fromBotId).changes;
  }

  // --- todo_runs -------------------------------------------------------------

  insertRun(input: InsertTodoRunInput): TodoRun {
    const id = newId('tdr');
    this.db
      .prepare(
        `insert into todo_runs
           (id, todo_id, conversation_id, message_id, status, result_message_id,
            dispatched_at, settled_at)
         values (?, ?, ?, ?, ?, null, ?, null)`,
      )
      .run(
        id,
        input.todoId,
        input.conversationId,
        input.messageId ?? null,
        input.status ?? 'dispatched',
        this.clock.now(),
      );
    const run = this.getRun(id);
    if (run === null) throw new Error(`todo run ${id} disappeared after insert`);
    return run;
  }

  getRun(id: string): TodoRun | null {
    const row = this.db.prepare('select * from todo_runs where id = ?').get(id) as
      TodoRunRow | undefined;
    return row ? rowToTodoRun(row) : null;
  }

  updateRun(id: string, patch: UpdateTodoRunPatch): TodoRun | null {
    const current = this.getRun(id);
    if (current === null) return null;
    // settled_at follows the status: stamped when the run first leaves `dispatched`, cleared
    // if it goes back (an explicit patch value wins).
    const nextStatus = patch.status ?? current.status;
    let settledAt = current.settledAt;
    if (nextStatus === 'dispatched') settledAt = null;
    else if (settledAt === null) settledAt = this.clock.now();
    if (patch.settledAt !== undefined) settledAt = patch.settledAt;
    this.db
      .prepare(
        `update todo_runs set message_id = ?, status = ?, result_message_id = ?, settled_at = ?
         where id = ?`,
      )
      .run(
        patch.messageId !== undefined ? patch.messageId : current.messageId,
        nextStatus,
        patch.resultMessageId !== undefined ? patch.resultMessageId : current.resultMessageId,
        settledAt,
        id,
      );
    return this.getRun(id);
  }

  /** Every run of a todo, newest dispatch first. */
  listRuns(todoId: string): TodoRun[] {
    return (
      this.db
        .prepare('select * from todo_runs where todo_id = ? order by dispatched_at desc, id desc')
        .all(todoId) as TodoRunRow[]
    ).map(rowToTodoRun);
  }

  lastRun(todoId: string): TodoRun | null {
    const row = this.db
      .prepare(
        'select * from todo_runs where todo_id = ? order by dispatched_at desc, id desc limit 1',
      )
      .get(todoId) as TodoRunRow | undefined;
    return row ? rowToTodoRun(row) : null;
  }

  /** Runs dispatched into one conversation that are not settled yet (delivery tracking). */
  listOpenRunsForConversation(conversationId: string): TodoRun[] {
    return (
      this.db
        .prepare(
          "select * from todo_runs where conversation_id = ? and status = 'dispatched' order by dispatched_at, id",
        )
        .all(conversationId) as TodoRunRow[]
    ).map(rowToTodoRun);
  }
}
