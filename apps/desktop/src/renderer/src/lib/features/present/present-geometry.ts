/**
 * 展示卡图表的几何（D87 P4 L1，设计 32 §12.1）：纯函数，渲染组件只负责把结果画成 SVG。图表不引
 * 第三方库（约束：离线打包、gzip 后 ≤150KB、跟随主题、可访问）——柱 / 折 / 饼三种自己画足够，
 * 零依赖，颜色经 CSS 变量跟随应用主题（选型记 todo/bot-widgets-authoring.md §8）。
 */

/** 两套主题下都清楚的系列色（同 kepcup-kit 的调色板顺序）。 */
export const PRESENT_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
] as const;

export function seriesColor(index: number): string {
  return PRESENT_PALETTE[index % PRESENT_PALETTE.length]!;
}

/**
 * 「好看」的坐标刻度：覆盖 [min, max]（总含 0），约 `count` 个刻度，步长取 1 / 2 / 5 × 10^n。
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo === hi) return [0, hi === 0 ? 1 : hi];
  const rough = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(rough));
  // 取对数尺度上离粗略步长最近的 1 / 2 / 5 × 10^n（刻度数接近 count）。
  const step = [1, 2, 5, 10]
    .map((m) => m * power)
    .reduce((best, s) => (Math.abs(Math.log(s / rough)) < Math.abs(Math.log(best / rough)) ? s : best));
  const first = Math.floor(lo / step);
  // 按有效数字取整（不是固定小数位）：极小 / 极大的量级也不会把相邻刻度并成同一个数。
  const at = (i: number): number => Number(((first + i) * step).toPrecision(12));
  const ticks: number[] = [];
  for (let i = 0; at(i) <= hi + step * 1e-9; i += 1) {
    ticks.push(at(i));
    if (ticks.length > 50) break;
  }
  if (ticks[ticks.length - 1]! < hi) ticks.push(at(ticks.length));
  return ticks;
}

export interface Plot {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 值 → y 坐标（按刻度两端线性映射）。 */
export function yScale(plot: Plot, ticks: number[]): (value: number) => number {
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const span = hi - lo || 1;
  const inner = plot.height - plot.top - plot.bottom;
  return (value) => plot.top + inner - ((value - lo) / span) * inner;
}

/** 分组柱：每个类目一个槽，槽内每个系列一根柱。返回每根柱的矩形（负值向下画）。 */
export function barRects(
  plot: Plot,
  categories: number,
  series: number[][],
  ticks: number[],
): Array<{
  series: number;
  category: number;
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const y = yScale(plot, ticks);
  const zero = y(0);
  const innerWidth = plot.width - plot.left - plot.right;
  const slot = innerWidth / Math.max(1, categories);
  const groupWidth = slot * 0.7;
  const barWidth = groupWidth / Math.max(1, series.length);
  const rects: Array<{
    series: number;
    category: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  series.forEach((values, s) => {
    for (let c = 0; c < categories; c++) {
      const value = values[c] ?? 0;
      const top = y(Math.max(0, value));
      const bottom = y(Math.min(0, value));
      rects.push({
        series: s,
        category: c,
        x: plot.left + c * slot + (slot - groupWidth) / 2 + s * barWidth,
        y: Math.min(top, zero),
        width: Math.max(1, barWidth - 1),
        height: Math.max(0, bottom - top),
      });
    }
  });
  return rects;
}

/** 类目的 x 中心（柱的标签、折线的点）。 */
export function categoryX(plot: Plot, categories: number, index: number): number {
  const innerWidth = plot.width - plot.left - plot.right;
  const slot = innerWidth / Math.max(1, categories);
  return plot.left + index * slot + slot / 2;
}

/** 饼图扇区的 SVG path（单个 100% 份额画成整圆的两段弧）。 */
export function pieArcs(
  values: number[],
  cx: number,
  cy: number,
  r: number,
): Array<{ path: string; share: number }> {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0) return [];
  let angle = -Math.PI / 2;
  return values.map((raw) => {
    const share = Math.max(0, raw) / total;
    const sweep = share * Math.PI * 2;
    const start = angle;
    angle += sweep;
    if (share >= 0.9999) {
      return {
        share,
        path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`,
      };
    }
    if (share <= 0) return { share, path: '' };
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    return {
      share,
      path: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
    };
  });
}

/** 数字的中文格式（非有限数显示「—」）。 */
export function formatNumber(value: number, unit = ''): string {
  if (!Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}${unit}`;
}
