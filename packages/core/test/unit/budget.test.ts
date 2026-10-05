import { describe, expect, it } from 'vitest';

import { containsCredential } from '../../src/memory/credential-patterns.js';
import { nextLocalMidnight, localDayStart, localDateKey } from '../../src/memory/local-date.js';
import { BudgetService } from '../../src/usage/budget.js';
import type { SettingsService } from '../../src/domain/settings.js';
import type { Clock } from '../../src/infra/clock.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

function makeBudget(options: {
  tokens: number;
  used: number;
  now: number;
  timeZone?: string;
}): BudgetService {
  const db = {
    prepare: () => ({
      get: () => ({ n: options.used }),
    }),
  } as unknown as SqliteDatabase;
  const settings = {
    get: () => ({ backgroundBudgetTokens: options.tokens }),
  } as unknown as SettingsService;
  const clock: Clock = { now: () => options.now };
  return new BudgetService({
    db,
    settings,
    clock,
    timeZone: options.timeZone ?? 'Asia/Shanghai',
  });
}

describe('background budget (P07 任务 12)', () => {
  const NOON_SHANGHAI = Date.UTC(2026, 9, 1, 4, 0, 0); // 12:00 上海时间

  it('counts usage against the configured limit', () => {
    expect(makeBudget({ tokens: 200_000, used: 199_999, now: NOON_SHANGHAI }).exceeded('bot_1')).toBe(
      false,
    );
    expect(makeBudget({ tokens: 200_000, used: 200_000, now: NOON_SHANGHAI }).exceeded('bot_1')).toBe(
      true,
    );
  });

  it('limit 0 means unlimited', () => {
    expect(makeBudget({ tokens: 0, used: 10_000_000, now: NOON_SHANGHAI }).exceeded('bot_1')).toBe(
      false,
    );
  });

  it('deferral target is the next local midnight', () => {
    const next = makeBudget({ tokens: 1, used: 5, now: NOON_SHANGHAI }).nextDayStart();
    // 上海时间 2026-10-01 12:00 的次日 00:00 = UTC 2026-10-01 16:00。
    expect(new Date(next).toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(next).toBeGreaterThan(NOON_SHANGHAI);
  });

  it('localDayStart/localDateKey agree across timezones', () => {
    const shanghaiStart = localDayStart(NOON_SHANGHAI, 'Asia/Shanghai');
    expect(localDateKey(new Date(shanghaiStart), 'Asia/Shanghai')).toBe('2026-10-01');
    expect(new Date(shanghaiStart).toISOString()).toBe('2026-09-30T16:00:00.000Z');
    const utcStart = localDayStart(NOON_SHANGHAI, 'UTC');
    expect(localDateKey(new Date(utcStart), 'UTC')).toBe('2026-10-01');
    expect(nextLocalMidnight(NOON_SHANGHAI, 'UTC')).toBe(Date.UTC(2026, 9, 2, 0, 0, 0));
  });
});

describe('credential gate used before writes (spot checks)', () => {
  it('blocks obvious secrets, allows prose', () => {
    expect(containsCredential('api_key=hunter2secret')).toBe(true);
    expect(containsCredential('今天天气不错')).toBe(false);
  });
});
