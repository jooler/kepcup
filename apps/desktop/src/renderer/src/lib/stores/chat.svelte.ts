import type { Bot, Conversation, Message, Run, SetupRequirement } from '@kepcup/shared';
import {
  GROUP_MEMBER_PREVIEW_MAX,
  groupTitleFromMemberNames,
  isSparseBotProfile,
} from '@kepcup/shared';
import type { ComposerReplyRef } from '../features/chats/composer-draft-persist';

export interface GroupMemberView {
  bot: Bot;
  joinedAt: number;
}

export interface GroupTurnState {
  batchId: string | null;
  phase: 'triaging' | 'running' | 'idle';
  currentBotId: string | null;
  queue: string[];
  pendingBatches: number;
}
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { permissions } from '$lib/stores/permissions.svelte';
import { agentsStore } from '$lib/stores/agents.svelte';
import { sendGateRequirement } from '../features/chats/send-gate';
import { restoredFailedRun, showsFailure } from '../features/chats/setup-continue';
import { resolveConversationBot } from '../features/chats/conversation-bot';
import {
  clearLastConversationId,
  loadLastConversationId,
  saveLastConversationId,
} from '../features/chats/last-conversation-persist';
import { isEphemeralApprovalCard } from '../features/approvals/ephemeral-approval';
import { isSilentOnArrival, mergeUnreadCount } from '../features/chats/unread';
import { settingCardOf } from '../features/settings-card/setting-card-model';
import { tasks } from '$lib/stores/tasks.svelte';
import { activeRunsOf } from '../features/tasks/task-view';
import { botMessageMutesRun, isInterimMessage } from '../features/chats/run-status-mute';
import { sidebarSections } from '../features/sidebar/sidebar-sections.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { toast } from 'svelte-sonner';

export type ConversationView = Conversation & {
  unreadCount?: number;
  runningBotIds?: string[];
  bot?: Bot | null;
};

export interface ActiveRunView {
  run: Run;
  /** Latest tool self-reported progress text (run.progress text tick). */
  progress: string;
  /** Tool the loop is calling right now (run.progress toolName tick). */
  toolName: string;
  /**
   * True right after a bot message of this run landed: the status line yields
   * its spot to that message until the next activity tick (tool_call /
   * progress) — todo/loop-interim-updates.md 的「状态提示消失 → 新状态提示」节奏。
   */
  muted: boolean;
  /** Time of the latest activity (status line: most recent task first). */
  at: number;
}

interface CurrentChat {
  conversation: ConversationView;
  messages: Message[];
  /** Active runs with their latest progress text (status line). */
  activeRuns: ActiveRunView[];
  /** The latest failed (retryable) run of this conversation. */
  failedRun: Run | null;
  loadingEarlier: boolean;
  hasEarlier: boolean;
  /** Group members (group conversations only). */
  members: GroupMemberView[];
}

const PAGE_SIZE = 60;

class ChatState {
  conversations = $state<ConversationView[]>([]);
  currentId = $state<string | null>(null);
  /** 新建群聊：主区域顶部的成员输入，尚未落库。 */
  composingGroup = $state(false);
  composeMemberIds = $state<string[]>([]);
  /** Ids of bots that currently have a running loop, per conversation. */
  runningByConversation = $state<Record<string, string[]>>({});
  /** Group turn state (P05), per conversation. */
  turnByConversation = $state<Record<string, GroupTurnState>>({});
  /**
   * The message being quoted in the composer (引用回复)：轻量引用快照而非
   * Message 全量——与 composer 草稿缓存（按会话持久化）共用形状，切换会话/
   * 重启后经缓存水合恢复。
   */
  replyTo = $state<ComposerReplyRef | null>(null);
  /** Evidence jump (P07 记忆标签页): flash + scroll to this message after select. */
  highlightMessageId = $state<string | null>(null);
  /**
   * 左栏条目的「最后一条消息」单行预览：启动时由 conversations.list 一并
   * 下发（最后一条文本消息），之后经消息事件/打开会话增量维护；无文本
   * 消息的会话回退到会话 summary。
   */
  lastMessageText = $state<Record<string, string>>({});
  #chat = $state<CurrentChat | null>(null);
  #lastSeqByConversation: Record<string, number> = {};
  /**
   * 本会话已关闭的失败横幅。关闭同时经 `runs.dismissFailure` 落库
   * （`failureDismissed`），刷新后由那条标记挡住；这个集合只盖住落库完成前
   * 的空窗，以及迟到的、还没带上标记的 run 事件。新的失败仍会显示。
   */
  #dismissedFailedRunIds = new Set<string>();
  /** Failed runs already retried by the in-chat setup card (one-shot). */
  #continuedSetupRunIds = new Set<string>();
  /**
   * 发送门禁置起的「缺设置」（inline setup，docs/design/18-inline-setup.md）：
   * 单聊 Bot 无可用模型时消息不发（内容留在输入框），先在消息列表里完成设置。
   * fromVoice 标记置起来源：语音入口（26 号设计）的转写能力缺失与发送门禁
   * 共用卡片层，语义上只用于标记入口。
   */
  #pendingSetup = $state<{ requirement: SetupRequirement; fromVoice: boolean } | null>(null);
  #started = false;
  /** conversations.list 至少成功过一次（之前 conversations 为空不代表真的没有会话）。 */
  #listLoaded = false;

