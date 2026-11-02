import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  computeStreaks,
  enumerateLocalDays,
  fillDailyPoints,
} from '../../src/domain/usage-stats.js';
import type { UsageDailyTotal } from '../../src/domain/usage.js';
import { localDateStart } from '../../src/memory/local-date.js';

function total(date: string, tokens: number, calls = 1): UsageDailyTotal {
  return {
    date,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens,
    calls,
    costUsd: null,
  };
}

describe('usage-stats', () => {
  it('addLocalDays crosses month / year boundaries', () => {
    expect(addLocalDays('2026-11-02', 1)).toBe('2026-11-03');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('enumerateLocalDays is inclusive', () => {
    expect(enumerateLocalDays('2026-10-31', '2026-11-02')).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('fillDailyPoints zero-fills missing days', () => {
    const points = fillDailyPoints('2026-11-01', '2026-11-03', [total('2026-11-02', 7)]);
    expect(points.map((point) => point.tokens)).toEqual([0, 7, 0]);
    expect(points.map((point) => point.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('computeStreaks counts from yesterday when today is still empty', () => {
    expect(computeStreaks(['2026-10-30', '2026-10-31', '2026-11-01'], '2026-11-02')).toEqual({
      current: 3,
      longest: 3,
    });
    expect(
      computeStreaks(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02'),
    ).toEqual({ current: 4, longest: 4 });
  });

  it('computeStreaks keeps the longest historical run', () => {
    expect(
      computeStreaks(
        ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-11', '2026-10-12'],
        '2026-10-20',
      ),
    ).toEqual({ current: 0, longest: 3 });
    expect(computeStreaks([], '2026-10-20')).toEqual({ current: 0, longest: 0 });
  });

  it('localDateStart resolves local midnight across DST', () => {
    // Asia/Shanghai has no DST: UTC+8 all year.
    expect(localDateStart('2026-11-02', 'Asia/Shanghai')).toBe(
      Date.parse('2026-11-01T16:00:00.000Z'),
    );
    // New York: EST (UTC-5) before the spring shift, EDT (UTC-4) after it.
    expect(localDateStart('2026-03-08', 'America/New_York')).toBe(
      Date.parse('2026-03-08T05:00:00.000Z'),
    );
    expect(localDateStart('2026-11-01', 'America/New_York')).toBe(
      Date.parse('2026-11-01T04:00:00.000Z'),
    );
  });
});
