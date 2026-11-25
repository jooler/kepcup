import type { Conversation, ConversationCache, Message, MessageCache } from '@kepcup/shared';
import {
  connections,
  serverHashOf,
  teamSourceId,
  type SourceId,
} from '$lib/rpc/connections.svelte';
import {
  getTeamCacheStore,
  type TeamCachePartition,
  type TeamCacheStore,
} from './team-cache-store';

/**
 * T8 步骤 3（62.10 §2 同步协议）：团队来源的本地缓存同步引擎（渲染层）。
 *
 * - 连接建立（团队来源 status → connected）：`team.bootstrap` 全量 →
 *   `putConversations {replace:true}` 对账（删除 / 归档 / 移出由此收敛）+ 每会话
 *   增量补拉（`messages.list {afterSeq}` 补新、`{changedSince}` 补编辑 / 撤回 /
 *   卡片状态——C6）。
 * - 在线时团队 core 事件（message.created / message.updated / conversation.*）
 *   直写缓存。
 * - 损坏 / seq 越界（补拉首行 seq ≠ 游标+1，或服务端 lastSeq 回退）→ 该会话
 *   `putMessages {replace:true}` 重拉最近一页。
 * - 同步 cursor 持久化在 localStorage（键含 serverHash + memberId；本地簿记，
 *   62.10「不缓存光标」指实时态读状态，与此无关），清除分区时一并清除。
 * - 附件 cache-aside：getAttachment miss → `attachments.get`（经团队连接）→
 *   putAttachment；离线 / 缓存禁用时返回 null（UI 占位）。
 *
 * 休眠铁律：未配置团队服务器 / platform 方法缺失 → store 为 null，本引擎全部
 * 方法成为 no-op（不建目录 / 不建 IndexedDB 库 / 无事件）。safeStorage 不可用
 * （open 拒绝）→ 该服务器缓存整体禁用（写缓存跳过、读路径直连服务端），不做
 * 明文兜底。
 *
 * 桌面只打开当前登录成员的分区：分区键含 memberId，换账号（switchAccount）后
 * 下一次 connected 会先关掉旧成员的打开分区再开新分区（旧分区数据原样留存）。
 */

const PAGE_SIZE = 60;
/** 增量补拉页大小（core messages.list 上限 200）。 */
const INCREMENTAL_PAGE = 200;
/** 单会话单轮补拉页数上限（200×25 = 5000 条；超出留给下一轮重连继续）。 */
const MAX_INCREMENTAL_PAGES = 25;

interface SyncCursor {
  version: 1;
  /** 全局 changedSince 游标（UTC ms；0 = 首连尚未全量过）。 */
  lastSyncAt: number;
  /** 每会话 lastSeq（重连 afterSeq 补拉的基准）。 */
  lastSeqByConversation: Record<string, number>;
}

function cursorStorageKey(serverHash: string, memberId: string): string {
  return `kepcup.teamCache.cursor.${serverHash}.${memberId}`;
}

function loadCursor(serverHash: string, memberId: string): SyncCursor {
  const empty: SyncCursor = { version: 1, lastSyncAt: 0, lastSeqByConversation: {} };
  if (typeof localStorage === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(cursorStorageKey(serverHash, memberId));
    if (raw === null) return empty;
    const parsed = JSON.parse(raw) as Partial<SyncCursor>;
    if (parsed.version !== 1 || typeof parsed.lastSyncAt !== 'number' || parsed.lastSeqByConversation === null || typeof parsed.lastSeqByConversation !== 'object') {
      return empty;
    }
    return { version: 1, lastSyncAt: parsed.lastSyncAt, lastSeqByConversation: { ...parsed.lastSeqByConversation } };
  } catch {
    return empty;
  }
}

function saveCursor(serverHash: string, memberId: string, cursor: SyncCursor): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(cursorStorageKey(serverHash, memberId), JSON.stringify(cursor));
  } catch {
    // 配额满 / 隐私模式：游标丢失只影响增量（下轮重连按 0 重拉），不致命。
  }
}

