import { describe, expect, test } from 'vitest';
import { ringGeometry } from './update-ring.js';

/** 圆形进度环纯几何：周长、clamp 与 NaN 兜底。 */

describe('ringGeometry', () => {
  test('0% 与 100% 的两个端点', () => {
    const empty = ringGeometry(0, 18);
    expect(empty.circumference).toBeCloseTo(2 * Math.PI * 18);
    expect(empty.dashoffset).toBeCloseTo(empty.circumference);

    const full = ringGeometry(100, 18);
    expect(full.dashoffset).toBeCloseTo(0);
  });

  test('中点数值随百分比线性推进', () => {
    const half = ringGeometry(50, 64);
    expect(half.dashoffset).toBeCloseTo(half.circumference / 2);
    const quarter = ringGeometry(25, 64);
    expect(quarter.dashoffset).toBeCloseTo(quarter.circumference * 0.75);
  });

  test('越界与 NaN 都 clamp 到 [0, 100]', () => {
    expect(ringGeometry(120, 10).dashoffset).toBeCloseTo(0);
    expect(ringGeometry(-3, 10).dashoffset).toBeCloseTo(ringGeometry(0, 10).circumference);
    expect(ringGeometry(Number.NaN, 10).dashoffset).toBeCloseTo(
      ringGeometry(0, 10).circumference,
    );
  });
});
