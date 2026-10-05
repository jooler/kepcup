import { describe, expect, it } from 'vitest';
import {
  humanizeLateBy,
  inQuietHours,
  isLateEnough,
  minutesOfLocalDay,
  parseQuietHours,
  quietHoursEndAt,
  evaluateGuard,
} from '../../src/schedule/guard.js';
import { nextLocalMidnight } from '../../src/memory/local-date.js';
import type { BotBehavior } from '@kepcup/shared';

function behavior(overrides: Partial<BotBehavior> = {}): BotBehavior {
  return { proactive: true, quiet_hours: null, max_proactive_per_day: null, ...overrides };
}

describe('P10 护栏：免打扰时段解析', () => {
  it('"HH:MM" 解析为分钟；非法输入返回 null', () => {
    expect(parseQuietHours(['23:00', '07:00'])).toEqual({ startMinutes: 23 * 60, endMinutes: 7 * 60 });
    expect(parseQuietHours(['0:30', '6:59'])).toEqual({ startMinutes: 30, endMinutes: 6 * 60 + 59 });
    expect(parseQuietHours(['24:00', '07:00'])).toBeNull();
    expect(parseQuietHours(['ab:cd', '07:00'])).toBeNull();
    expect(parseQuietHours(null)).toBeNull();
    expect(parseQuietHours(undefined)).toBeNull();
  });

  it('start == end（如 00:00–00:00）= 全天静音，不再视为关闭（BR-P10-009）', () => {
    expect(parseQuietHours(['00:00', '00:00'])).toEqual({ startMinutes: 0, endMinutes: 0 });
    expect(parseQuietHours(['09:00', '09:00'])).toEqual({ startMinutes: 540, endMinutes: 540 });
  });
});

describe('P10 护栏：免打扰时段判断（跨午夜正确）', () => {
  const tz = 'Asia/Shanghai';
  const quiet = parseQuietHours(['23:00', '07:00'])!;

  it('同时段窗口（13:00-14:00）只覆盖窗口内', () => {
    const window = parseQuietHours(['13:00', '14:00'])!;
    // 2026-10-01 05:30Z = 13:30 +08
    expect(inQuietHours(Date.parse('2026-10-01T05:30:00Z'), window, tz)).toBe(true);
    // 12:59 与 14:00 都不在窗口内（结束时刻放行）
    expect(inQuietHours(Date.parse('2026-10-01T04:59:00Z'), window, tz)).toBe(false);
    expect(inQuietHours(Date.parse('2026-10-01T06:00:00Z'), window, tz)).toBe(false);
  });

  it('跨午夜窗口：凌晨与深夜静音，白天放行', () => {
    // 2026-10-01T20:00:00Z = 10-02 04:00 +08（凌晨）→ 静音
    expect(inQuietHours(Date.parse('2026-10-01T20:00:00Z'), quiet, tz)).toBe(true);
    // 2026-10-01T16:30:00Z = 10-02 00:30 +08（午夜刚过）→ 静音
    expect(inQuietHours(Date.parse('2026-10-01T16:30:00Z'), quiet, tz)).toBe(true);
    // 2026-10-01T15:59:00Z = 10-01 23:59 +08（深夜）→ 静音
    expect(inQuietHours(Date.parse('2026-10-01T15:59:00Z'), quiet, tz)).toBe(true);
    // 2026-10-01T02:00:00Z = 10:00 +08（上午）→ 放行
    expect(inQuietHours(Date.parse('2026-10-01T02:00:00Z'), quiet, tz)).toBe(false);
  });

  it('推迟到时段结束（跨午夜的两个方向都正确）', () => {
    // 凌晨 04:00 +08 → 当天 07:00 +08 = 前一日 23:00Z
    expect(quietHoursEndAt(Date.parse('2026-10-01T20:00:00Z'), quiet, tz)).toBe(
      Date.parse('2026-10-01T23:00:00Z'),
    );
    // 深夜 23:30 +08 → 次日 07:00 +08 = 10-01 23:00Z
    expect(quietHoursEndAt(Date.parse('2026-10-01T15:30:00Z'), quiet, tz)).toBe(
      Date.parse('2026-10-01T23:00:00Z'),
    );
    // 不在静音窗口 → 立即
    expect(quietHoursEndAt(Date.parse('2026-10-01T02:00:00Z'), quiet, tz)).toBe(
      Date.parse('2026-10-01T02:00:00Z'),
    );
  });

  it('夏令时切换日：墙钟时刻被尊重（spring forward）', () => {
    // 2026-03-08 美国东部 02:00 跳到 03:00；静音 00:00-07:00，01:00 EST 时
    // 推迟到 07:00 EDT = 11:00Z（朴素加法会得到 12:00Z = 08:00 EDT）。
    const window = parseQuietHours(['00:00', '07:00'])!;
    const tzNy = 'America/New_York';
    expect(quietHoursEndAt(Date.parse('2026-03-08T06:00:00Z'), window, tzNy)).toBe(
      Date.parse('2026-03-08T11:00:00Z'),
    );
  });

  it('夏令时切换日：fall back 的静音结束时刻', () => {
    // 2026-11-01 美国东部 02:00 EDT 回拨 01:00 EST；00:30 EDT 处于静音，
    // 结束时刻 07:00 EST = 12:00Z。
    const window = parseQuietHours(['00:00', '07:00'])!;
    const tzNy = 'America/New_York';
    expect(quietHoursEndAt(Date.parse('2026-11-01T04:30:00Z'), window, tzNy)).toBe(
      Date.parse('2026-11-01T12:00:00Z'),
    );
  });

  it('minutesOfLocalDay 与 Intl 一致', () => {
    // 2026-10-01T15:30:00Z = 23:30 +08
    expect(minutesOfLocalDay(Date.parse('2026-10-01T15:30:00Z'), tz)).toBe(23 * 60 + 30);
  });
});

