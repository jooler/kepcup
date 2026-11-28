/**
 * 输入框草稿的持久化快照（纯函数，便于在 node 环境单测）：
 * 按会话缓存 composer 的编辑器文档 / @ 提及 / 引用回复 / 待发送附件元数据。
 *
 * 持久化走 IndexedDB（`kepcup.composer-drafts`，按会话一条记录，见
 * composer-drafts.svelte.ts）：单条草稿是完整编辑器文档，字节数随内容增长，
 * 旧 localStorage 单键整表（最多 30 份草稿）重写既慢又会撞每源配额、挤占
 * 小偏好的写入空间。这里只放纯数据与纯函数（读取归一化、快照合成、增量
 * diff）；旧版 localStorage 整表键（v3 / v2）由 store 启动时一次性导入。
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
import type { SourceId } from '$lib/rpc/connections.svelte';

export interface PersistedAttachment {
  attachmentId: string;
  fileName: string;
  mime: string;
  size: number;
}

/** 引用回复的轻量快照：预览渲染只需要的字段（发送时只回传 id）。
 * chat store 的运行期 replyTo 与持久化快照共用此形状。attachments 是被引用
 * 消息的附件元数据（引用块里的图片缩略图与灯箱需要；旧快照没有该字段）。 */
export interface ComposerReplyRef {
  id: string;
  senderType: 'user' | 'bot' | 'system';
  senderBotId: string | null;
  text: string;
  attachments?: PersistedAttachment[];
  /**
   * 该引用所属来源（`local` / `team:<hash>`）。可选：旧快照无此字段，按当前
   * 来源处理；跨来源同 id 会话（本机 c1 vs 团队 c1）不得复用彼此的引用。
   */
  source?: SourceId;
}

export interface PersistedComposerDraft {
  doc: JSONContent;
  mentions: string[];
  reply: ComposerReplyRef | null;
  attachments: PersistedAttachment[];
  updatedAt: number;
  /** 服务端共享草稿的版本（D120）；0 = 尚未与 core 同步。 */
  version: number;
  /** 本地有未确认的修改（断线 / 版本冲突恢复用）。 */
  dirty: boolean;
  /**
   * D115 附件直注：附件归属会话（attachments.upload / attachments.status 的
   * conversationId）。键是会话 id 时等于键本身；任务直注键为 `task:<id>`，
   * 这里存任务所在会话——重启后校验 chip 与上传都要用它。缺省 = 键即会话。
   */
  conversationId?: string;
}

export const COMPOSER_DRAFTS_STORAGE_KEY = 'kepcup.composer.drafts.v3';
/** 旧版本（纯本地草稿）；读取后一次性升级为 v3，导入完成即删除。 */
export const LEGACY_COMPOSER_DRAFTS_STORAGE_KEY = 'kepcup.composer.drafts.v2';
/** 容量上限：超出时按 updatedAt 淘汰最久未活跃的会话草稿。 */
export const MAX_PERSISTED_DRAFTS = 30;
/** 引用回复只用于预览（渲染层截断到 60 字符），持久化时截断保底。 */
const MAX_PERSISTED_REPLY_TEXT = 500;

/** 空编辑器文档（单空段落）。 */
export const EMPTY_COMPOSER_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** 旧版 localStorage 整表键的缝（一次性导入 + 导入后删键；node 单测可注入）。 */
export type LegacyDraftsStorage = Pick<Storage, 'getItem' | 'removeItem'>;

/** 文档里没有任何可发送内容（空段落/空列表）即为空草稿。 */
export function isComposerDocEmpty(doc: JSONContent): boolean {
  return !nodeHasContent(doc);
}

function nodeHasContent(node: JSONContent): boolean {
  if (node.type === 'text') return (node.text ?? '').trim().length > 0;
  if (node.type === 'mention') return true;
  return (node.content ?? []).some(nodeHasContent);
}

