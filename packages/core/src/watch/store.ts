import {
  newId,
  watchConditionSchema,
  watchSourceSchema,
  type Watch,
  type WatchCondition,
  type WatchSource,
  type WatchStatus,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface WatchRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  source_json: string;
  condition_json: string;
  interval_sec: number;
  status: WatchStatus;
  last_hash: string | null;
  last_quiet_hash: string | null;
  last_text: string | null;
  last_matched: number;
  alert_seq: number;
  alert_times_json: string;
  failures: number;
  last_error: string | null;
  last_checked_at: number | null;
  next_check_at: number;
  version: number;
  created_at: number;
  updated_at: number;
}

/**
 * A watch row plus what stays out of the RPC shape: the previous page lines
 * (diff base) and the alert times of the last 24 hours (alert cap).
 */
export interface StoredWatch extends Watch {
  lastText: string | null;
  alertTimes: number[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseAlertTimes(text: string): number[] {
  const value = parseJson(text);
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
}

/** The row as a watch, or an error message when its JSON columns do not parse. */
function rowToWatch(row: WatchRow): StoredWatch | string {
  const source = watchSourceSchema.safeParse(parseJson(row.source_json));
  if (!source.success) return `source_json: ${source.error.issues[0]?.message ?? 'invalid'}`;
  const condition = watchConditionSchema.safeParse(parseJson(row.condition_json));
  if (!condition.success) {
    return `condition_json: ${condition.error.issues[0]?.message ?? 'invalid'}`;
  }
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    source: source.data,
    condition: condition.data,
    intervalSec: row.interval_sec,
    status: row.status,
    lastHash: row.last_hash,
    lastQuietHash: row.last_quiet_hash,
    lastText: row.last_text,
    lastMatched: row.last_matched !== 0,
    alertSeq: row.alert_seq,
    alertTimes: parseAlertTimes(row.alert_times_json),
    failures: row.failures,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Public shape (no stored page text). */
export function publicWatch(watch: StoredWatch): Watch {
  const { lastText: _omitText, alertTimes: _omitTimes, ...rest } = watch;
  return rest;
}

export interface InsertWatchInput {
  botId: string;
  conversationId: string;
  source: WatchSource;
  condition: WatchCondition;
  intervalSec: number;
  nextCheckAt: number;
}

/** Fields a CAS write may change (`version` and `updated_at` are bumped by the store). */
export interface WatchPatch {
  status?: WatchStatus;
  lastHash?: string | null;
  lastQuietHash?: string | null;
  lastText?: string | null;
  lastMatched?: boolean;
  alertSeq?: number;
  alertTimes?: number[];
  failures?: number;
  lastError?: string | null;
  lastCheckedAt?: number | null;
  nextCheckAt?: number;
}

const PATCH_COLUMNS: Record<keyof WatchPatch, string> = {
  status: 'status',
  lastHash: 'last_hash',
  lastQuietHash: 'last_quiet_hash',
  lastText: 'last_text',
  lastMatched: 'last_matched',
  alertSeq: 'alert_seq',
  alertTimes: 'alert_times_json',
  failures: 'failures',
  lastError: 'last_error',
  lastCheckedAt: 'last_checked_at',
  nextCheckAt: 'next_check_at',
};

/**
 * Data access for main.db `watches` (docs/dev/03-data-model.md「watches」).
 * Every write is a compare-and-set on `version`: a check that ran while the
 * user paused / resumed / stopped the watch finds the version moved and
 * drops its result instead of overwriting the user's action.
 */
export class WatchesStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
    /** A row whose JSON columns do not parse (skipped by every read). */
    private readonly onBadRow: (id: string, error: string) => void = () => {},
  ) {}

  /** Parses rows, skipping (and reporting) the ones that do not parse. */
  #rows(rows: WatchRow[]): StoredWatch[] {
    const out: StoredWatch[] = [];
    for (const row of rows) {
      const watch = rowToWatch(row);
      if (typeof watch === 'string') this.onBadRow(row.id, watch);
      else out.push(watch);
    }
    return out;
  }

