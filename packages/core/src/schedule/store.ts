import type { Schedule, ScheduleOrigin } from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ScheduleRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  kind: 'once' | 'cron';
  run_at: number | null;
  cron: string | null;
  timezone: string;
  note: string;
  title: string;
  origin: ScheduleOrigin;
  commitment_id: string | null;
  status: 'active' | 'done' | 'cancelled';
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
}

function rowToSchedule(row: ScheduleRow): Schedule {
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
    status: row.status,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
  };
}

export interface InsertScheduleInput {
  botId: string;
  conversationId: string;
  kind: 'once' | 'cron';
  runAt?: number | null;
  cron?: string | null;
  timezone: string;
  note: string;
  title?: string | undefined;
  origin?: ScheduleOrigin | undefined;
  commitmentId?: string | null;
  nextFireAt: number | null;
}

export interface UpdateSchedulePatch {
  status?: Schedule['status'];
  nextFireAt?: number | null;
  lastFiredAt?: number | null;
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
            title, origin, commitment_id, status, next_fire_at, last_fired_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, null, ?)`,
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
        input.origin ?? (input.commitmentId ? 'commitment' : 'tool'),
        input.commitmentId ?? null,
        input.nextFireAt,
        this.clock.now(),
      );
    return this.getOrThrow(id);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare('select * from schedules where id = ?').get(id) as
      | ScheduleRow
      | undefined;
    return row ? rowToSchedule(row) : null;
  }

  private getOrThrow(id: string): Schedule {
    const row = this.get(id);
    if (row === null) throw new Error(`schedule ${id} disappeared after insert`);
    return row;
  }

  update(id: string, patch: UpdateSchedulePatch): Schedule | null {
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

  /** Active schedules with a pending occurrence at or before `now`. */
  due(now: number): Schedule[] {
    return (
      this.db
        .prepare(
          "select * from schedules where status = 'active' and next_fire_at is not null and next_fire_at <= ? order by next_fire_at",
        )
        .all(now) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** The active schedule with the earliest pending occurrence (timer target). */
  earliestActive(): Schedule | null {
    const row = this.db
      .prepare(
        "select * from schedules where status = 'active' and next_fire_at is not null order by next_fire_at limit 1",
      )
      .get() as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  /** Active schedules of one conversation (list_schedules tool). */
  listActiveForConversation(conversationId: string): Schedule[] {
    return this.#list(
      "where conversation_id = ? and status = 'active' order by next_fire_at is null, next_fire_at",
      conversationId,
    );
  }

  /** Active schedules of one bot in one conversation (ownership-scoped). */
  listActiveForBotInConversation(botId: string, conversationId: string): Schedule[] {
    return this.#list(
      "where bot_id = ? and conversation_id = ? and status = 'active' order by next_fire_at is null, next_fire_at",
      botId,
      conversationId,
    );
  }

  /** Every active schedule, soonest first (settings overview / RPC list). */
  listActive(): Schedule[] {
    return this.#list(
      "where status = 'active' order by next_fire_at is null, next_fire_at, created_at",
    );
  }

  #list(clause: string, ...params: string[]): Schedule[] {
    return (
      this.db.prepare(`select * from schedules ${clause}`).all(...params) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** 承诺作废 → 对应任务取消（P10 任务 6）；返回被取消的行（D80 回写回执卡）。 */
  cancelByCommitment(botId: string, commitmentId: string): Schedule[] {
    return (
      this.db
        .prepare(
          "update schedules set status = 'cancelled' where bot_id = ? and commitment_id = ? and status = 'active' returning *",
        )
        .all(botId, commitmentId) as ScheduleRow[]
    ).map(rowToSchedule);
  }

  /** 移出群：该 Bot 在此群的任务取消（03-data-model 删除级联）；返回被取消的行。 */
  cancelForBotInConversation(botId: string, conversationId: string): Schedule[] {
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
