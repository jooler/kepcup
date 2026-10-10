/**
 * 输入框草稿的持久化快照（纯函数，便于在 node 环境单测）：
 * 按会话缓存 composer 的编辑器文档 / @ 提及 / 引用回复 / 待发送附件元数据，
 * localStorage 落盘，切换会话与重启应用后重载。
 *
 * 文档存 TipTap 原生 JSON（editor.getJSON()）——中间过程不落 markdown，
 * mention 节点原样保留；markdown 只在发送入队时由 editor.getMarkdown()
 * 转换一次。v2 存储键：v1（markdown 文本）条目随之废弃。
 *
 * 附件字节本体在 core（上传即落盘 `{home}/conversations/{id}/attachments/`，
 * docs/design/20-conversation-media.md），这里只存 attachmentId + 元数据；
 * 上传未完成（uploading）与已失败（error）的条目没有可复用的字节，不落盘。
 */

import type { JSONContent } from '@tiptap/core';

export interface PersistedAttachment {
  attachmentId: string;
  fileName: string;
  mime: string;
  size: number;
}

/** 引用回复的轻量快照：预览渲染只需要的字段（发送时只回传 id）。
 * chat store 的运行期 replyTo 与持久化快照共用此形状。 */
export interface ComposerReplyRef {
  id: string;
  senderType: 'user' | 'bot' | 'system';
  senderBotId: string | null;
  text: string;
}

export interface PersistedComposerDraft {
  doc: JSONContent;
  mentions: string[];
  reply: ComposerReplyRef | null;
  attachments: PersistedAttachment[];
  updatedAt: number;
}

export const COMPOSER_DRAFTS_STORAGE_KEY = 'kepcup.composer.drafts.v2';
/** 容量上限：超出时按 updatedAt 淘汰最久未活跃的会话草稿。 */
export const MAX_PERSISTED_DRAFTS = 30;
/** 引用回复只用于预览（渲染层截断到 60 字符），持久化时截断保底。 */
const MAX_PERSISTED_REPLY_TEXT = 500;

/** 空编辑器文档（单空段落）。 */
export const EMPTY_COMPOSER_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

export type DraftsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** 文档里没有任何可发送内容（空段落/空列表）即为空草稿。 */
export function isComposerDocEmpty(doc: JSONContent): boolean {
  return !nodeHasContent(doc);
}

function nodeHasContent(node: JSONContent): boolean {
  if (node.type === 'text') return (node.text ?? '').trim().length > 0;
  if (node.type === 'mention') return true;
  return (node.content ?? []).some(nodeHasContent);
}

export function loadPersistedDrafts(
  storage: DraftsStorage | null,
): Record<string, PersistedComposerDraft> {
  if (storage === null) return {};
  let raw: string | null;
  try {
    raw = storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const out: Record<string, PersistedComposerDraft> = {};
  for (const [conversationId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const draft = normalizeDraft(value);
    if (draft !== null) out[conversationId] = draft;
  }
  return out;
}

function normalizeDoc(value: unknown): JSONContent | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'doc' || !Array.isArray(record.content)) return null;
  return record as unknown as JSONContent;
}

function normalizeDraft(value: unknown): PersistedComposerDraft | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const doc = normalizeDoc(record.doc);
  if (doc === null) return null;
  const mentions = Array.isArray(record.mentions)
    ? record.mentions.filter((mention): mention is string => typeof mention === 'string')
    : [];
  const reply = normalizeReply(record.reply);
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .map(normalizeAttachment)
        .filter((attachment): attachment is PersistedAttachment => attachment !== null)
    : [];
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0;
  if (
    isComposerDocEmpty(doc) &&
    mentions.length === 0 &&
    reply === null &&
    attachments.length === 0
  ) {
    return null;
  }
  return { doc, mentions, reply, attachments, updatedAt };
}

function normalizeReply(value: unknown): ComposerReplyRef | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  if (
    record.senderType !== 'user' &&
    record.senderType !== 'bot' &&
    record.senderType !== 'system'
  ) {
    return null;
  }
  const senderBotId = typeof record.senderBotId === 'string' ? record.senderBotId : null;
  const text =
    typeof record.text === 'string' ? record.text.slice(0, MAX_PERSISTED_REPLY_TEXT) : '';
  return { id: record.id, senderType: record.senderType, senderBotId, text };
}

function normalizeAttachment(value: unknown): PersistedAttachment | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.attachmentId !== 'string' || record.attachmentId.length === 0) return null;
  if (typeof record.fileName !== 'string' || typeof record.mime !== 'string') return null;
  if (typeof record.size !== 'number') return null;
  return {
    attachmentId: record.attachmentId,
    fileName: record.fileName,
    mime: record.mime,
    size: record.size,
  };
}

export interface SnapshotUpload {
  state: 'uploading' | 'ready' | 'error';
  attachmentId: string | null;
  fileName: string;
  mime: string;
  size: number;
}

/** 组装下一份快照：runtime 条目只保留 ready 的附件元数据；整体为空的会话
 * 不落盘（清空即遗忘）；超过 MAX_PERSISTED_DRAFTS 按 updatedAt 淘汰。 */
export function buildPersistedSnapshot(input: {
  /** 本会话（运行期）已打开过的会话草稿；未打开的沿用上一份快照原样保留。 */
  runtime: Record<
    string,
    {
      doc: JSONContent;
      mentions: string[];
      reply: ComposerReplyRef | null;
      uploads: SnapshotUpload[];
    }
  >;
  previous: Record<string, PersistedComposerDraft>;
  now: number;
}): Record<string, PersistedComposerDraft> {
  const merged: Record<string, PersistedComposerDraft> = {};
  for (const [conversationId, entry] of Object.entries(input.runtime)) {
    merged[conversationId] = {
      doc: entry.doc,
      mentions: [...entry.mentions],
      reply: entry.reply,
      attachments: entry.uploads
        .filter((upload) => upload.state === 'ready' && upload.attachmentId !== null)
        .map((upload) => ({
          attachmentId: upload.attachmentId as string,
          fileName: upload.fileName,
          mime: upload.mime,
          size: upload.size,
        })),
      updatedAt: input.now,
    };
  }
  for (const [conversationId, draft] of Object.entries(input.previous)) {
    if (!(conversationId in merged)) merged[conversationId] = draft;
  }
  const kept = Object.entries(merged).filter(([, draft]) => !isEmptyDraft(draft));
  kept.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  return Object.fromEntries(kept.slice(0, MAX_PERSISTED_DRAFTS));
}

function isEmptyDraft(draft: PersistedComposerDraft): boolean {
  return (
    isComposerDocEmpty(draft.doc) &&
    draft.mentions.length === 0 &&
    draft.reply === null &&
    draft.attachments.length === 0
  );
}

export function writePersistedDrafts(
  storage: DraftsStorage | null,
  drafts: Record<string, PersistedComposerDraft>,
): void {
  if (storage === null) return;
  try {
    const keys = Object.keys(drafts);
    if (keys.length === 0) {
      storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
      return;
    }
    storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // localStorage 不可用 / 配额满：缓存是尽力而为，不阻塞输入。
  }
}
