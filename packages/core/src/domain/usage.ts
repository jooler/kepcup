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
}
