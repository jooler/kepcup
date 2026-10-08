import { AGENT_TURN_BUDGET_TOKENS, BACKGROUND_DAILY_BUDGET_DEFAULT } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { SettingsService } from '../domain/settings.js';
import { localDayStart, nextLocalMidnight } from '../memory/local-date.js';

export interface BudgetServiceDeps {
  db: SqliteDatabase;
  settings: SettingsService;
  clock: Clock;
  timeZone: string;
}

/**
 * Per-bot daily background-loop budget (docs/dev/phases/P07-memory.md 任务 12):
 * once today's non-response usage for a bot reaches the limit, its remaining
 * background jobs (reflection / consolidation / …) defer to the next local
 * day. Response loops — and D75 supervisor turns / tasks, the user's own
 * work — are never throttled.
 */
export class BudgetService {
  readonly #deps: BudgetServiceDeps;

  constructor(deps: BudgetServiceDeps) {
    this.#deps = deps;
  }

  /** Configured daily token limit; 0 = unlimited. */
  limit(): number {
    const value = this.#deps.settings.get().backgroundBudgetTokens;
    return typeof value === 'number' ? value : BACKGROUND_DAILY_BUDGET_DEFAULT;
  }

  /**
   * Non-response tokens a bot consumed today (local day, UTC ms window).
   * External-agent rows (D72 P6, 审查 C2 / C5):
   * - a row without tokens (subscription agents often report none) counts as
   *   AGENT_TURN_BUDGET_TOKENS — one row per agent call (`complete()` attempt)
   *   or per reported model round of a background run, the same rule as the
   *   chain budget — so agent-backed background loops stay budgeted;
   * - group-chat triage on an agent counts too (built-in triage stays exempt:
   *   it is cheap and bounded by TRIAGE_TIMEOUT_MS; an agent triage is a whole
   *   one-shot session on the user's subscription).
   * Rows without a bot (global profile curation, group-chat summaries) are
   * charged to no bot.
   */
  usedToday(botId: string): number {
    const since = localDayStart(this.#deps.clock.now(), this.#deps.timeZone);
    const row = this.#deps.db
      .prepare(
        "select coalesce(sum(case when provider like 'agent:%' and input_tokens + output_tokens = 0 then ? else input_tokens + output_tokens end), 0) as n from usage_ledger where bot_id = ? and loop_type not in ('response', 'turn', 'task') and (loop_type != 'triage' or provider like 'agent:%') and created_at >= ?",
      )
      .get(AGENT_TURN_BUDGET_TOKENS, botId, since) as { n: number };
    return row.n;
  }

  exceeded(botId: string): boolean {
    const limit = this.limit();
    if (limit === 0) return false;
    return this.usedToday(botId) >= limit;
  }

  /** UTC ms of the next local midnight (deferral target, 任务 12). */
  nextDayStart(): number {
    return nextLocalMidnight(this.#deps.clock.now(), this.#deps.timeZone);
  }
}