  get current(): CurrentChat | null {
    return this.#chat;
  }

  /**
   * 左栏高亮的会话：组群输入打开时主区域不再是 currentId 那个会话，不高亮它
   * （currentId 本身保留，取消组群后回到原会话）。
   */
  get activeId(): string | null {
    return this.composingGroup ? null : this.currentId;
  }

  /**
   * 当前会话缺失的用户设置（消息列表设置卡片的数据源）：发送门禁置起的
   * pendingSetup 优先，否则取最近失败 run 携带的结构化 setup。
   */
  get setupRequirement(): SetupRequirement | null {
    if (this.#pendingSetup !== null) return this.#pendingSetup.requirement;
    return this.#chat?.failedRun?.setup ?? null;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('message.created', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#ingestMessage(data.conversationId, data.message, /* own */ false);
    });
    core.onEvent('message.updated', (payload) => {
      const data = payload as { conversationId: string; message: Message };
      this.#replaceMessage(data.message);
    });
    core.onEvent('conversation.updated', (payload) => {
      const data = payload as { conversation: Conversation };
      this.#upsertConversation(this.#withDirectBot(data.conversation));
      // Membership may have changed; member cards drive the @ popup and the
      // group info panel, so refresh them for the open group.
      if (data.conversation.type === 'group' && data.conversation.id === this.currentId) {
        void this.reloadMembers();
      }
    });
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.conversations = this.conversations.filter((c) => c.id !== data.id);
      this.#pruneSidebarSections();
      if (this.currentId === data.id) this.close();
    });
    core.onEvent('run.status', (payload) => {
      const data = payload as { run: Run };
      this.#applyRun(data.run);
    });
    core.onEvent('run.progress', (payload) => {
      const data = payload as { runId: string; text?: string; toolName?: string };
      const chat = this.#chat;
      const entry = chat?.activeRuns.find((a) => a.run.id === data.runId);
      if (chat && entry) {
        // tool_call tick: switch to the tool label; progress tick: tool
        // self-reported text wins until the next tool_call.
        if (data.toolName !== undefined) {
          entry.toolName = data.toolName;
          entry.progress = '';
        }
        if (data.text !== undefined) {
          entry.progress = data.text;
        }
        entry.muted = false;
        entry.at = Date.now();
        chat.activeRuns = [...chat.activeRuns];
      }
    });
    core.onEvent('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      const bot = data.bot;
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
      const chatState = this.#chat;
      if (!chatState) return;
      if (chatState.conversation.bot?.id === bot.id) {
        chatState.conversation = { ...chatState.conversation, bot };
      }
      if (chatState.members.some((member) => member.bot.id === bot.id)) {
        chatState.members = chatState.members.map((member) =>
          member.bot.id === bot.id ? { ...member, bot } : member,
        );
      }
    });
    core.onEvent('bot.deleted', (payload) => {
      const data = payload as { id: string };
      // 已删除 Bot 的只读直聊不再进左栏（03-data-model 数据保留不变，UI 表现
      // 删除效果）；群聊历史里它经 botName 回退为其 id。
      this.conversations = this.conversations.filter((c) => c.directBotId !== data.id);
      this.#pruneSidebarSections();
      if (this.#chat?.conversation.directBotId === data.id) this.close();
      // 正在组群的成员里有它：移出，免得用一个已删除的 Bot 建群。
      if (this.composeMemberIds.includes(data.id)) this.removeComposeMember(data.id);
    });
    core.onEvent('group.turn', (payload) => {
      const data = payload as GroupTurnState & { conversationId: string };
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
    const member = this.#chat?.members.find((m) => m.bot.id === botId);
    if (member) return member.bot.name || member.bot.id;
    const known = contacts.bots.find((bot) => bot.id === botId);
    if (known) return known.name || known.id;
    const directBot = this.#chat?.conversation.bot;
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
    this.#pruneSidebarSections();
  }

  /** Opens (or switches to) the direct chat with a bot. */
  async openDirect(botId: string): Promise<void> {
    const result = (await core.call('conversations.openDirect', { botId })) as {
      conversation: ConversationView;
    };
    await this.select(result.conversation.id);
  }

  /**
   * 启动恢复：优先精确恢复上次查看的会话（私聊或群聊，localStorage 记忆，
   * last-conversation-persist）；id 已失效（会话被删/Bot 被删转只读）或从未
   * 打开过则退回「最近 lastMessageAt」启发式；从没聊过则打开第一个 Bot 的
   * 直聊；一个 Bot 都没有（跳过了初始化向导）时不打开任何会话，交由调用方
   * 进入「选择 Bot」的引导态。
   */
  async restoreLast(): Promise<'conversation' | 'bot' | 'empty'> {
    const lastViewed = loadLastConversationId(globalThis.localStorage ?? null);
    if (lastViewed !== null && this.conversations.some((c) => c.id === lastViewed)) {
      await this.select(lastViewed);
      return 'conversation';
    }
    if (this.conversations.length > 0) {
      const latest = [...this.conversations].sort(
        (a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0),
      )[0]!;
      await this.select(latest.id);
      return 'conversation';
    }
    if (contacts.bots.length > 0) {
      await this.openDirect(contacts.bots[0]!.id);
      return 'bot';
    }
    return 'empty';
  }

  async select(conversationId: string): Promise<void> {
    const workbenchIntent = shell.workbenchIntent;
    const result = (await core.call('conversations.get', { id: conversationId })) as {
      conversation: ConversationView | null;
    };
    if (!result.conversation) return;
    this.cancelGroupCompose();
    this.#upsertConversation(result.conversation);
    const messages = await this.#loadLatest(conversationId);
    // D75: several tasks may be in flight next to the turns — look further back.
    const runs = (await core.call('runs.list', { conversationId, limit: 30 })) as { runs: Run[] };
    // Every in-flight run, however old (审查 L3: a long task may be older
    // than the latest page of runs).
    const inFlight = (await core.call('runs.list', { conversationId, active: true })) as {
      runs: Run[];
    };
    void tasks.loadActive(conversationId);
    const active = activeRunsOf(runs.runs, inFlight.runs, (r) => isActive(r.status));
    // 带 setup 的旧失败若已被后续响应 run 接手，不再恢复为设置卡（审查 HIGH #1）。
    const failed = restoredFailedRun(runs.runs, this.#dismissedFailedRunIds);
    if (failed !== null) logFailedRun(failed);
    this.#chat = {
      conversation: result.conversation,
      messages,
      activeRuns: active.map((run) => ({
        run,
        progress: '',
        toolName: '',
        // Same yield as live message.created ingest: a bot message of this run
        // already in the loaded page means the status line starts hidden.
        muted: botMessageMutesRun(messages, run.id),
        at: run.startedAt ?? run.createdAt,
      })),
      failedRun: failed,
      loadingEarlier: false,
      hasEarlier: messages.length >= PAGE_SIZE,
      members: [],
    };
    this.currentId = conversationId;
    // 工作台视图（D90 §5.1）的唯一退出点：与 #chat / currentId 同步切换，不先露出旧会话。
    // 慢 select 期间用户主动打开了工作台：尊重它，只更新当前会话。
    if (shell.workbenchIntent === workbenchIntent) shell.mainView = 'chats';
    this.replyTo = null;
    // 记住「上次查看的会话」：重启/刷新后 restoreLast 精确回到这里（私聊
    // 或群聊），而不是按最近消息时间挑一个。
    saveLastConversationId(globalThis.localStorage ?? null, conversationId);
    // 重新打开对话：对 pending 的 link 卡核对一次（P2，design 38 §4.3）。
    this.#recheckPendingLinkCards(messages);
    // 切换会话撤销门禁缺设置卡（与 close 同理；失败 run 的 setup 卡随
    // failedRun 天然按会话生效，无需处理）。
    this.#pendingSetup = null;
    // 末尾可能是 system_event（如环境安装批准提示），预览要重建到最后一「文本」
    // 消息——与 #ingestMessage 逐条事件记录的行为对齐。
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (this.#noteLastMessage(conversationId, messages[i]!)) break;
    }
    if (result.conversation.type === 'group') await this.reloadMembers();
    else await this.#startSparseInterview(result.conversation);
    await this.#markRead();
    await permissions.loadForConversation(conversationId);
  }

  /** Reloads the current group's member cards. */
  async reloadMembers(): Promise<void> {
    const chatState = this.#chat;
    if (!chatState || chatState.conversation.type !== 'group') return;
    const result = (await core.call('conversations.members', {
      conversationId: chatState.conversation.id,
    })) as { members: GroupMemberView[] };
    chatState.members = result.members;
    this.#syncMemberPreviews(chatState.conversation.id, result.members);
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

  #syncMemberPreviews(conversationId: string, members: GroupMemberView[]): void {
    // 与 core 下发的 memberPreviews 同一上限（左栏群头像只画这么多）。
    const memberPreviews = members.slice(0, GROUP_MEMBER_PREVIEW_MAX).map((member) => ({
      id: member.bot.id,
      name: member.bot.name,
      avatar: member.bot.avatar,
    }));
    this.conversations = this.conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, memberPreviews } : conversation,
    );
    if (this.#chat?.conversation.id === conversationId) {
      this.#chat.conversation = { ...this.#chat.conversation, memberPreviews };
    }
  }

  // --- group management (P05) --------------------------------------------------

  /**
   * 新建群聊：主区域顶部展开成员输入，点选已有 Bot，或回车用输入的名字
   * 新建一个画像为空的 Bot。空回车才真正创建群。
   */
  beginGroupCompose(): void {
    // 组群输入条在对话区里：工作台开着时先回到对话区，否则点「新建群聊」看不到任何反应。
    shell.mainView = 'chats';
    this.composingGroup = true;
    this.composeMemberIds = [];
  }

  cancelGroupCompose(): void {
    this.composingGroup = false;
    this.composeMemberIds = [];
  }

  addComposeMember(botId: string): void {
    if (this.composeMemberIds.includes(botId)) return;
    this.composeMemberIds = [...this.composeMemberIds, botId];
  }

  removeComposeMember(botId: string): void {
    this.composeMemberIds = this.composeMemberIds.filter((id) => id !== botId);
  }

  /**
   * 空回车：用成员名拼接群名并创建。只算通讯录里还在的 Bot（删除事件与
   * 通讯录刷新之间可能有残留 id），不足 2 人时不创建。
   */
  async commitGroupCompose(): Promise<boolean> {
    const members = this.composeMemberIds
      .map((id) => contacts.bots.find((bot) => bot.id === id))
      .filter((bot) => bot !== undefined);
    if (members.length < 2) return false;
    const ids = members.map((bot) => bot.id);
    const names = members.map((bot) => bot.name);
    const title = groupTitleFromMemberNames(names);
    try {
      const result = (await core.call('groups.create', {
        title,
        memberBotIds: ids,
      })) as { conversation: Conversation };
      this.cancelGroupCompose();
      await this.refresh();
      await this.select(result.conversation.id);
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('group.createFailed')));
      return false;
    }
  }

  /*
   * 对话内群创建（19/D60）的入口已由 GroupComposeBar 取代；下面两个方法只服务
   * 库里遗留的「创建中」群对话（GroupSetupCard 仍渲染这些卡片）。
   */
  async answerGroupSetup(
    conversationId: string,
    step: 'title' | 'purpose' | 'members' | 'project',
    value: string | string[] | null,
  ): Promise<boolean> {
    const payload =
      step === 'members'
        ? { conversationId, step, botIds: value as string[] }
        : step === 'project'
          ? { conversationId, step, path: value as string | null }
          : { conversationId, step, text: value as string };
    try {
      await core.call('groups.setup.answer', payload);
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  /** 放弃创建：级联删除该「创建中」的群对话（消息极少，无历史负担）。 */
  async cancelGroupSetup(conversationId: string): Promise<void> {
    try {
      await core.call('groups.setup.cancel', { conversationId });
      this.conversations = this.conversations.filter((c) => c.id !== conversationId);
      this.#pruneSidebarSections();
      if (this.currentId === conversationId) this.close();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
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

  async renameGroup(conversationId: string, title: string): Promise<boolean> {
    try {
      const result = (await core.call('groups.rename', { conversationId, title })) as {
        conversation: Conversation;
      };
      this.#upsertConversation(result.conversation);
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async addGroupMembers(conversationId: string, botIds: string[]): Promise<boolean> {
    try {
      await core.call('groups.addMembers', { conversationId, botIds });
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  async removeGroupMember(conversationId: string, botId: string): Promise<boolean> {
    try {
      await core.call('groups.removeMember', { conversationId, botId });
      await this.reloadMembers();
      return true;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
      return false;
    }
  }

  /** Silent-message click: re-dispatch the stored batch as an explicit @. */
  async redistribute(batchId: string, botId: string): Promise<void> {
    const chatState = this.#chat;
    if (!chatState) return;
    try {
      await core.call('groups.redistribute', {
        conversationId: chatState.conversation.id,
        batchId,
        botId,
      });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  close(): void {
    this.#chat = null;
    this.currentId = null;
    this.replyTo = null;
    this.highlightMessageId = null;
    // 会话消失（删除会话/删除 Bot/放弃建群）才走到这里：记忆一并清除，
    // 下次启动按启发式恢复，而不是指着一个不存在的 id。
    clearLastConversationId(globalThis.localStorage ?? null);
    // 门禁置起的缺设置卡是「本次发送动作」的即时引导：离开会话即撤销
    //（消息内容仍在输入框，再发送会重新拦下）。
    this.#pendingSetup = null;
  }

  /**
   * 窄屏「返回列表」（33-narrow-layout）：只退出当前会话视图回到列表层；会话
   * 本身还在，与 close()（会话消失时的清理，一并放弃启动恢复记忆）不同，
   * 这里保留记忆——下次启动 / 拉回宽屏仍回到该会话。
   */
  leaveCurrent(): void {
    this.#chat = null;
    this.currentId = null;
    this.replyTo = null;
    this.highlightMessageId = null;
    this.#pendingSetup = null;
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
    this.replyTo = {
      id: message.id,
      senderType: message.senderType,
      senderBotId: message.senderBotId,
      text: 'text' in message.content ? message.content.text : '',
    };
  }

  cancelReply(): void {
    this.replyTo = null;
  }

  async loadEarlier(): Promise<void> {
    const chat = this.#chat;
    if (!chat || chat.loadingEarlier || chat.messages.length === 0) return;
    chat.loadingEarlier = true;
    try {
      const oldestSeq = chat.messages[0]?.seq ?? 1;
      const result = (await core.call('messages.list', {
        conversationId: chat.conversation.id,
        beforeSeq: oldestSeq,
        limit: PAGE_SIZE,
      })) as { messages: Message[] };
      chat.messages = [...result.messages, ...chat.messages];
      chat.hasEarlier = result.messages.length >= PAGE_SIZE;
      // 翻页翻出的更早的 pending link 卡同样核对一次。
      this.#recheckPendingLinkCards(result.messages);
    } finally {
      chat.loadingEarlier = false;
    }
  }

  /**
   * 重新打开对话（或翻出更早消息）时，对消息里 pending 的 link 卡用读适配器核对一次
   * （P2，todo/conversational-settings-p2.md 任务 8）：SettingCard 的自动完成只认挂载之后的
   * settings.changed，用户在设置页改完、之后才回到这个对话时卡会一直挂着。核对由 core 做
   * （settings.cards.recheck）：通过才标 applied 并唤醒一次；核对不了（渲染层 / 只读 /
   * unknown / 兜底适配器）保持 pending，不擅自标完成。confirm / user-only / form 卡不在
   * 此列——那些要用户在卡上操作。结果经 message.updated 回来，无需本地处理。
   */
  #recheckPendingLinkCards(messages: readonly Message[]): void {
    for (const message of messages) {
      const setting = settingCardOf(message);
      if (setting === null || setting.state !== 'pending' || setting.mode !== 'link') continue;
      core.call('settings.cards.recheck', { messageId: message.id }).catch(() => {
        // 核对失败不影响打开对话；卡片保持 pending，用户仍可手动结卡。
      });
    }
  }

  // --- send（直发，无待发送队列）---------------------------------------------

  /**
   * 发送一条用户消息（messages.send）：core 侧落库 + 投递一步完成。
   * 空文本 + 无附件由组件层拦截，不发出请求。
   *
   * `conversationId` 由调用方显式给出并**只发往它**——发送是异步的（要等上传落定，
   * 最长 60 秒），期间用户可能已切到别的会话；若按「调用时的当前会话」发，文本会误投
   * 进新会话。因此这里不依赖 `#chat`。
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
      // 引用回复是当前会话的瞬态；发的是别的会话（用户已切走）时不能清掉眼前会话的引用。
      if (this.#chat?.conversation.id === conversationId) this.replyTo = null;
      return { ok: true };
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
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
    const chat = this.#chat;
    if (!chat) return false;
    const bot = chat.conversation.bot;
    if ((bot?.profile.runtime.agent.id ?? '').length > 0 && !agentsStore.loaded) {
      agentsStore.start();
      void agentsStore.refresh().catch(() => undefined);
    }
    const requirement = sendGateRequirement({
      conversationType: chat.conversation.type,
      bot,
      settings: settingsStore.settings,
      agents: agentsStore,
    });
    if (requirement === null) return false;
    this.#pendingSetup = { requirement, fromVoice: false };
    return true;
  }

  /**
   * 用户关闭设置卡片：门禁撤销、失败横幅一并收起。失败 run 带结构化 setup
   * 时顺带通知 core（一次性 internal event 唤醒对话轮）：Bot 得知用户放弃了
   * 配置，给出新的反馈；main-model 缺失时 core 侧自行跳过（对话轮本就跑
   * 不起来）。
   */
  dismissSetupCard(): void {
    this.#pendingSetup = null;
    const failed = this.#chat?.failedRun;
    if (failed?.setup) {
      this.dismissFailedRun(failed.id);
      core.call('runs.setupDismissed', { runId: failed.id }).catch(() => {
        // 通知失败不影响收卡（任务仍可在任务卡上手动重试）。
      });
    }
  }

  /**
   * 输入组件的语音功能（docs/design/26-voice-input.md）在缺设置时置起能力
   * 设置卡：与发送门禁同一层——卡片出现，完成设置后收卡。
   */
  requestCapabilitySetup(
    capability: Extract<SetupRequirement, { kind: 'capability-model' }>['capability'],
  ): void {
    if (this.#chat === null) return;
    this.#pendingSetup = { requirement: { kind: 'capability-model', capability }, fromVoice: true };
  }

  /**
   * 卡片内完成设置后的继续：core 失败路径（failedRun.setup）→ 收起横幅并
   * 自动重试原 run（原触发消息照常续跑，覆盖访谈回答 / 群聊 / 图像工具）。
   * 发送门禁路径无事可做——消息内容一直留在输入框，用户再按一次发送。
   */
  async continueAfterSetup(): Promise<void> {
    this.#pendingSetup = null;
    const failed = this.#chat?.failedRun;
    if (failed?.setup) {
      this.dismissFailedRun(failed.id);
      // 一次性续跑令牌：同一失败 run 只自动重试一次（设置卡的测试连接回调
      // 与随后迟到的 ready 事件不会把它重放两次）。
      if (!this.#continuedSetupRunIds.has(failed.id)) {
        this.#continuedSetupRunIds.add(failed.id);
        await this.retryRun(failed.id);
      }
    }
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
    try {
      await core.call('runs.retry', { runId });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  /**
   * 关闭失败横幅：先在本会话收起，再把该失败标成已读。run 行保留（步骤与
   * 重试来源都还在），刷新后不再恢复。
   */
  dismissFailedRun(runId: string): void {
    this.#dismissedFailedRunIds.add(runId);
    if (this.#chat?.failedRun?.id === runId) this.#chat.failedRun = null;
    core.call('runs.dismissFailure', { runId }).catch((error: unknown) => {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    });
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      await core.call('conversations.delete', { id });
      this.conversations = this.conversations.filter((c) => c.id !== id);
      this.#pruneSidebarSections();
      if (this.currentId === id) this.close();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async markRead(): Promise<void> {
    await this.#markRead();
  }

  // --- internals -----------------------------------------------------------------

  /**
   * 左栏分组归属跟随会话列表：不在列表里的会话不再占着归属。首次 refresh
   * 之前列表还是空的，此时清理会抹掉全部归属，所以要等列表加载过。
   */
  #pruneSidebarSections(): void {
    if (!this.#listLoaded) return;
    sidebarSections.prune(this.conversations.map((c) => c.id));
  }

  /** Records the sidebar's single-line「最后一条消息」preview (text messages only). */
  #noteLastMessage(conversationId: string, message: Message | null): boolean {
    if (message === null || message.status === 'recalled' || message.kind !== 'text') return false;
    const text = 'text' in message.content ? message.content.text.trim() : '';
    if (text.length === 0) return false;
    this.lastMessageText = { ...this.lastMessageText, [conversationId]: text };
    return true;
  }

  async #loadLatest(conversationId: string): Promise<Message[]> {
    const result = (await core.call('messages.list', {
      conversationId,
      limit: PAGE_SIZE,
    })) as { messages: Message[] };
    return result.messages;
  }

  /**
   * 会话此刻是否真的在用户眼前：对话视图里的当前会话。工作台（D90）盖住对话区时它仍是
   * `currentId`，但用户看不到——期间到达的回复要算未读，回到对话（`select`）时再补标已读。
   */
  isViewing(conversationId: string): boolean {
    return !shell.workbenchShown && this.currentId === conversationId;
  }

  async #markRead(): Promise<void> {
    const chat = this.#chat;
    if (!chat || chat.conversation.readOnly) return;
    // 工作台开着时不标已读（MessageList 卸载后一般不会走到这里，仍在此兜底）。
    if (shell.workbenchShown) return;
    const lastSeq = chat.messages.at(-1)?.seq;
    if (lastSeq === undefined || lastSeq <= chat.conversation.lastReadSeq) return;
    await core.call('conversations.markRead', {
      conversationId: chat.conversation.id,
      seq: lastSeq,
    });
    chat.conversation = { ...chat.conversation, lastReadSeq: lastSeq, unreadCount: 0 };
    this.conversations = this.conversations.map((c) =>
      c.id === chat.conversation.id ? { ...c, lastReadSeq: lastSeq, unreadCount: 0 } : c,
    );
  }

  #ingestMessage(conversationId: string, message: Message, own: boolean): void {
    // Task interim is a status overlay, not a chat bubble (may still arrive from older cores).
    if (isInterimMessage(message)) return;
    // Mid-turn permission popups are a dock card. Drop the message.created
    // payload so it never sits in the open conversation's message list.
    if (isEphemeralApprovalCard(message)) return;
    this.#lastSeqByConversation[conversationId] = Math.max(
      this.#lastSeqByConversation[conversationId] ?? 0,
      message.seq,
    );
    this.#noteLastMessage(conversationId, message);
    // Update the list entry (preview/time/order); refetch-less optimistic view.
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            lastSeq: Math.max(c.lastSeq, message.seq),
            lastMessageAt: message.createdAt,
            unreadCount:
              this.isViewing(c.id) || isSilentOnArrival(message)
                ? (c.unreadCount ?? 0)
                : (c.unreadCount ?? 0) + 1,
          }
        : c,
    );
    const chat = this.#chat;
    if (!chat || chat.conversation.id !== conversationId) return;
    if (!chat.messages.some((m) => m.id === message.id)) {
      chat.messages = [...chat.messages, message];
    }
    // 本 run 的消息落库：状态行让位（隐藏），直到下一个活动事件再出现。
    if (message.senderType === 'bot' && message.runId) {
      const entry = chat.activeRuns.find((a) => a.run.id === message.runId);
      if (entry && !entry.muted) {
        entry.muted = true;
        chat.activeRuns = [...chat.activeRuns];
      }
    }
    if (message.senderType === 'user') void this.#markRead();
    void own;
  }

  #replaceMessage(message: Message): void {
    const chat = this.#chat;
    if (!chat || chat.conversation.id !== message.conversationId) return;
    chat.messages = chat.messages.map((m) => (m.id === message.id ? message : m));
  }

  #upsertConversation(conversation: ConversationView): void {
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
    // 已删除 Bot 的直聊不回左栏（bot.deleted 时已移除条目）；仅当它正被打开
    // （如记忆证据跳转）时同步当前会话视图。
    if (merged.type === 'direct' && (merged.bot == null || merged.bot.status === 'deleted')) {
      if (this.#chat?.conversation.id === merged.id) {
        this.#chat.conversation = {
          ...merged,
          bot: merged.bot ?? this.#chat.conversation.bot,
        };
      }
      return;
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
    if (this.#chat?.conversation.id === conversation.id) {
      this.#chat.conversation = {
        ...merged,
        bot: conversation.bot ?? this.#chat.conversation.bot,
        memberPreviews: conversation.memberPreviews ?? this.#chat.conversation.memberPreviews,
      };
    }
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

  #applyRun(run: Run): void {
    if (run.conversationId === null) return;
    const current = this.runningByConversation[run.conversationId] ?? [];
    let running = [...current];
    if (isActive(run.status) && run.botId && !running.includes(run.botId)) {
      running = [...running, run.botId];
    } else if (!isActive(run.status) && run.botId && this.#isLastRunOfBot(run)) {
      running = running.filter((id) => id !== run.botId);
    }
    this.runningByConversation[run.conversationId] = running;
    this.conversations = this.conversations.map((c) =>
      c.id === run.conversationId ? { ...c, runningBotIds: running } : c,
    );

    const chat = this.#chat;
    if (!chat || chat.conversation.id !== run.conversationId) return;
    if (isActive(run.status)) {
      const existing = chat.activeRuns.find((a) => a.run.id === run.id);
      if (existing) {
        existing.run = run;
        chat.activeRuns = [...chat.activeRuns];
      } else {
        chat.activeRuns = [
          ...chat.activeRuns,
          { run, progress: '', toolName: '', muted: false, at: Date.now() },
        ];
      }
    } else {
      chat.activeRuns = chat.activeRuns.filter((a) => a.run.id !== run.id);
    }
    const failureHidden = run.failureDismissed === true || this.#dismissedFailedRunIds.has(run.id);
    if (run.status === 'failed' && !failureHidden && chat.failedRun?.id !== run.id) {
      logFailedRun(run);
    }
    chat.failedRun =
      run.status === 'failed' && showsFailure(run) && !failureHidden
        ? run
        : chat.failedRun?.id === run.id
          ? null
          : chat.failedRun;
  }

  /** Only clears the running marker when no other active run of this bot remains. */
  #isLastRunOfBot(run: Run): boolean {
    const chat = this.#chat;
    if (!chat) return true;
    for (const active of chat.activeRuns) {
      if (active.run.id !== run.id && active.run.botId === run.botId) return false;
    }
    return true;
  }
}

/**
 * Dev builds: a failed run's full error goes to the DevTools console (the
 * banner truncates it; the core also logs it to the `pnpm dev` terminal).
 */
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

export const chat = new ChatState();
