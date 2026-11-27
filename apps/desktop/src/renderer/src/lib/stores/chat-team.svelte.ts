import type { Bot, Conversation, Message, Run } from '@kepcup/shared';
import { messagePreviewText } from '@kepcup/shared';
import {
  connections,
  serverHashOf,
  teamSourceId,
  type ConversationRef,
  type SourceId,
} from '$lib/rpc/connections.svelte';
import { isInterimMessage } from '../features/chats/run-status-mute';
import { isEphemeralApprovalCard } from '../features/approvals/ephemeral-approval';
import { teamMessageArrival } from '../features/chats/unread';
import { notifyTeamMessage } from '$lib/features/team/team-notify';
import { teamCacheSync } from '../features/team/cache-sync.svelte';
import { permissions } from './permissions.svelte';
import type { ConversationView } from './chat-session.svelte';
import { messageVisibility } from './message-visibility.svelte';
import { t } from '$lib/i18n';
import { isPreviewableMessage, latestPreviewMessage } from '../features/chats/message-preview';
import { teamContext } from '../features/team/team-context.svelte';

/**
 * 聊天 store 的团队切片（T7 步骤 3，62.04 §7 多源化）：每个已融合团队来源
 * 一份独立的会话列表 / 未读 / 提及 / 最后消息预览。团队连接上的 core 事件与
 * 团队事件**只**更新本切片（id 碰撞隔离：同 id 的本机会话不受影响）。
 *
 * 本机列表（`chat.conversations`）与此并行——合并展示由侧栏的合并视图完成
 * （AppSidebar 团队分组，条目带「团队」徽标）。未融合 / 断开时切片为空数组，
 * 侧栏团队分组不渲染（休眠验收项）。
 */

export interface TeamConversationRow extends ConversationView {
  /** 未读的 @ 我提及数（`principal:<自己>`）；侧栏角标。 */
  mentionCount: number;
}

export interface TeamChatSlice {
  serverHash: string;
  conversations: TeamConversationRow[];
  lastMessageText: Record<string, string>;
}

export interface TeamChatsHost {
  /** 该团队会话此刻是否在用户眼前（主会话选中且工作台未盖住）。 */
  isViewing(source: SourceId, conversationId: string): boolean;
}

function rowOf(conversation: ConversationView): TeamConversationRow {
  return { ...conversation, mentionCount: 0 };
}

/**
 * 预览重读的窗口大小（messages.list 的 limit）。窗口被填满即视为「部分窗口」：
 * 更早的可预览行可能在窗口外，因此窗口内看不到可预览行时不能判定预览为空。
 */
const PREVIEW_WINDOW_LIMIT = 60;

class TeamChatsState {
  slices = $state<Record<string, TeamChatSlice>>({});
  #started = false;
  readonly #host: TeamChatsHost;
  /** 已接线的连接实例（按实例而非 serverHash：断开重连会换新连接对象）。 */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 接线台账（连接实例集合），不是 UI 状态。
  readonly #wired = new Set<object>();
  readonly #unsubscribers: Array<() => void> = [];
  /** Invalidates list/cache responses that started before an account switch. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Plain bookkeeping map, not UI state.
  readonly #sliceGenerations = new Map<string, number>();
  /** Serializes preview reconciliations so late edits cannot restore stale text. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Plain bookkeeping map, not UI state.
  readonly #previewGenerations = new Map<string, number>();
  /** Bumped by every preview writer; a slow re-read discards its stale result. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Plain bookkeeping map, not UI state.
  readonly #previewRevisions = new Map<string, number>();
  /** In-flight (microtask-coalesced) re-reads keyed by source + conversation. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Plain bookkeeping set, not UI state.
  readonly #scheduledPreviewRefreshes = new Set<string>();

  constructor(host: TeamChatsHost) {
    this.#host = host;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribers.push(connections.onSourcesChanged(() => this.#wireSources()));
    this.#unsubscribers.push(teamContext.onIdentityChanged(() => this.#wireSources()));
    this.#wireSources();
  }

  /** 某来源的切片（未融合 / 未建为空对象，UI 显示「未连接」占位）。 */
  sliceOf(serverHash: string): TeamChatSlice | null {
    return this.slices[serverHash] ?? null;
  }