function clearCursor(serverHash: string, memberId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(cursorStorageKey(serverHash, memberId));
  } catch {
    // 同上。
  }
}

function partitionKeyOf(partition: TeamCachePartition): string {
  return `${partition.serverHash}\n${partition.memberId}`;
}

export class TeamCacheSync {
  #store: TeamCacheStore | null = null;
  #storeResolved = false;
  /** 已打开的分区键（`serverHash\nmemberId`）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 引擎簿记集合，没有界面从它派生。
  readonly #opened = new Set<string>();
  /** 缓存被禁用的服务器（safeStorage 不可用 / open 失败；本会话内不再尝试）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 引擎簿记集合，没有界面从它派生。
  readonly #disabledServers = new Set<string>();
  /** 已接线的连接实例（按实例：断开重连会换新连接对象）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 接线台账，不是 UI 状态。
  readonly #wired = new Set<object>();
  readonly #unsubscribers: Array<() => void> = [];
  #started = false;

  /** 应用启动接线（chat.start 同一处调用；休眠：无团队来源时零副作用）。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(connections.onSourcesChanged(() => this.#wireSources()));
    this.#wireSources();
  }

  /** 测试 / teardown：解绑全部订阅（不清缓存数据）。 */
  stop(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers.length = 0;
    this.#wired.clear();
    this.#started = false;
  }

  // --- 读路径（chat-team / chat-session / 附件） ------------------------------

  /**
   * 缓存里的会话列表（离线水合 / 秒开水合的数据源）。缓存不可用（禁用 / 平台
   * 缺失 / 打不开）返回 null——调用方维持「未连接」占位或直连服务端。
   */
  async getConversationsFromCache(source: SourceId): Promise<ConversationCache[] | null> {
    const context = await this.#openForRead(source);
    if (context === null) return null;
    try {
      return await context.store.getConversations(context.partition);
    } catch (error) {
      this.#log('getConversations failed', error);
      return null;
    }
  }

  /**
   * 缓存里的会话消息页（升序；语义对齐 messages.list）。缓存不可用返回 null
   * （调用方走服务端）；命中但无行返回 []（调用方决定是否向服务端补）。
   */
  async getMessagesFromCache(
    source: SourceId,
    conversationId: string,
    options: { limit?: number; beforeSeq?: number } = {},
  ): Promise<MessageCache[] | null> {
    const context = await this.#openForRead(source);
    if (context === null) return null;
    try {
      return await context.store.getMessages(context.partition, conversationId, options);
    } catch (error) {
      this.#log('getMessages failed', error);
      return null;
    }
  }

  /** 打开团队会话的缓存快照（会话行 + 最近一页消息）；无行 / 无会话返回 null。 */
  async loadCachedSession(
    source: SourceId,
    conversationId: string,
  ): Promise<{ conversation: ConversationCache; messages: MessageCache[] } | null> {
    const conversations = await this.getConversationsFromCache(source);
    if (conversations === null) return null;
    const conversation = conversations.find((entry) => entry.id === conversationId);
    if (conversation === undefined) return null;
    const messages = await this.getMessagesFromCache(source, conversationId, { limit: PAGE_SIZE });
    if (messages === null || messages.length === 0) return null;
    return { conversation, messages };
  }

  /**
   * 读路径从服务端拉到的消息回写缓存（上滑分页 / 打开会话的在线路径共用）。
   * 失败静默（缓存是可丢弃的加速层）。
   */
  async rememberMessages(source: SourceId, conversationId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const context = await this.#openForWrite(source);
    if (context === null) return;
    try {
      await context.store.putMessages(context.partition, conversationId, messages, false);
      this.#advanceSeqCursor(context.partition, conversationId, messages);
    } catch (error) {
      this.#log('rememberMessages failed', error);
    }
  }

