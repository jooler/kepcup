import { newId, type JobType } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

/** Attempts before a repeatedly failing job reaches the `failed` terminal. */
export const JOB_MAX_ATTEMPTS = 3;

export interface JobRow {
  id: string;
  type: JobType;
  bot_id: string | null;
  conversation_id: string | null;
  payload_json: string;
  priority: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  run_after: number;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

export interface EnqueueJobInput {
  type: JobType;
  botId?: string | null;
  conversationId?: string | null;
  payload: Record<string, unknown>;
  priority: number;
  /** Same key keeps a single pending job (e.g. one summary per conversation). */
  dedupeKey?: string | null;
  runAfter?: number;
}

/**
 * Persistent background job queue. `running` rows are reset to `pending` on
 * startup with attempts incremented; more than three attempts fail the job.
 */
export class JobsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  enqueue(input: EnqueueJobInput): string {
    const id = newId('job');
    const now = this.clock.now();
    this.db
      .prepare(
        // The conflict target must repeat the partial index predicate
        // (jobs_dedupe: unique on dedupe_key where status='pending').
        'insert into jobs (id, type, bot_id, conversation_id, payload_json, priority, status, attempts, run_after, dedupe_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) ' +
          "on conflict(dedupe_key) where status = 'pending' do nothing",
      )
      .run(
        id,
        input.type,
        input.botId ?? null,
        input.conversationId ?? null,
        JSON.stringify(input.payload),
        input.priority,
        'pending',
        input.runAfter ?? now,
        input.dedupeKey ?? null,
        now,
        now,
      );
    return id;
  }

  /**
   * Claims the next runnable job (priority first, then age). `excludeTypes`
   * keeps those types pending forever (P07: suggestion jobs stored for later
   * phases are never consumed here).
   */
  claimNext(excludeTypes: readonly string[] = []): JobRow | null {
    const now = this.clock.now();
    let row: JobRow | null = null;
    const run = this.db.transaction(() => {
      const exclude =
        excludeTypes.length > 0
          ? ` and type not in (${excludeTypes.map(() => '?').join(',')})`
          : '';
      const candidate = this.db
        .prepare(
          `select * from jobs where status = 'pending' and run_after <= ?${exclude} order by priority, run_after limit 1`,
        )
        .get(now, ...excludeTypes) as JobRow | undefined;
      if (!candidate) return;
      this.db
        .prepare(
          "update jobs set status = 'running', attempts = attempts + 1, updated_at = ? where id = ?",
        )
        .run(now, candidate.id);
      row = { ...candidate, status: 'running', attempts: candidate.attempts + 1 };
    });
    run.immediate();
    return row;
  }

  complete(id: string): void {
    this.db
      .prepare("update jobs set status = 'done', updated_at = ? where id = ?")
      .run(this.clock.now(), id);
  }

  fail(id: string, error: string): void {
    const row = this.db.prepare('select attempts from jobs where id = ?').get(id) as
      { attempts: number } | undefined;
    if (!row) return;
    const status = row.attempts >= JOB_MAX_ATTEMPTS ? 'failed' : 'pending';
    this.db
      .prepare('update jobs set status = ?, last_error = ?, updated_at = ? where id = ?')
      .run(status, error.slice(0, 2000), this.clock.now(), id);
  }

  /**
   * Pushes a claimed job back to pending with a later run_after (P07: budget
   * deferral to the next day; vec rebuild waiting for a ready embedder).
   */
  defer(id: string, runAfter: number): void {
    this.db
      .prepare(
        "update jobs set status = 'pending', run_after = ?, attempts = max(attempts - 1, 0), updated_at = ? where id = ?",
      )
      .run(runAfter, this.clock.now(), id);
  }

  /**
   * Pulls a pending deduped job forward (P07: forget must run curation now —
   * the dedupe key keeps a single pending job, so an immediate enqueue would
   * otherwise be dropped and the delayed one honored instead, BR-P07-003).
   * Never delays an already-scheduled run. Returns the affected row count.
   */
  hasten(dedupeKey: string, runAfter: number): number {
    return this.db
      .prepare(
        "update jobs set run_after = ?, updated_at = ? where dedupe_key = ? and status = 'pending' and run_after > ?",
      )
      .run(runAfter, this.clock.now(), dedupeKey, runAfter).changes;
  }

  /** Startup recovery + cancel support. Returns the number of affected rows. */
  resetRunningToPending(): number {
    const result = this.db
      .prepare(
        `update jobs set status = case when attempts >= ${JOB_MAX_ATTEMPTS} then 'failed' else 'pending' end, updated_at = ? where status = 'running'`,
      )
      .run(this.clock.now());
    return result.changes;
  }

  cancelByConversation(conversationId: string): number {
    return this.db
      .prepare(
        "update jobs set status = 'cancelled', updated_at = ? where conversation_id = ? and status in ('pending', 'running')",
      )
      .run(this.clock.now(), conversationId).changes;
  }

  cancelByBot(botId: string): number {
    return this.db
      .prepare(
        "update jobs set status = 'cancelled', updated_at = ? where bot_id = ? and status in ('pending', 'running')",
      )
      .run(this.clock.now(), botId).changes;
  }

  deleteByBot(botId: string): void {
    this.db.prepare('delete from jobs where bot_id = ?').run(botId);
  }

  /**
   * Deletes terminal jobs (done / failed / cancelled) last updated before
   * `before` (BR-P10-008): every schedule fire and guard retry leaves a
   * terminal row, so the table would grow without bound. Pending and running
   * rows are never touched. Returns the number of deleted rows.
   */
  purgeTerminalOlderThan(before: number): number {
    return this.db
      .prepare(
        "delete from jobs where status in ('done', 'failed', 'cancelled') and updated_at < ?",
      )
      .run(before).changes;
  }

  /**
   * Latest completion time of the given done job types for one bot (P09: the
   * weekly lint clock resets on any maintenance). 0 when none ever completed.
   */
  lastDoneAt(botId: string, types: readonly string[]): number {
    const placeholders = types.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `select max(updated_at) as t from jobs where bot_id = ? and status = 'done' and type in (${placeholders})`,
      )
      .get(botId, ...types) as { t: number | null };
    return row.t ?? 0;
  }
}
