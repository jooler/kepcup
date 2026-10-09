import { createHash } from 'node:crypto';
import { WATCH_DIFF_SUMMARY_MAX_CHARS } from '@kepcup/shared';

/**
 * 网页按行 diff（W7 确定性监看，借 [M] page-diff.ts）：页面正文 → 规整的行；
 * 去掉相对时间（「3 分钟前」「just now」）后的「安静 hash」决定 `changed`
 * 条件是否成立——只有相对时间在走的页面不算变化。纯函数，无 FTS / 分词（§5
 * 护栏 5）。
 */

/** Page text → trimmed non-empty lines with internal whitespace collapsed. */
export function pageLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

/** Placeholder a relative time is replaced with (stable across checks). */
export const RELATIVE_TIME_PLACEHOLDER = '‹相对时间›';

/*
 * Relative-time patterns. Chinese: 「3 分钟前」「两小时前」「半小时前」「几秒前」
 * 「刚刚 / 刚才」「昨天 / 前天 / 今天」「3 天后」. English: "5 minutes ago",
 * "an hour ago", "a few seconds ago", "just now", "yesterday", "today",
 * "in 3 days", abbreviated "5m ago" / "3h ago" / "2d ago". Absolute dates and
 * clock times are left alone: when they change, the page did change — so are
 * calendar-like 「10日前发货」「3月前完成」 (bare 日 / 月 followed by more Han
 * text) and point counts 「100分后」 (bare 分 with 3+ digits).
 */
const CN_DIGITS = '[一二两三四五六七八九十百几半多数]+';
const CN_NUMBER = `(?:\\d+|${CN_DIGITS})`;
/** Units that are unambiguous after a number (no 「日」「月」「分」: see below). */
const CN_UNIT = '(?:秒钟|秒|分钟|小时|个小时|个钟头|钟头|天|周|星期|个星期|个月|年)';
const CN_AGO = '(?:以前|之前|前|以后|之后|后)';
const RELATIVE_TIME_PATTERNS: readonly RegExp[] = [
  new RegExp(`${CN_NUMBER}\\s*${CN_UNIT}\\s*${CN_AGO}`, 'g'),
  // Bare 「分」 is also a score / point count (「100分后」): only 1–2 digit counts.
  new RegExp(`(?<!\\d)(?:\\d{1,2}|${CN_DIGITS})\\s*分\\s*${CN_AGO}`, 'g'),
  // Bare 「日」「月」 also name a day / month of the calendar (「10日前发货」 =
  // ship before the 10th, 「3月前完成」): relative only at the end of a phrase,
  // not followed by more Han text.
  new RegExp(`${CN_NUMBER}\\s*[日月]\\s*${CN_AGO}(?!\\p{Script=Han})`, 'gu'),
  /刚刚|刚才|片刻前|前天|昨天|今天|明天|后天/g,
  /\b(?:\d+|an?|one|a\s+few|few|several)\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b/gi,
  /\b\d+\s*(?:s|m|h|d|w|mo|y)\s+ago\b/gi,
  /\bin\s+(?:\d+|an?|one|a\s+few)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/gi,
  /\b(?:just\s+now|moments?\s+ago|yesterday|today|tomorrow)\b/gi,
];

