import {
  WATCH_BACKOFF_MAX_MINUTES,
  WATCH_MIN_INTERVAL_SEC,
  WATCH_PAUSE_AFTER_FAILURES,
  type WatchCondition,
} from '@kepcup/shared';

/**
 * 监看条件求值与边沿触发（W7）：检查本身确定性、不花 LLM；只有「上次不满足、
 * 这次满足」才提醒（`changed`：去噪后的页面 hash 与上次不同）。
 */

/*
 * Numbers in price-like text. Supported:
 * - an optional currency sign right before the number: ¥ ￥ $ € £ (with or
 *   without a space), also after a sign: "-¥5";
 * - thousands separators: ASCII "," or full-width "，" between groups of exactly
 *   three digits ("1,299", "12，800.50");
 * - a decimal point "." ("99.90").
 * Not supported (read as separate numbers or not at all): European formats
 * ("1.299,00"), Chinese numerals (一百), unit words (万 / 亿 / k), scientific
 * notation, fractions. Prefer a selector on the price element for pages where
 * the first number is not the price.
 */
const NUMBER_PATTERN =
  /([¥￥$€£])?\s?([-−]?)([¥￥$€£])?\s?(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

export interface ExtractedNumber {
  value: number;
  /** A currency sign was attached (price-like). */
  currency: boolean;
}

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const digits = (match[4] ?? '').replace(/[,，]/g, '');
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    // A dash right after a letter / digit is a hyphen ("2026-10-09", "A-3"), not a sign.
    const signAt = match.index + Math.max(0, match[0].search(/[-−]/));
    const before = signAt > 0 ? text[signAt - 1]! : '';
    const negative = (match[2] === '-' || match[2] === '−') && !/[\p{L}\p{N}]/u.test(before);
    out.push({
      value: negative ? -value : value,
      currency: match[1] !== undefined || match[3] !== undefined,
    });
  }
  return out;
}

/** The number a number condition reads: the first price-like one, else the first one. */
export function pickNumber(text: string): number | null {
  const numbers = extractNumbers(text);
  if (numbers.length === 0) return null;
  return (numbers.find((n) => n.currency) ?? numbers[0]!).value;
}

/** What one check observed (the fetcher's text, already scoped to source.selector). */
export interface ConditionInput {
  text: string;
  /** Text of the number condition's own selector (null = selector matched nothing). */
  numberText?: string | null;
}

export type ConditionVerdict =
  | { ok: true; matched: boolean; /** Human summary of the observation. */ detail: string }
  /** The page could not be evaluated (counts as a failed check). */
  | { ok: false; error: string };

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/** Evaluates a condition's current value (not the edge). `changed` is always "matched". */
export function evaluateCondition(
  condition: WatchCondition,
  input: ConditionInput,
): ConditionVerdict {
  switch (condition.kind) {
    case 'changed':
      return { ok: true, matched: true, detail: '页面有变化' };
    case 'contains': {
      const matched = normalized(input.text).includes(normalized(condition.text));
      return {
        ok: true,
        matched,
        detail: matched ? `页面出现了「${condition.text}」` : `页面没有「${condition.text}」`,
      };
    }
    case 'not_contains': {
      const present = normalized(input.text).includes(normalized(condition.text));
      return {
        ok: true,
        matched: !present,
        detail: present ? `页面仍有「${condition.text}」` : `页面上「${condition.text}」消失了`,
      };
    }
    case 'number_below':
    case 'number_above': {
      if (
        condition.selector !== undefined &&
        (input.numberText === null || input.numberText === undefined)
      ) {
        return { ok: false, error: `页面上找不到元素 ${condition.selector}` };
      }
      const source = condition.selector !== undefined ? (input.numberText ?? '') : input.text;
      const value = pickNumber(source);
      if (value === null) return { ok: false, error: '页面上没有找到数字' };
      const matched =
        condition.kind === 'number_below' ? value < condition.value : value > condition.value;
      const op = condition.kind === 'number_below' ? '<' : '>';
      return {
        ok: true,
        matched,
        detail: `当前数值 ${value}（条件 ${op} ${condition.value}${matched ? '，已满足' : '，未满足'}）`,
      };
    }
  }
}

/**
 * Edge trigger: should this check alert?
 * - `changed`: a previous quiet hash exists and differs (the first check only
 *   records the baseline);
 * - the others: the condition was false at the previous check and is true now
 *   (`lastMatched` starts false, so a condition already true at the first
 *   check alerts once).
 */
export function isEdge(
  condition: WatchCondition,
  previous: { lastMatched: boolean; lastQuietHash: string | null },
  current: { matched: boolean; quietHash: string },
): boolean {
  if (condition.kind === 'changed') {
    return previous.lastQuietHash !== null && previous.lastQuietHash !== current.quietHash;
  }
  return !previous.lastMatched && current.matched;
}

/**
 * Failure backoff, `failures` counted after this failure: the upstream
 * min(60, 2^failures) minutes, but never sooner than the minimum check
 * interval (5 minutes) — a failing page is not hit more often than a healthy
 * one. Sequence: 5 / 5 / 8 / 16 / 32 / 60 minutes.
 */
export function failureBackoffMs(failures: number): number {
  const minutes = Math.min(WATCH_BACKOFF_MAX_MINUTES, 2 ** Math.max(0, failures));
  return Math.max(minutes * 60_000, WATCH_MIN_INTERVAL_SEC * 1000);
}

/** A watch pauses once this many consecutive checks failed. */
export function shouldPause(failures: number): boolean {
  return failures >= WATCH_PAUSE_AFTER_FAILURES;
}

/** One-line human description of a condition (tools, cards, the wake message). */
export function describeCondition(condition: WatchCondition): string {
  switch (condition.kind) {
    case 'changed':
      return '页面内容有变化';
    case 'contains':
      return `页面出现「${condition.text}」`;
    case 'not_contains':
      return `页面上「${condition.text}」消失`;
    case 'number_below':
      return `数值低于 ${condition.value}${condition.selector !== undefined ? `（元素 ${condition.selector}）` : ''}`;
    case 'number_above':
      return `数值高于 ${condition.value}${condition.selector !== undefined ? `（元素 ${condition.selector}）` : ''}`;
  }
}
