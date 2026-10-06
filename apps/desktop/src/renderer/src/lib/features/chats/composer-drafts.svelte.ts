import type { Attachment } from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';
import { attachmentUrl } from './attachments.svelte';
import {
  buildPersistedSnapshot,
  loadPersistedDrafts,
  writePersistedDrafts,
  type ComposerReplyRef,
  type DraftsStorage,
  type PersistedComposerDraft,
} from './composer-draft-persist';

/**
 * 输入框草稿的按会话缓存（store）：文本 / @ 提及 / 引用回复 / 待发送附件。
 * Composer 是唯一的读写方——进入会话时把缓存水合进组件状态，内容变化即写回，
 * 这里负责防抖落盘（localStorage）；因此切换会话、关闭应用后回到原会话都能
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
  text: string;
  mentions: string[];
  reply: ComposerReplyRef | null;
  uploads: PendingUpload[];
}

const PERSIST_DEBOUNCE_MS = 300;
const MAX_UPLOAD_BYTES = 30_000_000;

function draftsStorage(): DraftsStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
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

class ComposerDraftsState {
  /** 打开过的会话的输入框草稿；text/mentions/reply 由 Composer 的水合/保存 effect 同步。 */
  #runtime = $state<Record<string, ComposerRuntimeDraft>>({});
  /** 启动时从 localStorage 载入的快照：未打开过的会话原样保留，打开时晋升为 runtime。 */
  #snapshot: Record<string, PersistedComposerDraft> = loadPersistedDrafts(draftsStorage());
  // 上传任务管道：key → 完成后的 attachmentId（失败为 null）；没有界面从它派生。
  #uploadTasks = new Map<string, Promise<string | null>>();
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // 退出前的最后一笔兜底：防抖窗口内的键入也要落盘（localStorage 写是同步的）。
    window.addEventListener('pagehide', () => this.#persistNow());
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

  /** 组件水合用：当前草稿的文本/提及/引用（非响应式读取，进会话取一次）。 */
  loadDraft(conversationId: string): {
    text: string;
    mentions: string[];
    reply: ComposerReplyRef | null;
  } {
    const entry = this.#runtime[conversationId];
    return {
      text: entry?.text ?? '',
      mentions: entry ? [...entry.mentions] : [],
      reply: entry?.reply ?? null,
    };
  }

  /** 进入会话：把快照晋升为 runtime（幂等）；图片附件的预览经 attachments.get 重建。 */
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
    this.#runtime[conversationId] = {
      text: saved?.text ?? '',
      mentions: [...(saved?.mentions ?? [])],
      reply: saved?.reply ?? null,
      uploads,
    };
    for (const upload of uploads) {
      if (!upload.mime.startsWith('image/') || upload.attachmentId === null) continue;
      const key = upload.key;
      const attachmentId: string = upload.attachmentId;
      void attachmentUrl({ id: attachmentId, mime: upload.mime } as Attachment)
        .then((url) => this.patchUpload(conversationId, key, { previewUrl: url }))
        .catch(() => this.#dropUpload(conversationId, key));
    }
  }

  /** 文本/提及/引用变化写回缓存（保存分支每个键程都会进来；落盘是防抖的）。 */
  saveComposerText(
    conversationId: string,
    text: string,
    mentions: string[],
    reply: ComposerReplyRef | null,
  ): void {
    const entry = this.#ensureEntry(conversationId);
    entry.text = text;
    entry.mentions = [...mentions];
    entry.reply = reply;
    this.#schedulePersist();
  }

  // --- 附件上传管道（原 Composer 内联逻辑，移动后上传完成落点跟随会话，
  //     切换会话/关闭窗口都不再丢弃在途或已就绪的附件） ---------------------

  uploadFiles(conversationId: string, files: FileList | File[]): void {
    this.hydrate(conversationId);
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
      const runtimeEntry = this.#ensureEntry(conversationId);
      runtimeEntry.uploads = [...runtimeEntry.uploads, entry];
      const task = (async (): Promise<string | null> => {
        try {
          const bytesBase64 = await fileToBase64(file);
          const result = (await core.call('attachments.upload', {
            conversationId,
            fileName: entry.fileName,
            mime: entry.mime,
            bytesBase64,
          })) as { attachment: { id: string } };
          this.patchUpload(conversationId, entry.key, {
            state: 'ready',
            attachmentId: result.attachment.id,
          });
          return result.attachment.id;
        } catch {
          this.patchUpload(conversationId, entry.key, { state: 'error' });
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
   * 等待在途上传完成，返回可发送的附件 id。已就绪/失败的条目从 chip 区移除
   * （预览随之释放）；超时仍未完成的保留在原地（随下一条草稿发出或手动
   * 移除），不再静默丢弃。
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
    if (entry === undefined) return [];
    const ids = entry.uploads
      .filter((upload) => upload.state === 'ready' && upload.attachmentId !== null)
      .map((upload) => upload.attachmentId as string);
    for (const upload of entry.uploads) {
      if (upload.state !== 'uploading') this.#revokePreview(upload);
    }
    entry.uploads = entry.uploads.filter((upload) => upload.state === 'uploading');
    this.#schedulePersist();
    return ids;
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
      await core.call('attachments.detach', { id });
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

  /** 会话删除：丢弃 runtime 与快照条目。 */
  dropConversation(conversationId: string): void {
    const entry = this.#runtime[conversationId];
    if (entry !== undefined) {
      for (const upload of entry.uploads) this.#revokePreview(upload);
      delete this.#runtime[conversationId];
    }
    delete this.#snapshot[conversationId];
    this.#schedulePersist();
  }

  #ensureEntry(conversationId: string): ComposerRuntimeDraft {
    const existing = this.#runtime[conversationId];
    if (existing !== undefined) return existing;
    const created: ComposerRuntimeDraft = { text: '', mentions: [], reply: null, uploads: [] };
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
    const next = buildPersistedSnapshot({
      runtime: this.#runtime,
      previous: this.#snapshot,
      now: Date.now(),
    });
    this.#snapshot = next;
    writePersistedDrafts(draftsStorage(), next);
  }
}

export const composerDrafts = new ComposerDraftsState();
