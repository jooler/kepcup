<script lang="ts">
  import { cn } from '$lib/utils.js';
  import { ringGeometry } from './ring-geometry.js';
  import type { Snippet } from 'svelte';

  /**
   * 圆形进度指示（Circular Progress）：轨道 + 指示弧两段 SVG 圆环，中心留
   * children 插槽放图标 / 百分比。配色走 currentColor，由使用方以 class 指定
   * （如 text-blue-600 / text-primary）。value 的 NaN 与越界都 clamp 到
   * [0, 100]（分块差量下载的 percent 推送可能抖动 / 倒退）；弧段位移交给
   * CSS transition 抚平，起点由 -rotate-90 摆到 12 点钟。轨道透明度（20%）
   * 与过渡时长（300ms）在两种历史用法（侧栏外环 20%/300ms、进度卡片大环
   * 15%/500ms）间取统一值，如需个别微调可用 class 覆盖（tailwind-merge）。
   * 进度语义不在此处声明（aria 双报）：使用方的触发按钮 / 可见百分比文本
   * 已携带进度信息，svg 恒 aria-hidden。
   */
  interface Props {
    /** 进度 0–100；缺省 0（空环）。 */
    value?: number;
    /** 直径（px），同时是 SVG viewBox 边长——stroke-width 与像素 1:1。 */
    size?: number;
    /** 弧宽（px）。 */
    strokeWidth?: number;
    class?: string;
    /** 中心内容（绝对定位由使用方自行负责，容器是 relative）。 */
    children?: Snippet;
  }
  let { value = 0, size = 40, strokeWidth = 2.5, class: className, children }: Props = $props();

  // stroke-width ≥ size/2 时半径退化：兜成 0（circle 不渲染）而不是负值。
  const radius = $derived(Math.max(0, (size - strokeWidth) / 2));
  /** 0% → 整周（空环），100% → 0（满环）。 */
  const ring = $derived(ringGeometry(value, radius));
</script>

<div
  data-slot="circular-progress"
  class={cn('relative', className)}
  style:width="{size}px"
  style:height="{size}px"
>
  <svg viewBox="0 0 {size} {size}" class="absolute inset-0 -rotate-90" aria-hidden="true">
    <circle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      fill="none"
      stroke-width={strokeWidth}
      stroke="currentColor"
      class="opacity-20"
    />
    <circle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      fill="none"
      stroke-width={strokeWidth}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-dasharray={ring.circumference}
      style:stroke-dashoffset={ring.dashoffset}
      class="transition-[stroke-dashoffset] duration-300 ease-out"
    />
  </svg>
  {@render children?.()}
</div>
