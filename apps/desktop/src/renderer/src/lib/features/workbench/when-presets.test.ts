import { describe, expect, it } from 'vitest';
import {
  cronToPreset,
  draftFromSchedule,
  emptyWhenDraft,
  isPastOnce,
  skipsShortMonths,
  fromLocalInput,
  nextFireOfPreset,
  presetToCron,
  sameWhen,
  toLocalInput,
  whenFromDraft,
  type RepeatPreset,
} from './when-presets';

describe('presetToCron', () => {
  it('每天 / 工作日 / 每周几 / 每月几号 转成 5 段 cron', () => {
    expect(presetToCron({ kind: 'daily', time: '09:00' })).toBe('0 9 * * *');
    expect(presetToCron({ kind: 'weekdays', time: '08:30' })).toBe('30 8 * * 1-5');
    expect(presetToCron({ kind: 'weekly', days: [5, 1, 3], time: '18:05' })).toBe('5 18 * * 1,3,5');
    expect(presetToCron({ kind: 'weekly', days: [0, 6], time: '10:00' })).toBe('0 10 * * 0,6');
    expect(presetToCron({ kind: 'monthly', day: 15, time: '07:00' })).toBe('0 7 15 * *');
  });

  it('周日用 0 或 7 都归一；七天全选等价每天', () => {
    expect(presetToCron({ kind: 'weekly', days: [7], time: '09:00' })).toBe('0 9 * * 0');
    expect(presetToCron({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })).toBe(
      '0 9 * * *',
    );
  });

  it('不合法的预设返回 null', () => {
    expect(presetToCron({ kind: 'daily', time: '25:00' })).toBeNull();
    expect(presetToCron({ kind: 'daily', time: '' })).toBeNull();
    expect(presetToCron({ kind: 'weekly', days: [], time: '09:00' })).toBeNull();
    expect(presetToCron({ kind: 'monthly', day: 0, time: '09:00' })).toBeNull();
    expect(presetToCron({ kind: 'monthly', day: 32, time: '09:00' })).toBeNull();
  });
});

describe('cronToPreset', () => {
  it('识别回预设', () => {
    expect(cronToPreset('0 9 * * *')).toEqual({ kind: 'daily', time: '09:00' });
    expect(cronToPreset('30 8 * * 1-5')).toEqual({ kind: 'weekdays', time: '08:30' });
    expect(cronToPreset('30 8 * * 1,2,3,4,5')).toEqual({ kind: 'weekdays', time: '08:30' });
    expect(cronToPreset('0 10 * * 0,6')).toEqual({ kind: 'weekly', days: [0, 6], time: '10:00' });
    expect(cronToPreset('0 10 * * 6-7')).toEqual({ kind: 'weekly', days: [0, 6], time: '10:00' });
    expect(cronToPreset('0 7 15 * *')).toEqual({ kind: 'monthly', day: 15, time: '07:00' });
    expect(cronToPreset('  0 9 * * 0-6 ')).toEqual({ kind: 'daily', time: '09:00' });
  });

  it('认不出的形态返回 null', () => {
    for (const cron of [
      '',
      '* * * * *',
      '*/5 * * * *',
      '0 9,18 * * *',
      '0 * * * *',
      '0 9 1 6 *',
      '0 9 15 * 1',
      '0 9 * * 8',
      '61 9 * * *',
      '0 9 * *',
      '@daily',
    ]) {
      expect(cronToPreset(cron), cron).toBeNull();
    }
  });

  it('与 presetToCron 互为逆运算', () => {
    const presets: RepeatPreset[] = [
      { kind: 'daily', time: '09:00' },
      { kind: 'weekdays', time: '23:59' },
      { kind: 'weekly', days: [1, 4], time: '00:05' },
      { kind: 'weekly', days: [0], time: '12:00' },
      { kind: 'monthly', day: 1, time: '06:30' },
      { kind: 'monthly', day: 31, time: '06:30' },
    ];
    for (const preset of presets) {
      const cron = presetToCron(preset) as string;
      expect(cronToPreset(cron)).toEqual(preset);
    }
  });
});

describe('本地时间输入', () => {
  it('datetime-local 与时间戳互转', () => {
    const at = new Date(2026, 9, 16, 9, 5).getTime();
    expect(toLocalInput(at)).toBe('2026-10-16T09:05');
    expect(fromLocalInput('2026-10-16T09:05')).toBe(at);
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-10-16')).toBeNull();
  });
});

