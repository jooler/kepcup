import type { Bot, Conversation, Message, Run, SetupRequirement } from '@kepcup/shared';
import { isArchivedConversation } from '@kepcup/shared';
import { memberPreviewsOf } from './member-preview';
import type { ComposerReplyRef } from '../features/chats/composer-draft-persist';
import { errorText, t } from '$lib/i18n';
import {
  connections,
  conversationRefOf,
  type ConversationRef,
  type SourceId,
} from '$lib/rpc/connections.svelte';
import { teamCacheSync } from '../features/team/cache-sync.svelte';
import { permissions } from '$lib/stores/permissions.svelte';
import { agentsStore } from '$lib/stores/agents.svelte';
import { sendGateRequirement } from '../features/chats/send-gate';
import {
  restoredFailedRun,
  showsFailure,
  supersedesFailure,
} from '../features/chats/setup-continue';
import { settingCardOf } from '../features/settings-card/setting-card-model';
import { tasks } from '$lib/stores/tasks.svelte';
import { activeRunsOf } from '../features/tasks/task-view';
import { botMessageMutesRun, isInterimMessage } from '../features/chats/run-status-mute';
import { settingsStore } from '$lib/stores/settings.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { isEphemeralApprovalCard } from '../features/approvals/ephemeral-approval';
import { toast } from 'svelte-sonner';
import {
  isVisibilityScopePending,
  messageVisibility,
  messageVisibilityScope,
  type DisplayMessage,
} from './message-visibility.svelte';
import { teamContext } from '../features/team/team-context.svelte';
import { composerDrafts } from '../features/chats/composer-drafts.svelte';
import { isPreviewableMessage, latestPreviewMessage } from '../features/chats/message-preview';
import { voiceMode } from '../features/chats/voice-mode.svelte';
import { speechAudio } from '../features/chats/speech-audio.svelte';

/**
 * One open conversation's view. The object is replaced on `open` / `clear`
 * and mutated in place for messages, runs, and members. Narrow routing
 * depends on that: it tracks the reference, not property updates.
 */
export interface ChatSessionView {
  conversation: ConversationView;
  messages: DisplayMessage[];
  activeRuns: ActiveRunView[];
  failedRun: Run | null;
  loadingEarlier: boolean;
  hasEarlier: boolean;
  members: ProjectMemberView[];
}

export interface ProjectMemberView {
  bot: Bot;
  joinedAt: number;
}

export type ConversationView = Conversation & {
  unreadCount?: number;
  runningBotIds?: string[];
  bot?: Bot | null;
};

export interface ActiveRunView {
  run: Run;
  progress: string;
  toolName: string;
  muted: boolean;
  at: number;
}

/** List-level updates a session cannot own (the sidebar lives on `chat`). */
export interface ChatSessionHost {
  syncReadCursor(source: SourceId, conversationId: string, lastReadSeq: number): void;
  syncMemberPreviews(source: SourceId, conversationId: string, members: ProjectMemberView[]): void;
  noteIncoming(source: SourceId, conversationId: string, message: Message): void;
  applyMessageVisibility(
    source: SourceId,
    conversationId: string,
    message: DisplayMessage,
    hidden: boolean,
    latestPreview: boolean,
  ): void;
  applyMessagePreview(source: SourceId, conversationId: string, preview: Message | null): void;
  applyRunning(source: SourceId, run: Run): void;
  applyBot(source: SourceId, bot: Bot): void;
  /**
   * Sidebar (and, for the main session, the open view). Return true when
   * this host already wrote the open view, so the session does not replace
   * that merged row with the raw event.
   */
  applyConversation(source: SourceId, conversation: Conversation): boolean;
}

export interface OpenSessionOptions {
  /**
   * After the row is resolved and before messages load. `chat.select` cancels
   * project compose and upserts the sidebar row here. Return `'stop'` to leave
   * the session untouched (a card id is opened on the board instead).
   */
  afterResolved?: (conversation: ConversationView) => void | 'stop';
  /**
   * After the view is installed and before mark-read. `chat.select` returns
   * to the chat surface here so a workbench-covered open does not mark read
   * until the conversation is actually on screen.
   */
  onReady?: (conversation: ConversationView) => void | Promise<void>;
  /**
   * When false, skip the mark-read at the end of `open`. A card dialog marks
   * read only while it is visible and the window is focused.
   */
  markOnOpen?: boolean;
}

const PAGE_SIZE = 60;

const noopHost: ChatSessionHost = {
  syncReadCursor: () => undefined,
  syncMemberPreviews: () => undefined,
  noteIncoming: () => undefined,
  applyMessageVisibility: () => undefined,
  applyMessagePreview: () => undefined,
  applyRunning: () => undefined,
  applyBot: () => undefined,
  applyConversation: () => false,
};

/** The connection a session currently talks to ('local' = the core singleton). */
type SessionRpc = ReturnType<typeof connections.get>;

/**
 * The current-conversation half of `chat`: messages, runs, members, reply,
 * and the events that belong to one conversation id. `main` is one long-lived
 * instance switched with `open`. A dialog constructs its own, `open`s the
 * card conversation, and `dispose`s it on close. Nothing in the app reads a
 * session other than `main` until the context helper lands.
 */
export class ChatSession {
  /**
   * Stable view object. Null when no conversation is open. Replaced only by
   * `open` and `clear`.
   */
  view = $state<ChatSessionView | null>(null);
  replyTo = $state<ComposerReplyRef | null>(null);
  highlightMessageId = $state<string | null>(null);
  /**
   * 待回填输入框的文本（消息撤回后把原文交回 Composer，Composer 消费即清）。
   * nonce 区分两次相同文本的撤回，保证 effect 一定重跑。
   */
  composerInsertion = $state<{ text: string; nonce: number } | null>(null);
  #composerNonce = 0;
  /** Send-gate setup card for this session. Not shared across instances. */
  pendingSetup = $state<{ requirement: SetupRequirement; fromVoice: boolean } | null>(null);

