import { newId, type LoopType } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

export interface UsageRecordInput {
  runId: string;
  botId: string | null;
  conversationId: string | null;
  loopType: LoopType;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
}

/** One local-day bucket aggregated by SQLite (`localtime`, same zone as the app). */
export interface UsageDailyTotal {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output. */
  tokens: number;
  calls: number;
  costUsd: number | null;
}

export interface UsageModelTotalRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
  costUsd: number | null;
}

export interface UsageDailyModelRow {
  date: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
}

export interface UsageLoopTotalRow {
  loopType: LoopType;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
}

export interface UsageBotTotalRow {
  botId: string | null;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  calls: number;
}

export interface UsageChatSessionRow {
  conversationId: string;
  botId: string | null;
  minutes: number;
  startedAt: number;
  endedAt: number;
}

/** A chat session ends after this much silence between two text messages. */
export const CHAT_SESSION_GAP_MS = 30 * 60 * 1000;

/** Local-day expression shared by every usage aggregation (SQLite localtime). */
const LOCAL_DAY = "date(created_at / 1000, 'unixepoch', 'localtime')";

/** Append-only usage ledger (docs/design/14-models-and-browser.md). */
export class UsageService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  record(input: UsageRecordInput): void {
    this.db
      .prepare(
        'insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        newId('use'),
        input.runId,
        input.botId,
        input.conversationId,
        input.loopType,
        input.provider,
        input.model,
        Math.max(0, Math.round(input.inputTokens)),
        Math.max(0, Math.round(input.outputTokens)),
        Math.max(0, Math.round(input.cacheReadTokens ?? 0)),
        Math.max(0, Math.round(input.cacheWriteTokens ?? 0)),
        input.costUsd ?? null,
        this.clock.now(),
      );
  }

  totalByRun(runId: string): { input: number; output: number } {
    const row = this.db
      .prepare(
        'select coalesce(sum(input_tokens), 0) as i, coalesce(sum(output_tokens), 0) as o from usage_ledger where run_id = ?',
      )
      .get(runId) as { i: number; o: number };
    return { input: row.i, output: row.o };
  }

  /** Raw entries since a point in time (usage.summary aggregation, P07). */
  entriesSince(since: number): Array<{
    botId: string | null;
    loopType: LoopType;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        'select bot_id, loop_type, provider, input_tokens, output_tokens, cost_usd, created_at from usage_ledger where created_at >= ? order by created_at',
      )
      .all(since) as Array<{
      bot_id: string | null;
      loop_type: LoopType;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      botId: row.bot_id,
      loopType: row.loop_type,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    }));
  }

  /**
   * Daily totals for the whole ledger (usage.stats KPI / heatmap / streak).
   * One row per local day — no token row ever leaves SQLite.
   */
  dailyTotals(): UsageDailyTotal[] {
    const rows = this.db
      .prepare(
        `select ${LOCAL_DAY} as day,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                coalesce(sum(cache_read_tokens), 0) as cr,
                coalesce(sum(cache_write_tokens), 0) as cw,
                count(*) as calls,
                sum(cost_usd) as cost
           from usage_ledger
          group by day
          order by day`,
      )
      .all() as Array<{
      day: string;
      i: number;
      o: number;
      cr: number;
      cw: number;
      calls: number;
      cost: number | null;
    }>;
    return rows.map((row) => ({
      date: row.day,
      inputTokens: row.i,
      outputTokens: row.o,
      cacheReadTokens: row.cr,
      cacheWriteTokens: row.cw,
      tokens: row.i + row.o,
      calls: row.calls,
      costUsd: row.cost,
    }));
  }

  /** Per-model totals since `since` (range trend / donut). */
  modelTotals(since: number): UsageModelTotalRow[] {
    const rows = this.db
      .prepare(
        `select provider,
                model,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls,
                sum(cost_usd) as cost
           from usage_ledger
          where created_at >= ?
          group by provider, model
          order by (sum(input_tokens) + sum(output_tokens)) desc, provider, model`,
      )
      .all(since) as Array<{
      provider: string;
      model: string;
      i: number;
      o: number;
      calls: number;
      cost: number | null;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
      costUsd: row.cost,
    }));
  }

  /** Per-model daily tokens since `since` (multi-line trend chart). */
  dailyByModel(since: number): UsageDailyModelRow[] {
    const rows = this.db
      .prepare(
        `select ${LOCAL_DAY} as day,
                provider,
                model,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o
           from usage_ledger
          where created_at >= ?
          group by day, provider, model
          order by day`,
      )
      .all(since) as Array<{
      day: string;
      provider: string;
      model: string;
      i: number;
      o: number;
    }>;
    return rows.map((row) => ({
      date: row.day,
      provider: row.provider,
      model: row.model,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
    }));
  }

  /** Per loop type totals since `since` (composition card). */
  loopTotals(since: number): UsageLoopTotalRow[] {
    const rows = this.db
      .prepare(
        `select loop_type,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls
           from usage_ledger
          where created_at >= ?
          group by loop_type
          order by (sum(input_tokens) + sum(output_tokens)) desc, loop_type`,
      )
      .all(since) as Array<{ loop_type: LoopType; i: number; o: number; calls: number }>;
    return rows.map((row) => ({
      loopType: row.loop_type,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
    }));
  }

  /** Per bot totals since `since` (composition card). */
  botTotals(since: number): UsageBotTotalRow[] {
    const rows = this.db
      .prepare(
        `select bot_id,
                coalesce(sum(input_tokens), 0) as i,
                coalesce(sum(output_tokens), 0) as o,
                count(*) as calls
           from usage_ledger
          where created_at >= ?
          group by bot_id
          order by (sum(input_tokens) + sum(output_tokens)) desc, bot_id`,
      )
      .all(since) as Array<{ bot_id: string | null; i: number; o: number; calls: number }>;
    return rows.map((row) => ({
      botId: row.bot_id,
      inputTokens: row.i,
      outputTokens: row.o,
      tokens: row.i + row.o,
      calls: row.calls,
    }));
  }

  /**
   * Longest continuous chat session in the ledger's lifetime: text messages
   * grouped per conversation, split whenever two messages are more than
   * `CHAT_SESSION_GAP_MS` apart. The session span (last − first message) is the
   * "chat duration"; single-message sessions (span 0) are ignored.
   */
  longestChatSession(): UsageChatSessionRow | null {
    const row = this.db
      .prepare(
        `with marked as (
           select conversation_id,
                  seq,
                  created_at,
                  case when created_at - lag(created_at) over (
                         partition by conversation_id order by seq
                       ) > ? then 1 else 0 end as is_start
             from messages
            where kind = 'text' and sender_type <> 'system'
         ),
         sessions as (
           select conversation_id,
                  seq,
                  created_at,
                  sum(is_start) over (
                    partition by conversation_id order by seq
                  ) as session_no
             from marked
         ),
         spans as (
           select conversation_id,
                  session_no,
                  min(created_at) as started_at,
                  max(created_at) as ended_at
             from sessions
            group by conversation_id, session_no
           having max(created_at) > min(created_at)
         )
         select spans.conversation_id as conversation_id,
                spans.started_at as started_at,
                spans.ended_at as ended_at,
                coalesce(conversations.direct_bot_id, conversations.lead_bot_id) as bot_id
           from spans
           left join conversations on conversations.id = spans.conversation_id
          order by (spans.ended_at - spans.started_at) desc
          limit 1`,
      )
      .get(CHAT_SESSION_GAP_MS) as
      | { conversation_id: string; started_at: number; ended_at: number; bot_id: string | null }
      | undefined;
    if (row === undefined) return null;
    return {
      conversationId: row.conversation_id,
      botId: row.bot_id,
      minutes: Math.round((row.ended_at - row.started_at) / 60_000),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}
