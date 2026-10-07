/**
 * 左栏宽度布局的纯逻辑（rune store 在 sidebar-layout.svelte.ts，本文件可在
 * node 环境单测）：宽度的夹取、图标模式吸附与 localStorage 编解码。
 *
 * 最小宽度对齐 macOS 红绿灯的占位宽（hiddenInset 默认内嵌，侧栏头部 pl-20
 * 同值）——收窄到最小即「图标模式」：只显示头像/图标，名称走 hover 提示。
 */

export const SIDEBAR_MIN_WIDTH = 80;
export const SIDEBAR_MAX_WIDTH = 420;
/** 默认宽度与 UI 套件的 SIDEBAR_WIDTH（17.5rem）一致。 */
export const SIDEBAR_DEFAULT_WIDTH = 280;
/** 释放时低于该值吸附为最小宽（图标模式），避免停在挤塞的中间宽度。 */
export const SIDEBAR_ICON_SNAP_WIDTH = 160;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'kepcup.sidebar.width';

/** localStorage 的最小结构面（node 单测用替身注入）。 */
export type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 任意输入夹取到 [最小, 最大] 的整数像素；非法值回退默认宽。 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/** 拖拽释放时的落点：低于吸附阈值收成图标模式（最小宽），其余原样夹取。 */
export function settleSidebarWidth(width: number): number {
  const clamped = clampSidebarWidth(width);
  return clamped < SIDEBAR_ICON_SNAP_WIDTH ? SIDEBAR_MIN_WIDTH : clamped;
}

/** 是否处于图标模式（最小宽）：侧栏只显示图标/头像。 */
export function isSidebarCollapsed(width: number): boolean {
  return clampSidebarWidth(width) <= SIDEBAR_MIN_WIDTH;
}

export function loadSidebarWidth(storage: WidthStorage | null): number {
  let raw: string | null;
  try {
    raw = storage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? null;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  const parsed = raw === null ? Number.NaN : Number(raw);
  return clampSidebarWidth(parsed);
}

export function saveSidebarWidth(storage: WidthStorage | null, width: number): void {
  try {
    storage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // 持久化失败只影响下次启动的默认宽度
  }
}
