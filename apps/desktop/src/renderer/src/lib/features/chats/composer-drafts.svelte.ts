import type { JSONContent } from '@tiptap/core';
import type { Attachment } from '@kepcup/shared';
import { EMPTY_COMPOSER_DOC } from './composer-draft-persist';
import { errorText, t, listSeparator } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { toast } from 'svelte-sonner';
import { attachmentUrl } from './attachments.svelte';
import {
  classifyAttachmentStatuses,
  readyAttachmentIds,
  type AttachmentIssue,
  type AttachmentStatusLike,
} from './composer-send';
import {
  buildPersistedSnapshot,
  clearLegacyDraftKeys,
  diffPersistedDrafts,
  isComposerDocEmpty,
  loadPersistedDrafts,
  normalizePersistedDraft,
  type ComposerReplyRef,
  type LegacyDraftsStorage,
  type PersistedComposerDraft,
} from './composer-draft-persist';
import {
  createBrowserIdbKvFactory,
  type IdbKvDatabase,
} from '$lib/persist/idb-kv';
import { messageVisibility } from '$lib/stores/message-visibility.svelte';

/**
 * 输入框草稿的按会话缓存（store）：编辑器文档（原生 JSON）/ @ 提及 / 引用
 * 回复 / 待发送附件。
 * Composer 是唯一的读写方——进入会话时把缓存水合进组件状态，内容变化即写回，
 * 这里负责防抖落盘（IndexedDB 按会话一条记录，启动时一次性载入 + 旧版
 * localStorage 整表键一次性导入）；因此切换会话、关闭应用后回到原会话都能
 * 正确重载。附件字节本体在 core（上传即落盘，docs/design/20-conversation-media.md），
 * 快照只存 attachmentId + 元数据，重启后经 attachments.get 重建预览。
 */

/** 待发送附件 chip（runtime）：state/previewUrl 是瞬态，持久化只留 ready 元数据。 */
export interface PendingUpload {
  key: string;
  fileName: string;
  mime: string;
  size: number;
  state: 'uploading' | 'ready' | 'error';
  attachmentId: string | null;
  /** 图片专有：预览 objectURL（缩略图与灯箱共用，不等上传）。 */
  previewUrl: string | null;
  /** previewUrl 是否为本地上传时自建（可 revoke）；重启水合的预览来自
   * attachments.svelte.ts 的共享 LRU，所有权在那里，不能替它 revoke。 */
  ownsPreviewUrl: boolean;
}

interface ComposerRuntimeDraft {
  /** TipTap 编辑器文档（原生 JSON）：中间过程保持原始数据，发送时才转 markdown。 */
  doc: JSONContent;
  mentions: string[];
  reply: ComposerReplyRef | null;
  uploads: PendingUpload[];
  /** 与服务端共享草稿的同步状态（D120）。 */
  version: number;
  dirty: boolean;
  /**
   * D115 附件直注：附件归属会话（attachments.upload / attachments.status 的
   * conversationId）。键是会话 id 时缺省；任务直注键为 `task:<id>`，这里存
   * 任务所在会话，core RPC 都走它。
   */
  conversationId?: string;
}

const PERSIST_DEBOUNCE_MS = 300;
const MAX_UPLOAD_BYTES = 30_000_000;

const DRAFTS_DB_NAME = 'kepcup.composer-drafts';
const DRAFTS_DB_VERSION = 1;
const DRAFTS_STORE = 'drafts';

