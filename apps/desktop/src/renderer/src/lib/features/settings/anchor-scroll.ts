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
 *
 * `attempts` > 1 时找不到目标会再等（`wait`，缺省同 `flush`）后重试：右栏 Bot 配置等
 * 内容异步就绪的落点（草稿克隆完才渲染表单）用；设置弹框保持一次。
 */
export async function revealSettingsAnchor(options: {
  anchor: string;
  container: () => AnchorScrollContainer | null | undefined;
  flush: () => Promise<void>;
  clear: () => void;
  attempts?: number;
  wait?: () => Promise<void>;
}): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 1);
  let found = false;
  await options.flush();
  for (let attempt = 0; attempt < attempts && !found; attempt += 1) {
    if (attempt > 0) await (options.wait ?? options.flush)();
    const container = options.container();
    if (container) found = scrollToSettingsAnchor(container, options.anchor);
  }
  options.clear();
  return found;
}

/** 对话框里的锚点落点（群设置 / 项目设置）：最小结构面，便于单测。 */
export interface AnchorFocusRoot {
  querySelector(selector: string): AnchorFocusTarget | null;
}

export interface AnchorFocusTarget {
  scrollIntoView(options: { block: 'nearest' }): void;
  querySelector(selector: string): { focus(): void } | null;
}

/**
 * 对话框内的锚点：滚进视野并聚焦其中第一个输入控件（对话框本身不长，不必算偏移）。
 * 找不到返回 false。
 */
export function focusSettingsAnchor(root: AnchorFocusRoot, anchor: string): boolean {
  const target = root.querySelector(`[data-settings-anchor="${anchor}"]`);
  if (target === null) return false;
  target.scrollIntoView({ block: 'nearest' });
  target.querySelector('input, textarea, select')?.focus();
  return true;
}

/** 等一帧（锚点落点在异步挂载的对话框 / 覆盖层里时，重试之间的等待）。 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * 对话框锚点：最多等 `attempts` 帧直到锚点出现，再滚进视野并聚焦（`focusSettingsAnchor`）。
 * 对话框经 portal 异步挂载，一个 tick 不一定够。
 */
export async function revealDialogAnchor(
  root: AnchorFocusRoot,
  anchor: string,
  attempts = 20,
  wait: () => Promise<void> = nextFrame,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (focusSettingsAnchor(root, anchor)) return true;
    await wait();
  }
  return false;
}
