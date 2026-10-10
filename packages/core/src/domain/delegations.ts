import {
  AppError,
  newId,
  type Delegation,
  type DelegationIntent,
  type DelegationStatus,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

/**
 * 跨 Bot 委派行（D71，docs/design/27-butler-and-delegation.md §3）。状态流转
 * 的唯一入口：`submitted`（未投递）→ `working`（代发消息已落 B 私聊、B 的
 * run 已起）→ [`awaiting_tasks`（W6：B 的委派轮派了任务，等任务结算）] →
 * `completed` | `failed` | `cancelled`。终态不可再改。
 */

interface DelegationRow {
  id: string;
  from_bot_id: string;
  to_bot_id: string;
  from_conversation_id: string;
  to_conversation_id: string | null;
  task_text: string;
  status: DelegationStatus;
  depth: number;
  from_run_id: string | null;
  sent_message_id: string | null;
  to_message_id: string | null;
  run_id: string | null;
  result_excerpt: string | null;
  result_message_id: string | null;
  result_card_id: string | null;
  error_text: string | null;
  intent: string;
  task_ids_json: string;
  created_at: number;
  updated_at: number;
}

function parseIntent(value: string): DelegationIntent {
  return value === 'question' || value === 'fyi' ? value : 'request';
}

function parseTaskIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rowToDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    fromBotId: row.from_bot_id,
    toBotId: row.to_bot_id,
    fromConversationId: row.from_conversation_id,
    toConversationId: row.to_conversation_id,
    taskText: row.task_text,
    status: row.status,
    depth: row.depth,
    fromRunId: row.from_run_id,
    sentMessageId: row.sent_message_id,
    toMessageId: row.to_message_id,
    runId: row.run_id,
    resultExcerpt: row.result_excerpt,
    resultMessageId: row.result_message_id,
    resultCardId: row.result_card_id,
    errorText: row.error_text,
    intent: parseIntent(row.intent),
    taskIds: parseTaskIds(row.task_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TERMINAL: ReadonlySet<DelegationStatus> = new Set(['completed', 'failed', 'cancelled']);

export function isTerminalDelegation(status: DelegationStatus): boolean {
  return TERMINAL.has(status);
}

/** Columns a transition / patch may set (camelCase → column). */
const PATCH_COLUMNS = {
  toConversationId: 'to_conversation_id',
  sentMessageId: 'sent_message_id',
  toMessageId: 'to_message_id',
  runId: 'run_id',
  resultExcerpt: 'result_excerpt',
  resultMessageId: 'result_message_id',
  resultCardId: 'result_card_id',
  errorText: 'error_text',
} as const;

export type DelegationPatch = Partial<Record<keyof typeof PATCH_COLUMNS, string | null>> & {
  /** W6: the followed task ids (stored as JSON). */
  taskIds?: string[];
};

/** Non-terminal statuses (lifecycle, duplicate guard, recovery). */
const ACTIVE_SQL = "('submitted', 'working', 'awaiting_tasks')";

export class DelegationsService {
  /** Observer of every successful transition / patch (D73 P2: taint travels with a handoff). */
  #onMoved: ((delegation: Delegation) => void) | null = null;

  /** Registers the (single) transition observer; its errors never fail a transition. */
  onMoved(listener: (delegation: Delegation) => void): void {
    this.#onMoved = listener;
  }

  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: {
    fromBotId: string;
    toBotId: string;
    fromConversationId: string;
    taskText: string;
    depth: number;
    fromRunId: string | null;
    intent?: DelegationIntent;
  }): Delegation {
    const id = newId('dlg');
    const now = this.clock.now();
    this.db
      .prepare(
        "insert into delegations (id, from_bot_id, to_bot_id, from_conversation_id, task_text, status, depth, from_run_id, intent, created_at, updated_at) values (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.fromBotId,
        input.toBotId,
        input.fromConversationId,
        input.taskText,
        input.depth,
        input.fromRunId,
        input.intent ?? 'request',
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): Delegation | null {
    const row = this.db.prepare('select * from delegations where id = ?').get(id) as
      | DelegationRow
      | undefined;
    return row ? rowToDelegation(row) : null;
  }

  getOrThrow(id: string): Delegation {
    const delegation = this.get(id);
    if (!delegation) throw new AppError('NOT_FOUND', `委派 ${id} 不存在`);
    return delegation;
  }

  /** The `working` delegation B's run `runId` is executing (single-hop guard + settle hook). */
  workingByRun(runId: string): Delegation | null {
    const row = this.db
      .prepare("select * from delegations where run_id = ? and status = 'working'")
      .get(runId) as DelegationRow | undefined;
    return row ? rowToDelegation(row) : null;
  }

  /**
   * The delegation whose delegated run `runId` is, in any status (single-hop
   * guard: a delegated turn stays delegated after an fyi settled on delivery).
   */
  anyByRun(runId: string): Delegation | null {
    const row = this.db
      .prepare('select * from delegations where run_id = ? order by created_at limit 1')
      .get(runId) as DelegationRow | undefined;
    return row ? rowToDelegation(row) : null;
  }

  /** W6: delegations waiting for B's tasks, optionally only those to one bot. */
  listAwaitingTasks(toBotId?: string): Delegation[] {
    const rows =
      toBotId === undefined
        ? this.db
            .prepare("select * from delegations where status = 'awaiting_tasks' order by created_at, id")
            .all()
        : this.db
            .prepare(
              "select * from delegations where status = 'awaiting_tasks' and to_bot_id = ? order by created_at, id",
            )
            .all(toBotId);
    return (rows as DelegationRow[]).map(rowToDelegation);
  }

  /** Undelivered delegations to one bot, oldest first (FIFO delivery). */
  submittedFor(toBotId: string): Delegation[] {
    return (
      this.db
        .prepare(
          "select * from delegations where to_bot_id = ? and status = 'submitted' order by created_at, id",
        )
        .all(toBotId) as DelegationRow[]
    ).map(rowToDelegation);
  }

  /**
   * Delivered-but-never-triggered delegations to one bot (`working` without a
   * run id — the crash hit between the append+working transaction and the
   * run-id backfill). Recovery re-delivers their existing message.
   */
  stalledFor(toBotId: string): Delegation[] {
    return (
      this.db
        .prepare(
          "select * from delegations where to_bot_id = ? and status = 'working' and run_id is null order by created_at, id",
        )
        .all(toBotId) as DelegationRow[]
    ).map(rowToDelegation);
  }

  /** Every non-terminal delegation (startup recovery). */
  listActive(): Delegation[] {
    return (
      this.db
        .prepare(
          `select * from delegations where status in ${ACTIVE_SQL} order by created_at, id`,
        )
        .all() as DelegationRow[]
    ).map(rowToDelegation);
  }

  /** Non-terminal delegations touching a conversation on either side (lifecycle). */
  listActiveForConversation(conversationId: string): Delegation[] {
    return (
      this.db
        .prepare(
          `select * from delegations where status in ${ACTIVE_SQL} and (from_conversation_id = ? or to_conversation_id = ?)`,
        )
        .all(conversationId, conversationId) as DelegationRow[]
    ).map(rowToDelegation);
  }

  /** Non-terminal delegations where the bot is A or B (lifecycle). */
  listActiveForBot(botId: string): Delegation[] {
    return (
      this.db
        .prepare(
          `select * from delegations where status in ${ACTIVE_SQL} and (from_bot_id = ? or to_bot_id = ?)`,
        )
        .all(botId, botId) as DelegationRow[]
    ).map(rowToDelegation);
  }

  /** Non-terminal delegation from one A conversation to one B (duplicate guard). */
  activeBetween(fromConversationId: string, toBotId: string): Delegation | null {
    // W6: a queued fyi (still `submitted` while B is busy) waits for no result
    // and does not block a request / question to the same bot.
    const row = this.db
      .prepare(
        `select * from delegations where status in ${ACTIVE_SQL} and intent <> 'fyi' and from_conversation_id = ? and to_bot_id = ? limit 1`,
      )
      .get(fromConversationId, toBotId) as DelegationRow | undefined;
    return row ? rowToDelegation(row) : null;
  }

  /** W6 fyi throttle: a still-queued fyi from `fromBotId` to `toBotId` with the same text. */
  queuedFyiWithText(fromBotId: string, toBotId: string, taskText: string): Delegation | null {
    const row = this.db
      .prepare(
        "select * from delegations where status = 'submitted' and intent = 'fyi' and from_bot_id = ? and to_bot_id = ? and task_text = ? limit 1",
      )
      .get(fromBotId, toBotId, taskText) as DelegationRow | undefined;
    return row ? rowToDelegation(row) : null;
  }

  /** W6 fyi throttle: how many fyi one run of A has sent to `toBotId` (any status). */
  countFyiFromRun(fromRunId: string, toBotId: string): number {
    const row = this.db
      .prepare(
        "select count(*) as n from delegations where intent = 'fyi' and from_run_id = ? and to_bot_id = ?",
      )
      .get(fromRunId, toBotId) as { n: number };
    return row.n;
  }

  /**
   * Moves a delegation to `status` (and applies `patch`) iff it is currently in
   * one of `from`. Returns the updated row, or null when the row was already
   * elsewhere — callers racing the same delegation (cancel vs settle) lose
   * quietly instead of overwriting a terminal state.
   */
  transition(
    id: string,
    from: DelegationStatus[],
    status: DelegationStatus,
    patch: DelegationPatch = {},
  ): Delegation | null {
    const current = this.get(id);
    if (current === null || !from.includes(current.status)) return null;
    const sets = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [status, this.clock.now()];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      const value = patch[key as keyof typeof PATCH_COLUMNS];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (patch.taskIds !== undefined) {
      sets.push('task_ids_json = ?');
      params.push(JSON.stringify(patch.taskIds));
    }
    const placeholders = from.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `update delegations set ${sets.join(', ')} where id = ? and status in (${placeholders})`,
      )
      .run(...params, id, ...from);
    if (result.changes === 0) return null;
    const updated = this.getOrThrow(id);
    try {
      this.#onMoved?.(updated);
    } catch {
      // an observer must never break the transition
    }
    return updated;
  }

  /** Patches bookkeeping columns without a status change (e.g. the sent card id). */
  patch(id: string, patch: DelegationPatch): Delegation {
    const current = this.getOrThrow(id);
    return this.transition(id, [current.status], current.status, patch) ?? this.getOrThrow(id);
  }
}