describe('P10 护栏：全天静音（start == end，BR-P10-009）', () => {
  const tz = 'Asia/Shanghai';
  const allDay = parseQuietHours(['00:00', '00:00'])!;

  it('任意本地时刻都在静音窗口内', () => {
    expect(inQuietHours(Date.parse('2026-10-01T02:00:00Z'), allDay, tz)).toBe(true); // 10:00
    expect(inQuietHours(Date.parse('2026-10-01T15:59:00Z'), allDay, tz)).toBe(true); // 23:59
    expect(inQuietHours(Date.parse('2026-10-01T16:30:00Z'), allDay, tz)).toBe(true); // 00:30（次日）
  });

  it('推迟到下一个本地零点（00:00 之后仍静音 → 再次推迟，永不触发）', () => {
    // 13:30 +08 → 当天 24:00 本地
    expect(quietHoursEndAt(Date.parse('2026-10-01T05:30:00Z'), allDay, tz)).toBe(
      Date.parse('2026-10-01T16:00:00Z'),
    );
    // 23:30 +08 → 30 分钟后的本地零点
    expect(quietHoursEndAt(Date.parse('2026-10-01T15:30:00Z'), allDay, tz)).toBe(
      Date.parse('2026-10-01T16:00:00Z'),
    );
    // 00:30 +08（已越过零点）→ 下一个零点
    expect(quietHoursEndAt(Date.parse('2026-10-01T16:30:00Z'), allDay, tz)).toBe(
      Date.parse('2026-10-02T16:00:00Z'),
    );
  });

  it('evaluateGuard：全天静音下 scheduled 与 event 都推迟，原因为免打扰', () => {
    const verdict = evaluateGuard({
      behavior: behavior({ quiet_hours: ['00:00', '00:00'] }),
      now: Date.parse('2026-10-01T05:30:00Z'),
      timeZone: tz,
      sentToday: 0,
      isEvent: false,
    });
    expect(verdict).toEqual({
      kind: 'defer',
      reason: 'quiet-hours',
      retryAt: Date.parse('2026-10-01T16:00:00Z'),
    });
    const event = evaluateGuard({
      behavior: behavior({ quiet_hours: ['00:00', '00:00'] }),
      now: Date.parse('2026-10-01T05:30:00Z'),
      timeZone: tz,
      sentToday: 0,
      isEvent: true,
    });
    expect(event).toMatchObject({ kind: 'defer', reason: 'quiet-hours' });
  });
});

