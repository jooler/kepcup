/**
 * 组件「在新窗口打开」（widget-window.md §4.4）：渲染入口 URL 携带
 * `?kcWindow=widget` 的页面是独立组件窗口——App.svelte 顶层按此分支，
 * 只挂 WidgetWindowApp，不进主壳（侧栏 / 会话 / 全局浮层都不存在）。
 */
export const WIDGET_WINDOW_QUERY_KEY = 'kcWindow';
export const WIDGET_WINDOW_QUERY_VALUE = 'widget';

export function isWidgetWindowLocation(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(WIDGET_WINDOW_QUERY_KEY) === WIDGET_WINDOW_QUERY_VALUE;
}