  /** 按 (来源, id) 取团队会话行；本机来源不在本切片（返回 null）。 */
  conversationAt(ref: ConversationRef): TeamConversationRow | null {
    const hash = serverHashOf(ref.source);
    if (hash === null) return null;
    return this.slices[hash]?.conversations.find((row) => row.id === ref.id) ?? null;
  }

  /** 团队来源的会话读游标推进（主会话 markRead 后）：清未读与提及角标。 */
  syncReadCursor(source: SourceId, conversationId: string): void {
    const hash = serverHashOf(source);
    if (hash === null) return;
    const slice = this.slices[hash];
    if (!slice) return;
    slice.conversations = slice.conversations.map((row) =>
      row.id === conversationId ? { ...row, unreadCount: 0, mentionCount: 0 } : row,
    );
  }

  /** 打开 / 选中后的行刷新（open 拿到的会话视图写回切片）。 */
  upsertConversation(source: SourceId, conversation: ConversationView): void {
    const hash = serverHashOf(source);
    if (hash === null) return;
    const slice = this.ensureSlice(hash);
    const index = slice.conversations.findIndex((row) => row.id === conversation.id);
    if (index >= 0) {
      const existing = slice.conversations[index]!;
      slice.conversations[index] = {
        ...existing,
        ...conversation,
        // conversation.updated / open views can omit preview metadata; keep the
        // row's known preview instead of regressing the sidebar mask.
        lastPreviewSeq: conversation.lastPreviewSeq ?? existing.lastPreviewSeq,
        ...(conversation.lastMessageText === undefined && existing.lastMessageText !== undefined
          ? { lastMessageText: existing.lastMessageText }
          : {}),
        mentionCount: existing.mentionCount,
      };
    } else {
      slice.conversations = [rowOf(conversation), ...slice.conversations];
    }
  }

