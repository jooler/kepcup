import type { JSONContent } from '@tiptap/core';
import {
  type CollabClientRef,
  type CollabDraft,
  type CollabDraftAttachment,
  type CollabDraftChangedPayload,
  type CollabDraftClearedPayload,
  type CollabDraftOwnerChangedPayload,
  type CollabLease,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { composerDrafts } from '$lib/features/chats/composer-drafts.svelte';
import { clientIdentity } from './client-identity';

/**
 * 共享草稿（D120，docs/design/57-multi-client-collaboration.md §4）。
 *
 * 每个 Composer 实例持有一个 Store（主对话与看板卡片对话可以同时挂载）：
 * 状态、事件订阅与租约都按自己的会话隔离，绝不共用全局对话 id。
 *
 * 同一会话单写者租约（clientId + connectionId）；持有者可编辑，其余客户端
 * 只读镜像；发送经 `collab.draft.send` 原子清草稿。localStorage 只是断线 /
 * 崩溃缓冲（v3 快照带 version/dirty）。
 */

export type SharedDraftState = 'idle' | 'loading' | 'no-owner' | 'owner' | 'reader' | 'offline';

type Source = symbol;

interface LocalDraftPayload {
  doc: JSONContent;
  mentions: string[];
  replyTo: string | null;
  attachments: CollabDraftAttachment[];
}

interface DraftGetResult {
  draft: CollabDraft;
  lease: CollabLease | null;
}

interface DraftClaimResult {
  draft: CollabDraft;
  lease: CollabLease;
}

const PUSH_DEBOUNCE_MS = 200;
const RETRY_MS = 250;
const LEASE_RENEW_MS = 5_000;
const EMPTY_DOC: JSONContent = { type: 'doc', content: [] };

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function ownerRef(lease: CollabLease | null): CollabClientRef | null {
  return lease === null ? null : { id: lease.ownerClientId, name: lease.ownerName };
}

export class SharedDraftStore {
  state = $state<SharedDraftState>('idle');
  owner = $state<CollabClientRef | null>(null);
  leaseExpiresAt = $state<number | null>(null);
  version = $state(0);
  /** 每次把服务端草稿应用到本地 +1；Composer 据此切换编辑器内容。 */
  revision = $state(0);
  doc = $state<JSONContent | null>(null);
  /** true = doc 是当前会话的服务端快照（空草稿也是权威空，不是“未加载”）。 */
  loaded = $state(false);
  docConversationId = $state<string | null>(null);

  #conversationId: string | null = null;
  #source: Source | null = null;
  #started = false;
  #composing = false;
  #pending: LocalDraftPayload | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #renew: ReturnType<typeof setInterval> | null = null;
  #unsubscribers: Array<() => void> = [];
  #ready: Promise<void> = Promise.resolve();
  #readyResolve: (() => void) | null = null;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(
      core.onEvent('collab.draftChanged', (payload) => {
        this.#onChanged(payload as CollabDraftChangedPayload);
      }),
      core.onEvent('collab.draftOwnerChanged', (payload) => {
        this.#onOwnerChanged(payload as CollabDraftOwnerChangedPayload);
      }),
      core.onEvent('collab.draftCleared', (payload) => {
        this.#onCleared(payload as CollabDraftClearedPayload);
      }),
      // core 重启 / 重连后租约已随内存清空：所有非 idle 状态都重新 get + claim，
      // 否则被接管方会停在 reader 等一个不存在的 owner。
      core.onEvent('core.status', (payload) => {
        if ((payload as { status?: string }).status !== 'ready') return;
        if (this.state === 'idle') return;
        const conversationId = this.#conversationId;
        if (conversationId !== null) void this.#load(conversationId);
      }),
    );
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#onPageHide);
  }

  async enter(conversationId: string | null, source: Source): Promise<void> {
    if (this.#conversationId === conversationId && this.#source === source) return;
    const previous = this.#conversationId;
    if (previous !== null && this.state === 'owner') this.#releaseLease(previous);
    this.#stopTimers();
    this.#source = source;
    this.#conversationId = conversationId;
    this.owner = null;
    this.leaseExpiresAt = null;
    this.version = 0;
    this.loaded = false;
    this.doc = null;
    this.docConversationId = null;
    this.#pending = null;
    if (conversationId === null) {
      this.state = 'idle';
      this.#resolveReady();
      return;
    }
    composerDrafts.hydrate(conversationId);
    this.state = 'loading';
    const readyPromise = new Promise<void>((resolve) => {
      this.#readyResolve = resolve;
    });
    this.#ready = readyPromise;
    try {
      await this.#load(conversationId);
    } finally {
      if (this.#ready === readyPromise && this.#readyResolve !== null) {
        const resolve = this.#readyResolve;
        this.#readyResolve = null;
        resolve();
      }
    }
  }

  /** 等当前会话的 get + claim 落定（发送前用，避免 loading 窗口内读到旧草稿）。 */
  whenReady(): Promise<void> {
    return this.#ready;
  }

  #resolveReady(): void {
    this.#readyResolve?.();
    this.#readyResolve = null;
  }

  leave(source: Source): void {
    if (this.#source !== source) return;
    const conversationId = this.#conversationId;
    if (conversationId !== null && this.state === 'owner') this.#releaseLease(conversationId);
    this.#reset();
  }

  stop(): void {
    if (!this.#started) return;
    const conversationId = this.#conversationId;
    if (conversationId !== null && this.state === 'owner') this.#releaseLease(conversationId);
    this.#started = false;
    this.#stopTimers();
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.#onPageHide);
    this.#reset();
  }

  /** 输入框内容变化：持有者防抖上传；offline 时只排队，等重连后推。 */
  noteLocalChange(input: LocalDraftPayload): void {
    if (this.state !== 'owner' && this.state !== 'offline') return;
    const conversationId = this.#conversationId;
    if (conversationId === null) return;
    this.#pending = input;
    composerDrafts.markDirty(conversationId);
    if (this.#composing || this.state === 'offline') return;
    this.#schedulePush();
  }

  setComposing(composing: boolean): void {
    if (this.#composing === composing) return;
    this.#composing = composing;
    if (!composing && this.#pending !== null && this.state === 'owner') {
      this.#schedulePush(0);
    }
  }

  /** 空闲时 claim（焦点 / 编辑前调用）；被占用则转只读。 */
  async claimIfFree(): Promise<boolean> {
    const conversationId = this.#conversationId;
    if (conversationId === null || this.state !== 'no-owner') return false;
    try {
      const claimed = (await core.call('collab.draft.claim', {
        conversationId,
        clientId: clientIdentity.id,
        clientName: clientIdentity.name,
        connectionId: clientIdentity.connectionId,
      })) as DraftClaimResult;
      if (this.#conversationId !== conversationId) return false;
      this.#becomeOwner(claimed.lease);
      this.version = claimed.draft.version;
      if (this.#pending !== null) this.#schedulePush(0);
      return true;
    } catch {
      if (this.#conversationId === conversationId) await this.#refreshLease(conversationId);
      return false;
    }
  }

  /** 显式接管：从只读端抢过编辑权（UI 需先确认）。 */
  async takeover(): Promise<boolean> {
    const conversationId = this.#conversationId;
    if (conversationId === null) return false;
    try {
      const claimed = (await core.call('collab.draft.claim', {
        conversationId,
        clientId: clientIdentity.id,
        clientName: clientIdentity.name,
        connectionId: clientIdentity.connectionId,
        force: true,
      })) as DraftClaimResult;
      if (this.#conversationId !== conversationId) return false;
      this.#becomeOwner(claimed.lease);
      this.version = claimed.draft.version;
      if (this.#pending !== null) this.#schedulePush(0);
      else if (claimed.draft.version > 0) this.#apply(claimed.draft);
      return true;
    } catch {
      this.state = 'offline';
      return false;
    }
  }

  /** 发送：草稿、租约与消息落库在 core 的同一个调用里完成。 */
  async send(input: {
    text: string;
    mentions?: string[];
    replyTo?: string | null;
    attachmentIds?: string[];
    voiceMode?: boolean;
  }): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
    const conversationId = this.#conversationId;
    if (conversationId === null || this.state !== 'owner') {
      return { ok: false, code: 'DRAFT_NOT_OWNER' };
    }
    // 先把防抖窗口里的最新内容推到 core，避免发送的是旧版本。
    if (this.#pending !== null) {
      this.#clearDebounce();
      await this.#push();
      if (this.#conversationId !== conversationId || this.state !== 'owner') {
        return { ok: false, code: 'DRAFT_NOT_OWNER' };
      }
    }
    try {
      await core.call('collab.draft.send', {
        conversationId,
        clientId: clientIdentity.id,
        connectionId: clientIdentity.connectionId,
        baseVersion: this.version,
        text: input.text,
        ...(input.mentions !== undefined && input.mentions.length > 0
          ? { mentions: input.mentions }
          : {}),
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.attachmentIds !== undefined && input.attachmentIds.length > 0
          ? { attachmentIds: input.attachmentIds }
          : {}),
        ...(input.voiceMode === true ? { voiceMode: true } : {}),
        client: { id: clientIdentity.id, name: clientIdentity.name },
      });
      this.#stopRenew();
      this.#stopTimers();
      this.state = 'no-owner';
      this.owner = null;
      this.leaseExpiresAt = null;
      this.version = 0;
      this.#pending = null;
      this.doc = EMPTY_DOC;
      this.loaded = true;
      this.docConversationId = conversationId;
      this.revision += 1;
      composerDrafts.clearDocState(conversationId);
      return { ok: true };
    } catch (error) {
      const code = codeOf(error);
      if (code === 'DRAFT_STALE' || code === 'DRAFT_NOT_OWNER') await this.#load(conversationId);
      return { ok: false, code };
    }
  }

  async #load(conversationId: string): Promise<void> {
    try {
      const result = (await core.call('collab.draft.get', {
        conversationId,
      })) as DraftGetResult;
      if (this.#conversationId !== conversationId) return;
      const selfConnection = clientIdentity.connectionId;
      const leaseHeldByOther =
        result.lease !== null &&
        (result.lease.ownerClientId !== clientIdentity.id ||
          ((result.lease.ownerConnectionId ?? null) !== null &&
            (result.lease.ownerConnectionId ?? null) !== selfConnection));
      const localVersion = composerDrafts.syncVersion(conversationId);
      const localDirty =
        this.#pending !== null ||
        (composerDrafts.isDirty(conversationId) && localVersion > 0) ||
        (result.draft.version === 0 && composerDrafts.hasContent(conversationId));

      if (leaseHeldByOther) {
        // 只读镜像以服务端为准；但本地有未同步内容时保留本地文本，避免断线编辑
        // 被别人的快照覆盖（接管后再推）。
        if (!localDirty) this.#apply(result.draft);
        this.#becomeReader(result.lease!);
        return;
      }

      const claimed = (await core.call('collab.draft.claim', {
        conversationId,
        clientId: clientIdentity.id,
        clientName: clientIdentity.name,
        connectionId: selfConnection,
      })) as DraftClaimResult;
      if (this.#conversationId !== conversationId) return;
      this.#becomeOwner(claimed.lease);
      this.version = claimed.draft.version;
      if (localDirty) {
        // 断线期间 / 旧版本地草稿：claim 后推本地，不用旧的服务端快照覆盖。
        if (this.#pending === null) this.#pending = this.#localPayload(conversationId);
        if (this.#pending !== null) this.#schedulePush(0);
      } else if (claimed.draft.version > 0) {
        this.#apply(claimed.draft);
      }
    } catch (error) {
      if (this.#conversationId !== conversationId) return;
      if (codeOf(error) === 'DRAFT_BUSY') {
        await this.#refreshLease(conversationId);
        return;
      }
      this.state = 'offline';
    }
  }

  async #refreshLease(conversationId: string): Promise<void> {
    try {
      const result = (await core.call('collab.draft.get', {
        conversationId,
      })) as DraftGetResult;
      if (this.#conversationId !== conversationId) return;
      const selfConnection = clientIdentity.connectionId;
      if (result.lease === null) {
        this.state = 'no-owner';
        this.owner = null;
        this.leaseExpiresAt = null;
        return;
      }
      const mine =
        result.lease.ownerClientId === clientIdentity.id &&
        ((result.lease.ownerConnectionId ?? null) === null ||
          (result.lease.ownerConnectionId ?? null) === selfConnection);
      if (mine) {
        this.#becomeOwner(result.lease);
        if (this.#pending !== null) {
          this.version = result.draft.version;
          this.#schedulePush(0);
        } else if (result.draft.version > this.version) {
          this.#apply(result.draft);
        } else {
          this.version = result.draft.version;
        }
        return;
      }
      if (
        result.draft.version > 0 &&
        this.#pending === null &&
        !composerDrafts.isDirty(conversationId)
      ) {
        this.#apply(result.draft);
      }
      this.#becomeReader(result.lease);
    } catch {
      this.state = 'offline';
    }
  }

  async #push(): Promise<void> {
    const conversationId = this.#conversationId;
    const pending = this.#pending;
    if (conversationId === null || pending === null || this.state !== 'owner') return;
    try {
      const result = (await core.call('collab.draft.update', {
        conversationId,
        clientId: clientIdentity.id,
        connectionId: clientIdentity.connectionId,
        baseVersion: this.version,
        doc: pending.doc,
        mentions: pending.mentions,
        replyTo: pending.replyTo,
        attachments: pending.attachments,
      })) as { version: number; updatedAt: number };
      if (this.#conversationId !== conversationId) return;
      if (this.#pending === pending) this.#pending = null;
      this.version = result.version;
      this.leaseExpiresAt = Date.now() + 20_000;
      composerDrafts.setSyncState(conversationId, { version: result.version, dirty: false });
    } catch (error) {
      if (this.#conversationId !== conversationId) return;
      const code = codeOf(error);
      if (code === 'DRAFT_STALE' || code === 'DRAFT_NOT_OWNER') {
        composerDrafts.markDirty(conversationId);
        await this.#load(conversationId);
        return;
      }
      // 保留 pending：重连 / 限流后还能把最新内容补上，不能被服务端旧快照覆盖。
      composerDrafts.markDirty(conversationId);
      if (code === 'RATE_LIMITED') {
        this.#schedulePush(RETRY_MS);
        return;
      }
      this.state = 'offline';
    }
  }

  #localPayload(conversationId: string): LocalDraftPayload | null {
    const local = composerDrafts.loadDraft(conversationId);
    const attachments = composerDrafts.attachmentsMetadata(conversationId);
    return {
      doc: local.doc,
      mentions: local.mentions,
      replyTo: local.reply?.id ?? null,
      attachments,
    };
  }

  #apply(draft: CollabDraft): void {
    const conversationId = this.#conversationId;
    if (conversationId === null) return;
    this.version = draft.version;
    this.doc = draft.doc as unknown as JSONContent;
    this.loaded = true;
    this.docConversationId = conversationId;
    composerDrafts.applyServerDraft(conversationId, {
      doc: draft.doc as unknown as JSONContent,
      mentions: draft.mentions,
      replyTo: draft.replyTo,
      attachments: draft.attachments,
      version: draft.version,
    });
    this.revision += 1;
  }

  #becomeOwner(lease: CollabLease): void {
    this.state = 'owner';
    this.owner = ownerRef(lease);
    this.leaseExpiresAt = lease.expiresAt;
    this.#startRenew();
  }

  #becomeReader(lease: CollabLease): void {
    this.#stopRenew();
    this.state = 'reader';
    this.owner = ownerRef(lease);
    this.leaseExpiresAt = lease.expiresAt;
  }

  #startRenew(): void {
    this.#stopRenew();
    this.#renew = setInterval(() => {
      const conversationId = this.#conversationId;
      if (conversationId === null || this.state !== 'owner') return;
      void core
        .call('collab.draft.claim', {
          conversationId,
          clientId: clientIdentity.id,
          clientName: clientIdentity.name,
          connectionId: clientIdentity.connectionId,
        })
        .then((result) => {
          if (this.#conversationId !== conversationId || this.state !== 'owner') return;
          this.leaseExpiresAt = (result as DraftClaimResult).lease.expiresAt;
        })
        .catch(() => {
          if (this.#conversationId === conversationId) void this.#load(conversationId);
        });
    }, LEASE_RENEW_MS);
  }

  #stopRenew(): void {
    if (this.#renew !== null) {
      clearInterval(this.#renew);
      this.#renew = null;
    }
  }

  #clearDebounce(): void {
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
  }

  #schedulePush(delay = PUSH_DEBOUNCE_MS): void {
    this.#clearDebounce();
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#push();
    }, delay);
  }

  #stopTimers(): void {
    this.#stopRenew();
    this.#clearDebounce();
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
  }

  #releaseLease(conversationId: string): void {
    void core
      .call('collab.draft.release', {
        conversationId,
        clientId: clientIdentity.id,
        connectionId: clientIdentity.connectionId,
      })
      .catch(() => undefined);
  }

  #reset(): void {
    this.#stopTimers();
    this.#source = null;
    this.#conversationId = null;
    this.#pending = null;
    this.state = 'idle';
    this.owner = null;
    this.leaseExpiresAt = null;
    this.version = 0;
    this.loaded = false;
    this.doc = null;
    this.docConversationId = null;
    this.#resolveReady();
  }

  #onChanged(payload: CollabDraftChangedPayload): void {
    if (payload.conversationId !== this.#conversationId) return;
    // 持有者忽略自己的回声；offline 时保留本地未同步内容，等重连后推。
    if (this.state === 'owner' || this.state === 'offline') return;
    if (payload.draft.version <= this.version) return;
    // 读端有本地未同步文本时不覆盖（接管后推本地）。
    if (this.#pending !== null || composerDrafts.isDirty(payload.conversationId)) return;
    this.#apply(payload.draft);
  }

  #onOwnerChanged(payload: CollabDraftOwnerChangedPayload): void {
    if (payload.conversationId !== this.#conversationId) return;
    const owner = payload.owner;
    this.leaseExpiresAt = payload.expiresAt;
    if (owner === null) {
      this.#stopRenew();
      this.owner = null;
      if (this.state === 'owner' || this.state === 'reader' || this.state === 'loading') {
        this.state = 'no-owner';
      }
      return;
    }
    this.owner = owner;
    const ownerConnectionId = payload.ownerConnectionId ?? null;
    const mine =
      owner.id === clientIdentity.id &&
      (ownerConnectionId === null || ownerConnectionId === clientIdentity.connectionId);
    if (mine) {
      if (this.state !== 'owner') {
        this.state = 'owner';
        this.#startRenew();
      }
      if (this.#pending !== null) this.#schedulePush(0);
    } else {
      this.#stopRenew();
      this.state = 'reader';
    }
  }

  #onCleared(payload: CollabDraftClearedPayload): void {
    if (payload.conversationId !== this.#conversationId) return;
    this.#stopTimers();
    this.owner = null;
    this.leaseExpiresAt = null;
    this.version = 0;
    this.#pending = null;
    this.doc = EMPTY_DOC;
    this.loaded = true;
    this.docConversationId = payload.conversationId;
    this.state = 'no-owner';
    this.revision += 1;
    composerDrafts.clearDocState(payload.conversationId);
    // 读端的附件 chip 是发送者的镜像；发送者自己由 commitSent 处理。
    if (payload.byClientId !== clientIdentity.id) {
      composerDrafts.clearUploads(payload.conversationId);
    }
  }

  #onPageHide = (): void => {
    const conversationId = this.#conversationId;
    if (conversationId === null || this.state !== 'owner') return;
    this.#releaseLease(conversationId);
  };
}

export function createSharedDraftStore(): SharedDraftStore {
  return new SharedDraftStore();
}