  /**
   * 附件 cache-aside（62.10 §1）：命中缓存直接返回 base64；未命中且在线时经
   * 团队连接 `attachments.get` 下载并回写。离线 / 缓存禁用 / 下载失败 → null
   * （UI 显示不可用占位）。
   */
  async attachmentBytesBase64(source: SourceId, attachmentId: string): Promise<string | null> {
    const context = await this.#openForRead(source);
    if (context !== null) {
      try {
        const cached = await context.store.getAttachment(context.partition, attachmentId);
        if ('bytesBase64' in cached) return cached.bytesBase64;
      } catch (error) {
        this.#log('getAttachment failed', error);
      }
    }
    // miss / 缓存禁用 → 服务端（离线时连接不通，自然失败）。
    const conn = connections.get(source);
    if (conn.status !== 'connected') return null;
    try {
      const result = (await conn.call('attachments.get', { id: attachmentId })) as {
        dataBase64?: string;
      };
      const bytes = typeof result.dataBase64 === 'string' ? result.dataBase64 : null;
      if (bytes === null) return null;
      if (context !== null) {
        try {
          await context.store.putAttachment(context.partition, attachmentId, bytes);
        } catch (error) {
          // 回写失败（配额 / 损坏）：本次仍可用，下次重下。
          this.#log('putAttachment failed', error);
        }
      }
      return bytes;
    } catch {
      return null;
    }
  }

  // --- 生命周期（设置卡 / 移除服务器） -----------------------------------------

  /** 设置「清除本地缓存」（当前成员分区 + 该分区的同步 cursor）。 */
  async clearCurrentPartition(source: SourceId): Promise<void> {
    const hash = serverHashOf(source);
    const memberId = hash === null ? null : connections.get(source).memberId;
    if (hash === null || memberId === null) return;
    const store = this.#resolveStore();
    if (store === null) return;
    const partition = { serverHash: hash, memberId };
    try {
      await store.clearPartition(partition);
    } catch (error) {
      this.#log('clearPartition failed', error);
    }
    this.#opened.delete(partitionKeyOf(partition));
    clearCursor(hash, memberId);
  }

  /** 移除服务器配置：清除该服务器全部分区（含附件与密钥文件）与 cursor。 */
  async clearServerPartitions(serverHash: string): Promise<void> {
    const store = this.#resolveStore();
    if (store === null) return;
    try {
      await store.clearServer(serverHash);
    } catch (error) {
      this.#log('clearServer failed', error);
    }
    for (const key of [...this.#opened]) {
      if (key.startsWith(`${serverHash}\n`)) this.#opened.delete(key);
    }
    if (typeof localStorage !== 'undefined') {
      // 各成员分区的 cursor 一并清（键前缀匹配）。
      const prefix = `kepcup.teamCache.cursor.${serverHash}.`;
      try {
        const doomed: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (key !== null && key.startsWith(prefix)) doomed.push(key);
        }
        for (const key of doomed) localStorage.removeItem(key);
      } catch {
        // localStorage 不可用（隐私模式）：cursor 本来就在内存，忽略。
      }
    }
  }

  /** 该来源此刻是否「离线只读」（团队来源未连接；本机来源恒 false）。 */
  isSourceOffline(source: SourceId): boolean {
    if (source === 'local') return false;
    return connections.get(source).status !== 'connected';
  }

  // --- 引擎内部 ---------------------------------------------------------------

