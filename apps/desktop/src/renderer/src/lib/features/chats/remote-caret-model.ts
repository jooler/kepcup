import type { CollabPresenceEntry } from '@kepcup/shared';

export interface RemoteCaret {
  anchor: number;
  head: number;
  name: string;
  color: string;
}

/**
 * 远端光标匹配（D121）：只有 owner 上报的 selection 且 docVersion 与本地
 * 渲染的草稿版本一致时才显示；否则隐藏（光标位置对未来版本文档无意义）。
 * 纯函数，便于单测。
 */
export function remoteCaretFrom(
  entries: readonly CollabPresenceEntry[],
  ownerId: string,
  version: number,
): RemoteCaret | null {
  const entry = entries.find((candidate) => candidate.clientId === ownerId);
  const selection = entry?.selection ?? null;
  if (entry === undefined || selection === null || selection.docVersion !== version) return null;
  return {
    anchor: selection.anchor,
    head: selection.head,
    name: entry.clientName,
    color: entry.color,
  };
}
