/**
 * 设置分区内锚点滚动（宽屏 SettingsDialog 与窄屏 NarrowSettings 共用）：
 * 打开设置带 anchor（如「模型 → 默认模型」）时，目标分区渲染完成后把
 * `[data-settings-anchor]` 滚到容器顶部附近，然后清掉锚点（一次性消费）。
 *
 * 手动算 scrollTop 而不是 scrollIntoView：后者会让整个弹框 / 页面内容跟着抢滚动。
 */

/** 目标距容器顶部的留白（px）。 */
export const ANCHOR_SCROLL_MARGIN = 8;

/** 容器的最小结构面（单测用替身）。 */
export interface AnchorScrollContainer {
  scrollTop: number;
  querySelector(selector: string): { getBoundingClientRect(): { top: number } } | null;
  getBoundingClientRect(): { top: number };
  scrollTo(options: { top: number }): void;
}

/** 滚到锚点；找不到目标返回 false。 */
export function scrollToSettingsAnchor(container: AnchorScrollContainer, anchor: string): boolean {
  const target = container.querySelector(`[data-settings-anchor="${anchor}"]`);
  if (target === null) return false;
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTo({
    top: Math.max(0, container.scrollTop + offset - ANCHOR_SCROLL_MARGIN),
  });
  return true;
}

/**
 * 等分区渲染完（下一个 tick）后滚到锚点并清除锚点——无论找没找到都清，避免锚点
 * 残留导致下次打开误滚。`flush` 即 svelte 的 tick。
 */
export async function revealSettingsAnchor(options: {
  anchor: string;
  container: () => AnchorScrollContainer | null | undefined;
  flush: () => Promise<void>;
  clear: () => void;
}): Promise<void> {
  await options.flush();
  const container = options.container();
  if (container) scrollToSettingsAnchor(container, options.anchor);
  options.clear();
}