describe('whenFromDraft / draftFromSchedule', () => {
  it('不定 / 立即 / 某时 / 重复', () => {
    expect(whenFromDraft(emptyWhenDraft())).toBeNull();
    expect(whenFromDraft({ ...emptyWhenDraft(), mode: 'now' })).toBe('now');
    const at = new Date(2026, 9, 16, 9, 5);
    expect(
      whenFromDraft({ ...emptyWhenDraft(), mode: 'once', onceLocal: '2026-10-16T09:05' }),
    ).toBe(at.toISOString());
    expect(
      whenFromDraft({
        ...emptyWhenDraft(),
        mode: 'repeat',
        preset: { kind: 'weekdays', time: '09:00' },
      }),
    ).toBe('0 9 * * 1-5');
  });

  it('没填完整返回 undefined', () => {
    expect(whenFromDraft({ ...emptyWhenDraft(), mode: 'once' })).toBeUndefined();
    expect(
      whenFromDraft({
        ...emptyWhenDraft(),
        mode: 'repeat',
        preset: { kind: 'weekly', days: [], time: '09:00' },
      }),
    ).toBeUndefined();
  });

  it('现有排期回显：单次 / 可识别的 cron / 自定义 cron / 无', () => {
    const at = new Date(2026, 9, 16, 9, 5).getTime();
    expect(draftFromSchedule(null).mode).toBe('none');
    expect(
      draftFromSchedule({ kind: 'once', runAt: at, cron: null, timezone: 'UTC' }),
    ).toMatchObject({
      mode: 'once',
      onceLocal: '2026-10-16T09:05',
    });
    expect(
      draftFromSchedule(
        { kind: 'cron', runAt: null, cron: '0 8 * * 1-5', timezone: 'Asia/Shanghai' },
        'Asia/Shanghai',
      ),
    ).toMatchObject({
      mode: 'repeat',
      preset: { kind: 'weekdays', time: '08:00' },
      customCron: null,
    });
    const custom = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '*/10 * * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    expect(custom).toMatchObject({ mode: 'repeat', customCron: '*/10 * * * *' });
    // 自定义 cron 原样提交，不被预设吃掉。
    expect(whenFromDraft(custom)).toBe('*/10 * * * *');
  });

  it('sameWhen：回显后不改动视为相同', () => {
    const a = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    const b = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'Asia/Shanghai' },
      'Asia/Shanghai',
    );
    expect(sameWhen(a, b)).toBe(true);
    expect(sameWhen(a, { ...b, preset: { kind: 'daily', time: '10:00' } })).toBe(false);
  });
});

describe('nextFireOfPreset', () => {
  // 2026-10-15 是周四。
  const thu10 = new Date(2026, 9, 15, 10, 0).getTime();
  const at = (y: number, m: number, d: number, h: number, min = 0): number =>
    new Date(y, m - 1, d, h, min).getTime();

  it('每天：今天还没到点取今天，过了取明天', () => {
    expect(nextFireOfPreset({ kind: 'daily', time: '11:00' }, thu10)).toBe(at(2026, 10, 15, 11));
    expect(nextFireOfPreset({ kind: 'daily', time: '10:00' }, thu10)).toBe(at(2026, 10, 16, 10));
    expect(nextFireOfPreset({ kind: 'daily', time: '09:00' }, thu10)).toBe(at(2026, 10, 16, 9));
  });

  it('工作日：周五之后跳到下周一', () => {
    const fri = new Date(2026, 9, 16, 10, 0).getTime();
    expect(nextFireOfPreset({ kind: 'weekdays', time: '09:00' }, fri)).toBe(at(2026, 10, 19, 9));
  });

  it('每周几：取最近的一天', () => {
    expect(nextFireOfPreset({ kind: 'weekly', days: [0, 3], time: '09:00' }, thu10)).toBe(
      at(2026, 10, 18, 9),
    );
  });

  it('每月几号：本月已过则下月；31 号跳过 30 天的月份', () => {
    expect(nextFireOfPreset({ kind: 'monthly', day: 10, time: '09:00' }, thu10)).toBe(
      at(2026, 11, 10, 9),
    );
    expect(nextFireOfPreset({ kind: 'monthly', day: 31, time: '09:00' }, thu10)).toBe(
      at(2026, 10, 31, 9),
    );
    const nov1 = new Date(2026, 10, 1, 0, 0).getTime();
    expect(nextFireOfPreset({ kind: 'monthly', day: 31, time: '09:00' }, nov1)).toBe(
      at(2026, 12, 31, 9),
    );
  });

  it('预设不合法返回 null', () => {
    expect(nextFireOfPreset({ kind: 'weekly', days: [], time: '09:00' }, thu10)).toBeNull();
  });
});

describe('时区与过去时间', () => {
  it('cron 的时区与本机不同：不识别成预设，按只读 cron 回显且原样提交', () => {
    const draft = draftFromSchedule(
      { kind: 'cron', runAt: null, cron: '0 9 * * *', timezone: 'America/New_York' },
      'Asia/Shanghai',
    );
    expect(draft).toMatchObject({ mode: 'repeat', customCron: '0 9 * * *' });
    expect(whenFromDraft(draft)).toBe('0 9 * * *');
  });

  it('isPastOnce：只看填完整的「某时」', () => {
    const now = new Date(2026, 9, 15, 10, 0).getTime();
    const once = (onceLocal: string) => ({ ...emptyWhenDraft(), mode: 'once' as const, onceLocal });
    expect(isPastOnce(once('2026-10-15T09:59'), now)).toBe(true);
    expect(isPastOnce(once('2026-10-15T10:00'), now)).toBe(true);
    expect(isPastOnce(once('2026-10-15T10:01'), now)).toBe(false);
    expect(isPastOnce(once(''), now)).toBe(false);
    expect(isPastOnce(emptyWhenDraft(), now)).toBe(false);
  });

  it('skipsShortMonths：每月 29–31 号', () => {
    const monthly = (day: number) => ({
      ...emptyWhenDraft(),
      mode: 'repeat' as const,
      preset: { kind: 'monthly' as const, day, time: '09:00' },
    });
    expect(skipsShortMonths(monthly(28))).toBe(false);
    expect(skipsShortMonths(monthly(29))).toBe(true);
    expect(skipsShortMonths(monthly(31))).toBe(true);
    expect(skipsShortMonths({ ...monthly(31), mode: 'once' })).toBe(false);
  });
});
