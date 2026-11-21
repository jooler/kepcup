import type { Schedule, ScheduleOrigin } from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ScheduleRow {
  id: string;
  bot_id: string | null;
  conversation_id: string;
  kind: 'once' | 'cron';
  run_at: number | null;
  cron: string | null;
  timezone: string;
  note: string;
  title: string;
  origin: ScheduleOrigin;
  commitment_id: string | null;
  todo_id: string | null;
  status: 'active' | 'done' | 'cancelled';
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  owner_principal_id: string | null;
}

/**
 * A schedule row plus the ownership column that stays out of the shared RPC
 * shape (62.11 C13): the owning human principal, NULL = the single-user status
 * quo. Scheduled-fire runs are attributed to it, and the proactive daily cap
 * counts per (bot, owner).
 */
export interface StoredSchedule extends Schedule {
  ownerPrincipalId?: string | null;
}

function rowToSchedule(row: ScheduleRow): StoredSchedule {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    runAt: row.run_at,
    cron: row.cron,
    timezone: row.timezone,
    note: row.note,
    title: row.title,
    origin: row.origin,
    commitmentId: row.commitment_id,
    todoId: row.todo_id,
    status: row.status,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    ...(row.owner_principal_id !== null ? { ownerPrincipalId: row.owner_principal_id } : {}),
  };
}

export interface InsertScheduleInput {
  /** Null only for a workbench todo assigned to a group without a lead bot (D90). */
  botId: string | null;
  conversationId: string;
  kind: 'once' | 'cron';
  runAt?: number | null;
  cron?: string | null;
  timezone: string;
  note: string;
  title?: string | undefined;
  origin?: ScheduleOrigin | undefined;
  commitmentId?: string | null;
  /** Workbench todo this schedule fires for (origin = 'workbench', D90). */
  todoId?: string | null;
  /** 62.11 C13：归属主体（创建调用者 / 事项归属）。缺省 / null = NULL 行（现状）。 */
  ownerPrincipalId?: string | null;
  nextFireAt: number | null;
}

export interface UpdateSchedulePatch {
  status?: Schedule['status'];
  nextFireAt?: number | null;
  lastFiredAt?: number | null;
}

export interface UpdateScheduleTimingPatch {
  kind?: 'once' | 'cron';
  runAt?: number | null;
  cron?: string | null;
  timezone?: string;
  nextFireAt?: number | null;
  title?: string;
  note?: string;
}

/**
 * Data access for the schedules table (main.db, docs/dev/03-data-model.md
 * "schedules"). Pure persistence — guardrails, timers and delivery live in
 * ScheduleService.
 */
