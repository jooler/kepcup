import type { WidgetCard } from '@kepcup/shared';

/**
 * 组件覆盖层的全局状态（海报点击后真正运行的地方）：一次一个组件；conversationId
 * 用于「切会话自动关闭」（同 FileViewer 的会话归属守卫）。
 */
export interface OpenWidgetCard {
  messageId: string;
  card: WidgetCard;
  conversationId: string;
}

class WidgetViewerState {
  current: OpenWidgetCard | null = $state(null);

  get open(): boolean {
    return this.current !== null;
  }

  show(messageId: string, card: WidgetCard, conversationId: string): void {
    this.current = { messageId, card, conversationId };
  }

  close(): void {
    this.current = null;
  }
}

export const widgetViewer = new WidgetViewerState();

/**
 * 「在新窗口打开」的 IPC 载荷（widget-window.md §3）。`current` 是 `$state` 深代理，
 * Electron IPC 的结构化克隆序列化不了 Proxy（`DataCloneError`，实测 2026-11-05）——
 * 直传会在 `invoke` 边界就炸，表现是按钮一按即弹「未能打开组件窗口」、窗口不创建。
 * 必须 `$state.snapshot` 拍成纯 JSON 再过桥。
 */
export function widgetWindowHandoffPayload(current: OpenWidgetCard): {
  messageId: string;
  card: WidgetCard;
} {
  return { messageId: current.messageId, card: $state.snapshot(current.card) };
}