  #resolveStore(): TeamCacheStore | null {
    if (!this.#storeResolved) {
      this.#storeResolved = true;
      this.#store = getTeamCacheStore();
    }
    return this.#store;
  }

  #log(message: string, error: unknown): void {
    // 渲染层允许 console.warn（错误不静默惯例）；缓存失败不 toast（可丢弃加速层）。
    console.warn(`[team-cache-sync] ${message}`, error);
  }

  async #openForRead(source: SourceId): Promise<{ store: TeamCacheStore; partition: TeamCachePartition } | null> {
    const partition = await this.#ensureOpen(source);
    const store = this.#resolveStore();
    if (partition === null || store === null) return null;
    return { store, partition };
  }

  async #openForWrite(source: SourceId): Promise<{ store: TeamCacheStore; partition: TeamCachePartition } | null> {
    // 写路径与读路径同一门：禁用（safeStorage / 平台缺失）时跳过写缓存。
    return this.#openForRead(source);
  }

  async #ensureOpen(source: SourceId): Promise<TeamCachePartition | null> {
    const hash = serverHashOf(source);
    if (hash === null) return null;
    if (this.#disabledServers.has(hash)) return null;
    const memberId = connections.get(source).memberId;
    if (memberId === null) return null;
    const store = this.#resolveStore();
    if (store === null) return null;
    const partition: TeamCachePartition = { serverHash: hash, memberId };
    const key = partitionKeyOf(partition);
    if (this.#opened.has(key)) return partition;
    // 换账号（同服务器不同成员）：先关掉旧成员的打开分区（数据保留）。
    await this.#closeStalePartitions(store, hash, memberId);
    try {
      await store.open(partition);
    } catch (error) {
      // safeStorage 不可用 / 分区无法建立：该服务器缓存整体禁用（不重试——
      // 重试会在每次同步时反复炸 open；下次启动重试）。
      this.#disabledServers.add(hash);
      this.#log(`partition open disabled cache for ${hash}`, error);
      return null;
    }
    this.#opened.add(key);
    return partition;
  }

  async #closeStalePartitions(store: TeamCacheStore, serverHash: string, memberId: string): Promise<void> {
    for (const key of [...this.#opened]) {
      const [hash, id] = key.split('\n');
      if (hash === serverHash && id !== memberId && id !== undefined) {
        this.#opened.delete(key);
        try {
          await store.close({ serverHash, memberId: id });
        } catch (error) {
          this.#log('close stale partition failed', error);
        }
      }
    }
  }

  #wireSources(): void {
    for (const source of connections.sources()) {
      const hash = serverHashOf(source);
      if (hash === null) continue;
      const conn = connections.get(source);
      if (this.#wired.has(conn)) continue;
      this.#wired.add(conn);
      this.#unsubscribers.push(conn.onConnected(() => void this.#syncConnected(hash)));
      this.#unsubscribers.push(
        conn.onEvent('message.created', (payload) => {
          const data = payload as { conversationId: string; message: Message };
          void this.#recordMessage(source, data.conversationId, data.message);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('message.updated', (payload) => {
          const data = payload as { conversationId: string; message: Message };
          void this.#recordMessage(source, data.conversationId, data.message);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('conversation.updated', (payload) => {
          const data = payload as { conversation: Conversation };
          void this.#recordConversation(source, data.conversation);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('conversation.deleted', (payload) => {
          const data = payload as { id: string };
          void this.#forgetConversation(source, data.id);
        }),
      );
      if (conn.status === 'connected') void this.#syncConnected(hash);
    }
  }

  /**
   * 连接建立（含重连）的全量对账：bootstrap 会话 replace + 每会话增量补拉 +
   * changedSince 变更收敛。失败静默（缓存保留旧快照，下次重连再收敛）。
   */
  async #syncConnected(serverHash: string): Promise<void> {
    const source = teamSourceId(serverHash);
    const conn = connections.get(source);
    const memberId = conn.memberId;
    if (memberId === null) return;
    const context = await this.#openForWrite(source);
    if (context === null) return;
    const { store, partition } = context;
    const cursor = loadCursor(serverHash, memberId);
    // changedSince 在循环外取快照：所有会话用同一基线，避免循环中途前移游标
    // 跳过后面会话的变更。
    const changedSince = cursor.lastSyncAt;
    let newestChangedAt = 0;
    try {
      const bootstrap = (await conn.callTeam('team.bootstrap')) as {
        conversations?: Conversation[];
      };
      const conversations = bootstrap.conversations ?? [];
      await store.putConversations(partition, conversations, true);
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 对账簿记集合（无界面从它派生）。
      const keep = new Set(conversations.map((entry) => entry.id));
      for (const conversation of conversations) {
        newestChangedAt = Math.max(
          newestChangedAt,
          await this.#pullConversation(conn, partition, conversation, cursor, changedSince),
        );
      }
      // 移出 / 删除 / 归档出清单的会话：行已由 replace 对账删除，cursor 收尾。
      for (const id of Object.keys(cursor.lastSeqByConversation)) {
        if (!keep.has(id)) delete cursor.lastSeqByConversation[id];
      }
      cursor.lastSyncAt = newestChangedAt > 0 ? newestChangedAt : Date.now();
      saveCursor(serverHash, memberId, cursor);
    } catch (error) {
      // 断线 / 未认证：缓存保留旧快照（onConnected 再收敛）。
      this.#log(`syncConnected failed for ${serverHash}`, error);
    }
  }

  /**
   * 单会话增量补拉。返回本会话观测到的最大 changedAt（用于推进全局游标；无
   * changedSince 拉取时 0）。
   */
  async #pullConversation(
    conn: ReturnType<typeof connections.get>,
    partition: TeamCachePartition,
    conversation: Conversation,
    cursor: SyncCursor,
    changedSince: number,
  ): Promise<number> {
    const store = this.#store!;
    const id = conversation.id;
    const cachedMax = cursor.lastSeqByConversation[id] ?? 0;
    // 服务端 lastSeq 回退（乱序 / 版本回退）：丢弃该会话缓存重拉（62.10 §6）。
    if (conversation.lastSeq < cachedMax) {
      await this.#resetConversation(conn, partition, conversation, cursor);
      return 0;
    }
    if (cachedMax > 0) {
      let after = cachedMax;
      for (let page = 0; page < MAX_INCREMENTAL_PAGES; page += 1) {
        const result = (await conn.call('messages.list', {
          conversationId: id,
          afterSeq: after,
          limit: INCREMENTAL_PAGE,
        })) as { messages?: Message[] };
        const rows = result.messages ?? [];
        if (rows.length === 0) break;
        if (rows[0]!.seq !== after + 1) {
          // seq 断档（缓存缺中间段）：整会话重置重拉（不重不漏的前提）。
          await this.#resetConversation(conn, partition, conversation, cursor);
          return 0;
        }
        await store.putMessages(partition, id, rows, false);
        after = rows.at(-1)!.seq;
        cursor.lastSeqByConversation[id] = after;
        if (rows.length < INCREMENTAL_PAGE) break;
      }
    } else {
      // 首屏只拉最近一页（T8 §2 的「按需」口径）：更早的历史由上滑分页按需补
      // （读路径 rememberMessages 回写），游标取 max(fetchedMax, lastSeq)——
      // afterSeq 补拉只关心比游标新的消息。
      const result = (await conn.call('messages.list', {
        conversationId: id,
        limit: PAGE_SIZE,
      })) as { messages?: Message[] };
      const rows = result.messages ?? [];
      await store.putMessages(partition, id, rows, false);
      const fetchedMax = rows.length > 0 ? rows.at(-1)!.seq : 0;
      cursor.lastSeqByConversation[id] = Math.max(fetchedMax, conversation.lastSeq);
    }
    if (changedSince <= 0) return 0;
    // 变更收敛分页（T8 审查修正）：单页拉取会在 >INCREMENTAL_PAGE 行改写（长时间
    // 离线后的批量编辑 / 撤回）时截断——余下行会被「已推进的 cursor」永久跳过。
    // 服务端 cursor = 批内 max coalesce(updatedAt, createdAt)，下一次查询为排他
    // `>`（严格推进）——按页循环到短页为止；页数上限同 afterSeq 补拉（超出留给
    // 下一轮重连）。
    let since = changedSince;
    let newest = 0;
    for (let page = 0; page < MAX_INCREMENTAL_PAGES; page += 1) {
      const result = (await conn.call('messages.list', {
        conversationId: id,
        changedSince: since,
        limit: INCREMENTAL_PAGE,
      })) as { messages?: Message[]; cursor?: number };
      const rows = result.messages ?? [];
      if (rows.length > 0) await store.putMessages(partition, id, rows, false);
      if (typeof result.cursor !== 'number' || result.cursor <= since) {
        // 空页（无 cursor）/ 异常游标：收敛结束。
        return Math.max(newest, typeof result.cursor === 'number' ? result.cursor : 0);
      }
      newest = Math.max(newest, result.cursor);
      since = result.cursor;
      if (rows.length < INCREMENTAL_PAGE) break;
    }
    return newest;
  }

  /** 损坏 / 越界的会话重置：清空重拉最近一页（putMessages replace:true）。 */
  async #resetConversation(
    conn: ReturnType<typeof connections.get>,
    partition: TeamCachePartition,
    conversation: Conversation,
    cursor: SyncCursor,
  ): Promise<void> {
    const store = this.#store!;
    const result = (await conn.call('messages.list', {
      conversationId: conversation.id,
      limit: PAGE_SIZE,
    })) as { messages?: Message[] };
    const rows = result.messages ?? [];
    await store.putMessages(partition, conversation.id, rows, true);
    const fetchedMax = rows.length > 0 ? rows.at(-1)!.seq : 0;
    cursor.lastSeqByConversation[conversation.id] = Math.max(fetchedMax, conversation.lastSeq);
  }

  /** 事件直写：消息（含编辑 / 撤回 / 卡片状态）upsert + 游标推进。 */
  async #recordMessage(source: SourceId, conversationId: string, message: Message): Promise<void> {
    const context = await this.#openForWrite(source);
    if (context === null) return;
    try {
      await context.store.putMessages(context.partition, conversationId, [message], false);
      this.#advanceSeqCursor(context.partition, conversationId, [message]);
    } catch (error) {
      this.#log('recordMessage failed', error);
    }
  }

  #advanceSeqCursor(partition: TeamCachePartition, conversationId: string, messages: Message[]): void {
    // 消息按 seq 单调：游标取直写批次的最大 seq（编辑不改 seq）。
    let maxSeq = 0;
    for (const message of messages) maxSeq = Math.max(maxSeq, message.seq);
    if (maxSeq <= 0) return;
    const cursor = loadCursor(partition.serverHash, partition.memberId);
    const prev = cursor.lastSeqByConversation[conversationId] ?? 0;
    if (maxSeq <= prev) return;
    cursor.lastSeqByConversation[conversationId] = maxSeq;
    saveCursor(partition.serverHash, partition.memberId, cursor);
  }

  /** 事件直写：会话行 upsert（replace=false；删除走 #forgetConversation）。 */
  async #recordConversation(source: SourceId, conversation: Conversation): Promise<void> {
    const context = await this.#openForWrite(source);
    if (context === null) return;
    try {
      await context.store.putConversations(context.partition, [conversation], false);
    } catch (error) {
      this.#log('recordConversation failed', error);
    }
  }

  /** 会话删除 / 移出（事件）：读-过滤-写回（putConversations replace:true 对账）。 */
  async #forgetConversation(source: SourceId, conversationId: string): Promise<void> {
    const context = await this.#openForWrite(source);
    if (context === null) return;
    const { store, partition } = context;
    try {
      const cached = await store.getConversations(partition);
      const next = cached.filter((entry) => entry.id !== conversationId);
      if (next.length === cached.length) return;
      await store.putConversations(partition, next, true);
    } catch (error) {
      this.#log('forgetConversation failed', error);
    }
  }
}

export const teamCacheSync = new TeamCacheSync();