export class SchedulesStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  insert(input: InsertScheduleInput): Schedule {
    const id = newId('sch');
    this.db
      .prepare(
        `insert into schedules
           (id, bot_id, conversation_id, kind, run_at, cron, timezone, note,
            title, origin, commitment_id, todo_id, status, next_fire_at, last_fired_at, created_at,
            owner_principal_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, null, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.conversationId,
        input.kind,
        input.runAt ?? null,
        input.cron ?? null,
        input.timezone,
        input.note,
        input.title ?? '',
        // A todo link only makes sense on a workbench row (CHECK todo_id IS NULL OR origin = 'workbench').
        input.origin ??
          (input.todoId ? 'workbench' : input.commitmentId ? 'commitment' : 'tool'),
        input.commitmentId ?? null,
        input.todoId ?? null,
        input.nextFireAt,
        this.clock.now(),
        input.ownerPrincipalId ?? null,
      );
    return this.getOrThrow(id);
  }

  get(id: string): StoredSchedule | null {
    const row = this.db.prepare('select * from schedules where id = ?').get(id) as
      | ScheduleRow
      | undefined;
    return row ? rowToSchedule(row) : null;
  }

  private getOrThrow(id: string): StoredSchedule {
    const row = this.get(id);
    if (row === null) throw new Error(`schedule ${id} disappeared after insert`);
    return row;
  }

  update(id: string, patch: UpdateSchedulePatch): StoredSchedule | null {
    const row = this.get(id);
    if (row === null) return null;
    this.db
      .prepare(
        'update schedules set status = ?, next_fire_at = ?, last_fired_at = ? where id = ?',
      )
      .run(
        patch.status ?? row.status,
        patch.nextFireAt !== undefined ? patch.nextFireAt : row.nextFireAt,
        patch.lastFiredAt !== undefined ? patch.lastFiredAt : row.lastFiredAt,
        id,
      );
    return this.get(id);
  }

  /**
   * Edits the timing / title of a row in place (D90 reschedule / retitle); the card
   * snapshot is rewritten by the service.
   */
  updateTiming(id: string, patch: UpdateScheduleTimingPatch): StoredSchedule | null {
    const row = this.get(id);
    if (row === null) return null;
    this.db
      .prepare(
        `update schedules set kind = ?, run_at = ?, cron = ?, timezone = ?, next_fire_at = ?,
           title = ?, note = ? where id = ?`,
      )
      .run(
        patch.kind ?? row.kind,
        patch.runAt !== undefined ? patch.runAt : row.runAt,
        patch.cron !== undefined ? patch.cron : row.cron,
        patch.timezone ?? row.timezone,
        patch.nextFireAt !== undefined ? patch.nextFireAt : row.nextFireAt,
        patch.title ?? row.title,
        patch.note ?? row.note,
        id,
      );
    return this.get(id);
  }

  /** Active schedules with a pending occurrence at or before `now`. */
  due(now: number): StoredSchedule[] {
    return (
      this.db
        .prepare(
          "select * from schedules where status = 'active' and next_fire_at is not null and next_fire_at <= ? order by next_fire_at",
        )
        .all(now) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** The active schedule with the earliest pending occurrence (timer target). */
  earliestActive(): StoredSchedule | null {
    const row = this.db
      .prepare(
        "select * from schedules where status = 'active' and next_fire_at is not null order by next_fire_at limit 1",
      )
      .get() as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  /**
   * Active schedules of a conversation, plus — when it is a project — the
   * schedules that live on its card conversations.
   */
  listActiveForConversationScope(conversationId: string, ownerPrincipalId?: string): StoredSchedule[] {
    return this.#list(
      `where status = 'active' and (
         conversation_id = ?
         or conversation_id in (
           select id from conversations
           where type = 'card' and parent_project_id = ?
         )
       )${ownerPrincipalId === undefined ? '' : ' and owner_principal_id = ?'}
       order by next_fire_at is null, next_fire_at`,
      conversationId,
      conversationId,
      ...(ownerPrincipalId === undefined ? [] : [ownerPrincipalId]),
    );
  }

  /** Active schedules of one conversation (list_schedules tool). */
  listActiveForConversation(conversationId: string, ownerPrincipalId?: string): StoredSchedule[] {
    return this.#list(
      `where conversation_id = ? and status = 'active'${ownerPrincipalId === undefined ? '' : ' and owner_principal_id = ?'} order by next_fire_at is null, next_fire_at`,
      conversationId,
      ...(ownerPrincipalId === undefined ? [] : [ownerPrincipalId]),
    );
  }

  /** Active schedules of one bot in one conversation (ownership-scoped). */
  listActiveForBotInConversation(botId: string, conversationId: string): StoredSchedule[] {
    return this.#list(
      "where bot_id = ? and conversation_id = ? and status = 'active' order by next_fire_at is null, next_fire_at",
      botId,
      conversationId,
    );
  }

  /** Active schedules of one bot across its conversations (D88 handover inventory). */
  listActiveForBot(botId: string): StoredSchedule[] {
    return this.#list(
      "where bot_id = ? and status = 'active' order by next_fire_at is null, next_fire_at, created_at",
      botId,
    );
  }

  /** Active schedules of one workbench todo (D90: at most one by invariant). */
  listActiveForTodo(todoId: string): StoredSchedule[] {
    return this.#list(
      "where todo_id = ? and status = 'active' order by next_fire_at is null, next_fire_at, created_at",
      todoId,
    );
  }

  /**
   * Every active schedule, soonest first (settings overview / RPC list).
   * 62.11 C13：传入主体时只返回该主体拥有的行；缺省 = 不过滤（单用户现状）。
   */
  listActive(ownerPrincipalId?: string): StoredSchedule[] {
    return this.#list(
      `where status = 'active'${ownerPrincipalId === undefined ? '' : ' and owner_principal_id = ?'} order by next_fire_at is null, next_fire_at, created_at`,
      ...(ownerPrincipalId === undefined ? [] : [ownerPrincipalId]),
    );
  }

  #list(clause: string, ...params: string[]): StoredSchedule[] {
    return (
      this.db.prepare(`select * from schedules ${clause}`).all(...params) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** 承诺作废 → 对应任务取消（P10 任务 6）；返回被取消的行（D80 回写回执卡）。 */
  cancelByCommitment(botId: string, commitmentId: string): StoredSchedule[] {
    return (
      this.db
        .prepare(
          "update schedules set status = 'cancelled' where bot_id = ? and commitment_id = ? and status = 'active' returning *",
        )
        .all(botId, commitmentId) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** 移出项目组：该 Bot 在此项目组的任务取消（03-data-model 删除级联）；返回被取消的行。 */
  cancelForBotInConversation(botId: string, conversationId: string): StoredSchedule[] {
    return (
      this.db
        .prepare(
          "update schedules set status = 'cancelled' where bot_id = ? and conversation_id = ? and status = 'active' returning *",
        )
        .all(botId, conversationId) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** 删除对话：该对话的任务删除（03-data-model 删除级联；FK 亦级联，双保险）。 */
  deleteForConversation(conversationId: string): number {
    return this.db
      .prepare('delete from schedules where conversation_id = ?')
      .run(conversationId).changes;
  }

  /** 删除 Bot：任务删除（03-data-model 删除级联）。 */
  deleteForBot(botId: string): number {
    return this.db.prepare('delete from schedules where bot_id = ?').run(botId).changes;
  }
}
