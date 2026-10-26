import type { Bot, Conversation, Message, Run, SetupRequirement } from '@kepcup/shared';
import {
  PROJECT_MEMBER_PREVIEW_MAX,
  isArchivedConversation,
  projectTitleFromMemberNames,
  isSparseBotProfile,
  messagePreviewText,
} from '@kepcup/shared';
import type { ComposerReplyRef } from '../features/chats/composer-draft-persist';
import {
  ChatSession,
  type ConversationView,
  type ProjectMemberView,
} from './chat-session.svelte';

export type { ActiveRunView, ConversationView, ProjectMemberView } from './chat-session.svelte';

export interface ProjectTurnState {
  batchId: string | null;
  phase: 'routing' | 'running' | 'idle';
  currentBotId: string | null;
  queue: string[];
  pendingBatches: number;
}
import { board } from '$lib/features/board/board.svelte';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { resolveConversationBot } from '../features/chats/conversation-bot';
import {
  composeAddMember,
  composeBackToLead,
  composeRemoveMember,
  composeSelectLead,
  type ComposeState,
} from '../features/chats/project-compose';
import {
  clearLastConversationId,
  loadLastConversationId,
  saveLastConversationId,
} from '../features/chats/last-conversation-persist';
import { isEphemeralApprovalCard } from '../features/approvals/ephemeral-approval';
import { isSilentOnArrival, mergeUnreadCount } from '../features/chats/unread';
import { tasks } from '$lib/stores/tasks.svelte';
import { isInterimMessage } from '../features/chats/run-status-mute';
import { sidebarSections } from '../features/sidebar/sidebar-sections.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { toast } from 'svelte-sonner';

export interface SelectOptions {
  /**
   * 启动恢复落在工作台时保持主区不动：后台把会话装好，但不把 `shell.mainView`
   * 拉回对话（否则刷新时会先露出上一会话再跳到工作台）。
   */
  keepMainView?: boolean;
}