  insert(input: InsertWatchInput): StoredWatch {
    const id = newId('wat');
    const now = this.clock.now();
    this.db
      .prepare(
        `insert into watches
           (id, bot_id, conversation_id, source_json, condition_json, interval_sec, status,
            next_check_at, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.conversationId,
        JSON.stringify(input.source),
        JSON.stringify(input.condition),
        input.intervalSec,
        input.nextCheckAt,
        now,
        now,
      );
    const row = this.get(id);
    if (row === null) throw new Error(`watch ${id} disappeared after insert`);
    return row;
  }

  get(id: string): StoredWatch | null {
    const row = this.db.prepare('select * from watches where id = ?').get(id) as
      WatchRow | undefined;
    return row ? (this.#rows([row])[0] ?? null) : null;
  }

  /**
   * Compare-and-set: applies `patch` only when the row is still at
   * `expectedVersion`. Returns the updated row, or null on a conflict (or a
   * vanished row).
   */
  cas(id: string, expectedVersion: number, patch: WatchPatch): StoredWatch | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<
      [keyof WatchPatch, string]
    >) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      values.push(
        typeof value === 'boolean'
          ? value
            ? 1
            : 0
          : Array.isArray(value)
            ? JSON.stringify(value)
            : (value ?? null),
      );
    }
    sets.push('version = version + 1', 'updated_at = ?');
    values.push(this.clock.now());
    const changes = this.db
      .prepare(`update watches set ${sets.join(', ')} where id = ? and version = ?`)
      .run(...values, id, expectedVersion).changes;
    return changes === 1 ? this.get(id) : null;
  }

  /**
   * Active watches due at `now`, oldest deadline first. A row that does not
   * parse is paused with an error (it could never be checked, and left
   * active it would stay due forever and spin the worker).
   */
  due(now: number, limit = 20): StoredWatch[] {
    const rows = this.db
      .prepare(
        `select * from watches where status = 'active' and next_check_at <= ?
         order by next_check_at limit ?`,
      )
      .all(now, limit) as WatchRow[];
    const out: StoredWatch[] = [];
    for (const row of rows) {
      const watch = rowToWatch(row);
      if (typeof watch !== 'string') {
        out.push(watch);
        continue;
      }
      this.onBadRow(row.id, watch);
      this.db
        .prepare(
          `update watches set status = 'paused', last_error = ?, version = version + 1, updated_at = ?
           where id = ? and version = ?`,
        )
        .run('监看记录损坏，无法检查（请停止后重新创建）', this.clock.now(), row.id, row.version);
    }
    return out;
  }

  /** The nearest deadline among active watches (timer arming). */
  earliestActive(): number | null {
    const row = this.db
      .prepare("select min(next_check_at) as at from watches where status = 'active'")
      .get() as { at: number | null };
    return row.at;
  }

  /** Watches that are not stopped (active + paused), optionally of one bot. */
  countLive(botId?: string): number {
    const row = (
      botId === undefined
        ? this.db.prepare("select count(*) as n from watches where status != 'stopped'").get()
        : this.db
            .prepare("select count(*) as n from watches where status != 'stopped' and bot_id = ?")
            .get(botId)
    ) as { n: number };
    return row.n;
  }

  /** Live (not stopped) watches, optionally of one conversation, newest first. */
  listLive(conversationId?: string): StoredWatch[] {
    const rows =
      conversationId === undefined
        ? this.db
            .prepare("select * from watches where status != 'stopped' order by created_at desc")
            .all()
        : this.db
            .prepare(
              "select * from watches where status != 'stopped' and conversation_id = ? order by created_at desc",
            )
            .all(conversationId);
    return this.#rows(rows as WatchRow[]);
  }

  listLiveForBotInConversation(botId: string, conversationId: string): StoredWatch[] {
    return this.#rows(
      this.db
        .prepare(
          "select * from watches where status != 'stopped' and bot_id = ? and conversation_id = ? order by created_at",
        )
        .all(botId, conversationId) as WatchRow[],
    );
  }

  listForConversation(conversationId: string): StoredWatch[] {
    return this.#rows(
      this.db
        .prepare('select * from watches where conversation_id = ?')
        .all(conversationId) as WatchRow[],
    );
  }

  listForBot(botId: string, conversationId?: string): StoredWatch[] {
    const rows =
      conversationId === undefined
        ? this.db.prepare('select * from watches where bot_id = ?').all(botId)
        : this.db
            .prepare('select * from watches where bot_id = ? and conversation_id = ?')
            .all(botId, conversationId);
    return this.#rows(rows as WatchRow[]);
  }

  delete(id: string): boolean {
    return this.db.prepare('delete from watches where id = ?').run(id).changes > 0;
  }

  /**
   * Deletion cascades: drops whatever is left of a bot's (or a bot's in one
   * conversation, or a conversation's) watches — rows that did not parse
   * were skipped by the list the cascade walked.
   */
  deleteRemaining(scope: { botId?: string; conversationId?: string }): number {
    const where: string[] = [];
    const values: string[] = [];
    if (scope.botId !== undefined) {
      where.push('bot_id = ?');
      values.push(scope.botId);
    }
    if (scope.conversationId !== undefined) {
      where.push('conversation_id = ?');
      values.push(scope.conversationId);
    }
    if (where.length === 0) return 0;
    return this.db.prepare(`delete from watches where ${where.join(' and ')}`).run(...values)
      .changes;
  }
}
