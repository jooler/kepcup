import { describe, expect, test } from 'vitest';

import { barRects, formatNumber, niceTicks, pieArcs, yScale, type Plot } from './present-geometry';

/** 展示卡图表几何（D87 P4 L1）：刻度含 0、负值向下画、饼图份额与整圆、非有限数不显示 NaN。 */
const plot: Plot = { width: 200, height: 120, left: 20, right: 0, top: 10, bottom: 10 };

describe('present geometry', () => {
  test('niceTicks always covers 0 and the data range with 1/2/5 steps', () => {
    expect(niceTicks(3, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-12, 30)).toEqual([-20, -10, 0, 10, 20, 30]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(0.1, 0.42)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  test('niceTicks keeps distinct ticks at tiny and huge magnitudes', () => {
    const tiny = niceTicks(0, 3e-12);
    expect(new Set(tiny).size).toBe(tiny.length);
    expect(tiny[tiny.length - 1]).toBeGreaterThanOrEqual(3e-12);
    const huge = niceTicks(0, 8.7e15);
    expect(new Set(huge).size).toBe(huge.length);
    expect(huge[huge.length - 1]).toBeGreaterThanOrEqual(8.7e15);
  });

  test('bars grow up from zero for positives and down for negatives', () => {
    const ticks = niceTicks(-10, 10);
    const zero = yScale(plot, ticks)(0);
    const [up, down] = barRects(plot, 2, [[10, -10]], ticks);
    expect(up!.y + up!.height).toBeCloseTo(zero);
    expect(down!.y).toBeCloseTo(zero);
    expect(up!.height).toBeGreaterThan(0);
    expect(down!.height).toBeGreaterThan(0);
  });

  test('pie arcs: shares sum to 1, a single slice is a full circle, zero total draws nothing', () => {
    const arcs = pieArcs([1, 3], 50, 50, 40);
    expect(arcs.map((a) => a.share)).toEqual([0.25, 0.75]);
    expect(arcs[1]!.path).toContain(' 1 1 '); // large-arc flag for the 75% slice
    expect(pieArcs([5], 50, 50, 40)[0]!.path).toContain('A 40 40 0 1 1');
    expect(pieArcs([0, 0], 50, 50, 40)).toEqual([]);
  });

  test('formatNumber never prints NaN', () => {
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(1234.567, '元')).toBe('1,234.57元');
  });
});
