import type { Bot, Conversation, Message, Run, SetupRequirement } from '@kepcup/shared';
import { PROJECT_MEMBER_PREVIEW_MAX, isArchivedConversation } from '@kepcup/shared';
import type { ComposerReplyRef } from '../features/chats/composer-draft-persist';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { permissions } from '$lib/stores/permissions.svelte';
import { agentsStore } from '$lib/stores/agents.svelte';
import { sendGateRequirement } from '../features/chats/send-gate';
import { restoredFailedRun, showsFailure } from '../features/chats/setup-continue';
import { settingCardOf } from '../features/settings-card/setting-card-model';
import { tasks } from '$lib/stores/tasks.svelte';
import { activeRunsOf } from '../features/tasks/task-view';
import { botMessageMutesRun, isInterimMessage } from '../features/chats/run-status-mute';
import { settingsStore } from '$lib/stores/settings.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { isEphemeralApprovalCard } from '../features/approvals/ephemeral-approval';
import { toast } from 'svelte-sonner';

/**
 * One open conversation's view. The object is replaced on `open` / `clear`
 * and mutated in place for messages, runs, and members. Narrow routing
 * depends on that: it tracks the reference, not property updates.
 */
export interface ChatSessionView {
  conversation: ConversationView;
  messages: Message[];
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
  syncReadCursor(conversationId: string, lastReadSeq: number): void;
  syncMemberPreviews(conversationId: string, members: ProjectMemberView[]): void;
  noteIncoming(conversationId: string, message: Message): void;
  applyRunning(run: Run): void;
  applyBot(bot: Bot): void;
  /**
   * Sidebar (and, for the main session, the open view). Return true when
   * this host already wrote the open view, so the session does not replace
   * that merged row with the raw event.
   */
  applyConversation(conversation: Conversation): boolean;
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
  applyRunning: () => undefined,
  applyBot: () => undefined,
  applyConversation: () => false,
};

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
  /** Send-gate setup card for this session. Not shared across instances. */
  pendingSetup = $state<{ requirement: SetupRequirement; fromVoice: boolean } | null>(null);

  #host: ChatSessionHost;
  #unsubscribers: Array<() => void> = [];
  #disposed = false;
  /**
   * Foreground sessions update the right-panel grants list and may open the
   * main task page. A dialog session is not foreground.
   */
  #foreground: boolean;
  /** Failed-run banners closed in this instance. Survives `open` of another id. */
  #dismissedFailedRunIds = new Set<string>();
  #continuedSetupRunIds = new Set<string>();
  /** Conversation id currently counted in `tasks.retain`. */
  #heldConversationId: string | null = null;
  /**
   * Opens the task run page. The main session uses `tasks.openDetail`. A
   * dialog can replace this so the card does not take over the main view.
   */
  openTask = (taskId: string, trigger: HTMLElement | null = null): void => {
    tasks.openDetail(taskId, trigger);
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

  /** Subscribe once. `chat.start` attaches `main`; other instances attach here. */
  start(): void {
    if (this.#unsubscribers.length > 0 || this.#disposed) return;
    this.#subscribe();
  }

  get conversationId(): string | null {
    return this.view?.conversation.id ?? null;
  }

  get conversation(): ConversationView | null {
    return this.view?.conversation ?? null;
  }

  get messages(): Message[] {
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
   */
  async open(id: string, options: OpenSessionOptions = {}): Promise<boolean> {
    if (this.#disposed) return false;
    const loaded = (await core.call('conversations.get', { id })) as {
      conversation: ConversationView | null;
    };
    if (!loaded.conversation) return false;
    let conversation = loaded.conversation;
    // Card rows are not in the sidebar. `chat.select` stops here, before any
    // message load or unarchive, and opens the board instead.
    if (conversation.type === 'card') {
      if (options.afterResolved?.(conversation) === 'stop') return false;
    } else if (isArchivedConversation(conversation)) {
      const restored = (await core.call('conversations.unarchive', { id })) as {
        conversation: ConversationView;
      };
      conversation = restored.conversation;
    }
    if (conversation.type !== 'card') options.afterResolved?.(conversation);
    const messages = await this.#loadLatest(id);
    const runs = (await core.call('runs.list', { conversationId: id, limit: 30 })) as {
      runs: Run[];
    };
    const inFlight = (await core.call('runs.list', { conversationId: id, active: true })) as {
      runs: Run[];
    };
    // Not awaited: select must not wait on the task list (same as today).
    void tasks.loadActive(id);
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
      hasEarlier: messages.length >= PAGE_SIZE,
      members: [],
    };
    this.replyTo = null;
    this.pendingSetup = null;
    this.#holdConversation(id);
    this.#recheckPendingLinkCards(messages);
    // Shell side effects (leave the workbench, close the task page) before
    // the project member fetch. Waiting on members used to keep the previous
    // surface up until that RPC returned.
    await options.onReady?.(conversation);
    if (conversation.type === 'project') await this.reloadMembers();
    if (options.markOnOpen !== false) await this.markRead();
    await permissions.loadForConversation(id, { foreground: this.#foreground });
    return true;
  }

  /** Drop the view but keep the subscription. `main` uses this on close. */
  clear(): void {
    this.#releaseConversation();
    this.view = null;
    this.replyTo = null;
    this.highlightMessageId = null;
    this.pendingSetup = null;
  }

  /** Unsubscribe. Later events for this instance are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.clear();
  }

  async send(
    conversationId: string,
    text: string,
    options: { mentions?: string[]; replyTo?: string | null; attachmentIds?: string[] } = {},
  ): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
    try {
      await core.call('messages.send', {
        conversationId,
        text,
        ...(options.mentions !== undefined && options.mentions.length > 0
          ? { mentions: options.mentions }
          : {}),
        ...(options.replyTo != null ? { replyTo: options.replyTo } : {}),
        ...(options.attachmentIds !== undefined && options.attachmentIds.length > 0
          ? { attachmentIds: options.attachmentIds }
          : {}),
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
      core.call('runs.setupDismissed', { runId: failed.id }).catch(() => undefined);
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
    await core.call('conversations.markRead', {
      conversationId: view.conversation.id,
      seq: lastSeq,
    });
    view.conversation = { ...view.conversation, lastReadSeq: lastSeq, unreadCount: 0 };
    this.#host.syncReadCursor(view.conversation.id, lastSeq);
  }

  async loadEarlier(): Promise<void> {
    const view = this.view;
    if (!view || view.loadingEarlier || view.messages.length === 0) return;
    view.loadingEarlier = true;
    try {
      const oldestSeq = view.messages[0]?.seq ?? 1;
      const result = (await core.call('messages.list', {
        conversationId: view.conversation.id,
        beforeSeq: oldestSeq,
        limit: PAGE_SIZE,
      })) as { messages: Message[] };
      view.messages = [...result.messages, ...view.messages];
      view.hasEarlier = result.messages.length >= PAGE_SIZE;
      this.#recheckPendingLinkCards(result.messages);
    } finally {
      view.loadingEarlier = false;
    }
  }

  async retryRun(runId: string): Promise<void> {
    try {
      await core.call('runs.retry', { runId });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  dismissFailedRun(runId: string): void {
    this.#dismissedFailedRunIds.add(runId);
    const view = this.view;
    if (view?.failedRun?.id === runId) view.failedRun = null;
    core.call('runs.dismissFailure', { runId }).catch((error: unknown) => {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    });
  }

  async reloadMembers(): Promise<void> {
    const view = this.view;
    if (!view || view.conversation.type !== 'project') return;
    const result = (await core.call('conversations.members', {
      conversationId: view.conversation.id,
    })) as { members: ProjectMemberView[] };
    view.members = result.members;
    view.conversation = {
      ...view.conversation,
      memberPreviews: result.members.slice(0, PROJECT_MEMBER_PREVIEW_MAX).map((member) => ({
        id: member.bot.id,
        name: member.bot.name,
        avatar: member.bot.avatar,
      })),
    };
    this.#host.syncMemberPreviews(view.conversation.id, result.members);
  }

  startReply(message: Message): void {
    this.replyTo = {
      id: message.id,
      senderType: message.senderType,
      senderBotId: message.senderBotId,
      text: 'text' in message.content ? message.content.text : '',
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

  #holdConversation(id: string): void {
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

  #subscribe(): void {
    const listen = (event: string, handler: (payload: unknown) => void): void => {
      this.#unsubscribers.push(core.onEvent(event, handler));
    };
    listen('message.created', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#ingestMessage(data.conversationId, data.message);
    });
    listen('message.updated', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#replaceMessage(data.message);
    });
    listen('run.status', (payload) => {
      const data = payload as { run: Run };
      this.#applyRun(data.run);
    });
    listen('run.progress', (payload) => {
      const data = payload as { runId: string; text?: string; toolName?: string };
      this.#applyProgress(data);
    });
    listen('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      this.#applyBot(data.bot);
    });
    listen('conversation.updated', (payload) => {
      const data = payload as { conversation: Conversation };
      this.#applyConversation(data.conversation);
    });
  }

  #ingestMessage(conversationId: string, message: Message): void {
    if (this.#disposed) return;
    if (isInterimMessage(message) || isEphemeralApprovalCard(message)) return;
    this.#host.noteIncoming(conversationId, message);
    const view = this.view;
    if (!view || view.conversation.id !== conversationId) return;
    if (!view.messages.some((item) => item.id === message.id)) {
      view.messages = [...view.messages, message];
    }
    if (message.senderType === 'bot' && message.runId) {
      const entry = view.activeRuns.find((item) => item.run.id === message.runId);
      if (entry && !entry.muted) {
        entry.muted = true;
        view.activeRuns = [...view.activeRuns];
      }
    }
    if (message.senderType === 'user') void this.markRead();
  }

  #replaceMessage(message: Message): void {
    if (this.#disposed) return;
    const view = this.view;
    if (!view || view.conversation.id !== message.conversationId) return;
    view.messages = view.messages.map((item) => (item.id === message.id ? message : item));
  }

  #applyRun(run: Run): void {
    if (this.#disposed || run.conversationId === null) return;
    this.#host.applyRunning(run);
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
    if (run.status === 'failed' && !failureHidden && view.failedRun?.id !== run.id) {
      logFailedRun(run);
    }
    view.failedRun =
      run.status === 'failed' && showsFailure(run) && !failureHidden
        ? run
        : view.failedRun?.id === run.id
          ? null
          : view.failedRun;
  }

  #applyProgress(data: { runId: string; text?: string; toolName?: string }): void {
    if (this.#disposed) return;
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

  #applyBot(bot: Bot): void {
    if (this.#disposed) return;
    this.#host.applyBot(bot);
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

  #applyConversation(conversation: Conversation): void {
    if (this.#disposed) return;
    const hostWroteView = this.#host.applyConversation(conversation);
    const view = this.view;
    if (!view || view.conversation.id !== conversation.id) return;
    // The main host merges unread and running markers onto the open view.
    // Writing the raw event afterwards drops that merge.
    if (!hostWroteView) {
      view.conversation = {
        ...conversation,
        bot: conversation.bot ?? view.conversation.bot,
        memberPreviews: conversation.memberPreviews ?? view.conversation.memberPreviews,
      };
    }
    if (conversation.type === 'project') void this.reloadMembers();
  }

  async #loadLatest(conversationId: string): Promise<Message[]> {
    const result = (await core.call('messages.list', {
      conversationId,
      limit: PAGE_SIZE,
    })) as { messages: Message[] };
    return result.messages;
  }

  #recheckPendingLinkCards(messages: readonly Message[]): void {
    for (const message of messages) {
      const setting = settingCardOf(message);
      if (setting === null || setting.state !== 'pending' || setting.mode !== 'link') continue;
      core.call('settings.cards.recheck', { messageId: message.id }).catch(() => undefined);
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