/** 旧版整表键的一次性读取（v3 优先，v2 升级标记 dirty）；只用于启动导入。 */
export function loadPersistedDrafts(
  storage: LegacyDraftsStorage | null,
): Record<string, PersistedComposerDraft> {
  if (storage === null) return {};
  // v3 键存在（哪怕是空对象）就表示当前版本已初始化，不再回落到 v2——否则
  // 发送掉最后一条草稿后重启，旧版 v2 会“复活”。
  let hasCurrent: boolean;
  try {
    hasCurrent = storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY) !== null;
  } catch {
    return {};
  }
  if (hasCurrent) return readLegacyDrafts(storage, COMPOSER_DRAFTS_STORAGE_KEY);
  const legacy = readLegacyDrafts(storage, LEGACY_COMPOSER_DRAFTS_STORAGE_KEY);
  for (const draft of Object.values(legacy)) {
    draft.version = 0;
    draft.dirty = true;
  }
  return legacy;
}

/** 旧键导入收口：两个整表键一并删除（尽力而为；删不掉下次再导一次也幂等）。 */
export function clearLegacyDraftKeys(storage: LegacyDraftsStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    storage.removeItem(LEGACY_COMPOSER_DRAFTS_STORAGE_KEY);
  } catch {
    // 尽力而为。
  }
}

function readLegacyDrafts(
  storage: LegacyDraftsStorage,
  key: string,
): Record<string, PersistedComposerDraft> {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
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
    const draft = normalizePersistedDraft(value);
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

/** 单条草稿记录的归一化：形状不对 / 整体为空的条目丢弃（旧键与 IDB 记录读取共用）。 */
export function normalizePersistedDraft(value: unknown): PersistedComposerDraft | null {
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
  const version =
    typeof record.version === 'number' && Number.isInteger(record.version) && record.version >= 0
      ? record.version
      : 0;
  const dirty = typeof record.dirty === 'boolean' ? record.dirty : true;
  const conversationId =
    typeof record.conversationId === 'string' && record.conversationId.length > 0
      ? record.conversationId
      : undefined;
  if (
    isComposerDocEmpty(doc) &&
    mentions.length === 0 &&
    reply === null &&
    attachments.length === 0
  ) {
    return null;
  }
  return {
    doc,
    mentions,
    reply,
    attachments,
    updatedAt,
    version,
    dirty,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
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
  const source =
    record.source === 'local' ||
    (typeof record.source === 'string' && record.source.startsWith('team:'))
      ? (record.source as SourceId)
      : undefined;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
        .map(normalizeAttachment)
        .filter((attachment): attachment is PersistedAttachment => attachment !== null)
    : [];
  return {
    id: record.id,
    senderType: record.senderType,
    senderBotId,
    text,
    ...(source !== undefined ? { source } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
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
      version?: number;
      dirty?: boolean;
      /** D115 附件直注：附件归属会话（任务直注键 ≠ 会话 id 时记录）。 */
      conversationId?: string;
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
      version: entry.version ?? 0,
      dirty: entry.dirty ?? true,
      ...(entry.conversationId !== undefined && entry.conversationId !== conversationId
        ? { conversationId: entry.conversationId }
        : {}),
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

/** 新旧快照的增量：只落变化的会话记录（IDB 按会话一条，不再整表重写）。 */
export interface PersistedDraftDiff {
  upserts: Array<[string, PersistedComposerDraft]>;
  deletes: string[];
}

export function diffPersistedDrafts(
  previous: Record<string, PersistedComposerDraft>,
  next: Record<string, PersistedComposerDraft>,
): PersistedDraftDiff {
  const upserts: Array<[string, PersistedComposerDraft]> = [];
  const deletes: string[] = [];
  for (const [key, draft] of Object.entries(next)) {
    // 按序列化内容比较：buildPersistedSnapshot 原样保留 previous 条目（引用
    // 相等）自然跳过；runtime 重建的条目只有内容真变了才重写。
    const before = previous[key];
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(draft)) {
      upserts.push([key, draft]);
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) deletes.push(key);
  }
  return { upserts, deletes };
}