describe('P10 护栏：每日上限与主动消息开关', () => {
  const tz = 'Asia/Shanghai';
  const now = Date.parse('2026-10-01T05:30:00Z'); // 13:30 本地，非静音

  it('默认上限 MAX_PROACTIVE_PER_DAY，超出推迟到次日零点', () => {
    expect(evaluateGuard({ behavior: behavior(), now, timeZone: tz, sentToday: 4, isEvent: false })).toEqual({
      kind: 'allow',
    });
    const verdict = evaluateGuard({
      behavior: behavior(),
      now,
      timeZone: tz,
      sentToday: 5,
      isEvent: false,
    });
    expect(verdict).toEqual({ kind: 'defer', reason: 'daily-cap', retryAt: nextLocalMidnight(now, tz) });
  });

  it('Profile 覆盖上限；事件触发不受每日上限', () => {
    const capped = behavior({ max_proactive_per_day: 2 });
    expect(evaluateGuard({ behavior: capped, now, timeZone: tz, sentToday: 1, isEvent: false }).kind).toBe(
      'allow',
    );
    expect(
      evaluateGuard({ behavior: capped, now, timeZone: tz, sentToday: 2, isEvent: false }),
    ).toMatchObject({ kind: 'defer', reason: 'daily-cap' });
    // 事件触发豁免每日上限
    expect(evaluateGuard({ behavior: capped, now, timeZone: tz, sentToday: 99, isEvent: true }).kind).toBe(
      'allow',
    );
  });

  it('关闭主动消息 → 推迟并保留任务', () => {
    const verdict = evaluateGuard({
      behavior: behavior({ proactive: false }),
      now,
      timeZone: tz,
      sentToday: 0,
      isEvent: false,
    });
    expect(verdict).toMatchObject({ kind: 'defer', reason: 'proactive-disabled' });
    if (verdict.kind === 'defer') expect(verdict.retryAt).toBeGreaterThan(now);
  });

  it('免打扰时段优先于每日上限判断', () => {
    const quietNow = Date.parse('2026-10-01T20:00:00Z'); // 04:00 +08，静音
    const verdict = evaluateGuard({
      behavior: behavior({ quiet_hours: ['23:00', '07:00'], max_proactive_per_day: 0 }),
      now: quietNow,
      timeZone: tz,
      sentToday: 99,
      isEvent: false,
    });
    expect(verdict).toMatchObject({ kind: 'defer', reason: 'quiet-hours' });
  });
});

describe('P10：late_by 人类可读格式与阈值', () => {
  it('超过 1 分钟才标注（严格大于）', () => {
    expect(isLateEnough(60_000)).toBe(false);
    expect(isLateEnough(60_001)).toBe(true);
    expect(isLateEnough(0)).toBe(false);
  });

  it('人类可读格式', () => {
    expect(humanizeLateBy(3 * 60 * 60 * 1000)).toBe('3 小时');
    expect(humanizeLateBy(3 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe('3 小时 15 分钟');
    expect(humanizeLateBy(90 * 60 * 1000)).toBe('1 小时 30 分钟');
    expect(humanizeLateBy(2 * 24 * 60 * 60 * 1000)).toBe('2 天');
    expect(humanizeLateBy(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 1000)).toBe('2 天 3 分钟');
    expect(humanizeLateBy(61 * 60 * 1000)).toBe('1 小时 1 分钟');
    // 不足 1 分钟的部分四舍五入，且不会输出空串
    expect(humanizeLateBy(60_001)).toBe('1 分钟');
  });
});
