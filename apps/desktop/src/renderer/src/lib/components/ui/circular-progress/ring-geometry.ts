/**
 * 圆形进度环的纯几何计算（CircularProgress 组件的核心数学）。SVG 用
 * stroke-dasharray = 整周长 + stroke-dashoffset 后移出未完成弧段；起点由
 * -rotate-90 摆到 12 点钟。percent 推送可能倒退/抖动，这里 clamp 到
 * [0, 100]（NaN 也归 0），视觉平滑交给 CSS transition。
 */
export interface RingGeometry {
  /** 整周长（stroke-dasharray 与 dashoffset 的分母）。 */
  circumference: number;
  /** 可直接绑定 stroke-dashoffset 的偏移：0% → 整周（空环），100% → 0。 */
  dashoffset: number;
}

export function ringGeometry(percent: number, radius: number): RingGeometry {
  const circumference = 2 * Math.PI * radius;
  const finite = Number.isFinite(percent) ? percent : 0;
  const clamped = Math.min(100, Math.max(0, finite));
  return {
    circumference,
    dashoffset: circumference * (1 - clamped / 100),
  };
}
