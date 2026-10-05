import type { Attachment } from '@kepcup/shared';

/** 本地媒体条目（待发送附件）：字节还在渲染层，直接持 objectURL，不走 attachments.get。 */
export interface LocalMedia {
  id: string;
  fileName: string;
  mime: string;
  url: string;
  /** 判别字段：Attachment 没有该字段。 */
  local: true;
}

export type MediaItem = Attachment | LocalMedia;

export function isLocalMedia(item: MediaItem): item is LocalMedia {
  return 'local' in item;
}

/**
 * 灯箱状态（docs/design/20-conversation-media.md）：消息附件里的媒体
 * （图片/视频/音频）与输入坞里的待发送图片点击后在全局单例灯箱中查看，
 * 可在同组媒体之间前后切换。组件挂载在 ChatView。
 */
class MediaViewerState {
  items: MediaItem[] = $state([]);
  index = $state(-1);

  get open(): boolean {
    return this.index >= 0 && this.items[this.index] !== undefined;
  }

  get current(): MediaItem | null {
    return this.items[this.index] ?? null;
  }

  show(items: MediaItem[], index: number): void {
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