  #host: ChatSessionHost;
  /**
   * 本会话当前来源（T7 融合视图）：'local' 为既有行为；团队来源时本会话的
   * 全部 RPC 与事件都走该团队连接（`connections.get(source)`）。
   */
  #source: SourceId = 'local';
  /**
   * 本机事件订阅（永挂）：本机左栏的列表级更新（host 回调）只由本会话驱动，
   * 不能因打开团队会话而漏掉本机消息。团队来源的列表级更新由 chat.team 切片
   * 自己订阅（单一写方，避免重复计数）；本会话对团队事件只更新打开的视图。
   */
  #localUnsubscribers: Array<() => void> = [];
  #localSubscribed = false;
  /** 当前团队来源的视图级订阅（来源切换时重挂）。 */
  #teamSubscribedSource: SourceId | null = null;
  #teamUnsubscribers: Array<() => void> = [];
  #teamIdentityUnsubscribe: (() => void) | null = null;
  #identityUnsubscribe: (() => void) | null = null;
  #teamContextIdentityUnsubscribe: (() => void) | null = null;
  #resolvedVisibilityScope = messageVisibilityScope('local');
  #visibilityIdentityResolved = !isVisibilityScopePending(this.#resolvedVisibilityScope);
  #openGeneration = 0;
  // 普通 Set（刻意非响应式）：事件转发台账，没有界面从它派生。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #incomingListeners = new Set<(conversationId: string, message: Message) => void>();
  #disposed = false;
  /**
   * Foreground sessions update the right-panel grants list and may open the
   * main task page. A dialog session is not foreground.
   */
  #foreground: boolean;
  /** Failed-run banners closed in this instance. Survives `open` of another id. */
  // Plain Set: bookkeeping, not UI state.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #dismissedFailedRunIds = new Set<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #continuedSetupRunIds = new Set<string>();
  /** Conversation id currently counted in `tasks.retain`. */
  #heldConversationId: string | null = null;
  /**
   * Opens the task run page. The main session uses `tasks.openDetail`. A
   * dialog can replace this so the card does not take over the main view.
   */
  openTask = (taskId: string, trigger: HTMLElement | null = null): void => {
    // Keyed by this session's conversation so switching bots keeps the page:
    // `chat.select` calls `tasks.enterConversation` for the new one.
    tasks.openDetail(taskId, trigger, this.conversationId);
  };

