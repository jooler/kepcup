import {
  AppError,
  COLLAB_DRAFT_BROADCAST_MIN_MS,
  COLLAB_DRAFT_CLAIM_MAX_HZ,
  COLLAB_DRAFT_HUGE_BYTES,
  COLLAB_DRAFT_LARGE_BYTES,
  COLLAB_DRAFT_LEASE_MS,
  COLLAB_DRAFT_LEASE_SWEEP_MS,
  COLLAB_DRAFT_MAX_BYTES,
  COLLAB_DRAFT_MAX_DEPTH,
  COLLAB_DRAFT_MAX_NODES,
  COLLAB_DRAFT_MENTION_MAX_CHARS,
  COLLAB_DRAFT_REPLY_ID_MAX_CHARS,
  COLLAB_DRAFT_UPDATE_MAX_HZ,
  type CollabClientRef,
  type CollabDraft,
  type CollabDraftAttachment,
  type CollabDraftChangedPayload,
  type CollabDraftClearedPayload,
  type CollabDraftOwnerChangedPayload,
  type CollabLease,
  type Message,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import { sanitizeClientName } from './client-name.js';
import { TokenBucket } from './rate-limit.js';

/**
 * 多客户端共享草稿（D120，docs/design/57-multi-client-collaboration.md §4）。
 *
 * 草稿正文在 `composer_drafts`（main.db，整库加密）；编辑者租约只在内存，
 * core 重启后由首个 claim 重建。同一会话同一时刻只有一个写入者；所有更新都
 * 带 `baseVersion`，版本不匹配即 `DRAFT_STALE`，不静默覆盖。租约按
 * clientId + connectionId 归属：同一设备的两个标签页不会都自认持有者。
 *
 * 发送时草稿行在消息事务内删除（orchestrator 的 onPersisted 回调），避免
 * 「消息已落库、草稿还在」的重复发送窗口。
 */

export interface DraftServiceEvents {
  'collab.draftChanged': CollabDraftChangedPayload;
  'collab.draftOwnerChanged': CollabDraftOwnerChangedPayload;
  'collab.draftCleared': CollabDraftClearedPayload;
}

export interface DraftSendInput {
  text: string;
  mentions?: string[];
  replyTo?: string | null;
  attachmentIds?: string[];
  voiceMode?: boolean;
  /** D121：消息归属（渲染层显示「来自 X」）。 */
  client?: CollabClientRef;
}

export interface DraftServiceDeps {
  db: SqliteDatabase;
  clock: Clock;
  publish: <K extends keyof DraftServiceEvents>(name: K, payload: DraftServiceEvents[K]) => void;
  /** 与 messages.send 同一条落库 / 路由路径（orchestrator.sendMessage）。 */
  sendMessage: (
    conversationId: string,
    input: DraftSendInput,
    /** 在消息事务内执行：删除草稿行与消息落库同生共死。 */
    onPersisted: () => void,
  ) => { message: Message; runId: string | null };
}

interface DraftRow {
  doc_json: string;
  mentions_json: string;
  reply_to: string | null;
  attachments_json: string;
  version: number;
  updated_at: number;
}

interface Lease {
  ownerClientId: string;
  /** null = 旧客户端未上报连接 id（按 clientId 兼容）。 */
  ownerConnectionId: string | null;
  ownerName: string;
  expiresAt: number;
}

const EMPTY_DOC = { type: 'doc' as const, content: [] as unknown[] };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isForeignKeyError(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
}

function rateLimited(): AppError {
  return new AppError('RATE_LIMITED', '操作过于频繁，请稍后再试');
}

function validateDocShape(doc: unknown): void {
  if (doc === null || typeof doc !== 'object' || (doc as { type?: unknown }).type !== 'doc') {
    throw new AppError('INVALID_INPUT', '草稿文档格式不正确');
  }
  const stack: Array<{ node: unknown; depth: number }> = [{ node: doc, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.node === null || typeof entry.node !== 'object') continue;
    if (entry.depth > COLLAB_DRAFT_MAX_DEPTH) {
      throw new AppError('INVALID_INPUT', '草稿嵌套过深');
    }
    nodes += 1;
    if (nodes > COLLAB_DRAFT_MAX_NODES) {
      throw new AppError('INVALID_INPUT', '草稿节点过多');
    }
    if (Array.isArray(entry.node)) {
      for (const item of entry.node) stack.push({ node: item, depth: entry.depth + 1 });
    } else {
      for (const value of Object.values(entry.node)) {
        if (value !== null && typeof value === 'object') {
          stack.push({ node: value, depth: entry.depth + 1 });
        }
      }
    }
  }
}

export class DraftService {
  readonly #deps: DraftServiceDeps;
  readonly #leases = new Map<string, Lease>();
  readonly #claimBucket: TokenBucket;
  readonly #updateBucket: TokenBucket;
  readonly #dirty = new Set<string>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #flushDelayMs = COLLAB_DRAFT_BROADCAST_MIN_MS;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(deps: DraftServiceDeps) {
    this.#deps = deps;
    this.#claimBucket = new TokenBucket(
      deps.clock,
      COLLAB_DRAFT_CLAIM_MAX_HZ,
      COLLAB_DRAFT_CLAIM_MAX_HZ * 2,
    );
    this.#updateBucket = new TokenBucket(
      deps.clock,
      COLLAB_DRAFT_UPDATE_MAX_HZ,
      COLLAB_DRAFT_UPDATE_MAX_HZ * 2,
    );
    this.#sweepTimer = setInterval(() => this.#sweepExpiredLeases(), COLLAB_DRAFT_LEASE_SWEEP_MS);
    this.#sweepTimer.unref?.();
  }

  get(conversationId: string): { draft: CollabDraft; lease: CollabLease | null } {
    this.#expireLease(conversationId);
    return { draft: this.#read(conversationId), lease: this.#leaseView(conversationId) };
  }

  claim(input: {
    conversationId: string;
    clientId: string;
    clientName: string;
    connectionId?: string;
    force?: boolean;
  }): { draft: CollabDraft; lease: CollabLease } {
    if (!this.#claimBucket.take(input.clientId)) throw rateLimited();
    this.#expireLease(input.conversationId);
    const now = this.#deps.clock.now();
    const existing = this.#leases.get(input.conversationId);
    const connectionId = input.connectionId ?? null;
    const sameClient = existing?.ownerClientId === input.clientId;
    if (existing !== undefined && !sameClient && input.force !== true) {
      throw new AppError('DRAFT_BUSY', '另一位用户正在编辑这个会话的草稿', {
        ownerClientId: existing.ownerClientId,
        ownerName: existing.ownerName,
        expiresAt: existing.expiresAt,
      });
    }
    const lease: Lease = {
      ownerClientId: input.clientId,
      ownerConnectionId: connectionId,
      ownerName: sanitizeClientName(input.clientName),
      expiresAt: now + COLLAB_DRAFT_LEASE_MS,
    };
    // 同一持有者同一连接的续期不广播；同设备另一个标签页 claim 会接管并广播，
    // 让旧标签页立即转只读。
    const changed =
      existing === undefined ||
      existing.ownerClientId !== lease.ownerClientId ||
      existing.ownerConnectionId !== lease.ownerConnectionId ||
      existing.ownerName !== lease.ownerName;
    this.#leases.set(input.conversationId, lease);
    if (changed) this.#publishOwner(input.conversationId, lease);
    return {
      draft: this.#read(input.conversationId),
      lease: this.#leaseView(input.conversationId)!,
    };
  }

  update(input: {
    conversationId: string;
    clientId: string;
    connectionId?: string;
    baseVersion: number;
    doc: unknown;
    mentions?: string[];
    replyTo?: string | null;
    attachments?: CollabDraftAttachment[];
  }): { version: number; updatedAt: number } {
    if (!this.#updateBucket.take(input.clientId)) throw rateLimited();
    this.#requireOwner(input.conversationId, input.clientId, input.connectionId);
    const current = this.#read(input.conversationId);
    if (input.baseVersion !== current.version) {
      throw new AppError('DRAFT_STALE', '草稿已被更新，请重新加载', {
        version: current.version,
      });
    }
    const doc = input.doc ?? EMPTY_DOC;
    const mentions = input.mentions ?? current.mentions;
    const attachments = input.attachments ?? current.attachments;
    const replyTo = input.replyTo !== undefined ? input.replyTo : current.replyTo;
    const payloadBytes = this.#validatePayload(doc, mentions, replyTo, attachments);
    const now = this.#deps.clock.now();
    const version = current.version + 1;
    try {
      this.#deps.db
        .prepare(
          `insert into composer_drafts
             (conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(conversation_id) do update set
             doc_json = excluded.doc_json,
             mentions_json = excluded.mentions_json,
             reply_to = excluded.reply_to,
             attachments_json = excluded.attachments_json,
             version = excluded.version,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.conversationId,
          JSON.stringify(doc),
          JSON.stringify(mentions),
          replyTo,
          JSON.stringify(attachments),
          version,
          now,
        );
    } catch (error) {
      if (isForeignKeyError(error)) {
        throw new AppError('NOT_FOUND', '会话不存在或已被删除');
      }
      throw error;
    }
    this.#renew(input.conversationId);
    this.#scheduleChanged(input.conversationId, payloadBytes);
    return { version, updatedAt: now };
  }

  release(input: { conversationId: string; clientId: string; connectionId?: string }): void {
    const lease = this.#leases.get(input.conversationId);
    if (lease === undefined || lease.ownerClientId !== input.clientId) return;
    if (
      input.connectionId !== undefined &&
      lease.ownerConnectionId !== null &&
      lease.ownerConnectionId !== input.connectionId
    ) {
      return;
    }
    this.#leases.delete(input.conversationId);
    this.#publishOwner(input.conversationId, null);
  }

  /** 连接断开：只释放该连接持有的草稿租约（同设备其他标签页不受影响）。 */
  releaseClientConnection(clientId: string, connectionId: string): void {
    for (const [conversationId, lease] of [...this.#leases]) {
      if (lease.ownerClientId !== clientId) continue;
      if (lease.ownerConnectionId !== null && lease.ownerConnectionId !== connectionId) continue;
      this.#leases.delete(conversationId);
      this.#publishOwner(conversationId, null);
    }
  }

  /** 端点整体掉线（配对设备）：释放该客户端的全部草稿租约。 */
  releaseClient(clientId: string): void {
    for (const [conversationId, lease] of [...this.#leases]) {
      if (lease.ownerClientId !== clientId) continue;
      this.#leases.delete(conversationId);
      this.#publishOwner(conversationId, null);
    }
  }

  send(input: {
    conversationId: string;
    clientId: string;
    connectionId?: string;
    baseVersion: number;
    text: string;
    mentions?: string[];
    replyTo?: string | null;
    attachmentIds?: string[];
    voiceMode?: boolean;
    /** D121：消息归属（渲染层显示「来自 X」）。 */
    client?: CollabClientRef;
  }): { message: Message; runId: string | null } {
    this.#requireOwner(input.conversationId, input.clientId, input.connectionId);
    const current = this.#read(input.conversationId);
    if (input.baseVersion !== current.version) {
      throw new AppError('DRAFT_STALE', '草稿已被更新，请重新加载', {
        version: current.version,
      });
    }
    // 草稿行在消息事务内删除（onPersisted）；路由失败会向外抛，但草稿不会
    // 留下「消息已落库、草稿还在」的重复发送状态。
    const result = this.#deps.sendMessage(
      input.conversationId,
      {
        text: input.text,
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.voiceMode === true ? { voiceMode: true } : {}),
        ...(input.client !== undefined ? { client: input.client } : {}),
      },
      () => this.#deleteRow(input.conversationId),
    );
    // 兜底：宿主实现可能没有调用回调（旧注入 / 测试假实现）。
    this.#deleteRow(input.conversationId);
    this.#leases.delete(input.conversationId);
    if (this.#flushTimer !== null) {
      this.#dirty.delete(input.conversationId);
      if (this.#dirty.size === 0) {
        clearTimeout(this.#flushTimer);
        this.#flushTimer = null;
      }
    }
    this.#deps.publish('collab.draftCleared', {
      conversationId: input.conversationId,
      byClientId: input.clientId,
    });
    this.#publishOwner(input.conversationId, null);
    return result;
  }

  /** 立即冲刷待广播的草稿快照（测试 / 关闭前）。 */
  flushNow(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#dirty.size === 0) return;
    const conversations = [...this.#dirty];
    this.#dirty.clear();
    for (const conversationId of conversations) {
      this.#deps.publish('collab.draftChanged', {
        conversationId,
        draft: this.#read(conversationId),
      });
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#leases.clear();
    this.#dirty.clear();
    this.#claimBucket.clear();
    this.#updateBucket.clear();
  }

  #read(conversationId: string): CollabDraft {
    const row = this.#deps.db
      .prepare(
        `select doc_json, mentions_json, reply_to, attachments_json, version, updated_at
           from composer_drafts where conversation_id = ?`,
      )
      .get(conversationId) as DraftRow | undefined;
    if (row === undefined) {
      return {
        conversationId,
        doc: EMPTY_DOC,
        mentions: [],
        replyTo: null,
        attachments: [],
        version: 0,
        updatedAt: 0,
      };
    }
    return {
      conversationId,
      doc: parseJson(row.doc_json, EMPTY_DOC),
      mentions: parseJson<string[]>(row.mentions_json, []),
      replyTo: row.reply_to,
      attachments: parseJson<CollabDraftAttachment[]>(row.attachments_json, []),
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  #requireOwner(conversationId: string, clientId: string, connectionId?: string): Lease {
    this.#expireLease(conversationId);
    const lease = this.#leases.get(conversationId);
    const ownerError = (): AppError =>
      new AppError(
        'DRAFT_NOT_OWNER',
        '你没有这个会话草稿的编辑权',
        lease === undefined
          ? undefined
          : {
              ownerClientId: lease.ownerClientId,
              ownerName: lease.ownerName,
              expiresAt: lease.expiresAt,
            },
      );
    if (lease === undefined || lease.ownerClientId !== clientId) throw ownerError();
    if (
      connectionId !== undefined &&
      lease.ownerConnectionId !== null &&
      lease.ownerConnectionId !== connectionId
    ) {
      throw ownerError();
    }
    return lease;
  }

  #renew(conversationId: string): void {
    const lease = this.#leases.get(conversationId);
    if (lease === undefined) return;
    lease.expiresAt = this.#deps.clock.now() + COLLAB_DRAFT_LEASE_MS;
  }

  #deleteRow(conversationId: string): void {
    this.#deps.db
      .prepare('delete from composer_drafts where conversation_id = ?')
      .run(conversationId);
  }

  #validatePayload(
    doc: unknown,
    mentions: readonly string[],
    replyTo: string | null,
    attachments: readonly CollabDraftAttachment[],
  ): number {
    validateDocShape(doc);
    if (mentions.some((mention) => mention.length > COLLAB_DRAFT_MENTION_MAX_CHARS)) {
      throw new AppError('INVALID_INPUT', '提及内容过长');
    }
    if (replyTo !== null && replyTo.length > COLLAB_DRAFT_REPLY_ID_MAX_CHARS) {
      throw new AppError('INVALID_INPUT', '引用消息 id 过长');
    }
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify({ doc, mentions, replyTo, attachments });
    } catch {
      throw new AppError('INVALID_INPUT', '草稿无法序列化');
    }
    const bytes = Buffer.byteLength(payloadJson, 'utf8');
    if (bytes > COLLAB_DRAFT_MAX_BYTES) {
      throw new AppError('INVALID_INPUT', '草稿过大');
    }
    return bytes;
  }

  #expireLease(conversationId: string): void {
    const lease = this.#leases.get(conversationId);
    if (lease === undefined) return;
    if (lease.expiresAt > this.#deps.clock.now()) return;
    this.#leases.delete(conversationId);
    this.#publishOwner(conversationId, null);
  }

  #sweepExpiredLeases(): void {
    if (this.#closed) return;
    const now = this.#deps.clock.now();
    for (const [conversationId, lease] of this.#leases) {
      if (lease.expiresAt > now) continue;
      this.#leases.delete(conversationId);
      this.#publishOwner(conversationId, null);
    }
  }

  #leaseView(conversationId: string): CollabLease | null {
    const lease = this.#leases.get(conversationId);
    if (lease === undefined) return null;
    return {
      ownerClientId: lease.ownerClientId,
      ownerConnectionId: lease.ownerConnectionId,
      ownerName: lease.ownerName,
      expiresAt: lease.expiresAt,
    };
  }

  #publishOwner(conversationId: string, lease: Lease | null): void {
    if (this.#closed) return;
    this.#deps.publish('collab.draftOwnerChanged', {
      conversationId,
      owner: lease === null ? null : { id: lease.ownerClientId, name: lease.ownerName },
      ownerConnectionId: lease?.ownerConnectionId ?? null,
      expiresAt: lease?.expiresAt ?? null,
    });
  }

  #scheduleChanged(conversationId: string, bytes: number): void {
    if (this.#closed) return;
    this.#dirty.add(conversationId);
    // 大草稿降低广播频率：>64KB → 1s，>128KB → 2s；延迟档位变化时重排定时器。
    const delay =
      bytes > COLLAB_DRAFT_HUGE_BYTES
        ? 2_000
        : bytes > COLLAB_DRAFT_LARGE_BYTES
          ? 1_000
          : COLLAB_DRAFT_BROADCAST_MIN_MS;
    if (this.#flushTimer !== null) {
      if (delay === this.#flushDelayMs) return;
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#flushDelayMs = delay;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flushNow();
    }, delay);
    this.#flushTimer.unref?.();
  }
}
