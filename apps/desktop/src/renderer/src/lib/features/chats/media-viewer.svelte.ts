import type { Attachment } from '@kepcup/shared';

/**
 * 灯箱状态（docs/design/20-conversation-media.md）：消息附件里的媒体
 * （图片/视频/音频）点击后在全局单例灯箱中查看，可在同一条消息的媒体
 * 之间前后切换。组件挂载在 ChatView。
 */
class MediaViewerState {
  items: Attachment[] = $state([]);
  index = $state(-1);

  get open(): boolean {
    return this.index >= 0 && this.items[this.index] !== undefined;
  }

  get current(): Attachment | null {
    return this.items[this.index] ?? null;
  }

  show(items: Attachment[], index: number): void {
    if (items.length === 0) return;
    this.items = [...items];
    this.index = Math.max(0, Math.min(index, items.length - 1));
  }

  close(): void {
    this.index = -1;
    this.items = [];
  }

  step(delta: number): void {
    if (!this.open) return;
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
  }
}

export const mediaViewer = new MediaViewerState();