class ChatState {
  /**
   * The main conversation view. Dialogs will construct their own session;
   * this one is switched by `select`.
   */
  readonly main = new ChatSession(
    {
      syncReadCursor: (conversationId, lastReadSeq) => {
        this.conversations = this.conversations.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, lastReadSeq, unreadCount: 0 }
            : conversation,
        );
      },
      syncMemberPreviews: (conversationId, members) => {
        this.#syncMemberPreviews(conversationId, members);
      },
      noteIncoming: (conversationId, message) => {
        this.#noteIncoming(conversationId, message);
      },
      applyRunning: (run) => {
        this.#applyRunning(run);
      },
      applyBot: (bot) => {
        this.#applyBotToList(bot);
      },
      applyConversation: (conversation) => {
        if (isArchivedConversation(conversation)) this.#archivedIds.add(conversation.id);
        else this.#archivedIds.delete(conversation.id);
        return this.#upsertConversation(this.#withDirectBot(conversation));
      },
    },
    { attach: false, foreground: true },
  );
  conversations = $state<ConversationView[]>([]);
  /**
   * New-project compose: the two-round input at the top of the main area,
   * not yet persisted. Round 1 picks the lead (single), round 2 the members
   * (multi). `composeMemberIds` does NOT include the lead; both are merged
   * only in the projects.create payload.
   */
  composingProject = $state(false);
  composePhase = $state<ComposeState['phase']>('lead');
  composeLeadId = $state<string | null>(null);
  composeMemberIds = $state<string[]>([]);
  /** Ids of bots that currently have a running loop, per conversation. */
  runningByConversation = $state<Record<string, string[]>>({});
  /** Group turn state (P05), per conversation. */
  turnByConversation = $state<Record<string, ProjectTurnState>>({});
  /**
   * 左栏条目的「最后一条消息」单行预览：启动时由 conversations.list 一并
   * 下发（最后一条文本消息），之后经消息事件/打开会话增量维护；无文本
   * 消息的会话回退到会话 summary。
   */
  lastMessageText = $state<Record<string, string>>({});
  #lastSeqByConversation: Record<string, number> = {};
  #started = false;
  /** conversations.list 至少成功过一次（之前 conversations 为空不代表真的没有会话）。 */
  #listLoaded = false;
  /**
   * 已归档（已从对话列表移除）的会话 id：它们不在左栏，但左栏分组归属与置顶
   * 要留着，恢复后回到原位。
   */
  #archivedIds = new Set<string>();

  /** Stable until the next open/clear. Property updates do not replace it. */
  get current() {
    return this.main.view;
  }

  get currentId(): string | null {
    return this.main.conversationId;
  }

  get replyTo(): ComposerReplyRef | null {
    return this.main.replyTo;
  }

  set replyTo(value: ComposerReplyRef | null) {
    this.main.replyTo = value;
  }

  get highlightMessageId(): string | null {
    return this.main.highlightMessageId;
  }

  set highlightMessageId(value: string | null) {
    this.main.highlightMessageId = value;
  }

  /**
   * Conversation highlighted in the sidebar: while the project compose is open
   * the main area no longer shows the currentId conversation, so do not
   * highlight it (currentId itself is kept; cancelling returns to it).
   */
  get activeId(): string | null {
    return this.composingProject ? null : this.currentId;
  }

  /**
   * 当前会话缺失的用户设置（消息列表设置卡片的数据源）：发送门禁置起的
   * pendingSetup 优先，否则取最近失败 run 携带的结构化 setup。
   */
  get setupRequirement(): SetupRequirement | null {
    return this.main.setupRequirement;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // The session subscribes to message, run, bot, and conversation updates.
    // List-only events stay here.
    this.main.start();
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.#archivedIds.delete(data.id);
      this.conversations = this.conversations.filter((c) => c.id !== data.id);
      this.pruneSidebarSections();
      if (this.currentId === data.id) this.close();
    });
    core.onEvent('bot.deleted', (payload) => {
      const data = payload as { id: string };
      // 已删除 Bot 的只读直聊不再进左栏（03-data-model 数据保留不变，UI 表现
      // 删除效果）；项目组历史里它经 botName 回退为其 id。
      this.conversations = this.conversations.filter((c) => c.directBotId !== data.id);
      this.pruneSidebarSections();
      if (this.main.conversation?.directBotId === data.id) this.close();
      // It is part of an in-flight project compose: a picked lead goes back to
      // round 1 (chosen members kept), members are dropped — never build the
      // project around a deleted bot.
      if (this.composeLeadId === data.id) this.backToLeadPhase();
      if (this.composeMemberIds.includes(data.id)) this.removeComposeMember(data.id);
    });
    core.onEvent('project.turn', (payload) => {
      const data = payload as ProjectTurnState & { conversationId: string };
      this.turnByConversation[data.conversationId] = {
        batchId: data.batchId,
        phase: data.phase,
        currentBotId: data.currentBotId,
        queue: data.queue,
        pendingBatches: data.pendingBatches,
      };
    });
  }

  /**
   * Bot display name for status lines / member cards / message senders.
   * Removed-from-group members keep their name (design/01: 历史消息发送者仍显示
   * Bot 名称)；deleted bots fall through to their id (design/01: 显示其 id).
   */
  botName(botId: string): string {
    const member = this.main.members.find((m) => m.bot.id === botId);
    if (member) return member.bot.name || member.bot.id;
    const known = contacts.bots.find((bot) => bot.id === botId);
    if (known) return known.name || known.id;
    const directBot = this.main.conversation?.bot;
    if (directBot && directBot.id === botId) return directBot.name || directBot.id;
    return botId;
  }

  async refresh(): Promise<void> {
    const result = (await core.call('conversations.list')) as { conversations: ConversationView[] };
    // 已删除 Bot 的直聊（占位行 status='deleted'）不在左栏列出；启动恢复与
    // 事件驱动的增删在此统一过滤。
    this.conversations = result.conversations.filter(
      (c) => !(c.type === 'direct' && (c.bot == null || c.bot.status === 'deleted')),
    );
    // 左栏「最后一条消息」预览：conversations.list 一并下发了库里的最后一条
    // 文本消息，启动即有预览；之后仍由消息事件/打开会话增量维护（merge 保
    // 持事件侧可能更新的值）。
    const lastMessageText = { ...this.lastMessageText };
    for (const conversation of this.conversations) {
      this.runningByConversation[conversation.id] = conversation.runningBotIds ?? [];
      this.#lastSeqByConversation[conversation.id] = conversation.lastSeq;
      if (conversation.lastMessageText !== undefined) {
        lastMessageText[conversation.id] = conversation.lastMessageText;
      }
    }
    this.lastMessageText = lastMessageText;
    this.#listLoaded = true;
    this.pruneSidebarSections();
  }

  /** Opens (or switches to) the direct chat with a bot. */
  async openDirect(botId: string, options: SelectOptions = {}): Promise<void> {
    const result = (await core.call('conversations.openDirect', { botId })) as {
      conversation: ConversationView;
    };
    await this.select(result.conversation.id, options);
  }

  /**
   * 启动恢复：优先精确恢复上次查看的会话（私聊或项目组，localStorage 记忆，
   * last-conversation-persist）；id 已失效（会话被删/Bot 被删转只读）或从未
   * 打开过则退回「最近 lastMessageAt」启发式；从没聊过则打开第一个 Bot 的
   * 直聊；一个 Bot 都没有（跳过了初始化向导）时不打开任何会话，交由调用方
   * 进入「选择 Bot」的引导态。
   */
  async restoreLast(options: SelectOptions = {}): Promise<'conversation' | 'bot' | 'empty'> {
    const lastViewed = loadLastConversationId(globalThis.localStorage ?? null);
    if (lastViewed !== null && this.conversations.some((c) => c.id === lastViewed)) {
      await this.select(lastViewed, options);
      return 'conversation';
    }
    if (this.conversations.length > 0) {
      const latest = [...this.conversations].sort(
        (a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0),
      )[0]!;
      await this.select(latest.id, options);
      return 'conversation';
    }
    if (contacts.bots.length > 0) {
      await this.openDirect(contacts.bots[0]!.id, options);
      return 'bot';
    }
    return 'empty';
  }

  async select(conversationId: string, options: SelectOptions = {}): Promise<void> {
    const workbenchIntent = shell.workbenchIntent;
    // Filled when `conversations.get` (inside `open`) returns a card row.
    // Card rows are not in `this.conversations`, so the type check has to
    // happen on that fetched object. A thrown get does not fall through.
    // A box, not a `let`: the assignment sits in a callback, and control-flow
    // analysis would otherwise keep the local as `null`.
    const cardRedirect: { conversation: ConversationView | null } = { conversation: null };
    const opened = await this.main.open(conversationId, {
      afterResolved: (conversation) => {
        if (conversation.type === 'card') {
          cardRedirect.conversation = conversation;
          return 'stop';
        }
        this.cancelProjectCompose();
        this.#upsertConversation(conversation);
      },
      onReady: async (conversation) => {
        // 工作台视图（D90 §5.1）的唯一退出点。慢 select 期间用户主动打开了工作台：
        // 尊重它，只更新当前会话。启动恢复要落在工作台时同样不动主区（keepMainView）。
        // Mark-read runs after this, so a covered conversation stays unread.
        if (!options.keepMainView && shell.workbenchIntent === workbenchIntent) shell.showChats();
        // 项目组视图（WP6 §4.11）的收口不变式：进入会话自然回到沟通 tab、详情分区回概览。
        shell.projectView = 'chat';
        shell.projectSettingsSection = 'overview';
        board.closeCard();
        tasks.closeDetail();
        saveLastConversationId(globalThis.localStorage ?? null, conversationId);
        const messages = this.main.messages;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (this.#noteLastMessage(conversationId, messages[i]!)) break;
        }
        if (conversation.type !== 'project') await this.#startSparseInterview(conversation);
      },
    });
    const redirected = cardRedirect.conversation;
    if (redirected !== null) {
      const projectId = redirected.parentProjectId;
      const cardId = redirected.cardTodoId;
      if (projectId !== null && cardId !== null) {
        await shell.openBoardCard(projectId, cardId);
      }
      return;
    }
    if (!opened) return;
  }

  /** Reloads the current group's member cards. */
  async reloadMembers(): Promise<void> {
    await this.main.reloadMembers();
  }

  /** 空画像的新 Bot 第一次打开私聊时，主动发出定位提问。已经问过的不重复发。 */
  async #startSparseInterview(conversation: ConversationView): Promise<void> {
    const bot = conversation.bot;
    if (!bot || bot.setupState !== 'interviewing' || !isSparseBotProfile(bot.profile)) return;
    try {
      await core.call('bots.interview.start', { id: bot.id });
    } catch (error) {
      console.warn('[kepcup] interview start failed', error);
    }
  }

  #syncMemberPreviews(conversationId: string, members: ProjectMemberView[]): void {
    // 与 core 下发的 memberPreviews 同一上限（左栏群头像只画这么多）。
    const memberPreviews = members.slice(0, PROJECT_MEMBER_PREVIEW_MAX).map((member) => ({
      id: member.bot.id,
      name: member.bot.name,
      avatar: member.bot.avatar,
    }));
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, memberPreviews } : conversation,
    );
  }

  // --- project compose (D92 §11.1: two-round creation, lead first) -------------

  #composeState(): ComposeState {
    return {
      phase: this.composePhase,
      leadId: this.composeLeadId,
      memberIds: this.composeMemberIds,
    };
  }

  #setComposeState(next: ComposeState): void {
    this.composePhase = next.phase;
    this.composeLeadId = next.leadId;
    this.composeMemberIds = next.memberIds;
  }

  /**
   * New project: open the two-round compose at the top of the main area —
   * round 1 picks the lead (single), round 2 the members (multi). Pick an
   * existing bot, or press Enter on a typed name to create an empty-profile
   * bot.
   */
  beginProjectCompose(): void {
    // The compose view lives in the chats area: leave the workbench first,
    // otherwise clicking "new project" would show no reaction at all.
    shell.showChats();
    this.composingProject = true;
    this.#setComposeState({ phase: 'lead', leadId: null, memberIds: [] });
  }

  cancelProjectCompose(): void {
    this.composingProject = false;
    this.#setComposeState({ phase: 'lead', leadId: null, memberIds: [] });
  }

  /** Round-1 pick: enter the members round (a bot picked from the members leaves them). */
  selectComposeLead(botId: string): void {
    this.#setComposeState(composeSelectLead(this.#composeState(), botId));
  }

  /** Back to round 1 to re-pick the lead; the chosen members are kept. */
  backToLeadPhase(): void {
    this.#setComposeState(composeBackToLead(this.#composeState()));
  }

  addComposeMember(botId: string): void {
    this.#setComposeState(composeAddMember(this.#composeState(), botId));
  }

  removeComposeMember(botId: string): void {
    this.#setComposeState(composeRemoveMember(this.#composeState(), botId));
  }

  /**
   * Empty-Enter commit: only bots still in the roster count (a deletion event
   * may land before the roster refresh); without the lead or with fewer than
   * one valid member, do not create. The title joins "lead, members…" with the
   * lead first. `memberBotIds` includes the lead.
   */
  async commitProjectCompose(): Promise<boolean> {
    const lead =
      this.composeLeadId === null
        ? undefined
        : contacts.bots.find((bot) => bot.id === this.composeLeadId);
    const members = this.composeMemberIds
      .map((id) => contacts.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined);
    if (lead === undefined || members.length < 1) return false;
    const title = projectTitleFromMemberNames([lead.name, ...members.map((bot) => bot.name)]);
    try {
      const result = (await core.call('projects.create', {
        title,
        leadBotId: lead.id,
        memberBotIds: [lead.id, ...members.map((bot) => bot.id)],
      })) as { conversation: Conversation };
      this.cancelProjectCompose();
      await this.refresh();
      await this.select(result.conversation.id);
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('project.createFailed')));
      return false;
    }
  }

  /**
   * 访谈目录卡作答（19/D59）：path 为 null 表示「暂不设置」；作答后缓冲的
   * 首答与目录决定一起投递给 Bot（首个响应 run 开始）。
   */
  async answerSetupPath(conversationId: string, path: string | null): Promise<void> {
    try {
      await core.call('bots.interview.answerPath', { conversationId, path });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async renameProject(conversationId: string, title: string): Promise<boolean> {
    try {
      const result = (await core.call('projects.update', { conversationId, title })) as {
        conversation: Conversation;
      };
      this.#upsertConversation(result.conversation);
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  /**
   * Update the project goal (D92 §11.3 overview section). `goal: null` clears
   * it. The returned conversation flows into the sidebar list; the open chat
   * follows it via the same upsert (the `conversation.updated` event repeats it).
   */
  async updateProjectGoal(conversationId: string, goal: string | null): Promise<boolean> {
    try {
      const result = (await core.call('projects.update', { conversationId, goal })) as {
        conversation: Conversation;
      };
      this.#upsertConversation(result.conversation);
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  /** Hand the lead crown to another member bot (D92 §5: every project has one). */
  async setProjectLead(conversationId: string, botId: string): Promise<boolean> {
    try {
      const result = (await core.call('projects.setLead', { conversationId, botId })) as {
        conversation: Conversation;
      };
      this.#upsertConversation(result.conversation);
      // The lead badge sits on member rows; refresh them right away.
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async addProjectMembers(conversationId: string, botIds: string[]): Promise<boolean> {
    try {
      await core.call('projects.addMembers', { conversationId, botIds });
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async removeProjectMember(conversationId: string, botId: string): Promise<boolean> {
    try {
      await core.call('projects.removeMember', { conversationId, botId });
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  close(): void {
    this.main.clear();
    tasks.closeDetail();
    // 会话消失（删除会话/删除 Bot/放弃建项目组）才走到这里：记忆一并清除，
    // 下次启动按启发式恢复，而不是指着一个不存在的 id。
    clearLastConversationId(globalThis.localStorage ?? null);
  }

  /**
   * 窄屏「返回列表」（33-narrow-layout）：只退出当前会话视图回到列表层；会话
   * 本身还在，与 close()（会话消失时的清理，一并放弃启动恢复记忆）不同，
   * 这里保留记忆——下次启动 / 拉回宽屏仍回到该会话。
   */
  leaveCurrent(): void {
    this.main.clear();
    tasks.closeDetail();
    // 项目组视图同样收口（WP6 §4.11）：回到列表层后重新进入任何会话都从沟通开始。
    shell.projectView = 'chat';
    shell.projectSettingsSection = 'overview';
    board.closeCard();
  }

  /**
   * Memory evidence jump (任务书任务 13): opens the evidence conversation and
   * highlights the message. Returns false when the conversation is deleted —
   * the caller then shows 「来源对话已删除」.
   */
  async jumpToMessage(conversationId: string, messageId: string): Promise<boolean> {
    const result = (await core.call('conversations.get', { id: conversationId })) as {
      conversation: ConversationView | null;
    };
    if (!result.conversation) return false;
    await this.select(conversationId);
    this.highlightMessageId = messageId;
    return true;
  }

  startReply(message: Message): void {
    this.main.startReply(message);
  }

  cancelReply(): void {
    this.replyTo = null;
  }

  async loadEarlier(): Promise<void> {
    await this.main.loadEarlier();
  }

  // --- send（直发，无待发送队列）---------------------------------------------

  /**
   * 发送一条用户消息（messages.send）：core 侧落库 + 投递一步完成。
   * 空文本 + 无附件由组件层拦截，不发出请求。
   *
   * `conversationId` 由调用方显式给出并**只发往它**——发送是异步的（要等上传落定，
   * 最长 60 秒），期间用户可能已切到别的会话；若按「调用时的当前会话」发，文本会误投
   * 进新会话。
   *
   * 返回 `{ ok: true }` = core 已受理；失败返回错误码，**不在这里 toast**——调用方
   * （composer-send）要先按错误码/附件状态判因再决定提示（附件失效 vs 通用错误），
   * 并据此回填输入内容（不能把用户的内容吞掉）。
   */
  async send(
    conversationId: string,
    text: string,
    options: { mentions?: string[]; replyTo?: string | null; attachmentIds?: string[] } = {},
  ): Promise<{ ok: true } | { ok: false; code: string | undefined }> {
    return this.main.send(conversationId, text, options);
  }

  /** 发送失败的通用提示（附件失效等可归因的情形由调用方另行提示）。 */
  reportSendFailure(code: string | undefined): void {
    toast.error(errorText(code, t('chats.errorCode.INTERNAL')));
  }

  // --- inline setup（对话内设置引导，docs/design/18-inline-setup.md）-----------

  /**
   * 发送门禁（send-gate.ts）：单聊 Bot 跑不起来时不发送——内置 Bot 无可用
   * 模型 → main-model 卡；外部 Agent Bot 未开实验 / 未启用 / 未安装 / 未登录
   * → Agent 设置卡（D72 P4）。置起 pendingSetup；消息内容留在输入框，设置
   * 完成后用户再按一次发送。快照未加载时放行，由 core 的结构化失败
   *（run.setup）兜底出卡片。Composer 发送前调用（true = 已拦截，不要清空）。
   */
  gateForSend(): boolean {
    return this.main.gateForSend();
  }

  /**
   * 用户关闭设置卡片：门禁撤销、失败横幅一并收起。失败 run 带结构化 setup
   * 时顺带通知 core（一次性 internal event 唤醒对话轮）：Bot 得知用户放弃了
   * 配置，给出新的反馈；main-model 缺失时 core 侧自行跳过（对话轮本就跑
   * 不起来）。
   */
  dismissSetupCard(): void {
    this.main.dismissSetupCard();
  }

  /**
   * 输入组件的语音功能（docs/design/26-voice-input.md）在缺设置时置起能力
   * 设置卡：与发送门禁同一层——卡片出现，完成设置后收卡。
   */
  requestCapabilitySetup(
    capability: Extract<SetupRequirement, { kind: 'capability-model' }>['capability'],
  ): void {
    this.main.requestCapabilitySetup(capability);
  }

  /**
   * 卡片内完成设置后的继续：core 失败路径（failedRun.setup）→ 收起横幅并
   * 自动重试原 run（原触发消息照常续跑，覆盖访谈回答 / 项目组 / 图像工具）。
   * 发送门禁路径无事可做——消息内容一直留在输入框，用户再按一次发送。
   */
  async continueAfterSetup(): Promise<void> {
    await this.main.continueAfterSetup();
  }

  // --- messages ---------------------------------------------------------------

  async edit(id: string, text: string): Promise<void> {
    try {
      await core.call('messages.edit', { id, text });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  // --- runs --------------------------------------------------------------------

  async retryRun(runId: string): Promise<void> {
    await this.main.retryRun(runId);
  }

  /**
   * 关闭失败横幅：先在本会话收起，再把该失败标成已读。run 行保留（步骤与
   * 重试来源都还在），刷新后不再恢复。
   */
  dismissFailedRun(runId: string): void {
    this.main.dismissFailedRun(runId);
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      await core.call('conversations.delete', { id });
      this.conversations = this.conversations.filter((c) => c.id !== id);
      this.pruneSidebarSections();
      if (this.currentId === id) this.close();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  /**
   * 从对话列表移除（归档）：数据、消息、wiki 全留，会话仍在通讯录里可恢复。
   * 与「删除对话」（物理删除）不同——后者只在项目详情页危险区与管家聊天里。
   */
  async archiveConversation(id: string): Promise<void> {
    try {
      await core.call('conversations.archive', { id });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  /** 恢复已归档的会话：回到对话列表。 */
  async restoreConversation(id: string): Promise<void> {
    try {
      const result = (await core.call('conversations.unarchive', { id })) as {
        conversation: ConversationView;
      };
      this.#upsertConversation(result.conversation);
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async markRead(): Promise<void> {
    await this.main.markRead();
  }

  // --- internals -----------------------------------------------------------------

  /**
   * 左栏分组归属跟随会话列表：不在列表里的会话不再占着归属。首次 refresh
   * 之前列表还是空的，此时清理会抹掉全部归属，所以要等列表加载过；名册
   * （通讯录）没加载前同理——否则会把已归档会话的归属误删。
   * 已归档（已从对话列表移除）的会话也算「还在」——恢复后要回到原分组。
   */
  pruneSidebarSections(): void {
    if (!this.#listLoaded || !contacts.rosterLoaded) return;
    const ids: string[] = this.conversations.map((c) => c.id);
    for (const id of this.#archivedIds) ids.push(id);
    for (const conversation of contacts.conversations) {
      if (isArchivedConversation(conversation)) ids.push(conversation.id);
    }
    sidebarSections.prune(ids);
  }

  /**
   * Records the sidebar's single-line「最后一条消息」preview. Text messages keep
   * their body; cards are folded into「icon + 标题 + 摘要」(same helper as
   * conversations.list, so startup and live events agree).
   */
  #noteLastMessage(conversationId: string, message: Message | null): boolean {
    if (message === null) return false;
    const text = messagePreviewText(message);
    if (text === null || text.length === 0) return false;
    this.lastMessageText = { ...this.lastMessageText, [conversationId]: text };
    return true;
  }

  /**
   * 会话此刻是否真的在用户眼前：对话视图里的当前会话。工作台（D90）盖住对话区时它仍是
   * `currentId`，但用户看不到——期间到达的回复要算未读，回到对话（`select`）时再补标已读。
   */
  isViewing(conversationId: string): boolean {
    return !shell.workbenchShown && this.currentId === conversationId;
  }

  /** Sidebar row for a new message. The open transcript is the session's job. */
  #noteIncoming(conversationId: string, message: Message): void {
    if (isInterimMessage(message) || isEphemeralApprovalCard(message)) return;
    this.#lastSeqByConversation[conversationId] = Math.max(
      this.#lastSeqByConversation[conversationId] ?? 0,
      message.seq,
    );
    this.#noteLastMessage(conversationId, message);
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            lastSeq: Math.max(conversation.lastSeq, message.seq),
            lastMessageAt: message.createdAt,
            unreadCount:
              this.isViewing(conversation.id) || isSilentOnArrival(message)
                ? (conversation.unreadCount ?? 0)
                : (conversation.unreadCount ?? 0) + 1,
          }
        : conversation,
    );
  }

  /**
   * Insert or refresh a sidebar row. Returns true when this call owned the
   * open-view write (so the session must not replace it). Card rows are
   * ignored here; the session applies those itself.
   */
  #upsertConversation(conversation: ConversationView): boolean {
    // Card chats are hidden. A dialog session still hears the event itself.
    if (conversation.type === 'card') return false;
    const index = this.conversations.findIndex((c) => c.id === conversation.id);
    const unread = mergeUnreadCount(conversation, this.conversations[index]);
    // A conversation first seen through an event without a count (D75: seq
    // math would count private task rows): ask the server for its count.
    if (unread.refetch) void this.#refreshUnread(conversation.id);
    const merged: ConversationView = {
      ...conversation,
      unreadCount: unread.count,
      runningBotIds:
        this.runningByConversation[conversation.id] ?? conversation.runningBotIds ?? [],
    };
    // 已归档（已从对话列表移除）的会话不进左栏；数据全留，通讯录里可恢复。
    if (isArchivedConversation(conversation)) {
      this.conversations = this.conversations.filter((c) => c.id !== conversation.id);
      if (this.main.view?.conversation.id === conversation.id) this.close();
      return true;
    }
    // 已删除 Bot 的直聊不回左栏（bot.deleted 时已移除条目）；仅当它正被打开
    // （如记忆证据跳转）时同步当前会话视图。
    if (merged.type === 'direct' && (merged.bot == null || merged.bot.status === 'deleted')) {
      const view = this.main.view;
      if (view?.conversation.id === merged.id) {
        view.conversation = {
          ...merged,
          bot: merged.bot ?? view.conversation.bot,
        };
      }
      return true;
    }
    if (index >= 0) {
      const existing = this.conversations[index]!;
      this.conversations[index] = {
        ...merged,
        bot: conversation.bot ?? existing.bot,
        memberPreviews: conversation.memberPreviews ?? existing.memberPreviews,
      };
      this.conversations = [...this.conversations];
    } else {
      this.conversations = [merged, ...this.conversations];
    }
    const view = this.main.view;
    if (view?.conversation.id === conversation.id) {
      view.conversation = {
        ...merged,
        bot: conversation.bot ?? view.conversation.bot,
        memberPreviews: conversation.memberPreviews ?? view.conversation.memberPreviews,
      };
    }
    return true;
  }

  /**
   * 事件负载缺 `bot`（未经视图化的推送）时先查通讯录补齐；通讯录也没有就回源
   * conversations.get——否则活跃 Bot 的新单聊会被当作已删除而不进左栏
   * （D70 管家建团队后左栏只剩管家，刷新才出现）。显式 null 原样交给
   * #upsertConversation 按已删除处理，不回源，避免循环。
   */
  #withDirectBot(conversation: Conversation): Conversation {
    if (conversation.bot !== undefined) return conversation;
    const resolved = resolveConversationBot(conversation, contacts.bots);
    if (resolved.refetch) void this.#refetchConversation(conversation.id);
    return resolved.conversation;
  }

  async #refetchConversation(conversationId: string): Promise<void> {
    try {
      const result = (await core.call('conversations.get', { id: conversationId })) as {
        conversation: ConversationView | null;
      };
      if (result.conversation && result.conversation.bot !== undefined) {
        this.#upsertConversation(result.conversation);
      }
    } catch (error) {
      console.warn('[kepcup] conversation refetch failed', { conversationId, error });
    }
  }

  async #refreshUnread(conversationId: string): Promise<void> {
    try {
      const result = (await core.call('conversations.get', { id: conversationId })) as {
        conversation: ConversationView | null;
      };
      const count = result.conversation?.unreadCount;
      if (count === undefined) return;
      this.conversations = this.conversations.map((c) =>
        c.id === conversationId ? { ...c, unreadCount: count } : c,
      );
    } catch {
      // Keeps the provisional count.
    }
  }

  /** Sidebar running markers. The open session owns activeRuns and failedRun. */
  #applyRunning(run: Run): void {
    if (run.conversationId === null) return;
    const current = this.runningByConversation[run.conversationId] ?? [];
    let running = [...current];
    if (isActive(run.status) && run.botId && !running.includes(run.botId)) {
      running = [...running, run.botId];
    } else if (!isActive(run.status) && run.botId && this.#isLastRunOfBot(run)) {
      running = running.filter((id) => id !== run.botId);
    }
    this.runningByConversation[run.conversationId] = running;
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === run.conversationId ? { ...conversation, runningBotIds: running } : conversation,
    );
  }

  #applyBotToList(bot: Bot): void {
    this.conversations = this.conversations.map((conversation) => {
      const withBot = conversation.bot?.id === bot.id ? { ...conversation, bot } : conversation;
      if (!withBot.memberPreviews?.some((member) => member.id === bot.id)) return withBot;
      return {
        ...withBot,
        memberPreviews: withBot.memberPreviews.map((member) =>
          member.id === bot.id ? { id: bot.id, name: bot.name, avatar: bot.avatar } : member,
        ),
      };
    });
  }

  /** Only clears the running marker when no other active run of this bot remains. */
  #isLastRunOfBot(run: Run): boolean {
    const view = this.main.view;
    if (!view) return true;
    for (const active of view.activeRuns) {
      if (active.run.id !== run.id && active.run.botId === run.botId) return false;
    }
    return true;
  }
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

export const chat = new ChatState();
