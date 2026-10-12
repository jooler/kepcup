/**
 * 全局快捷键的纯判定（App.svelte 只负责接线）：Cmd/Ctrl+K 打开全局搜索。
 *
 * 为什么要抽出来：
 * - `preventDefault` 必须在「确认会处理」之后才调——此前它排在条件判断之前，于是
 *   核心未就绪、设置页开着、已有模态时快捷键被白白吞掉（输入框里的 Cmd+K 之类
 *   也得不到浏览器/控件默认行为）；
 * - 已有 bits-ui 模态（扩展中心、侧栏确认框、群设置、Diff……）时不能再叠一个搜索
 *   弹框：两层模态的焦点陷阱会互抢焦点。模态的状态散落在各自组件里（并非都在
 *   shell store），所以以 DOM 为准——所有模态都经 `$lib/components/ui/dialog`
 *   / `sheet` 渲染，打开时 portal 里一定有带 `data-slot` 的遮罩。
 */

/** 模态遮罩选择器：dialog / sheet 两族 ui 组件的 overlay（关闭动画结束后才卸载）。 */
export const MODAL_OVERLAY_SELECTOR = '[data-slot="dialog-overlay"], [data-slot="sheet-overlay"]';

/** 页面里是否已有打开的 bits-ui 模态。 */
export function hasOpenModal(root: Pick<ParentNode, 'querySelector'>): boolean {
  return root.querySelector(MODAL_OVERLAY_SELECTOR) !== null;
}

export type SearchShortcutEvent = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>;

export function isSearchShortcut(event: SearchShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
}

export interface SearchShortcutState {
  coreReady: boolean;
  searchOpen: boolean;
  onboardingOpen: boolean;
  settingsOpen: boolean;
  narrowSettingsOpen: boolean;
  /** 页面里是否已有打开的模态（hasOpenModal）。 */
  modalOpen: boolean;
}

/** 'open' = 处理（调用方 preventDefault 并打开搜索）；'ignore' = 不处理、不拦截事件。 */
export function resolveSearchShortcut(state: SearchShortcutState): 'open' | 'ignore' {
  if (!state.coreReady) return 'ignore';
  if (state.searchOpen || state.onboardingOpen) return 'ignore';
  if (state.settingsOpen || state.narrowSettingsOpen) return 'ignore';
  if (state.modalOpen) return 'ignore';
  return 'open';
}
