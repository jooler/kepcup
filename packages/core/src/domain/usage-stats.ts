import type { UsageDailyPoint, UsageStatsOutput } from '@kepcup/shared';
import { localDateKey, localDateStart } from '../memory/local-date.js';
import type { UsageDailyTotal, UsageService } from './usage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` + N calendar days (timezone-free date math). */
export function addLocalDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + delta);
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Inclusive list of local dates from `startDate` to `endDate`. */
export function enumerateLocalDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  for (let date = startDate; date <= endDate; date = addLocalDays(date, 1)) {
    days.push(date);
    if (days.length > 4000) break;
  }
  return days;
}

/** Zero-filled daily points; `totals` may omit days without ledger rows. */
export function fillDailyPoints(
  startDate: string,
  endDate: string,
  totals: readonly UsageDailyTotal[],
): UsageDailyPoint[] {
  const byDate = new Map(totals.map((total) => [total.date, total]));
  return enumerateLocalDays(startDate, endDate).map((date) => {
    const total = byDate.get(date);
    return {
      date,
      inputTokens: total?.inputTokens ?? 0,
      outputTokens: total?.outputTokens ?? 0,
      tokens: total?.tokens ?? 0,
      calls: total?.calls ?? 0,
    };
  });
}

/**
 * Current / longest consecutive active-day streaks. `current` counts back
 * from today; if today has no usage yet the streak still counts from yesterday
 * (a user opening the page in the morning should not see it reset).
 */
export function computeStreaks(
  activeDates: readonly string[],
  today: string,
): { current: number; longest: number } {
  const days = [...new Set(activeDates)].sort();
  const active = new Set(days);
  let longest = 0;
  let run = 0;
  for (let index = 0; index < days.length; index += 1) {
    const previous = days[index - 1];
    run = previous !== undefined && addLocalDays(previous, 1) === days[index] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  let cursor = active.has(today) ? today : addLocalDays(today, -1);
  let current = 0;
  while (active.has(cursor)) {
    current += 1;
    cursor = addLocalDays(cursor, -1);
  }
  return { current, longest };
}

export interface UsageStatsParams {
  usage: UsageService;
  now: number;
  timeZone: string;
  days: number;
  heatmapDays: number;
}

/** Builds the settings Usage dashboard snapshot (one RPC round trip). */
export function buildUsageStats(params: UsageStatsParams): UsageStatsOutput {
  const { usage, now, timeZone, days, heatmapDays } = params;
  const today = localDateKey(new Date(now), timeZone);
  const dailyAll = usage.dailyTotals();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let calls = 0;
  let costUsd: number | null = null;
  for (const day of dailyAll) {
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    cacheReadTokens += day.cacheReadTokens;
    cacheWriteTokens += day.cacheWriteTokens;
    calls += day.calls;
    if (day.costUsd !== null) costUsd = (costUsd ?? 0) + day.costUsd;
  }

  const peakDay = dailyAll.reduce<UsageDailyTotal | null>(
    (peak, day) => (day.tokens > 0 && (peak === null || day.tokens > peak.tokens) ? day : peak),
    null,
  );

  const heatmapStart = addLocalDays(today, -(heatmapDays - 1));
  const heatmapPoints = fillDailyPoints(
    heatmapStart,
    today,
    dailyAll.filter((day) => day.date >= heatmapStart),
  );

  const rangeStart = addLocalDays(today, -(days - 1));
  const since = localDateStart(rangeStart, timeZone);
  const rangeDaily = fillDailyPoints(
    rangeStart,
    today,
    dailyAll.filter((day) => day.date >= rangeStart),
  );

  return {
    totals: {
      inputTokens,
      outputTokens,
      tokens: inputTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      calls,
      costUsd,
      activeDays: dailyAll.length,
      firstDate: dailyAll[0]?.date ?? null,
      lastDate: dailyAll[dailyAll.length - 1]?.date ?? null,
    },
    peakDay: peakDay === null ? null : fillDailyPoints(peakDay.date, peakDay.date, [peakDay])[0]!,
    streak: computeStreaks(
      dailyAll.map((day) => day.date),
      today,
    ),
    heatmap: { startDate: heatmapStart, endDate: today, points: heatmapPoints },
    range: {
      days,
      startDate: rangeStart,
      endDate: today,
      daily: rangeDaily,
      dailyByModel: usage.dailyByModel(since),
      byModel: usage.modelTotals(since),
      byLoop: usage.loopTotals(since),
      byBot: usage.botTotals(since),
      byTool: usage.toolTotals(since),
    },
    longestChat: usage.longestChatSession(),
  };
}

export { DAY_MS };