  constructor(
    host: ChatSessionHost = noopHost,
    options: { attach?: boolean; foreground?: boolean } = {},
  ) {
    this.#host = host;
    // Only an explicit foreground session (the main chat) may replace the
    // right-panel grants list or the main task page. `new ChatSession()` is
    // a dialog and must not steal either.
    this.#foreground = options.foreground === true;
    if (!this.#foreground) this.openTask = () => undefined;
    if (options.attach !== false) this.start();
  }

  /**
   * Subscribe once per source. `chat.start` attaches `main`; dialogs attach here.
   * （本机订阅与旧版一样只在 start 落位——open 不再隐式订阅本机来源。）
   */
  start(): void {
    this.#identityUnsubscribe ??= connections.onSourcesChanged(() =>
      this.#handleVisibilityIdentityChange(),
    );
    this.#teamContextIdentityUnsubscribe ??= teamContext.onIdentityChanged(() =>
      this.#handleVisibilityIdentityChange(),
    );
    this.#ensureSubscribed();
  }

  /** 当前来源（'local' = 既有单例语义）。 */
  get source(): SourceId {
    return this.#source;
  }

  /** 当前来源的连接视图（调用 / 事件 / 身份）。 */
  #rpc(): SessionRpc {
    return connections.get(this.#source);
  }

  #withPreviewMetadata(
    conversation: ConversationView,
    messages: readonly Message[],
    hasEarlier: boolean,
  ): ConversationView {
    const latest = latestPreviewMessage(messages);
    if (latest !== null) return { ...conversation, lastPreviewSeq: latest.seq };
    return hasEarlier ? conversation : { ...conversation, lastPreviewSeq: undefined };
  }

  #reconcilePreview(
    source: SourceId,
    conversationId: string,
    messages: readonly Message[],
    knownPreviewSeq?: number,
  ): void {
    const latest = latestPreviewMessage(messages);
    const override = messageVisibility.previewOverride(source, conversationId);
    if (override !== null) {
      const sourceMessage = messages.find((message) => message.id === override.messageId);
      const stale =
        (knownPreviewSeq !== undefined && override.seq !== knownPreviewSeq) ||
        (sourceMessage !== undefined && !isPreviewableMessage(sourceMessage)) ||
        (latest !== null && latest.id !== override.messageId);
      if (stale) messageVisibility.setPreviewHidden(source, conversationId, false);
    }
    if (latest !== null) {
      const hidden = messageVisibility.isHidden(source, conversationId, latest.id);
      messageVisibility.setPreviewHidden(source, conversationId, hidden, latest.seq, latest.id);
    }
  }

  /**
   * 后台发送的归属解析：会话视图在当前来源上有记录就用它，否则视为本机
   * （弹层 session 的任务直注等路径只发本机会话）。
   */
  #sourceOfId(conversationId: string): SourceId {
    if (this.view?.conversation.id === conversationId) return this.#source;
    return 'local';
  }

  #ensureSubscribed(): void {
    if (this.#disposed) return;
    if (!this.#localSubscribed) {
      this.#localSubscribed = true;
      this.#subscribeSource('local');
    }
    if (this.#source === 'local') {
      if (this.#teamSubscribedSource !== null) {
        for (const unsubscribe of this.#teamUnsubscribers) unsubscribe();
        this.#teamUnsubscribers = [];
        this.#teamIdentityUnsubscribe?.();
        this.#teamIdentityUnsubscribe = null;
        this.#teamSubscribedSource = null;
      }
      return;
    }
    if (this.#teamSubscribedSource === this.#source) return;
    for (const unsubscribe of this.#teamUnsubscribers) unsubscribe();
    this.#teamUnsubscribers = [];
    this.#teamIdentityUnsubscribe?.();
    const source = this.#source;
    this.#teamIdentityUnsubscribe = connections
      .get(source)
      .onIdentityChanged(() => this.#handleVisibilityIdentityChange(source));
    this.#subscribeSource(source);
    this.#teamSubscribedSource = source;
  }

  get conversationId(): string | null {
    return this.view?.conversation.id ?? null;
  }

  get conversation(): ConversationView | null {
    return this.view?.conversation ?? null;
  }

  get messages(): DisplayMessage[] {
    return this.view?.messages ?? [];
  }

  get activeRuns(): ActiveRunView[] {
    return this.view?.activeRuns ?? [];
  }

  get failedRun(): Run | null {
    return this.view?.failedRun ?? null;
  }

  get hasEarlier(): boolean {
    return this.view?.hasEarlier ?? false;
  }

  get members(): ProjectMemberView[] {
    return this.view?.members ?? [];
  }

  get setupRequirement(): SetupRequirement | null {
    if (this.pendingSetup !== null) return this.pendingSetup.requirement;
    return this.view?.failedRun?.setup ?? null;
  }

  /**
   * Load half of opening a conversation. Returns false when the id is gone;
   * the previous view stays. Archived rows are restored first. Does not touch
   * navigation (shell, last-id, project compose, sparse interview).
   *
   * T7: 入参可为 `ConversationRef`（团队来源的会话经该来源的连接取数与收发）；
   * 字符串 id 保持本机来源语义（既有调用点与测试零改动）。
   */
  async open(
    idOrRef: string | ConversationRef,
    options: OpenSessionOptions = {},
  ): Promise<boolean> {
    if (this.#disposed) return false;
    const ref = conversationRefOf(idOrRef);
    const id = ref.id;
    const request = ++this.#openGeneration;
    const rpc = connections.get(ref.source);
    const isCurrent = (): boolean =>
      !this.#disposed && request === this.#openGeneration && this.#source === ref.source;
    this.#source = ref.source;
    this.#resolvedVisibilityScope = messageVisibilityScope(ref.source);
    this.#visibilityIdentityResolved = !isVisibilityScopePending(this.#resolvedVisibilityScope);
    // Team views subscribe on open; switching back to local also drops the old team listeners.
    if (ref.source !== 'local' || this.#teamSubscribedSource !== null) this.#ensureSubscribed();
    // T8 读路径（团队来源）：先渲染缓存（秒开 + 离线兜底），随后服务端路径在
    // 上面覆盖（在线时）；服务端不可达且缓存有快照 → 离线只读视图（跳过 runs /
    // markRead / permissions 等写与服务端取数）。卡片会话不走缓存（chat.select
    // 的 stop 语义在服务端路径里，先装视图会破坏导航）。
    const cached =
      ref.source !== 'local' ? await teamCacheSync.loadCachedSession(ref.source, id) : null;
    if (!isCurrent()) return false;
    if (cached !== null && cached.conversation.type !== 'card') {
      const messages = messageVisibility.applyMany(ref.source, id, cached.messages);
      const hasEarlier = cached.messages.length >= PAGE_SIZE;
      const conversation = this.#withPreviewMetadata(
        cached.conversation as ConversationView,
        messages,
        hasEarlier,
      );
      const latestPreview = latestPreviewMessage(messages);
      if (latestPreview !== null || !hasEarlier) {
        this.#reconcilePreview(ref.source, id, messages, conversation.lastPreviewSeq);
        if (latestPreview === null) {
          messageVisibility.setPreviewHidden(ref.source, id, false);
          this.#host.applyMessagePreview(ref.source, id, null);
        }
      }
      this.view = {
        conversation,
        messages,
        activeRuns: [],
        failedRun: null,
        loadingEarlier: false,
        hasEarlier,
        members: [],
      };
      this.replyTo = null;
      this.pendingSetup = null;
      this.composerInsertion = null;
    }
    if (
      ref.source !== 'local' &&
      cached !== null &&
      cached.conversation.type !== 'card' &&
      connections.get(ref.source).status !== 'connected'
    ) {
      // 离线只读：缓存快照就是本次打开的结果（不伪造在线数据）。afterResolved /
      // onReady 照常走（导航收尾与侧栏行 upsert 不依赖服务端）；markRead /
      // permissions / runs 等写与服务端取数全部跳过。
      options.afterResolved?.(cached.conversation as ConversationView);
      this.#holdConversation(id);
      await options.onReady?.(cached.conversation as ConversationView);
      return isCurrent();
    }
    const loaded = (await rpc.call('conversations.get', { id })) as {
      conversation: ConversationView | null;
    };
    if (!isCurrent() || !loaded.conversation) return false;
    let conversation = loaded.conversation;
    // Card rows are not in the sidebar. `chat.select` stops here, before any
    // message load or unarchive, and opens the board instead.
    if (conversation.type === 'card') {
      if (options.afterResolved?.(conversation) === 'stop') return false;
    } else if (
      this.#foreground &&
      this.#source === 'local' &&
      isArchivedConversation(conversation)
    ) {
      // 只有主对话会话把归档会话恢复进侧栏（与构造器的归属约束同理）。后台 /
      // 弹层 session 是纯取数——任务详情页的归属会话 session 打开用户归档的
      // 私聊时，静默 unarchive 会把它悄悄顶回左栏。归档会话照常可读。
      // 团队来源的归档恢复由团队层语义决定，P1 不在本机侧栏恢复。
      const restored = (await rpc.call('conversations.unarchive', { id })) as {
        conversation: ConversationView;
      };
      conversation = restored.conversation;
    }
    if (!isCurrent()) return false;
    if (conversation.type !== 'card') options.afterResolved?.(conversation);
    const loadedMessages = await this.#loadLatest(id, rpc);
    if (!isCurrent()) return false;
    if (ref.source !== 'local') {
      void teamCacheSync.rememberMessages(ref.source, id, loadedMessages);
    }
    const messages = messageVisibility.applyMany(ref.source, id, loadedMessages);
    const hasEarlier = messages.length >= PAGE_SIZE;
    conversation = this.#withPreviewMetadata(conversation, messages, hasEarlier);
    const latestPreview = latestPreviewMessage(messages);
    if (latestPreview !== null || !hasEarlier) {
      this.#reconcilePreview(ref.source, id, messages, conversation.lastPreviewSeq);
      if (latestPreview === null) {
        messageVisibility.setPreviewHidden(ref.source, id, false);
        this.#host.applyMessagePreview(ref.source, id, null);
      }
    }
    const runs = (await rpc.call('runs.list', { conversationId: id, limit: 30 })) as {
      runs: Run[];
    };
    const inFlight = (await rpc.call('runs.list', { conversationId: id, active: true })) as {
      runs: Run[];
    };
    if (!isCurrent()) return false;
    // Not awaited: select must not wait on the task list (same as today).
    // 团队来源的任务页是重型面板（DEV-142）：不拉本机任务列表。
    if (this.#source === 'local') void tasks.loadActive(id);
    const active = activeRunsOf(runs.runs, inFlight.runs, (run) => isActive(run.status));
    const failed = restoredFailedRun(runs.runs, this.#dismissedFailedRunIds);
    if (failed !== null) logFailedRun(failed);
    this.view = {
      conversation,
      messages,
      activeRuns: active.map((run) => ({
        run,
        progress: '',
        toolName: '',
        muted: botMessageMutesRun(messages, run.id),
        at: run.startedAt ?? run.createdAt,
      })),
      failedRun: failed,
      loadingEarlier: false,
      hasEarlier,
      members: [],
    };
    this.replyTo = null;
    this.pendingSetup = null;
    this.composerInsertion = null;
    this.#holdConversation(id);
    this.#recheckPendingLinkCards(messages);
    // Shell side effects (leave the workbench, close the task page) before
    // the project member fetch. Waiting on members used to keep the previous
    // surface up until that RPC returned.
    await options.onReady?.(conversation);
    if (!isCurrent()) return false;
    if (conversation.type === 'project') await this.reloadMembers();
    if (!isCurrent()) return false;
    if (options.markOnOpen !== false) await this.markRead();
    if (!isCurrent()) return false;
    await permissions.loadForConversation(id, {
      foreground: this.#foreground,
      ...(this.#source === 'local' ? {} : { source: this.#source }),
      call: (method: string, input?: unknown) => rpc.call(method, input),
    });
    return isCurrent();
  }

  /** Drop the view but keep the subscription. `main` uses this on close. */
  clear(): void {
    this.#openGeneration += 1;
    this.#releaseConversation();
    this.view = null;
    this.replyTo = null;
    this.highlightMessageId = null;
    this.composerInsertion = null;
    this.pendingSetup = null;
  }

  /** Unsubscribe. Later events for this instance are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#localUnsubscribers) unsubscribe();
    this.#localUnsubscribers = [];
    this.#localSubscribed = false;
    for (const unsubscribe of this.#teamUnsubscribers) unsubscribe();
    this.#teamUnsubscribers = [];
    this.#teamIdentityUnsubscribe?.();
    this.#teamIdentityUnsubscribe = null;
    this.#teamSubscribedSource = null;
    this.#identityUnsubscribe?.();
    this.#identityUnsubscribe = null;
    this.#teamContextIdentityUnsubscribe?.();
    this.#teamContextIdentityUnsubscribe = null;
    this.#incomingListeners.clear();
    this.clear();
  }

  /**
   * message.created 的轻量订阅口（docs/design/53-voice-conversation.md Bot 播报
   * 链路）：`#ingestMessage` 滤掉 interim / 临时审批卡之后透传（会话无关，订阅
   * 方自行按 conversationId 与自身口径过滤——语音播报还要过 isVisibleInTranscript）。
   * 返回取消函数。
   */
  onIncomingMessage(listener: (conversationId: string, message: Message) => void): () => void {
    this.#incomingListeners.add(listener);
    return () => {
      this.#incomingListeners.delete(listener);
    };
  }

  async send(
    conversationId: string,
    text: string,
    options: {
      mentions?: string[];
      replyTo?: string | null;
      attachmentIds?: string[];
      /** 语音对话模式发送（53 号修订 v2 V2-1）：core 记 content.origin='voice'。 */
      voiceMode?: boolean;
      /** D121：发这条消息的客户端（设备），UI 显示「来自 X」。 */
      client?: { id: string; name: string };
    } = {},
  ): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
    try {
      // 发送按会话归属选连接（发送是异步的——附件上传期间用户可能已切走；
      // 当前打开的就是它则用会话源，否则按视图归属解析）。团队来源的
      // client 标记（D121「来自 X」）用该来源自己的协作身份。
      const source =
        this.view?.conversation.id === conversationId
          ? this.#source
          : this.#sourceOfId(conversationId);
      const rpc = connections.get(source);
      const identity = source === 'local' ? null : rpc.clientIdentity;
      await rpc.call('messages.send', {
        conversationId,
        text,
        ...(options.mentions !== undefined && options.mentions.length > 0
          ? { mentions: options.mentions }
          : {}),
        ...(options.replyTo != null ? { replyTo: options.replyTo } : {}),
        ...(options.attachmentIds !== undefined && options.attachmentIds.length > 0
          ? { attachmentIds: options.attachmentIds }
          : {}),
        ...(options.voiceMode === true ? { voiceMode: true } : {}),
        ...(identity !== null
          ? { client: options.client ?? { id: identity.id, name: identity.name } }
          : {}),
        ...(identity === null && options.client !== undefined ? { client: options.client } : {}),
      });
      if (this.view?.conversation.id === conversationId) this.replyTo = null;
      return { ok: true };
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  }

  gateForSend(): boolean {
    const view = this.view;
    if (!view) return false;
    // 团队来源的模型 / Agent 配置在服务端域（本机设置卡不适用）：不做本机
    // 发送门禁，由团队服务器的结构化失败（run.setup）兜底出卡。
    if (this.#source !== 'local') return false;
    const bot = view.conversation.bot;
    if ((bot?.profile.runtime.agent.id ?? '').length > 0 && !agentsStore.loaded) {
      agentsStore.start();
      void agentsStore.refresh().catch(() => undefined);
    }
    const requirement = sendGateRequirement({
      conversationType: view.conversation.type,
      bot,
      settings: settingsStore.settings,
      agents: agentsStore,
    });
    if (requirement === null) return false;
    this.pendingSetup = { requirement, fromVoice: false };
    return true;
  }

  dismissSetupCard(): void {
    this.pendingSetup = null;
    const failed = this.view?.failedRun;
    if (failed?.setup) {
      this.dismissFailedRun(failed.id);
      this.#rpc()
        .call('runs.setupDismissed', { runId: failed.id })
        .catch(() => undefined);
    }
  }

  async continueAfterSetup(): Promise<void> {
    this.pendingSetup = null;
    const failed = this.view?.failedRun;
    if (failed?.setup) {
      this.dismissFailedRun(failed.id);
      if (!this.#continuedSetupRunIds.has(failed.id)) {
        this.#continuedSetupRunIds.add(failed.id);
        await this.retryRun(failed.id);
      }
    }
  }

  requestCapabilitySetup(
    capability: Extract<SetupRequirement, { kind: 'capability-model' }>['capability'],
  ): void {
    if (this.view === null) return;
    this.pendingSetup = { requirement: { kind: 'capability-model', capability }, fromVoice: true };
  }

  async markRead(): Promise<void> {
    const view = this.view;
    if (!view || view.conversation.readOnly) return;
    if (shell.workbenchShown) return;
    const lastSeq = view.messages.at(-1)?.seq;
    if (lastSeq === undefined || lastSeq <= view.conversation.lastReadSeq) return;
    const source = this.#source;
    await this.#rpc().call('conversations.markRead', {
      conversationId: view.conversation.id,
      seq: lastSeq,
    });
    if (this.view !== view || this.#source !== source) return;
    view.conversation = { ...view.conversation, lastReadSeq: lastSeq, unreadCount: 0 };
    this.#host.syncReadCursor(this.#source, view.conversation.id, lastSeq);
  }

  async loadEarlier(): Promise<void> {
    const view = this.view;
    if (!view || view.loadingEarlier || view.messages.length === 0) return;
    view.loadingEarlier = true;
    try {
      const oldestSeq = view.messages[0]?.seq ?? 1;
      // T8 读路径（团队来源）：先试缓存（离线可翻更早历史）；缓存无更早时在线
      // 向服务端补并把结果回写缓存，离线则止于缓存（hasEarlier=false）。
      if (this.#source !== 'local') {
        const cached = await teamCacheSync.getMessagesFromCache(
          this.#source,
          view.conversation.id,
          {
            beforeSeq: oldestSeq,
            limit: PAGE_SIZE,
          },
        );
        if (cached !== null) {
          if (cached.length > 0) {
            view.messages = [
              ...messageVisibility.applyMany(this.#source, view.conversation.id, cached),
              ...view.messages,
            ];
            view.hasEarlier = cached.length >= PAGE_SIZE;
            this.#recheckPendingLinkCards(cached);
          } else if (connections.get(this.#source).status === 'connected') {
            const fetched = await this.#fetchEarlierFromServer(view.conversation.id, oldestSeq);
            view.messages = [
              ...messageVisibility.applyMany(this.#source, view.conversation.id, fetched),
              ...view.messages,
            ];
            view.hasEarlier = fetched.length >= PAGE_SIZE;
            this.#recheckPendingLinkCards(fetched);
            void teamCacheSync.rememberMessages(this.#source, view.conversation.id, fetched);
          } else {
            view.hasEarlier = false;
          }
          return;
        }
        // 缓存禁用（null）：走既有服务端路径。
      }
      const result = (await this.#rpc().call('messages.list', {
        conversationId: view.conversation.id,
        beforeSeq: oldestSeq,
        limit: PAGE_SIZE,
      })) as { messages: Message[] };
      if (this.#source !== 'local') {
        void teamCacheSync.rememberMessages(this.#source, view.conversation.id, result.messages);
      }
      view.messages = [
        ...messageVisibility.applyMany(this.#source, view.conversation.id, result.messages),
        ...view.messages,
      ];
      view.hasEarlier = result.messages.length >= PAGE_SIZE;
      this.#recheckPendingLinkCards(result.messages);
    } finally {
      view.loadingEarlier = false;
    }
  }

  /** 服务端的更早一页（loadEarlier 的在线补拉路径；报错原样抛出）。 */
  async #fetchEarlierFromServer(conversationId: string, oldestSeq: number): Promise<Message[]> {
    const result = (await this.#rpc().call('messages.list', {
      conversationId,
      beforeSeq: oldestSeq,
      limit: PAGE_SIZE,
    })) as { messages: Message[] };
    return result.messages;
  }

  async retryRun(runId: string): Promise<void> {
    try {
      await this.#rpc().call('runs.retry', { runId });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  dismissFailedRun(runId: string): void {
    this.#dismissedFailedRunIds.add(runId);
    const view = this.view;
    if (view?.failedRun?.id === runId) view.failedRun = null;
    this.#rpc()
      .call('runs.dismissFailure', { runId })
      .catch((error: unknown) => {
        toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      });
  }

  async reloadMembers(): Promise<void> {
    const view = this.view;
    if (!view || view.conversation.type !== 'project') return;
    const source = this.#source;
    const result = (await this.#rpc().call('conversations.members', {
      conversationId: view.conversation.id,
    })) as { members: ProjectMemberView[] };
    if (this.view !== view || this.#source !== source) return;
    view.members = result.members;
    view.conversation = {
      ...view.conversation,
      memberPreviews: memberPreviewsOf(result.members),
    };
    this.#host.syncMemberPreviews(this.#source, view.conversation.id, result.members);
  }

  #handleVisibilityIdentityChange(changedSource?: SourceId): void {
    if (changedSource !== undefined && changedSource !== this.#source) return;
    const nextScope = messageVisibilityScope(this.#source);
    if (nextScope === this.#resolvedVisibilityScope) return;
    const wasResolved = this.#visibilityIdentityResolved;
    const resolved = !isVisibilityScopePending(nextScope);
    this.#resolvedVisibilityScope = nextScope;
    this.#visibilityIdentityResolved = resolved;
    if (!wasResolved && resolved) {
      this.refreshMessageVisibility();
      return;
    }
    voiceMode.exit();
    speechAudio.stop();
    this.clear();
  }

  /** Re-resolve hidden state after the active viewer/source identity changes. */
  refreshMessageVisibility(): void {
    const view = this.view;
    if (view === null) return;
    const source = this.#source;
    const conversationId = view.conversation.id;
    view.messages = messageVisibility.applyMany(source, conversationId, view.messages);
    for (const message of view.messages) {
      if (message.hidden !== true) continue;
      voiceMode.hideMessage(message.id);
      speechAudio.hideMessage(message.id);
    }
    const reply = this.replyTo;
    if (reply !== null && messageVisibility.isHidden(source, conversationId, reply.id)) {
      this.replyTo = null;
      composerDrafts.clearReply(conversationId, reply.id);
    }
    const latestPreview = latestPreviewMessage(view.messages);
    if (latestPreview === null && view.hasEarlier) return;
    if (latestPreview === null) {
      view.conversation = { ...view.conversation, lastPreviewSeq: undefined };
      messageVisibility.setPreviewHidden(source, conversationId, false);
      this.#host.applyMessagePreview(source, conversationId, null);
      return;
    }
    view.conversation = { ...view.conversation, lastPreviewSeq: latestPreview.seq };
    this.#reconcilePreview(source, conversationId, view.messages, latestPreview.seq);
    this.#host.applyMessagePreview(source, conversationId, latestPreview);
  }

  startReply(message: Message): void {
    if (messageVisibility.isHidden(this.#source, message.conversationId, message.id)) return;
    this.replyTo = {
      id: message.id,
      senderType: message.senderType,
      senderBotId: message.senderBotId,
      text: 'text' in message.content ? message.content.text : '',
      source: this.#source,
      ...(message.attachments.length > 0
        ? {
            attachments: message.attachments.map((attachment) => ({
              attachmentId: attachment.id,
              fileName: attachment.fileName,
              mime: attachment.mime,
              size: attachment.size,
            })),
          }
        : {}),
    };
  }

  /** Update the renderer-only hidden overlay and refresh its sidebar preview. */
  setMessageHidden(messageId: string, hidden: boolean): boolean {
    const view = this.view;
    if (view === null) return false;
    const message = view.messages.find((item) => item.id === messageId);
    if (message === undefined || message.senderType !== 'bot') return false;
    const source = this.#source;
    const conversationId = view.conversation.id;
    if (messageVisibility.isIdentityPending(source)) return false;
    messageVisibility.setHidden(source, conversationId, messageId, hidden);
    const updated: DisplayMessage = { ...message, hidden };
    view.messages = view.messages.map((item) => (item.id === messageId ? updated : item));
    const latestPreview = latestPreviewMessage(view.messages);
    if (latestPreview !== null) {
      view.conversation = {
        ...view.conversation,
        lastPreviewSeq: latestPreview.seq,
      };
    }
    const latest = latestPreview?.id === messageId;
    if (latest) {
      messageVisibility.setPreviewHidden(source, conversationId, hidden, message.seq, message.id);
    } else {
      this.#reconcilePreview(
        source,
        conversationId,
        view.messages,
        view.conversation.lastPreviewSeq,
      );
    }
    if (hidden) {
      voiceMode.hideMessage(messageId);
      speechAudio.hideMessage(messageId);
      if (this.replyTo?.id === messageId) this.replyTo = null;
      composerDrafts.clearReply(conversationId, messageId);
    }
    this.#host.applyMessageVisibility(source, conversationId, updated, hidden, latest);
    return true;
  }

  /** 请求把一段文本回填进输入框（撤回回填；Composer 消费后清空）。 */
  requestComposerInsert(text: string): void {
    this.composerInsertion = { text, nonce: (this.#composerNonce += 1) };
  }

  #holdConversation(id: string): void {
    // 任务页保留只对本机会话（tasks store 是本机域；团队来源的任务页按
    // DEV-142「在团队窗口打开」，且跨来源 id 可能与本机会话碰撞）。
    if (this.#source !== 'local') {
      this.#releaseConversation();
      return;
    }
    if (this.#heldConversationId === id) return;
    if (this.#heldConversationId !== null) tasks.release(this.#heldConversationId);
    tasks.retain(id);
    this.#heldConversationId = id;
  }

  #releaseConversation(): void {
    if (this.#heldConversationId === null) return;
    tasks.release(this.#heldConversationId);
    this.#heldConversationId = null;
  }

  /**
   * 在 `source` 上订阅事件。本机事件走完整流程（host 列表回调 + 视图）；
   * 团队事件只更新打开的视图（列表级更新归 chat.team 切片，单一写方）。
   */
  #subscribeSource(source: SourceId): void {
    const rpc = connections.get(source);
    const unsubs = source === 'local' ? this.#localUnsubscribers : this.#teamUnsubscribers;
    const listen = (event: string, handler: (payload: unknown) => void): void => {
      unsubs.push(rpc.onEvent(event, handler));
    };
    listen('message.created', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#ingestMessage(source, data.conversationId, data.message);
    });
    listen('message.updated', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#replaceMessage(source, data.message);
    });
    listen('run.status', (payload) => {
      const data = payload as { run: Run };
      this.#applyRun(source, data.run);
    });
    listen('run.progress', (payload) => {
      const data = payload as { runId: string; text?: string; toolName?: string };
      this.#applyProgress(source, data);
    });
    listen('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      this.#applyBot(source, data.bot);
    });
    listen('conversation.updated', (payload) => {
      const data = payload as { conversation: Conversation };
      this.#applyConversation(source, data.conversation);
    });
  }

  #ingestMessage(source: SourceId, conversationId: string, message: Message): void {
    if (this.#disposed) return;
    if (isInterimMessage(message) || isEphemeralApprovalCard(message)) return;
    const display = messageVisibility.apply(source, conversationId, message);
    const mutatesCurrentView = source === this.#source;
    const currentView = this.view;
    if (
      mutatesCurrentView &&
      currentView?.conversation.id === conversationId &&
      isPreviewableMessage(display) &&
      display.seq >= (currentView.conversation.lastPreviewSeq ?? 0)
    ) {
      currentView.conversation = { ...currentView.conversation, lastPreviewSeq: display.seq };
      messageVisibility.setPreviewHidden(
        source,
        conversationId,
        display.hidden === true,
        display.seq,
        display.id,
      );
    }
    if (source === 'local') this.#host.noteIncoming('local', conversationId, display);
    // 播报订阅口（53 号）：在 interim / 临时审批卡过滤之后、视图判重之前透传；
    // 本机事件恒透传（打开团队会话不丢本机播报链路），团队事件只在该来源
    // 是当前会话来源时透传。
    const forwardToListeners = source === 'local' || source === this.#source;
    // 只读会话（view 为空或别的会话）也照发——订阅方按需自筛。隐藏消息不进入
    // 语音等外部订阅链路，但仍照常入列表与未读状态。单个订阅方抛错只 warn。
    if (forwardToListeners && display.hidden !== true) {
      for (const listener of this.#incomingListeners) {
        try {
          listener(conversationId, display);
        } catch (error) {
          console.warn('[kepcup] incoming-message listener failed', {
            conversationId,
            messageId: display.id,
            error,
          });
        }
      }
    }
    const view = this.view;
    if (!mutatesCurrentView || !view || view.conversation.id !== conversationId) return;
    if (!view.messages.some((item) => item.id === display.id)) {
      view.messages = [...view.messages, display];
    }
    if (display.senderType === 'bot' && display.runId) {
      const entry = view.activeRuns.find((item) => item.run.id === display.runId);
      if (entry && !entry.muted) {
        entry.muted = true;
        view.activeRuns = [...view.activeRuns];
      }
    }
    if (display.senderType === 'user') void this.markRead();
  }

  #replaceMessage(source: SourceId, message: Message): void {
    if (this.#disposed || source !== this.#source) return;
    const view = this.view;
    if (!view || view.conversation.id !== message.conversationId) return;
    const display = messageVisibility.apply(source, message.conversationId, message);
    view.messages = view.messages.map((item) => (item.id === display.id ? display : item));
    const latestPreview = latestPreviewMessage(view.messages);
    if (latestPreview !== null) {
      view.conversation = {
        ...view.conversation,
        lastPreviewSeq: latestPreview.seq,
      };
      this.#reconcilePreview(
        source,
        display.conversationId,
        view.messages,
        latestPreview.seq,
      );
      this.#host.applyMessagePreview(source, display.conversationId, latestPreview);
    } else if (!view.hasEarlier) {
      view.conversation = { ...view.conversation, lastPreviewSeq: undefined };
      messageVisibility.setPreviewHidden(source, display.conversationId, false);
      this.#host.applyMessagePreview(source, display.conversationId, null);
    }
    this.#host.applyMessageVisibility(
      source,
      display.conversationId,
      display,
      display.hidden === true,
      latestPreview?.id === display.id,
    );
  }

  #applyRun(source: SourceId, run: Run): void {
    if (this.#disposed || run.conversationId === null) return;
    if (source === 'local') this.#host.applyRunning('local', run);
    if (source !== this.#source) return;
    const view = this.view;
    if (!view || view.conversation.id !== run.conversationId) return;
    if (isActive(run.status)) {
      const existing = view.activeRuns.find((item) => item.run.id === run.id);
      if (existing) {
        existing.run = run;
        view.activeRuns = [...view.activeRuns];
      } else {
        view.activeRuns = [
          ...view.activeRuns,
          { run, progress: '', toolName: '', muted: false, at: Date.now() },
        ];
      }
    } else {
      view.activeRuns = view.activeRuns.filter((item) => item.run.id !== run.id);
    }
    const failureHidden = run.failureDismissed === true || this.#dismissedFailedRunIds.has(run.id);
    const failed = run.status === 'failed' && showsFailure(run) && !failureHidden;
    if (failed && view.failedRun?.id !== run.id) {
      logFailedRun(run);
    }
    // 与打开会话时的恢复判定共用 supersedesFailure：只让更新的失败顶掉旧横幅
    // （项目组里较早创建、较晚结算的失败不能覆盖更新的）；同 Bot 更晚的对话轮
    // 完成后旧失败不再是当前状态，更新的失败已被关闭时也不让更早的冒出来。
    // 运行中 / 取消 / 中断的后续轮不算接手（旧消息仍未回答）。
    const replacesFailure =
      failed &&
      (view.failedRun === null ||
        view.failedRun.id === run.id ||
        run.createdAt >= view.failedRun.createdAt);
    if (replacesFailure) {
      view.failedRun = run;
    } else if (view.failedRun?.id === run.id) {
      view.failedRun = null;
    } else if (
      view.failedRun !== null &&
      run.createdAt > view.failedRun.createdAt &&
      supersedesFailure(view.failedRun, run, failureHidden)
    ) {
      view.failedRun = null;
    }
  }

  #applyProgress(
    source: SourceId,
    data: { runId: string; text?: string; toolName?: string },
  ): void {
    if (this.#disposed || source !== this.#source) return;
    const view = this.view;
    const entry = view?.activeRuns.find((item) => item.run.id === data.runId);
    if (!view || !entry) return;
    if (data.toolName !== undefined) {
      entry.toolName = data.toolName;
      entry.progress = '';
    }
    if (data.text !== undefined) entry.progress = data.text;
    entry.muted = false;
    entry.at = Date.now();
    view.activeRuns = [...view.activeRuns];
  }

  #applyBot(source: SourceId, bot: Bot): void {
    if (this.#disposed) return;
    if (source === 'local') this.#host.applyBot('local', bot);
    if (source !== this.#source) return;
    const view = this.view;
    if (!view) return;
    if (view.conversation.bot?.id === bot.id) {
      view.conversation = { ...view.conversation, bot };
    }
    if (view.members.some((member) => member.bot.id === bot.id)) {
      view.members = view.members.map((member) =>
        member.bot.id === bot.id ? { ...member, bot } : member,
      );
    }
  }

  #applyConversation(source: SourceId, conversation: Conversation): void {
    if (this.#disposed) return;
    const hostWroteView =
      source === 'local' ? this.#host.applyConversation('local', conversation) : false;
    if (source !== this.#source) return;
    const view = this.view;
    if (!view || view.conversation.id !== conversation.id) return;
    // The main host merges unread and running markers onto the open view.
    // Writing the raw event afterwards drops that merge.
    if (!hostWroteView) {
      view.conversation = {
        ...conversation,
        // conversation.updated payloads can omit preview metadata; keep the
        // view's known preview instead of dropping it on unrelated updates.
        lastPreviewSeq: conversation.lastPreviewSeq ?? view.conversation.lastPreviewSeq,
        ...(conversation.lastMessageText === undefined &&
        view.conversation.lastMessageText !== undefined
          ? { lastMessageText: view.conversation.lastMessageText }
          : {}),
        bot: conversation.bot ?? view.conversation.bot,
        memberPreviews: conversation.memberPreviews ?? view.conversation.memberPreviews,
      };
    }
    if (conversation.type === 'project') void this.reloadMembers();
  }

  async #loadLatest(conversationId: string, rpc: SessionRpc): Promise<Message[]> {
    const result = (await rpc.call('messages.list', {
      conversationId,
      limit: PAGE_SIZE,
    })) as { messages: Message[] };
    return result.messages;
  }

  #recheckPendingLinkCards(messages: readonly Message[]): void {
    for (const message of messages) {
      const setting = settingCardOf(message);
      if (setting === null || setting.state !== 'pending' || setting.mode !== 'link') continue;
      this.#rpc()
        .call('settings.cards.recheck', { messageId: message.id })
        .catch(() => undefined);
    }
  }
}

function logFailedRun(run: Run): void {
  if (!import.meta.env.DEV) return;
  console.warn('[kepcup] run failed', {
    runId: run.id,
    loopType: run.loopType,
    botId: run.botId,
    error: run.error,
    setup: run.setup,
  });
}

function isActive(status: Run['status']): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'waiting_approval' ||
    status === 'waiting_lease'
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}