  /** 会话消失（删除 / 移出）：仅本切片。 */
  forgetConversation(source: SourceId, conversationId: string): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice) return;
    messageVisibility.forget(source, conversationId);
    slice.conversations = slice.conversations.filter((row) => row.id !== conversationId);
    const previews = { ...slice.lastMessageText };
    delete previews[conversationId];
    slice.lastMessageText = previews;
  }

  /** 团队消息到达：未读 / 预览 / 提及角标 + 免打扰感知的通知。 */
  noteIncoming(source: SourceId, conversationId: string, message: Message): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice) return;
    if (isInterimMessage(message) || isEphemeralApprovalCard(message)) return;
    const display = messageVisibility.apply(source, conversationId, message);
    const row = slice.conversations.find((entry) => entry.id === conversationId);
    const previewable = isPreviewableMessage(display);
    const latest = previewable && display.seq >= (row?.lastPreviewSeq ?? 0);
    if (latest) {
      this.#bumpPreviewRevision(source, conversationId);
      messageVisibility.setPreviewHidden(
        source,
        conversationId,
        display.hidden === true,
        display.seq,
        display.id,
      );
      const text = display.hidden === true ? t('messages.hidden') : messagePreviewText(display);
      if (text !== null && text.length > 0) {
        slice.lastMessageText = { ...slice.lastMessageText, [conversationId]: text };
      }
    }
    const viewing = this.#host.isViewing(source, conversationId);
    // 团队会话是多人类语境：senderType 'user' 不再「必是自己的回执」（本机
    // isSilentOnArrival 的单主体口径）——只静默自己的消息回声；工作台回执卡
    // 规则照搬（system_event + workbench origin，发送方必非 user）。判定与
    // 本机列表路径的团队会话共用一份（DEV-146，teamMessageArrival）。
    const verdict = teamMessageArrival(display, this.selfMemberId(source));
    const { silent } = verdict;
    const mentioned = display.hidden !== true && verdict.mentioned;
    slice.conversations = slice.conversations.map((row) =>
      row.id === conversationId
        ? {
            ...row,
            lastSeq: Math.max(row.lastSeq, display.seq),
            lastPreviewSeq:
              previewable && display.seq >= (row.lastPreviewSeq ?? 0)
                ? display.seq
                : row.lastPreviewSeq,
            lastMessageAt: display.createdAt,
            unreadCount: viewing || silent ? (row.unreadCount ?? 0) : (row.unreadCount ?? 0) + 1,
            mentionCount: viewing ? row.mentionCount : row.mentionCount + (mentioned ? 1 : 0),
          }
        : row,
    );
    // 唯一的主动提醒是被 @（team-notify：quietHours 在其内抑制）；普通消息只进
    // 未读 / 预览，不弹 toast。
    if (mentioned && !viewing && !silent) {
      const updatedRow = slice.conversations.find((entry) => entry.id === conversationId) ?? null;
      notifyTeamMessage(source, updatedRow, display);
    }
  }

  applyMessageVisibility(
    source: SourceId,
    conversationId: string,
    message: Message,
    hidden: boolean,
    latest: boolean,
  ): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice || !latest) return;
    this.#bumpPreviewRevision(source, conversationId);
    messageVisibility.setPreviewHidden(source, conversationId, hidden, message.seq, message.id);
    slice.conversations = slice.conversations.map((row) =>
      row.id === conversationId ? { ...row, lastPreviewSeq: message.seq } : row,
    );
    const text = hidden ? t('messages.hidden') : messagePreviewText(message);
    if (text !== null && text.length > 0) {
      slice.lastMessageText = { ...slice.lastMessageText, [conversationId]: text };
    }
  }

  applyMessagePreview(source: SourceId, conversationId: string, preview: Message | null): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice) return;
    this.#bumpPreviewRevision(source, conversationId);
    if (preview === null) {
      messageVisibility.setPreviewHidden(source, conversationId, false);
      slice.lastMessageText = { ...slice.lastMessageText, [conversationId]: '' };
      slice.conversations = slice.conversations.map((row) =>
        row.id === conversationId ? { ...row, lastPreviewSeq: undefined } : row,
      );
      return;
    }
    slice.conversations = slice.conversations.map((row) =>
      row.id === conversationId ? { ...row, lastPreviewSeq: preview.seq } : row,
    );
    const hidden = messageVisibility.isHidden(source, conversationId, preview.id);
    messageVisibility.setPreviewHidden(source, conversationId, hidden, preview.seq, preview.id);
    const text = hidden ? t('messages.hidden') : messagePreviewText(preview);
    if (text !== null && text.length > 0) {
      slice.lastMessageText = { ...slice.lastMessageText, [conversationId]: text };
    }
  }

  /** 预览写入的单调修订号：慢请求回来后据此丢弃已被后来的写入覆盖的结果。 */
  #bumpPreviewRevision(source: SourceId, conversationId: string): void {
    const key = `${source}::${conversationId}`;
    this.#previewRevisions.set(key, (this.#previewRevisions.get(key) ?? 0) + 1);
  }

  /** 已被更新的可预览行取代的隐藏预览遮罩：清掉，别遮住新预览。 */
  #clearStalePreviewOverride(
    source: SourceId,
    conversationId: string,
    lastPreviewSeq?: number,
  ): void {
    if (lastPreviewSeq === undefined) return;
    const override = messageVisibility.previewOverride(source, conversationId);
    if (override !== null && override.seq < lastPreviewSeq) {
      messageVisibility.setPreviewHidden(source, conversationId, false);
    }
  }

  /** 侧栏执行中标记（团队来源的 run 状态）。 */
  applyRunning(source: SourceId, run: Run): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice || run.conversationId === null) return;
    slice.conversations = slice.conversations.map((row) => {
      if (row.id !== run.conversationId) return row;
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 行内临时集合。
      const running = new Set(row.runningBotIds ?? []);
      const active =
        run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'waiting_approval' ||
        run.status === 'waiting_lease';
      if (active && run.botId) running.add(run.botId);
      else if (run.botId) running.delete(run.botId);
      return { ...row, runningBotIds: [...running] };
    });
  }

  selfMemberId(source: SourceId): string | null {
    return connections.get(source).memberId;
  }

  /**
   * 断线占位：先同步清空（不伪造在线数据的既有语义），再尝试由本地缓存水合
   * （T8 离线只读——列表由缓存提供；无缓存时维持空占位）。
   */
  markDisconnected(serverHash: string): void {
    this.#invalidateSlice(serverHash);
    const slice = this.slices[serverHash];
    if (slice) {
      slice.conversations = [];
      slice.lastMessageText = {};
    }
    void this.#hydrateFromCache(serverHash);
  }

  /**
   * 缓存水合（T8 步骤 4）：把分区里的会话镜像装进切片。已连接且在线数据已到位
   * 时不回退（避免异步水合竞态覆盖新鲜数据）；缓存不可用 / 为空时维持「未连接」
   * 占位（不伪造数据——既有行为）。
   */
  async #hydrateFromCache(serverHash: string): Promise<void> {
    const source = teamSourceId(serverHash);
    const generation = this.#sliceGenerations.get(serverHash) ?? 0;
    const memberId = connections.get(source).memberId;
    const cached = await teamCacheSync.getConversationsFromCache(source);
    if (!this.#isCurrentSlice(source, generation, memberId)) return;
    if (cached === null || cached.length === 0) {
      const stale = this.slices[serverHash];
      if (stale) {
        stale.conversations = [];
        stale.lastMessageText = {};
      }
      return;
    }
    // 已连接且列表已由服务端刷新：跳过（缓存只兜离线 / 首屏前的空档）。
    const existing = this.slices[serverHash];
    if (
      connections.get(source).status === 'connected' &&
      (existing?.conversations.length ?? 0) > 0
    ) {
      return;
    }
    const slice = this.ensureSlice(serverHash);
    slice.conversations = cached.map((conversation) => rowOf(conversation as ConversationView));
    const previews: Record<string, string> = {};
    for (const conversation of cached) {
      this.#clearStalePreviewOverride(source, conversation.id, conversation.lastPreviewSeq);
      if (messageVisibility.previewHidden(source, conversation.id, conversation.lastPreviewSeq)) {
        previews[conversation.id] = t('messages.hidden');
      } else if (
        conversation.lastMessageText !== undefined &&
        conversation.lastMessageText.length > 0
      ) {
        previews[conversation.id] = conversation.lastMessageText;
      }
    }
    slice.lastMessageText = previews;
  }

  #isCurrentSlice(source: SourceId, generation: number, memberId: string | null): boolean {
    const hash = serverHashOf(source);
    return (
      hash !== null &&
      generation === (this.#sliceGenerations.get(hash) ?? 0) &&
      connections.get(source).memberId === memberId
    );
  }

  #invalidateSlice(serverHash: string): void {
    this.#sliceGenerations.set(serverHash, (this.#sliceGenerations.get(serverHash) ?? 0) + 1);
    const slice = this.slices[serverHash];
    if (slice !== undefined) {
      slice.conversations = [];
      slice.lastMessageText = {};
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers.length = 0;
    this.#wired.clear();
    this.#sliceGenerations.clear();
    this.#previewGenerations.clear();
    this.#previewRevisions.clear();
    this.#scheduledPreviewRefreshes.clear();
    this.slices = {};
    this.#started = false;
  }

  private ensureSlice(serverHash: string): TeamChatSlice {
    let slice = this.slices[serverHash];
    if (!slice) {
      slice = { serverHash, conversations: [], lastMessageText: {} };
      this.slices = { ...this.slices, [serverHash]: slice };
    }
    return slice;
  }

  /** 新团队来源出现（或已存在但未接线）：订阅其事件流并首拉会话列表。 */
  #wireSources(): void {
    for (const source of connections.sources()) {
      const hash = serverHashOf(source);
      if (hash === null) continue;
      const conn = connections.get(source);
      if (this.#wired.has(conn)) continue;
      this.#wired.add(conn);
      // T8：先由缓存水合（秒出——打开侧栏即有历史），随后服务端刷新覆盖。
      void this.#hydrateFromCache(hash);
      this.#unsubscribers.push(conn.onConnected(() => void this.#refresh(hash)));
      this.#unsubscribers.push(
        conn.onIdentityChanged(() => {
          this.#invalidateSlice(hash);
          void this.#hydrateFromCache(hash);
          if (conn.status === 'connected') void this.#refresh(hash);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('conversation.updated', (payload) => {
          const data = payload as { conversation: Conversation };
          if (data.conversation.type === 'card' || data.conversation.type === 'bot_direct') return;
          this.upsertConversation(source, data.conversation as ConversationView);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('conversation.deleted', (payload) => {
          const data = payload as { id: string };
          this.forgetConversation(source, data.id);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('message.created', (payload) => {
          const data = payload as { conversationId: string; message: Message };
          this.noteIncoming(source, data.conversationId, data.message);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('message.updated', (payload) => {
          const data = payload as { conversationId: string; message: Message };
          const message = messageVisibility.apply(source, data.conversationId, data.message);
          const row = this.slices[hash]?.conversations.find(
            (entry) => entry.id === data.conversationId,
          );
          const previewable = isPreviewableMessage(message);
          const previewSeq = row?.lastPreviewSeq ?? 0;
          const override = messageVisibility.previewOverride(source, data.conversationId);
          const wasPreviewRow = message.seq === previewSeq || override?.messageId === message.id;
          const latest = previewable && message.seq >= previewSeq;
          if (latest) {
            this.applyMessageVisibility(
              source,
              data.conversationId,
              message,
              message.hidden === true,
              true,
            );
          }
          // Only a row that owned the preview can change it: a still-previewable
          // edit is applied above; a row that stopped being previewable (recall,
          // blank edit) needs the window re-read to fall back. Unrelated system /
          // card updates cost no RPC. #refreshPreview alone decides whether "no
          // previewable row" may clear the preview, so a failed or partial fetch
          // never drops a fail-closed hidden-preview mask.
          if (!previewable && wasPreviewRow) {
            this.#schedulePreviewRefresh(source, data.conversationId, conn);
          }
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('run.status', (payload) => {
          const data = payload as { run: Run };
          this.applyRunning(source, data.run);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('bot.updated', (payload) => {
          const data = payload as { bot: Bot };
          this.#applyBot(source, data.bot);
        }),
      );
      this.#unsubscribers.push(
        conn.onEvent('bot.deleted', (payload) => {
          const data = payload as { id: string };
          const slice = this.slices[hash];
          if (!slice) return;
          slice.conversations = slice.conversations.filter((row) => row.directBotId !== data.id);
        }),
      );
      // 审批 / 授权事件转发进 permissions store（按来源标记，decide 走团队连接）。
      for (const event of [
        'approval.created',
        'approval.resolved',
        'grant.changed',
        'permissions.mode.changed',
      ] as const) {
        this.#unsubscribers.push(
          conn.onEvent(event, (payload) => {
            permissions.ingestSourceEvent(source, event, payload);
          }),
        );
      }
      if (conn.status === 'connected') void this.#refresh(hash);
    }
    // 已移除的服务器：丢切片。
    for (const hash of Object.keys(this.slices)) {
      if (serverHashOf(teamSourceId(hash)) === null) continue;
      if (!connections.sources().includes(teamSourceId(hash))) {
        this.#invalidateSlice(hash);
        const next = { ...this.slices };
        delete next[hash];
        this.slices = next;
      }
    }
  }

  /**
   * Re-read the preview window for one conversation. A preview writer bumping the
   * revision while the RPC is in flight makes the response stale (a newer
   * message.created / hide already set the preview), so the response is dropped.
   */
  async #refreshPreview(
    source: SourceId,
    conversationId: string,
    conn: ReturnType<typeof connections.get>,
  ): Promise<void> {
    const hash = serverHashOf(source);
    if (hash === null) return;
    const key = `${source}::${conversationId}`;
    const request = (this.#previewGenerations.get(key) ?? 0) + 1;
    this.#previewGenerations.set(key, request);
    const revision = this.#previewRevisions.get(key) ?? 0;
    const startSeq =
      this.slices[hash]?.conversations.find((entry) => entry.id === conversationId)
        ?.lastPreviewSeq ?? 0;
    const generation = this.#sliceGenerations.get(hash) ?? 0;
    const memberId = conn.memberId;
    try {
      const result = (await conn.call('messages.list', {
        conversationId,
        limit: PREVIEW_WINDOW_LIMIT,
      })) as { messages: Message[] };
      if (
        request !== this.#previewGenerations.get(key) ||
        revision !== (this.#previewRevisions.get(key) ?? 0) ||
        !this.#isCurrentSlice(source, generation, memberId) ||
        connections.get(source) !== conn
      ) {
        return;
      }
      const latest = latestPreviewMessage(
        messageVisibility.applyMany(source, conversationId, result.messages),
      );
      // A full window that holds no previewable row is only a partial view: an
      // earlier previewable row may sit outside it. Clearing here would drop a
      // fail-closed hidden-preview mask for a conversation whose newest rows are
      // all system events / recalled rows. Keep the existing preview override
      // and row metadata; only a complete window makes null authoritative.
      if (latest === null && result.messages.length >= PREVIEW_WINDOW_LIMIT) return;
      // Never move the preview backwards behind a row that became newer while
      // this request was in flight. (A recall legitimately falls back to an
      // earlier preview, so compare against what the row looked like at start.)
      const row = this.slices[hash]?.conversations.find((entry) => entry.id === conversationId);
      const currentSeq = row?.lastPreviewSeq ?? 0;
      if (latest !== null && latest.seq < currentSeq && currentSeq > startSeq) return;
      this.applyMessagePreview(source, conversationId, latest);
    } catch {
      // A failed re-read is not authoritative either: keep the existing preview
      // (possibly a hidden-preview mask) instead of clearing it.
    }
  }

  /**
   * Coalesce the per-conversation re-read within a microtask: a burst of
   * message.updated events (recall + edit, card updates) causes one RPC, not one
   * per row. The revision guard still discards a response superseded by a newer
   * preview writer.
   */
  #schedulePreviewRefresh(
    source: SourceId,
    conversationId: string,
    conn: ReturnType<typeof connections.get>,
  ): void {
    const key = `${source}::${conversationId}`;
    if (this.#scheduledPreviewRefreshes.has(key)) return;
    this.#scheduledPreviewRefreshes.add(key);
    queueMicrotask(() => {
      this.#scheduledPreviewRefreshes.delete(key);
      void this.#refreshPreview(source, conversationId, conn);
    });
  }

  async #refresh(serverHash: string): Promise<void> {
    const source = teamSourceId(serverHash);
    const conn = connections.get(source);
    const generation = this.#sliceGenerations.get(serverHash) ?? 0;
    const memberId = conn.memberId;
    try {
      const result = (await conn.call('conversations.list')) as {
        conversations: ConversationView[];
      };
      if (
        generation !== (this.#sliceGenerations.get(serverHash) ?? 0) ||
        conn.memberId !== memberId ||
        connections.get(source) !== conn
      ) {
        return;
      }
      const slice = this.ensureSlice(serverHash);
      // 与本机左栏同口径：已删除 Bot 的占位直聊、卡片 / bot_direct 不列。
      const rows = result.conversations
        .filter(
          (conversation) =>
            conversation.type !== 'card' &&
            conversation.type !== 'bot_direct' &&
            !(
              conversation.type === 'direct' &&
              (conversation.bot == null || conversation.bot.status === 'deleted')
            ),
        )
        .map((conversation) => {
          const existing = slice.conversations.find((row) => row.id === conversation.id);
          const row = rowOf(conversation);
          return existing !== undefined
            ? {
                ...row,
                unreadCount: conversation.unreadCount ?? existing.unreadCount,
                mentionCount: existing.mentionCount,
              }
            : row;
        });
      slice.conversations = rows;
      const previews: Record<string, string> = {};
      for (const conversation of result.conversations) {
        this.#clearStalePreviewOverride(source, conversation.id, conversation.lastPreviewSeq);
        if (messageVisibility.previewHidden(source, conversation.id, conversation.lastPreviewSeq)) {
          previews[conversation.id] = t('messages.hidden');
        } else if (conversation.lastMessageText !== undefined) {
          previews[conversation.id] = conversation.lastMessageText;
        }
      }
      slice.lastMessageText = previews;
    } catch {
      // 断开 / 未认证：缓存水合（T8 离线只读），无缓存时保留「未连接」空占位。
      if (
        generation === (this.#sliceGenerations.get(serverHash) ?? 0) &&
        conn.memberId === memberId &&
        connections.get(source) === conn
      ) {
        await this.#hydrateFromCache(serverHash);
      }
    }
  }

  #applyBot(source: SourceId, bot: Bot): void {
    const hash = serverHashOf(source);
    const slice = hash === null ? null : this.slices[hash];
    if (!slice) return;
    slice.conversations = slice.conversations.map((row) =>
      row.bot?.id === bot.id ? { ...row, bot } : row,
    );
  }
}

export { TeamChatsState };
