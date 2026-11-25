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
/**
 * 宽屏布局的聊天区最小可用宽度（px）：窗口最小宽已放宽到手机宽度（main/window.ts
 * 375），窄屏断点（640 进入 / 680 退出）与旧的 960 下限之间多出一段「宽屏三栏」可达
 * 区间——侧栏按窗口宽度夹取、右栏放不下时让位，都以这条为底线。
 */
export const WIDE_CHAT_MIN_WIDTH = 360;
/** 宽屏右栏（Bot 详情）内容的最小可用宽度（px）；覆盖抽屉的固定宽按它加留白。 */
export const WIDE_RIGHT_PANEL_MIN_WIDTH = 300;
/**
 * 并排形态下右栏的默认占比（0.41，与 ChatsArea 的 PANEL_DEFAULT_SIZE 一致，单一
 * 事实来源：ChatsArea 从它派生百分比整数）。
 */
export const WIDE_RIGHT_PANEL_DEFAULT_SHARE = 0.41;
/** 覆盖抽屉（中窄窗口的右栏形态）的固定宽（px）：内容 300 可用 + 留白。 */
export const PANEL_DRAWER_WIDTH = 360;
/**
 * 并排形态下对话区的舒适宽线（px）：低于它右栏展开会把对话挤得不舒适，切覆盖抽屉。
 * 推算：对话可用宽 =（窗口宽 − 有效侧栏宽）×（1 − 右栏默认占比）；默认侧栏 280 下
 * 对应窗口 ~1178px（主 Bot 调研建议的 1150~1200 一档）——窗口 900~1100 的实测挤压
 * 区间对应对话 ~370~480px，远低于此线。
 */
export const PANEL_DRAWER_CHAT_ENTER_WIDTH = 530;
/**
 * 退出抽屉回到并排的宽线（px，含）：与进入线构成 40px 滞回缓冲（对齐窄屏
 * 640/680 的风格）——判定轴是对话可用宽，断点附近拖拽不抖动，且侧栏拖宽/收窄
 * 同样受这条线保护（右栏宽度是按窗口比例切的，侧栏挤占同样伤对话区）。
 */
export const PANEL_DRAWER_CHAT_EXIT_WIDTH = 570;
export const SIDEBAR_WIDTH_STORAGE_KEY = 'kepcup.sidebar.width';

/** localStorage 的最小结构面（node 单测用替身注入）。 */
export type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 任意输入夹取到 [最小, 最大] 的整数像素；非法值回退默认宽。 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/**
 * 该窗口宽度下侧栏的宽度上限：给聊天区留出 WIDE_CHAT_MIN_WIDTH，且不超过全局上限、
 * 不低于最小宽。非法窗口宽度不夹取（回退全局上限）。
 */
export function maxSidebarWidthFor(windowWidth: number): number {
  if (!Number.isFinite(windowWidth)) return SIDEBAR_MAX_WIDTH;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth - WIDE_CHAT_MIN_WIDTH)),
  );
}

/**
 * 实际渲染宽度：持久化的偏好宽度再按窗口夹取（偏好本身不改写，窗口拉回去就恢复）。
 */
export function effectiveSidebarWidth(storedWidth: number, windowWidth: number): number {
  return Math.min(clampSidebarWidth(storedWidth), maxSidebarWidthFor(windowWidth));
}

/**
 * 并排形态下对话区的默认可用宽（px）：pane group 宽（窗口 − 有效侧栏）中
 * 扣除右栏默认占比后的份额。非法宽度回退 0（判定视为抽屉形态）。
 */
export function sideBySideChatWidth(windowWidth: number, sidebarWidth: number): number {
  if (!Number.isFinite(windowWidth)) return 0;
  const groupWidth = windowWidth - sidebarWidth;
  if (!Number.isFinite(groupWidth) || groupWidth <= 0) return 0;
  return Math.round(groupWidth * (1 - WIDE_RIGHT_PANEL_DEFAULT_SHARE));
}

/**
 * 带滞回的「右栏覆盖抽屉」判定：已在抽屉则对话可用宽 ≥ 570 才回并排，未在抽屉则
 * < 530 才进入（见 PANEL_DRAWER_CHAT_ENTER_WIDTH 的推算）。宽屏下窗口中窄时右栏
 * 不再并排挤压对话区，改固定宽浮层抽屉；窗口 / 侧栏宽度任一变化都可能翻转。
 * 非法窗口宽度一律按并排处理（与旧 rightPanelFits 一致）。
 */
export function nextPanelDrawer(
  previouslyDrawer: boolean,
  windowWidth: number,
  sidebarWidth: number,
): boolean {
  if (!Number.isFinite(windowWidth)) return false;
  const chatWidth = sideBySideChatWidth(windowWidth, sidebarWidth);
  return chatWidth <
    (previouslyDrawer ? PANEL_DRAWER_CHAT_EXIT_WIDTH : PANEL_DRAWER_CHAT_ENTER_WIDTH);
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
