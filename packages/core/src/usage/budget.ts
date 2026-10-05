import { BACKGROUND_DAILY_BUDGET_DEFAULT } from '@kepcup/shared';
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
 * day. Response loops are never throttled.
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

  /** Non-response tokens a bot consumed today (local day, UTC ms window). */
  usedToday(botId: string): number {
    const since = localDayStart(this.#deps.clock.now(), this.#deps.timeZone);
    const row = this.#deps.db
      .prepare(
        "select coalesce(sum(input_tokens + output_tokens), 0) as n from usage_ledger where bot_id = ? and loop_type != 'response' and loop_type != 'triage' and created_at >= ?",
      )
      .get(botId, since) as { n: number };
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
