import {
  MAX_PROACTIVE_PER_DAY,
  SCHEDULE_GUARD_RETRY_MS,
  SCHEDULE_LATE_BY_MIN_MS,
  type BotBehavior,
} from '@kepcup/shared';
import { localDayStart, nextLocalMidnight } from '../memory/local-date.js';

/**
 * Proactive-message guardrails (P10, docs/design/02-execution.md "主动消息"):
 * quiet hours in the user's local time zone (cross-midnight correct), the
 * daily proactive cap counted per local day, and the proactive switch. Pure
 * functions so time zones / DST / cross-midnight windows are unit-testable.
 */

export interface QuietHoursWindow {
  startMinutes: number;
  endMinutes: number;
}

/**
 * "HH:MM" → minutes of day; null when malformed. start == end (the
 * conventional "00:00–00:00") is the 24-hour window — the whole day is quiet
 * (BR-P10-009): the wrap-around reading of "from X until X" is uniform with
 * the start > end midnight-crossing rule.
 */
export function parseQuietHours(
  value: readonly [string, string] | null | undefined,
): QuietHoursWindow | null {
  if (!value) return null;
  const parse = (raw: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const start = parse(value[0] ?? '');
  const end = parse(value[1] ?? '');
  if (start === null || end === null) return null;
  return { startMinutes: start, endMinutes: end };
}

/** Minutes-of-day (0..1439) of `nowMs` rendered in `timeZone`. */
export function minutesOfLocalDay(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return (get('hour') % 24) * 60 + get('minute');
}

export function inQuietHours(nowMs: number, window: QuietHoursWindow, timeZone: string): boolean {
  const minutes = minutesOfLocalDay(nowMs, timeZone);
  if (window.startMinutes < window.endMinutes) {
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  // start > end crosses local midnight (e.g. 23:00–07:00); start == end is
  // the wrap-around 24h window: every minute satisfies one of the arms.
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

/**
 * Maps a wall-clock time on the local day containing `dayStart` to a UTC
 * instant, DST-safe: iteratively reconciles the wall time (a skipped
 * spring-forward time lands after the gap, an ambiguous fall-back time picks
 * the first occurrence — same convention as the cron parser).
 */
function wallTimeToEpoch(dayStart: number, minutes: number, timeZone: string): number {
  let candidate = dayStart + minutes * 60_000;
  for (let i = 0; i < 3; i += 1) {
    const actual = minutesOfLocalDay(candidate, timeZone);
    if (actual === minutes) return candidate;
    candidate += (minutes - actual) * 60_000;
  }
  return candidate;
}

/**
 * The instant the currently-active quiet window ends; `nowMs` itself when not
 * quiet. An end at 00:00 is represented by endMinutes 0, so an all-day
 * window (start == end) defers to the next local midnight.
 */
export function quietHoursEndAt(nowMs: number, window: QuietHoursWindow, timeZone: string): number {
  if (!inQuietHours(nowMs, window, timeZone)) return nowMs;
  const minutes = minutesOfLocalDay(nowMs, timeZone);
  // Cross-midnight window: early-morning minutes belong to the window that
  // started yesterday, so it ends today; late-evening minutes end tomorrow.
  const dayStart =
    window.startMinutes < window.endMinutes || minutes < window.endMinutes
      ? localDayStart(nowMs, timeZone)
      : nextLocalMidnight(nowMs, timeZone);
  return wallTimeToEpoch(dayStart, window.endMinutes, timeZone);
}

export type GuardReason = 'proactive-disabled' | 'quiet-hours' | 'daily-cap';

export type GuardVerdict =
  | { kind: 'allow' }
  | { kind: 'defer'; reason: GuardReason; retryAt: number };

/**
 * Whether a proactive trigger may fire right now. Event triggers are exempt
 * from the daily cap but still bound by quiet hours and the proactive switch
 * is checked by the caller for scheduled triggers only (docs/dev/phases/
 * P10-proactive.md 任务 5).
 */
export function evaluateGuard(input: {
  behavior: BotBehavior;
  now: number;
  timeZone: string;
  /** Proactive executions that actually sent a message today (local day). */
  sentToday: number;
  isEvent: boolean;
}): GuardVerdict {
  const { behavior, now, timeZone, sentToday, isEvent } = input;
  if (!behavior.proactive) {
    return { kind: 'defer', reason: 'proactive-disabled', retryAt: now + SCHEDULE_GUARD_RETRY_MS };
  }
  const quiet = parseQuietHours(behavior.quiet_hours);
  if (quiet !== null && inQuietHours(now, quiet, timeZone)) {
    return { kind: 'defer', reason: 'quiet-hours', retryAt: quietHoursEndAt(now, quiet, timeZone) };
  }
  const cap = behavior.max_proactive_per_day ?? MAX_PROACTIVE_PER_DAY;
  if (!isEvent && sentToday >= cap) {
    return { kind: 'defer', reason: 'daily-cap', retryAt: nextLocalMidnight(now, timeZone) };
  }
  return { kind: 'allow' };
}

/** UI-facing deferral text (P10 任务 7; the interface renders it verbatim). */
export function guardReasonText(reason: GuardReason): string {
  switch (reason) {
    case 'proactive-disabled':
      return '该 Bot 已关闭主动消息';
    case 'quiet-hours':
      return '免打扰时段';
    case 'daily-cap':
      return '今日主动消息已达上限';
  }
}

/** Whether a late trigger carries the late_by marker (P10 任务 4: > 1 分钟). */
export function isLateEnough(lateByMs: number): boolean {
  return lateByMs > SCHEDULE_LATE_BY_MIN_MS;
}

/** "2 小时 15 分钟" style duration for the trigger segment (human readable). */
export function humanizeLateBy(lateByMs: number): string {
  const totalMinutes = Math.max(1, Math.round(lateByMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`);
  return parts.join(' ');
}
