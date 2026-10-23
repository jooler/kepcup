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
