import { CronExpressionParser } from 'cron-parser';

/**
 * Cron helpers (P10). cron-parser is a small, dependency-free utility library
 * (explicitly allowed by docs/dev/01-conventions.md 依赖管理) chosen for its
 * IANA time-zone + DST correctness; the commit message carries the rationale.
 */

/** True when `expression` parses as a standard 5-field (or @-shortcut) cron. */
export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * First occurrence of the expression strictly after `afterMs` in `timeZone`,
 * DST-correct (a skipped wall time lands after the gap, ambiguous times fire
 * once). Null when the expression is invalid or has no further occurrence.
 */
export function nextCronFireAt(
  expression: string,
  timeZone: string,
  afterMs: number,
): number | null {
  try {
    const parsed = CronExpressionParser.parse(expression.trim(), {
      currentDate: new Date(afterMs),
      tz: timeZone,
    });
    return parsed.next().getTime();
  } catch {
    return null;
  }
}