function draftsStorage(): LegacyDraftsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 草稿库（按会话一条记录）；IndexedDB 不可用（node 测试 / 隐私模式）为 null。 */
function draftsDb(): Promise<IdbKvDatabase> | null {
  const factory = globalThis.indexedDB;
  if (factory === undefined || factory === null) return null;
  return createBrowserIdbKvFactory(factory).open(DRAFTS_DB_NAME, DRAFTS_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(DRAFTS_STORE)) db.createObjectStore(DRAFTS_STORE);
  });
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMime(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return MIME_BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** 导出给 node 单测注入内存 IDB；运行时只用下方单例。 */
export class ComposerDraftsState {
  /**
   * 附件 RPC 的会话来源（T7 融合视图）：Composer 进入会话时设置——团队会话的
   * 附件上传 / 状态 / 摘除经该团队连接；缺省 'local'（既有行为）。
   */
  #rpcSource: SourceId = 'local';

  setRpcSource(source: SourceId): void {
    this.#rpcSource = source;
  }

  #rpc(): ReturnType<typeof connections.get> {
    return connections.get(this.#rpcSource);
  }

  #replyIsHidden(conversationId: string, reply: ComposerReplyRef | null): boolean {
    return (
      reply !== null &&
      reply.senderType === 'bot' &&
      messageVisibility.isHidden(this.#rpcSource, conversationId, reply.id)
    );
  }

  /**
   * A reply snapshot is only valid for the source that produced it: local and
   * team conversations can share an id, and drafts are keyed by conversation id
   * alone. Old persisted snapshots have no `source` (treated as current).
   */
  #replyIsForeign(reply: ComposerReplyRef | null): boolean {
    return reply !== null && reply.source !== undefined && reply.source !== this.#rpcSource;
  }

  #replyIsUnusable(conversationId: string, reply: ComposerReplyRef | null): boolean {
    return this.#replyIsForeign(reply) || this.#replyIsHidden(conversationId, reply);
  }

  /** 打开过的会话的输入框草稿；text/mentions/reply 由 Composer 的水合/保存 effect 同步。 */
  #runtime = $state<Record<string, ComposerRuntimeDraft>>({});
  /** 上次落盘的快照（IndexedDB 的内存镜像）：未打开过的会话原样保留，打开时晋升为 runtime。 */
  #snapshot: Record<string, PersistedComposerDraft> = {};
  /**
   * 服务端草稿被应用到本地的次数。Composer 监听它来把编辑器内容切到共享草稿
   * （初次进入 / 读端镜像 / 发送后清空），避免和本地键入互相触发。
   */
  revision = $state(0);
  // 上传任务管道：key → 完成后的 attachmentId（失败为 null）；没有界面从它派生。
  #uploadTasks = new Map<string, Promise<string | null>>();
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  #kvDb: Promise<IdbKvDatabase> | null;
  #ready: Promise<void>;

  /**
   * `kv` 仅供 node 单测注入内存 IDB；生产走 `draftsDb()`（globalThis.indexedDB）。
   */
  constructor(options: { kv?: Promise<IdbKvDatabase> | null } = {}) {
    // 退出前的最后一笔兜底：防抖窗口内的键入也要落盘。IndexedDB 写是异步的，
    // pagehide 时尽力提交；强制杀进程可能丢防抖窗口内最后几笔键入——草稿本
    // 就是尽力而为的缓存（旧 localStorage 同步写在隐私模式下同样可能丢）。
    globalThis.window?.addEventListener?.('pagehide', () => this.#persistNow());
    this.#kvDb = options.kv !== undefined ? options.kv : draftsDb();
    this.#ready = this.#load();
  }

  /**
   * 启动载入完成；App bootstrap await 它之后才恢复会话，避免「进了会话但
   * 持久化草稿还没载入」把旧草稿清掉。
   */
  ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * 启动载入：IndexedDB 全量并入（IDB 为权威来源）→ 旧 localStorage 整表键
   * 一次性导入（只补 IDB 没有有效记录的键，逐条 await 落库）→ 旧键收口。
   * 落库 / 打开失败时旧键保留（它可能是唯一持久副本），下次启动重试导入。
   */
  async #load(): Promise<void> {
    const storage = draftsStorage();
    const legacy = loadPersistedDrafts(storage);
    let handle: IdbKvDatabase | null = null;
    const db = this.#kvDb;
    if (db !== null) {
      try {
        handle = await db;
      } catch {
        // 打开失败：本会话内存态照常（仅不跨重启记忆）；旧键保留重试。
        handle = null;
      }
    }
    let legacyPersisted = Object.keys(legacy).length === 0;
    if (handle !== null) {
      try {
        const store = handle.store(DRAFTS_STORE);
        const entries = await store.getEntries();
        const idbDrafts: Record<string, PersistedComposerDraft> = {};
        for (const { key, value } of entries) {
          const draft = normalizePersistedDraft(value);
          if (draft !== null) idbDrafts[key] = draft;
        }
        // 合并方向：载入窗口内 runtime / 快照里已有的键是更新的（内存胜出）；
        // IDB 记录只补快照没有的键。旧键只补 IDB 没有有效记录的键——重导入
        //（上次落库成功但删键失败等）不得覆盖 IDB 里较新的草稿。
        const merged = { ...this.#snapshot };
        for (const [key, draft] of Object.entries(idbDrafts)) {
          if (!(key in merged)) merged[key] = draft;
        }
        const pendingLegacy: Array<[string, PersistedComposerDraft]> = [];
        for (const [key, draft] of Object.entries(legacy)) {
          if (key in idbDrafts) continue;
          if (!(key in merged)) {
            merged[key] = draft;
            pendingLegacy.push([key, draft]);
          }
        }
        this.#snapshot = merged;
        // 导入条目显式逐条落库（await 确认成功）——不能指望后续防抖落盘，
        // diff 基线此时已含导入条目，只会得出「无变化」。
        for (const [key, draft] of pendingLegacy) await store.put(key, draft);
        legacyPersisted = true;
      } catch {
        // 落库 / 读取失败：旧键并入内存兜底并保留，下次启动重试导入。
        const snapshot = { ...this.#snapshot };
        for (const [key, draft] of Object.entries(legacy)) {
          if (!(key in snapshot)) snapshot[key] = draft;
        }
        this.#snapshot = snapshot;
      }
    } else {
      // 无 IDB：旧键只并入内存（它是唯一持久副本，保留，下次启动重试迁移）。
      const snapshot = { ...this.#snapshot };
      for (const [key, draft] of Object.entries(legacy)) {
        if (!(key in snapshot)) snapshot[key] = draft;
      }
      this.#snapshot = snapshot;
    }
    // 收口：迁移确认落库（或本就没有旧数据）才删旧整表键，不再留随草稿
    // 膨胀的单键值；删不掉（removeItem 异常）下次启动重导只补 IDB 缺口。
    if (legacyPersisted) clearLegacyDraftKeys(storage);
  }

  /** 订阅会话删除：缓存条目随会话一起丢弃（core 侧附件经删除级联清理）。 */
  start(): void {
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.dropConversation(data.id);
    });
  }

  /** 当前会话的待发送附件（组件只读视图；未打开过 = 空数组）。 */
  uploadsOf(conversationId: string): PendingUpload[] {
    return this.#runtime[conversationId]?.uploads ?? [];
  }

  /**
   * 附件归属会话（D115 附件直注）：core RPC 的 conversationId。键是会话 id 时
   * 即键本身；任务直注键（`task:<id>`）取 runtime 里记录的归属会话。
   */
  #ownerOf(key: string): string {
    return this.#runtime[key]?.conversationId ?? key;
  }

  /** 组件水合用：当前草稿的文档/提及/引用（非响应式读取，进会话取一次）。 */
  loadDraft(conversationId: string): {
    doc: JSONContent;
    mentions: string[];
    reply: ComposerReplyRef | null;
  } {
    const entry = this.#runtime[conversationId];
    const reply = entry?.reply ?? null;
    if (this.#replyIsUnusable(conversationId, reply)) {
      if (entry !== undefined) entry.reply = null;
      this.#schedulePersist();
      return {
        doc: entry?.doc ?? EMPTY_COMPOSER_DOC,
        mentions: [...(entry?.mentions ?? [])],
        reply: null,
      };
    }
    return {
      doc: entry?.doc ?? EMPTY_COMPOSER_DOC,
      mentions: entry ? [...entry.mentions] : [],
      reply,
    };
  }

  /**
   * 进入会话：把快照晋升为 runtime（幂等）。恢复出来的附件 chip 不能直接信：core 会在
   * 7 天后回收未绑定附件（AttachmentsService.sweepOrphans），也可能已被先前一次受理了的
   * 发送占用——所以对**所有**附件（不只图片）经 attachments.status 一次往返校验，
   * 失效的摘掉；图片再经 attachments.get 重建预览。
   */
  hydrate(conversationId: string): void {
    if (this.#runtime[conversationId] !== undefined) return;
    const saved = this.#snapshot[conversationId];
    const uploads: PendingUpload[] = (saved?.attachments ?? []).map((attachment) => ({
      key: `att_${attachment.attachmentId}`,
      fileName: attachment.fileName,
      mime: attachment.mime,
      size: attachment.size,
      state: 'ready',
      attachmentId: attachment.attachmentId,
      previewUrl: null,
      ownsPreviewUrl: false,
    }));
    const reply = saved?.reply ?? null;
    const replyHidden = this.#replyIsUnusable(conversationId, reply);
    this.#runtime[conversationId] = {
      doc: saved?.doc ?? EMPTY_COMPOSER_DOC,
      mentions: [...(saved?.mentions ?? [])],
      reply: replyHidden ? null : reply,
      uploads,
      version: saved?.version ?? 0,
      dirty: saved?.dirty ?? false,
      // D115 附件直注：任务直注键的归属会话随快照恢复（chip 校验 / 上传 RPC 用）。
      ...(saved?.conversationId !== undefined ? { conversationId: saved.conversationId } : {}),
    };
    if (replyHidden) this.#schedulePersist();
    if (uploads.length > 0) void this.#verifyRestored(conversationId, uploads);
  }

  /**
   * 应用服务端共享草稿（D120）：整份替换文档 / 提及 / 引用 / 附件元数据，
   * 并把版本记为已同步。Composer 由 `revision` 感知并把编辑器内容切过去。
   */
  applyServerDraft(
    conversationId: string,
    input: {
      doc: JSONContent;
      mentions: string[];
      replyTo: string | null;
      attachments: Array<{ attachmentId: string; fileName: string; mime: string; size: number }>;
      version: number;
    },
  ): void {
    this.hydrate(conversationId);
    const entry = this.#ensureEntry(conversationId);
    entry.doc = input.doc;
    entry.mentions = [...input.mentions];
    // 服务端只存 reply 的 id：本地已有同 id 的预览就保留，否则（另一台设备）无预览。
    const reply = input.replyTo !== null && entry.reply?.id === input.replyTo ? entry.reply : null;
    entry.reply = this.#replyIsUnusable(conversationId, reply) ? null : reply;
    entry.uploads = input.attachments.map((attachment) => ({
      key: `att_${attachment.attachmentId}`,
      fileName: attachment.fileName,
      mime: attachment.mime,
      size: attachment.size,
      state: 'ready' as const,
      attachmentId: attachment.attachmentId,
      previewUrl: null,
      ownsPreviewUrl: false,
    }));
    entry.version = input.version;
    entry.dirty = false;
    this.revision += 1;
    this.#schedulePersist();
    if (entry.uploads.length > 0) void this.#verifyRestored(conversationId, entry.uploads);
  }

  /** 共享草稿的同步状态（ack / stale 恢复后由 sharedDraft 写回）。 */
  setSyncState(conversationId: string, state: { version: number; dirty: boolean }): void {
    const entry = this.#ensureEntry(conversationId);
    entry.version = state.version;
    entry.dirty = state.dirty;
    this.#schedulePersist();
  }

  /** 本地是否有未确认的共享草稿修改（断线重连时决定推本地还是拉服务端）。 */
  isDirty(conversationId: string): boolean {
    return this.#runtime[conversationId]?.dirty ?? false;
  }

  /** 本地快照上次同步到的服务端版本（0 = 从未同步 / 旧 v2 草稿）。 */
  syncVersion(conversationId: string): number {
    return this.#runtime[conversationId]?.version ?? 0;
  }

  /** 远端发送后清空镜像里的附件 chip（读端不拥有这些上传）。 */
  clearUploads(conversationId: string): void {
    const entry = this.#runtime[conversationId];
    if (entry === undefined || entry.uploads.length === 0) return;
    for (const upload of entry.uploads) this.#revokePreview(upload);
    entry.uploads = [];
    this.#schedulePersist();
  }

  /** 本地有未确认修改（由 Composer 在共享草稿 notOwner 时也可标记恢复）。 */
  markDirty(conversationId: string): void {
    const entry = this.#ensureEntry(conversationId);
    entry.dirty = true;
    this.#schedulePersist();
  }

  /** 发送成功 / 远端清空后清掉正文与引用（附件 chip 由 commitSent 单独处理）。 */
  clearDocState(conversationId: string): void {
    const entry = this.#ensureEntry(conversationId);
    entry.doc = EMPTY_COMPOSER_DOC;
    entry.mentions = [];
    entry.reply = null;
    entry.version = 0;
    entry.dirty = false;
    this.revision += 1;
    this.#schedulePersist();
  }

  /** 共享草稿 update 的附件元数据（只含 ready 的 chip）。 */
  attachmentsMetadata(
    conversationId: string,
  ): Array<{ attachmentId: string; fileName: string; mime: string; size: number }> {
    const entry = this.#runtime[conversationId];
    if (entry === undefined) return [];
    return entry.uploads
      .filter((upload) => upload.state === 'ready' && upload.attachmentId !== null)
      .map((upload) => ({
        attachmentId: upload.attachmentId as string,
        fileName: upload.fileName,
        mime: upload.mime,
        size: upload.size,
      }));
  }

  /** 本地是否有可迁移到服务端的内容（文档 / 提及 / 引用 / 附件）。 */
  hasContent(conversationId: string): boolean {
    const entry = this.#runtime[conversationId];
    if (entry === undefined) return false;
    return (
      !isComposerDocEmpty(entry.doc) ||
      entry.mentions.length > 0 ||
      entry.reply !== null ||
      entry.uploads.length > 0
    );
  }

  async #verifyRestored(conversationId: string, restored: PendingUpload[]): Promise<void> {
    let found: AttachmentIssue | null = null;
    try {
      found = await this.inspectAttachments(
        conversationId,
        restored.map((upload) => upload.attachmentId as string),
      );
    } catch {
      // 查不出（core 暂不可用等）：不据此丢 chip——发送时若真失效会按错误码再判因。
    }
    if (found !== null) {
      const issue = found;
      const gone = this.discardAttachments(conversationId, issue);
      if (issue.missing.length > 0) {
        const names = restored
          .filter((upload) => issue.missing.includes(upload.attachmentId as string))
          .map((upload) => upload.fileName);
        toast.info(t('composer.attachmentExpired', { names: names.join(listSeparator()) }));
      }
      if (gone !== null) restored = restored.filter((upload) => !gone.has(upload.key));
    }
    // 预览：仅图片；已被丢弃的 chip 不再请求。
    for (const upload of restored) {
      if (!upload.mime.startsWith('image/') || upload.attachmentId === null) continue;
      if (this.#runtime[conversationId]?.uploads.every((u) => u.key !== upload.key)) continue;
      const key = upload.key;
      void attachmentUrl({ id: upload.attachmentId, mime: upload.mime } as Attachment)
        .then((url) => this.patchUpload(conversationId, key, { previewUrl: url }))
        .catch(() => this.#dropUpload(conversationId, key));
    }
  }

  /**
   * 批量查附件状态（core 一次往返，不读字节），归类为失效附件。首参是草稿键
   * （状态缓存键）；core RPC 的 conversationId 缺省按 `#ownerOf` 解析（任务
   * 直注键 ≠ 会话 id 时走记录的归属会话），第三个参数可显式覆盖。
   */
  async inspectAttachments(
    key: string,
    attachmentIds: readonly string[],
    conversationId?: string,
  ): Promise<AttachmentIssue> {
    if (attachmentIds.length === 0) return { missing: [], sent: [] };
    const result = (await this.#rpc().call('attachments.status', {
      conversationId: conversationId ?? this.#ownerOf(key),
      ids: [...attachmentIds],
    })) as { statuses: AttachmentStatusLike[] };
    return classifyAttachmentStatuses(result.statuses);
  }

  /**
   * 摘掉失效附件对应的 chip（不 detach：missing 已不存在，sent 已属于某条消息）。
   * 返回被摘掉的 chip key 集合（无则 null）。
   */
  discardAttachments(conversationId: string, issue: AttachmentIssue): Set<string> | null {
    const entry = this.#runtime[conversationId];
    if (entry === undefined) return null;
    const dead = new Set([...issue.missing, ...issue.sent]);
    const gone = entry.uploads.filter(
      (upload) => upload.attachmentId !== null && dead.has(upload.attachmentId),
    );
    if (gone.length === 0) return null;
    for (const upload of gone) this.#revokePreview(upload);
    entry.uploads = entry.uploads.filter((upload) => !gone.includes(upload));
    this.#schedulePersist();
    return new Set(gone.map((upload) => upload.key));
  }

  /** 消息已发出后清掉该会话缓存里的引用回复（用户已切走时，回来不应还挂着旧引用）。 */
  clearReply(conversationId: string, messageId?: string): void {
    const entry = this.#runtime[conversationId];
    if (entry === undefined || entry.reply === null) return;
    if (messageId !== undefined && entry.reply.id !== messageId) return;
    entry.reply = null;
    this.#schedulePersist();
  }

  /** 文档/提及/引用变化写回缓存（保存分支每个键程都会进来；落盘是防抖的）。 */
  saveComposerDoc(
    conversationId: string,
    doc: JSONContent,
    mentions: string[],
    reply: ComposerReplyRef | null,
  ): void {
    const entry = this.#ensureEntry(conversationId);
    entry.doc = doc;
    entry.mentions = [...mentions];
    entry.reply = this.#replyIsUnusable(conversationId, reply) ? null : reply;
    this.#schedulePersist();
  }

  // --- 附件上传管道（原 Composer 内联逻辑，移动后上传完成落点跟随会话，
  //     切换会话/关闭窗口都不再丢弃在途或已就绪的附件） ---------------------

  /**
   * 上传附件：chips 挂在 `key` 的草稿缓存下；core RPC 的 conversationId 缺省
   * 按 `#ownerOf(key)` 解析（会话键 = 键本身，任务直注键 = 记录的归属会话），
   * `ownerConversationId` 显式覆盖（首次直注上传时传入任务所在会话并记住）。
   */
  uploadFiles(key: string, files: FileList | File[], ownerConversationId?: string): void {
    this.hydrate(key);
    if (ownerConversationId !== undefined && ownerConversationId !== key) {
      this.#ensureEntry(key).conversationId = ownerConversationId;
    }
    const conversationId = ownerConversationId ?? this.#ownerOf(key);
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t('composer.attachmentTooLarge', { name: file.name }));
        continue;
      }
      const mime = file.type.length > 0 ? file.type : guessMime(file.name);
      const entry: PendingUpload = {
        key: `up_${Math.random().toString(36).slice(2)}_${Date.now()}`,
        fileName: file.name.length > 0 ? file.name : 'pasted-image.png',
        mime,
        size: file.size,
        state: 'uploading',
        attachmentId: null,
        previewUrl: mime.startsWith('image/') ? URL.createObjectURL(file) : null,
        ownsPreviewUrl: true,
      };
      const runtimeEntry = this.#ensureEntry(key);
      runtimeEntry.uploads = [...runtimeEntry.uploads, entry];
      const task = (async (): Promise<string | null> => {
        try {
          const bytesBase64 = await fileToBase64(file);
          const result = (await this.#rpc().call('attachments.upload', {
            conversationId,
            fileName: entry.fileName,
            mime: entry.mime,
            bytesBase64,
          })) as { attachment: { id: string } };
          this.patchUpload(key, entry.key, {
            state: 'ready',
            attachmentId: result.attachment.id,
          });
          return result.attachment.id;
        } catch {
          this.patchUpload(key, entry.key, { state: 'error' });
          toast.error(t('composer.attachmentUploadFailed', { name: entry.fileName }));
          return null;
        }
      })();
      this.#uploadTasks.set(entry.key, task);
      void task.finally(() => {
        if (this.#uploadTasks.get(entry.key) === task) this.#uploadTasks.delete(entry.key);
      });
    }
  }

  /**
   * 等待在途上传完成，返回可发送的附件 id。**不移除任何 chip**：就绪的 chip
   * 要等发送成功后由 commitSent 摘掉（发送失败时它们原样留在输入框，可直接
   * 重试，不会变成孤儿）；上传失败的 chip 留着显示错误，由用户手动移除；
   * 超时仍未完成的同样保留，不静默丢弃。
   */
  async settle(conversationId: string): Promise<string[]> {
    for (let guard = 0; guard < 600; guard += 1) {
      const uploading =
        this.#runtime[conversationId]?.uploads.some((upload) => upload.state === 'uploading') ??
        false;
      if (!uploading) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const entry = this.#runtime[conversationId];
    return entry === undefined ? [] : readyAttachmentIds(entry.uploads);
  }

  /**
   * 消息已发出：摘掉随它发出的附件 chip（释放预览，不 detach——附件已转正属于
   * 该消息）。其余 chip（上传失败 / 仍在上传）原样保留。
   */
  commitSent(conversationId: string, attachmentIds: readonly string[]): void {
    const entry = this.#runtime[conversationId];
    if (entry === undefined || attachmentIds.length === 0) return;
    const sent = new Set(attachmentIds);
    const gone = entry.uploads.filter(
      (upload) => upload.attachmentId !== null && sent.has(upload.attachmentId),
    );
    if (gone.length === 0) return;
    for (const upload of gone) this.#revokePreview(upload);
    entry.uploads = entry.uploads.filter((upload) => !gone.includes(upload));
    this.#schedulePersist();
  }

  /** 移除 chip：等在途上传落定后把 core 侧附件行与文件一并清掉（不留孤儿）。 */
  async removeUpload(conversationId: string, key: string): Promise<void> {
    const entry = this.#runtime[conversationId];
    const upload = entry?.uploads.find((candidate) => candidate.key === key);
    if (entry === undefined || upload === undefined) return;
    entry.uploads = entry.uploads.filter((candidate) => candidate.key !== key);
    this.#revokePreview(upload);
    this.#schedulePersist();
    const task = this.#uploadTasks.get(key);
    const id = upload.attachmentId ?? (task !== undefined ? await task.catch(() => null) : null);
    if (id === null) return;
    try {
      await this.#rpc().call('attachments.detach', { id });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  /** 快照里的附件在 core 侧已不存在（行/文件被清）：静默撤 chip。 */
  #dropUpload(conversationId: string, key: string): void {
    const entry = this.#runtime[conversationId];
    const upload = entry?.uploads.find((candidate) => candidate.key === key);
    if (entry === undefined || upload === undefined) return;
    entry.uploads = entry.uploads.filter((candidate) => candidate.key !== key);
    this.#revokePreview(upload);
    this.#schedulePersist();
  }

  patchUpload(conversationId: string, key: string, patch: Partial<PendingUpload>): void {
    const entry = this.#runtime[conversationId];
    if (entry === undefined) return;
    // $state 数组里的对象是深代理：必须按 key 替换整个条目才触发更新。
    entry.uploads = entry.uploads.map((upload) =>
      upload.key === key ? { ...upload, ...patch } : upload,
    );
    this.#schedulePersist();
  }

  #revokePreview(upload: PendingUpload): void {
    if (upload.ownsPreviewUrl && upload.previewUrl !== null) URL.revokeObjectURL(upload.previewUrl);
  }

  /**
   * 会话删除：丢弃 runtime 与快照条目，并显式删掉 IndexedDB 记录——快照已在
   * 此处先行删除，后续防抖落盘的 diff 不会再为它产生 deletes（旧整表重写
   * 天然清掉，按会话记录后必须自己删，否则重启会复活已删会话的草稿）。
   */
  dropConversation(conversationId: string): void {
    const entry = this.#runtime[conversationId];
    if (entry !== undefined) {
      for (const upload of entry.uploads) this.#revokePreview(upload);
      delete this.#runtime[conversationId];
    }
    delete this.#snapshot[conversationId];
    this.#deleteDraftRecord(conversationId);
    this.#schedulePersist();
  }

  #ensureEntry(conversationId: string): ComposerRuntimeDraft {
    const existing = this.#runtime[conversationId];
    if (existing !== undefined) return existing;
    const created: ComposerRuntimeDraft = {
      doc: EMPTY_COMPOSER_DOC,
      mentions: [],
      reply: null,
      uploads: [],
      version: 0,
      dirty: false,
    };
    this.#runtime[conversationId] = created;
    return created;
  }

  // --- 落盘 ---------------------------------------------------------------

  #schedulePersist(): void {
    if (this.#persistTimer !== null) clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  #persistNow(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    const previous = this.#snapshot;
    const next = buildPersistedSnapshot({
      runtime: this.#runtime,
      previous,
      now: Date.now(),
    });
    this.#snapshot = next;
    const db = this.#kvDb;
    if (db === null) return;
    const { upserts, deletes } = diffPersistedDrafts(previous, next);
    if (upserts.length === 0 && deletes.length === 0) return;
    void db
      .then(async (handle) => {
        const store = handle.store(DRAFTS_STORE);
        for (const [key, draft] of upserts) await store.put(key, draft);
        for (const key of deletes) await store.delete(key);
      })
      .catch(() => {
        // IndexedDB 不可用 / 配额满：缓存是尽力而为，不阻塞输入。
      });
  }

  /** 单条草稿记录直删（dropConversation 用；fire-and-forget，失败留待下次覆盖）。 */
  #deleteDraftRecord(key: string): void {
    const db = this.#kvDb;
    if (db === null) return;
    void db
      .then((handle) => handle.store(DRAFTS_STORE).delete(key))
      .catch(() => {
        // 同上：尽力而为。
      });
  }
}

export const composerDrafts = new ComposerDraftsState();
