/**
 * 窄屏布局（手机式单栏）的纯逻辑（rune store 在 narrow-layout.svelte.ts，本文件
 * 可在 node 环境单测）：断点判定、底部 tab 集合、tab 栏显隐推导与设置分区过滤。
 *
 * 窄屏模式（docs/design/33-narrow-layout.md）：窗口被拉窄到手机宽度后整个应用
 * 变成单栏 Panel——底部全局 tab（对话 / 通讯录 / 扩展 / 我）为第一层导航，会话
 * 详情与 Bot 详情覆盖层是第二层（tab 栏隐藏、左上角返回）。这也是未来移动端的
 * 导航参考模型。
 */

/**
 * 窄屏断点（px）：窗口内容宽小于该值进入窄屏模式，与 Tailwind sm 对齐。
 * 宽度监听用 svelte:window bind:innerWidth（matchMedia 的 change 监听在部分
 * 环境不触发，innerWidth 绑定随 resize 即时回填，纯响应式无事件订阅）。
 */
export const NARROW_LAYOUT_MAX_WIDTH = 640;

/**
 * 退出窄屏的宽度（px，含）：滞回区间 [640, 680)——进入窄屏要小于 640，回到宽屏
 * 要至少 680。宽 / 窄是两棵不同的组件树（切换即整树重挂载），断点附近来回抖动
 * 一个像素就重挂载一次会丢滚动位置与局部状态，滞回把「抖动」吸收在 40px 缓冲里。
 */
export const NARROW_LAYOUT_EXIT_WIDTH = 680;

/** 底部全局 tab（顺序即展示顺序）。 */
export const NARROW_TABS = ['chats', 'contacts', 'extensions', 'me'] as const;
export type NarrowTab = (typeof NARROW_TABS)[number];

/**
 * 窄屏模式下的设置弹框要隐藏的分区：「通讯录」「用户画像」已提取为底部 tab
 * （通讯录 / 我），弹框里再出现一份会重复；其余设置留在弹框（入口在「我」页）。
 */
export const NARROW_HIDDEN_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'contacts',
  'profile',
]);

/** 窗口内容宽是否处于窄屏模式（无历史时的判定：开区间，640px 整属宽屏，与 sm: 一致）。 */
export function isNarrowWidth(width: number): boolean {
  return Number.isFinite(width) && width < NARROW_LAYOUT_MAX_WIDTH;
}

/**
 * 带滞回的窄屏判定：已在窄屏则宽度 < 680 才保持窄屏（≥ 680 才退出），未在窄屏则
 * < 640 才进入。非法宽度一律视为宽屏（与 isNarrowWidth 一致）。
 */
export function nextNarrow(previouslyNarrow: boolean, width: number): boolean {
  if (!Number.isFinite(width)) return false;
  return width < (previouslyNarrow ? NARROW_LAYOUT_EXIT_WIDTH : NARROW_LAYOUT_MAX_WIDTH);
}

/**
 * 底部 tab 栏是否显示：进入「详情层」即隐藏——对话详情（对话 tab 下已选中会话）
 * 与 Bot 详情覆盖层；其余（列表 / 通讯录 / 扩展 / 我）都显示。
 */
export function showNarrowTabBar(
  tab: NarrowTab,
  hasCurrentConversation: boolean,
  botDetailOpen: boolean,
): boolean {
  if (botDetailOpen) return false;
  if (tab === 'chats' && hasCurrentConversation) return false;
  return true;
}
