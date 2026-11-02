import type { UsageDailyModelPoint, UsageDailyPoint, UsageModelTotal } from '@kepcup/shared';

/**
 * Pure helpers for the settings Usage dashboard: calendar bucketing, model
 * series, donut slices and locale-aware number/date text. Charts themselves
 * are hand-drawn SVG (same zero-dependency approach as the present cards).
 */

const DAY_MS = 86_400_000;

function dateKeyToUtc(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
}

/** `YYYY-MM-DD` + N calendar days. */
export function addDays(dateKey: string, delta: number): string {
  const date = dateKeyToUtc(dateKey);
  date.setUTCDate(date.getUTCDate() + delta);
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** ISO weekday offset: Monday = 0 … Sunday = 6. */
export function mondayOffset(dateKey: string): number {
  return (dateKeyToUtc(dateKey).getUTCDay() + 6) % 7;
}

export interface HeatCell {
  date: string;
  tokens: number;
  calls: number;
  column: number;
  row: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatMatrix {
  cells: HeatCell[];
  weeks: number;
  /** Columns where a new month starts (labels are formatted by the caller). */
  monthStarts: Array<{ column: number; date: string }>;
}

/** Heat level 0-4 from a day's tokens relative to the maximum in the window. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

/** Calendar-heatmap layout: weeks as columns, Monday-to-Sunday rows. */
export function heatMatrix(points: readonly UsageDailyPoint[]): HeatMatrix {
  if (points.length === 0) return { cells: [], weeks: 0, monthStarts: [] };
  const max = points.reduce((best, point) => Math.max(best, point.tokens), 0);
  const offset = mondayOffset(points[0]!.date);
  const cells = points.map((point, index) => {
    const slot = offset + index;
    return {
      date: point.date,
      tokens: point.tokens,
      calls: point.calls,
      column: Math.floor(slot / 7),
      row: slot % 7,
      level: heatLevel(point.tokens, max),
    };
  });
  const weeks = Math.floor((offset + points.length - 1) / 7) + 1;
  // The window may start mid-week: always label the first (partial) column,
  // then add a label whenever a Monday opens a new month.
  const monthStarts: Array<{ column: number; date: string }> = [
    { column: 0, date: points[0]!.date },
  ];
  let lastMonth = points[0]!.date.slice(0, 7);
  for (const cell of cells) {
    if (cell.row !== 0) continue;
    const month = cell.date.slice(0, 7);
    if (month === lastMonth) continue;
    lastMonth = month;
    monthStarts.push({ column: cell.column, date: cell.date });
  }
  return { cells, weeks, monthStarts };
}

export interface WeekBucket {
  weekStart: string;
  tokens: number;
  calls: number;
}

/** Sum daily points into Monday-starting weeks. */
export function weeklyTotals(points: readonly UsageDailyPoint[]): WeekBucket[] {
  const buckets = new Map<string, WeekBucket>();
  for (const point of points) {
    const weekStart = addDays(point.date, -mondayOffset(point.date));
    const bucket = buckets.get(weekStart) ?? { weekStart, tokens: 0, calls: 0 };
    bucket.tokens += point.tokens;
    bucket.calls += point.calls;
    buckets.set(weekStart, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
}

/** Running total across the heatmap window. */
export function cumulativeTotals(points: readonly UsageDailyPoint[]): Array<{
  date: string;
  tokens: number;
}> {
  let sum = 0;
  return points.map((point) => {
    sum += point.tokens;
    return { date: point.date, tokens: sum };
  });
}

export interface ModelSeries {
  key: string;
  provider: string;
  model: string;
  label: string;
  total: number;
  values: number[];
}

export const OTHER_MODEL_KEY = '__other__';

/**
 * Top-N model series for the trend chart, with the remainder summed into an
 * "other" series. `dates` defines the x axis (zero days included).
 */
export function modelSeries(
  byModel: readonly UsageModelTotal[],
  dailyByModel: readonly UsageDailyModelPoint[],
  dates: readonly string[],
  limit = 5,
): ModelSeries[] {
  const ranked = byModel.filter((model) => model.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  if (ranked.length === 0) return [];
  const top = ranked.slice(0, limit);
  const topKeys = new Set(top.map((model) => `${model.provider}|${model.model}`));
  const index = new Map(dates.map((date, i) => [date, i]));
  // The same model id can be served by two vendors; disambiguate those labels.
  const nameCounts = new Map<string, number>();
  for (const model of top) {
    nameCounts.set(model.model, (nameCounts.get(model.model) ?? 0) + 1);
  }
  const series = top.map((model) => ({
    key: `${model.provider}|${model.model}`,
    provider: model.provider,
    model: model.model,
    label:
      (nameCounts.get(model.model) ?? 0) > 1 ? `${model.model} · ${model.provider}` : model.model,
    total: model.tokens,
    values: dates.map(() => 0),
  }));
  const byKey = new Map(series.map((item) => [item.key, item]));
  let other: ModelSeries | null = null;
  for (const point of dailyByModel) {
    const at = index.get(point.date);
    if (at === undefined) continue;
    const key = `${point.provider}|${point.model}`;
    const target = topKeys.has(key)
      ? byKey.get(key)
      : (other ??= {
          key: OTHER_MODEL_KEY,
          provider: '',
          model: '',
          label: '',
          total: 0,
          values: dates.map(() => 0),
        });
    if (target === undefined) continue;
    target.values[at] = (target.values[at] ?? 0) + point.tokens;
    target.total += point.tokens;
  }
  return other === null ? series : [...series, other];
}

export interface UsageSlice {
  key: string;
  label: string;
  value: number;
  share: number;
}

/** Top-N model shares for the donut, with the remainder folded into "other". */
export function donutSlices(byModel: readonly UsageModelTotal[], limit = 5): UsageSlice[] {
  const ranked = byModel.filter((model) => model.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const total = ranked.reduce((sum, model) => sum + model.tokens, 0);
  if (total === 0) return [];
  const top = ranked.slice(0, limit);
  const slices: UsageSlice[] = top.map((model) => ({
    key: `${model.provider}|${model.model}`,
    label: model.model,
    value: model.tokens,
    share: model.tokens / total,
  }));
  const rest = ranked.slice(limit).reduce((sum, model) => sum + model.tokens, 0);
  if (rest > 0) {
    slices.push({
      key: OTHER_MODEL_KEY,
      label: '',
      value: rest,
      share: rest / total,
    });
  }
  return slices;
}

/** Compact token text: `77.4 亿` / `12.3 万` in zh, `774M` / `12.3K` in en. */
export function formatCompact(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  // No thousands separators on the scaled part: "8600 万", not "8,600 万".
  const short = (scaled: number): string =>
    new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
      useGrouping: false,
    }).format(scaled);
  if (locale.startsWith('zh')) {
    if (abs >= 1e8) return `${short(value / 1e8)} 亿`;
    if (abs >= 1e4) return `${short(value / 1e4)} 万`;
    return new Intl.NumberFormat(locale).format(value);
  }
  if (abs >= 1e9) return `${short(value / 1e9)}B`;
  if (abs >= 1e6) return `${short(value / 1e6)}M`;
  if (abs >= 1e3) return `${short(value / 1e3)}K`;
  return new Intl.NumberFormat(locale).format(value);
}

/** Full grouped number (tooltips, detail values). */
export function formatFull(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale).format(value);
}

export function formatCost(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(value);
}

/** Local calendar date (`YYYY-MM-DD`) of a UTC timestamp in the viewer's zone. */
export function localDateKeyOf(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/** `11月2日` / `Nov 2` (UTC-pinned: date keys are calendar values). */
export function formatDayLabel(dateKey: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateKeyToUtc(dateKey));
}

/** `11月` / `Nov` (heatmap month axis). */
export function formatMonthLabel(dateKey: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
    dateKeyToUtc(dateKey),
  );
}

/** `11/2` (trend x axis). */
export function formatAxisDate(dateKey: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(dateKeyToUtc(dateKey));
}

/** Round minutes into hours + minutes for localized duration templates. */
export function splitDuration(minutes: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Evenly sampled tick indexes (at most `count`, always includes both ends). */
export function sampleIndexes(length: number, count: number): number[] {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

export { DAY_MS };
