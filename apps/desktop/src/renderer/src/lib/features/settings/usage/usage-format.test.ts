import { describe, expect, it } from 'vitest';
import type { UsageDailyModelPoint, UsageDailyPoint, UsageModelTotal } from '@kepcup/shared';
import {
  addDays,
  cumulativeTotals,
  donutSlices,
  formatCompact,
  heatLevel,
  heatMatrix,
  modelSeries,
  mondayOffset,
  sampleIndexes,
  splitDuration,
  weeklyTotals,
} from './usage-format';

function point(date: string, tokens: number, calls = 1): UsageDailyPoint {
  return { date, inputTokens: tokens, outputTokens: 0, tokens, calls };
}

describe('usage-format', () => {
  it('addDays crosses months / years / leap days', () => {
    expect(addDays('2026-11-02', 1)).toBe('2026-11-03');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('mondayOffset treats Monday as 0 and Sunday as 6', () => {
    expect(mondayOffset('2026-11-02')).toBe(0);
    expect(mondayOffset('2026-11-01')).toBe(6);
  });

  it('heatMatrix lays days out in Monday-start weeks and labels months', () => {
    const points = [
      point('2026-10-26', 0),
      point('2026-10-27', 1),
      point('2026-10-28', 2),
      point('2026-10-29', 3),
      point('2026-10-30', 4),
      point('2026-10-31', 5),
      point('2026-11-01', 6),
      point('2026-11-02', 7),
    ];
    const matrix = heatMatrix(points);
    expect(matrix.weeks).toBe(2);
    expect(matrix.cells[0]).toMatchObject({ column: 0, row: 0, level: 0 });
    expect(matrix.cells[6]).toMatchObject({ column: 0, row: 6 });
    expect(matrix.cells[7]).toMatchObject({ column: 1, row: 0, level: 4 });
    expect(matrix.monthStarts).toEqual([
      { column: 0, date: '2026-10-26' },
      { column: 1, date: '2026-11-02' },
    ]);
  });

  it('heatLevel uses quartiles and ignores empty days', () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(10, 100)).toBe(1);
    expect(heatLevel(30, 100)).toBe(2);
    expect(heatLevel(60, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
    expect(heatLevel(0, 0)).toBe(0);
  });

  it('weeklyTotals groups Monday-start weeks', () => {
    const weeks = weeklyTotals([
      point('2026-10-26', 10),
      point('2026-10-27', 20),
      point('2026-11-02', 5),
    ]);
    expect(weeks).toEqual([
      { weekStart: '2026-10-26', tokens: 30, calls: 2 },
      { weekStart: '2026-11-02', tokens: 5, calls: 1 },
    ]);
  });

  it('cumulativeTotals is a running sum', () => {
    expect(cumulativeTotals([point('2026-11-01', 10), point('2026-11-02', 5)])).toEqual([
      { date: '2026-11-01', tokens: 10 },
      { date: '2026-11-02', tokens: 15 },
    ]);
  });

  it('modelSeries keeps the top N and folds the rest into other', () => {
    const byModel: UsageModelTotal[] = [
      {
        provider: 'p',
        model: 'a',
        inputTokens: 60,
        outputTokens: 0,
        tokens: 60,
        calls: 1,
        costUsd: null,
      },
      {
        provider: 'p',
        model: 'b',
        inputTokens: 30,
        outputTokens: 0,
        tokens: 30,
        calls: 1,
        costUsd: null,
      },
      {
        provider: 'p',
        model: 'c',
        inputTokens: 10,
        outputTokens: 0,
        tokens: 10,
        calls: 1,
        costUsd: null,
      },
    ];
    const daily: UsageDailyModelPoint[] = [
      {
        date: '2026-11-01',
        provider: 'p',
        model: 'a',
        inputTokens: 60,
        outputTokens: 0,
        tokens: 60,
      },
      {
        date: '2026-11-01',
        provider: 'p',
        model: 'b',
        inputTokens: 30,
        outputTokens: 0,
        tokens: 30,
      },
      {
        date: '2026-11-02',
        provider: 'p',
        model: 'c',
        inputTokens: 10,
        outputTokens: 0,
        tokens: 10,
      },
    ];
    const series = modelSeries(byModel, daily, ['2026-11-01', '2026-11-02'], 2);
    expect(series.map((item) => item.key)).toEqual(['p|a', 'p|b', '__other__']);
    expect(series[0]!.values).toEqual([60, 0]);
    expect(series[2]!.values).toEqual([0, 10]);
    expect(series[2]!.total).toBe(10);
  });

  it('modelSeries disambiguates duplicate model names by provider', () => {
    const byModel: UsageModelTotal[] = [
      {
        provider: 'one',
        model: 'm',
        inputTokens: 20,
        outputTokens: 0,
        tokens: 20,
        calls: 1,
        costUsd: null,
      },
      {
        provider: 'two',
        model: 'm',
        inputTokens: 10,
        outputTokens: 0,
        tokens: 10,
        calls: 1,
        costUsd: null,
      },
    ];
    const series = modelSeries(byModel, [], [], 5);
    expect(series.map((item) => item.label)).toEqual(['m · one', 'm · two']);
  });

  it('donutSlices normalizes shares and folds the remainder', () => {
    const byModel: UsageModelTotal[] = [
      {
        provider: 'p',
        model: 'a',
        inputTokens: 70,
        outputTokens: 0,
        tokens: 70,
        calls: 1,
        costUsd: null,
      },
      {
        provider: 'p',
        model: 'b',
        inputTokens: 20,
        outputTokens: 0,
        tokens: 20,
        calls: 1,
        costUsd: null,
      },
      {
        provider: 'p',
        model: 'c',
        inputTokens: 10,
        outputTokens: 0,
        tokens: 10,
        calls: 1,
        costUsd: null,
      },
    ];
    const slices = donutSlices(byModel, 2);
    expect(slices.map((slice) => slice.value)).toEqual([70, 20, 10]);
    expect(slices[2]!.share).toBeCloseTo(0.1);
    expect(slices[2]!.key).toBe('__other__');
    expect(donutSlices([])).toEqual([]);
  });

  it('formatCompact uses 万/亿 in Chinese and K/M/B in English', () => {
    expect(formatCompact(7_740_000_000, 'zh-CN')).toBe('77.4 亿');
    expect(formatCompact(86_000_000, 'zh-CN')).toBe('8600 万');
    expect(formatCompact(12_345, 'zh-CN')).toBe('1.2 万');
    expect(formatCompact(7_740_000_000, 'en-US')).toBe('7.7B');
    expect(formatCompact(1234, 'en-US')).toBe('1.2K');
    expect(formatCompact(Number.NaN, 'en-US')).toBe('—');
  });

  it('splitDuration and sampleIndexes behave at the edges', () => {
    expect(splitDuration(436)).toEqual({ hours: 7, minutes: 16 });
    expect(splitDuration(0)).toEqual({ hours: 0, minutes: 0 });
    expect(sampleIndexes(0, 6)).toEqual([]);
    expect(sampleIndexes(3, 6)).toEqual([0, 1, 2]);
    expect(sampleIndexes(11, 6)).toEqual([0, 2, 4, 6, 8, 10]);
  });
});
