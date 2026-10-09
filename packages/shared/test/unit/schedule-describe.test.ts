import { describe, expect, it } from 'vitest';
import {
  describeCron,
  describeInstant,
  describeScheduleWhen,
  scheduleDisplayTitle,
} from '../../src/schedule-describe.js';

const TZ = 'Asia/Shanghai';
/** 2026-10-09T10:00:00+08:00, a Friday. */
const NOW = Date.parse('2026-10-09T10:00:00+08:00');

describe('describeCron', () => {
  it.each([
    ['0 9 * * *', '每天 09:00'],
    ['30 18 * * 1-5', '每个工作日 18:30'],
    ['0 10 * * 0,6', '每个周末 10:00'],
    ['0 10 * * 6,7', '每个周末 10:00'],
    ['0 9 * * 1', '每周一 09:00'],
    ['0 9 * * 1,3', '每周一、三 09:00'],
    ['0 9 * * 1-3', '每周一、二、三 09:00'],
    ['0 9 * * 0', '每周日 09:00'],
    ['0 9,18 * * *', '每天 09:00、18:00'],
    ['0 9 1 * *', '每月 1 日 09:00'],
    ['0 9 1,15 * *', '每月 1、15 日 09:00'],
    ['0 9 1 3 *', '每年 3 月 1 日 09:00'],
    ['*/15 * * * *', '每 15 分钟'],
    ['0 */2 * * *', '每 2 小时'],
    ['5 * * * *', '每小时第 5 分'],
    ['@daily', '每天 00:00'],
    ['@weekly', '每周日 00:00'],
  ])('%s → %s', (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });

  it.each(['0 9-18 * * *', '0 9 * * MON', '0 9 1 * 1', 'not a cron', '0 9 L * *'])(
    'returns null for unsupported shape %s',
    (cron) => {
      expect(describeCron(cron)).toBeNull();
    },
  );
});

describe('describeInstant', () => {
  it('says 今天 / 明天 relative to now', () => {
    expect(describeInstant(Date.parse('2026-10-09T15:30:00+08:00'), TZ, NOW)).toBe('今天 15:30');
    expect(describeInstant(Date.parse('2026-10-10T09:00:00+08:00'), TZ, NOW)).toBe('明天 09:00');
  });

  it('gives month, day and weekday otherwise, the year only across years', () => {
    expect(describeInstant(Date.parse('2026-10-12T09:00:00+08:00'), TZ, NOW)).toBe(
      '10月12日（周一）09:00',
    );
    expect(describeInstant(Date.parse('2027-01-04T09:00:00+08:00'), TZ, NOW)).toBe(
      '2027年1月4日（周一）09:00',
    );
  });

  it('renders the wall time of the given zone', () => {
    expect(describeInstant(Date.parse('2026-10-12T01:00:00Z'), 'America/New_York')).toBe(
      '10月11日（周日）21:00',
    );
  });
});

describe('describeScheduleWhen', () => {
  it('falls back to the raw cron for shapes it cannot word', () => {
    expect(
      describeScheduleWhen({ kind: 'cron', cron: '0 9-18 * * *', runAt: null, timezone: TZ }),
    ).toBe('cron「0 9-18 * * *」');
  });

  it('appends the zone when it differs from the user zone', () => {
    expect(
      describeScheduleWhen(
        { kind: 'cron', cron: '0 9 * * *', runAt: null, timezone: 'Europe/London' },
        { localTimeZone: TZ },
      ),
    ).toBe('每天 09:00（Europe/London）');
    expect(
      describeScheduleWhen(
        { kind: 'cron', cron: '0 9 * * *', runAt: null, timezone: TZ },
        { localTimeZone: TZ },
      ),
    ).toBe('每天 09:00');
  });

  it('words one-shot schedules', () => {
    expect(
      describeScheduleWhen(
        { kind: 'once', cron: null, runAt: Date.parse('2026-10-10T09:00:00+08:00'), timezone: TZ },
        { now: NOW },
      ),
    ).toBe('明天 09:00');
  });
});

describe('scheduleDisplayTitle', () => {
  it('prefers the title and cuts long notes', () => {
    expect(scheduleDisplayTitle({ title: '工作日早报', note: 'x' })).toBe('工作日早报');
    expect(scheduleDisplayTitle({ title: '', note: '提醒用户整理周报' })).toBe('提醒用户整理周报');
    expect(scheduleDisplayTitle({ title: ' ', note: 'a'.repeat(30) })).toBe(`${'a'.repeat(24)}…`);
  });
});