/** One line with every relative time replaced by RELATIVE_TIME_PLACEHOLDER. */
export function withoutRelativeTimes(line: string): string {
  let out = line;
  for (const pattern of RELATIVE_TIME_PATTERNS) {
    out = out.replace(pattern, RELATIVE_TIME_PLACEHOLDER);
  }
  return out;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of the lines as they are. */
export function pageHash(lines: readonly string[]): string {
  return sha256(lines.join('\n'));
}

/** Hash of the lines with relative times removed (what `changed` compares). */
export function quietHash(lines: readonly string[]): string {
  return sha256(lines.map(withoutRelativeTimes).join('\n'));
}

export interface PageDiff {
  added: string[];
  removed: string[];
  changed: Array<{ before: string; after: string }>;
  /** No line was added / removed / changed, but the lines' order differs. */
  reordered?: boolean;
}

/**
 * Line diff of two page versions, relative times ignored. Lines are matched
 * as a multiset (order-insensitive, count-aware): a page's lines rarely
 * reorder, and an LCS over thousands of lines is not worth its cost here.
 * A removed line pairs with the first unpaired added line that is similar
 * enough (shared prefix + suffix ≥ half the longer line) → "changed"
 * (「价格：¥100」→「价格：¥90」); the rest stay added / removed.
 */
export function diffPage(before: readonly string[], after: readonly string[]): PageDiff {
  const remaining = new Map<string, number>();
  for (const line of before) {
    const key = withoutRelativeTimes(line);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of after) {
    const key = withoutRelativeTimes(line);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  const leftover = new Map(remaining);
  for (const line of before) {
    const key = withoutRelativeTimes(line);
    const count = leftover.get(key) ?? 0;
    if (count > 0) {
      leftover.set(key, count - 1);
      removed.push(line);
    }
  }
  const changed: Array<{ before: string; after: string }> = [];
  const unpairedAdded = [...added];
  const unpairedRemoved: string[] = [];
  for (const line of removed) {
    const index = unpairedAdded.findIndex((candidate) => similar(line, candidate));
    if (index >= 0) {
      changed.push({ before: line, after: unpairedAdded[index]! });
      unpairedAdded.splice(index, 1);
    } else {
      unpairedRemoved.push(line);
    }
  }
  const diff: PageDiff = { added: unpairedAdded, removed: unpairedRemoved, changed };
  if (isEmptyDiff(diff) && before.length === after.length) {
    const quietBefore = before.map(withoutRelativeTimes);
    if (after.some((line, i) => withoutRelativeTimes(line) !== quietBefore[i])) {
      diff.reordered = true;
    }
  }
  return diff;
}

/** Shared prefix + suffix covers at least half of the longer line. */
function similar(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  if (max === 0) return true;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) * 2 >= max;
}

export function isEmptyDiff(diff: PageDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

const LINE_PREVIEW_CHARS = 160;

function clip(line: string): string {
  return line.length > LINE_PREVIEW_CHARS ? `${line.slice(0, LINE_PREVIEW_CHARS)}…` : line;
}

/**
 * Human-readable 增删改 summary of a diff, at most `maxChars` (default
 * WATCH_DIFF_SUMMARY_MAX_CHARS). Lines that do not fit are counted in a
 * closing「另有 N 处变化未列出」line. The content is web page text: callers
 * must present it to a bot as untrusted.
 */
export function describePageDiff(
  diff: PageDiff,
  maxChars = WATCH_DIFF_SUMMARY_MAX_CHARS,
  options: { comparedChars?: number } = {},
): string {
  // The stored previous version was cut: only that much of the page was compared.
  const cutNote =
    options.comparedChars !== undefined ? `（页面过长，仅比较前 ${options.comparedChars} 字）` : '';
  if (isEmptyDiff(diff)) {
    if (diff.reordered === true) return `页面内容顺序有变化（没有新增或删除的行）。${cutNote}`;
    return cutNote !== ''
      ? `比较范围内没有变化${cutNote}，变化可能在页面后部。`
      : '页面内容没有变化（只有相对时间等噪声）。';
  }
  const header = `修改 ${diff.changed.length} 行，新增 ${diff.added.length} 行，删除 ${diff.removed.length} 行${cutNote}`;
  const entries: string[] = [
    ...diff.changed.map((entry) => `~ ${clip(entry.before)} → ${clip(entry.after)}`),
    ...diff.added.map((line) => `+ ${clip(line)}`),
    ...diff.removed.map((line) => `- ${clip(line)}`),
  ];
  const lines = [header];
  let used = header.length;
  let shown = 0;
  for (const entry of entries) {
    const restAfter = entries.length - shown - 1;
    // Reserve room for the closing "另有 N 处" line whenever entries remain.
    const reserve = restAfter > 0 ? 24 : 0;
    if (used + 1 + entry.length + reserve > maxChars) break;
    lines.push(entry);
    used += 1 + entry.length;
    shown += 1;
  }
  if (shown < entries.length) lines.push(`…另有 ${entries.length - shown} 处变化未列出`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
