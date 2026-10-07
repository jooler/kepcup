import type { Bot, Conversation, Draft, Message, Run, SetupRequirement } from '@kepcup/shared';
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
import { restoredFailedRun } from '../features/chats/setup-continue';
import { settingsStore } from '$lib/stores/settings.svelte';
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
}

interface CurrentChat {
  conversation: ConversationView;
  messages: Message[];
  drafts: Draft[];
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
   * Failed runs the user closed on the run-failed banner (session-scoped):
   * they never resurface on reselect or later run events; a *new* failure
   * still shows. Not persisted — a relaunch lists the failure again.
   */
  #dismissedFailedRunIds = new Set<string>();
  /** Failed runs already retried by the in-chat setup card (one-shot). */
  #continuedSetupRunIds = new Set<string>();
  /**
   * 发送门禁置起的「缺设置」（inline setup，docs/design/18-inline-setup.md）：
   * 单聊 Bot 无可用模型时消息不发（草稿留在队列），先在消息列表里完成设置。
   * fromVoice 标记置起来源：语音入口（26 号设计）与草稿队列互不相干，完成
   * 设置后不得触发 flush。
   */
  #pendingSetup = $state<{ requirement: SetupRequirement; fromVoice: boolean } | null>(null);
  #started = false;

  get current(): CurrentChat | null {
    return this.#chat;
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
      this.#upsertConversation(data.conversation);
      // Membership may have changed; member cards drive the @ popup and the
      // group info panel, so refresh them for the open group.
      if (data.conversation.type === 'group' && data.conversation.id === this.currentId) {
        void this.reloadMembers();
      }
    });
    core.onEvent('conversation.deleted', (payload) => {
      const data = payload as { id: string };
      this.conversations = this.conversations.filter((c) => c.id !== data.id);
      if (this.currentId === data.id) this.close();
    });
    core.onEvent('draft.changed', (payload) => {
      const data = payload as { conversationId: string; drafts: Draft[] };
      if (this.currentId === data.conversationId && this.#chat) {
        this.#chat.drafts = data.drafts;
      }
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
        chat.activeRuns = [...chat.activeRuns];
      }
    });
    core.onEvent('bot.updated', (payload) => {
      const data = payload as { bot: Bot };
      this.conversations = this.conversations.map((c) =>
        c.bot?.id === data.bot.id ? { ...c, bot: data.bot } : c,
      );
      if (this.#chat?.conversation.bot?.id === data.bot.id) {
        this.#chat.conversation = { ...this.#chat.conversation, bot: data.bot };
      }
    });
    core.onEvent('bot.deleted', (payload) => {
      const data = payload as { id: string };
      // 已删除 Bot 的只读直聊不再进左栏（03-data-model 数据保留不变，UI 表现
      // 删除效果）；群聊历史里它经 botName 回退为其 id。
      this.conversations = this.conversations.filter((c) => c.directBotId !== data.id);
      if (this.#chat?.conversation.directBotId === data.id) this.close();
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
  }

  /** Opens (or switches to) the direct chat with a bot. */
  async openDirect(botId: string): Promise<void> {
    const result = (await core.call('conversations.openDirect', { botId })) as {
      conversation: ConversationView;
    };
    await this.select(result.conversation.id);
  }

  /**
   * 启动恢复：直接激活上一次对话的会话（最近 lastMessageAt），从没聊过则
   * 打开第一个 Bot 的直聊；一个 Bot 都没有（跳过了初始化向导）时不打开
   * 任何会话，交由调用方进入「选择 Bot」的引导态。
   */
  async restoreLast(): Promise<'conversation' | 'bot' | 'empty'> {
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
    const result = (await core.call('conversations.get', { id: conversationId })) as {
      conversation: ConversationView | null;
    };
    if (!result.conversation) return;
    this.#upsertConversation(result.conversation);
    const messages = await this.#loadLatest(conversationId);
    const drafts = (await core.call('drafts.list', { conversationId })) as { drafts: Draft[] };
    const runs = (await core.call('runs.list', { conversationId, limit: 5 })) as { runs: Run[] };
    const active = runs.runs.filter((r) => isActive(r.status));
    // 带 setup 的旧失败若已被后续响应 run 接手，不再恢复为设置卡（审查 HIGH #1）。
    const failed = restoredFailedRun(runs.runs, this.#dismissedFailedRunIds);
    this.#chat = {
      conversation: result.conversation,
      messages,
      drafts: drafts.drafts,
      activeRuns: active.map((run) => ({ run, progress: '', toolName: '', muted: false })),
      failedRun: failed,
      loadingEarlier: false,
      hasEarlier: messages.length >= PAGE_SIZE,
      members: [],
    };
    this.currentId = conversationId;
    this.replyTo = null;
    // 切换会话撤销门禁缺设置卡（与 close 同理；失败 run 的 setup 卡随
    // failedRun 天然按会话生效，无需处理）。
    this.#pendingSetup = null;
    // 末尾可能是 system_event（如环境安装批准提示），预览要重建到最后一「文本」
    // 消息——与 #ingestMessage 逐条事件记录的行为对齐。
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (this.#noteLastMessage(conversationId, messages[i]!)) break;
    }
    if (result.conversation.type === 'group') await this.reloadMembers();
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
  }

  // --- group management (P05) --------------------------------------------------

  /**
   * 对话内群创建（19/D60）：不再弹框——直接创建「创建中」的群对话并进入，
   * 四问以卡片在对话中逐题收集（零模型调用），完成后群数据一次性生效。
   */
  async createGroupViaSetup(): Promise<Conversation | null> {
    try {
      const result = (await core.call('groups.setup.start')) as { conversation: Conversation };
      await this.refresh();
      await this.select(result.conversation.id);
      return result.conversation;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('group.createFailed')));
      return null;
    }
  }

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

  async renameGroup(conversationId: string, title: string): Promise<void> {
    try {
      const result = (await core.call('groups.rename', { conversationId, title })) as {
        conversation: Conversation;
      };
      this.#upsertConversation(result.conversation);
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async addGroupMembers(conversationId: string, botIds: string[]): Promise<void> {
    try {
      await core.call('groups.addMembers', { conversationId, botIds });
      await this.reloadMembers();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async removeGroupMember(conversationId: string, botId: string): Promise<void> {
    try {
      await core.call('groups.removeMember', { conversationId, botId });
      await this.reloadMembers();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
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
    // 门禁置起的缺设置卡是「本次发送动作」的即时引导：离开会话即撤销
    //（草稿仍在原会话队列，再发送会重新拦下）。
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
    } finally {
      chat.loadingEarlier = false;
    }
  }

  // --- drafts ----------------------------------------------------------------

  async addDraft(
    text: string,
    options: { mentions?: string[]; replyTo?: string | null; attachmentIds?: string[] } = {},
  ): Promise<void> {
    const chat = this.#chat;
    if (!chat) return;
    await core.call('drafts.add', {
      conversationId: chat.conversation.id,
      text,
      ...(options.mentions !== undefined && options.mentions.length > 0
        ? { mentions: options.mentions }
        : {}),
      ...(options.replyTo != null ? { replyTo: options.replyTo } : {}),
      ...(options.attachmentIds !== undefined && options.attachmentIds.length > 0
        ? { attachmentIds: options.attachmentIds }
        : {}),
    });
  }

  /** 移除草稿阶段的附件（docs/design/20-conversation-media.md）；draft.changed 自动刷新。 */
  async detachAttachment(id: string): Promise<void> {
    try {
      await core.call('attachments.detach', { id });
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async updateDraft(id: string, text: string): Promise<void> {
    await core.call('drafts.update', { id, text });
  }

  async removeDraft(id: string): Promise<void> {
    await core.call('drafts.remove', { id });
  }

  async reorderDrafts(ids: string[]): Promise<void> {
    const chat = this.#chat;
    if (!chat) return;
    await core.call('drafts.reorder', { conversationId: chat.conversation.id, ids });
  }

  async flush(): Promise<void> {
    const chat = this.#chat;
    if (!chat) return;
    if (this.#gateForMissingModel()) return;
    try {
      await core.call('drafts.flush', { conversationId: chat.conversation.id });
      this.replyTo = null;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  /** 逐条「立即」：只把这一条草稿发出，其余留在队列里。 */
  async flushOne(id: string): Promise<void> {
    if (this.#gateForMissingModel()) return;
    try {
      await core.call('drafts.flushOne', { id });
      this.replyTo = null;
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  // --- inline setup（对话内设置引导，docs/design/18-inline-setup.md）-----------

  /**
   * 发送门禁（send-gate.ts）：单聊 Bot 跑不起来时不发送——内置 Bot 无可用
   * 模型 → main-model 卡；外部 Agent Bot 未开实验 / 未启用 / 未安装 / 未登录
   * → Agent 设置卡（D72 P4）。置起 pendingSetup，草稿原地保留；设置完成后
   * continueAfterSetup 自动冲掉草稿。快照未加载时放行，由 core 的结构化
   * 失败（run.setup）兜底出卡片。
   */
  #gateForMissingModel(): boolean {
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

  /** 用户关闭设置卡片：门禁撤销、失败横幅一并收起（草稿保留，可再试）。 */
  dismissSetupCard(): void {
    this.#pendingSetup = null;
    const failed = this.#chat?.failedRun;
    if (failed?.setup) this.dismissFailedRun(failed.id);
  }

  /**
   * 输入组件的语音功能（docs/design/26-voice-input.md）在缺设置时置起能力
   * 设置卡：与发送门禁同一层——卡片出现、完成设置后 continueAfterSetup 收卡。
   * 不阻断任何已排队草稿（语音与草稿队列互不相干）。
   */
  requestCapabilitySetup(
    capability: Extract<SetupRequirement, { kind: 'capability-model' }>['capability'],
  ): void {
    if (this.#chat === null) return;
    this.#pendingSetup = { requirement: { kind: 'capability-model', capability }, fromVoice: true };
  }

  /**
   * 卡片内完成设置后的继续：core 失败路径（failedRun.setup）→ 收起横幅并
   * 自动重试原 run（原触发消息照常续跑，覆盖访谈回答 / 群聊 / 图像工具）；
   * 发送门禁路径 → 自动冲掉保留的草稿队列。语音置起的卡片不冲队列——它
   * 不是发送门禁，完成设置后用户自己决定何时发送（26 号设计：互不相干）。
   */
  async continueAfterSetup(): Promise<void> {
    const fromVoice = this.#pendingSetup?.fromVoice === true;
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
    // 发送门禁扣下的草稿在设置完成后照常发出（D58），失败重试之后也一样。
    if (!fromVoice && (this.#chat?.drafts.length ?? 0) > 0) await this.flush();
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

  /** Closes the run-failed banner; the run stays retryable via runs.list. */
  dismissFailedRun(runId: string): void {
    this.#dismissedFailedRunIds.add(runId);
    if (this.#chat?.failedRun?.id === runId) this.#chat.failedRun = null;
  }

  async deleteConversation(id: string): Promise<void> {
    try {
      await core.call('conversations.delete', { id });
      this.conversations = this.conversations.filter((c) => c.id !== id);
      if (this.currentId === id) this.close();
    } catch (error) {
      toast.error(errorText(errorCode(error), t('chats.errorCode.INTERNAL')));
    }
  }

  async markRead(): Promise<void> {
    await this.#markRead();
  }

  // --- internals -----------------------------------------------------------------

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

  async #markRead(): Promise<void> {
    const chat = this.#chat;
    if (!chat || chat.conversation.readOnly) return;
    const lastSeq = chat.messages.at(-1)?.seq;
    if (lastSeq === undefined || lastSeq <= chat.conversation.lastReadSeq) return;
    await core.call('conversations.markRead', {
      conversationId: chat.conversation.id,
      seq: lastSeq,
    });
    chat.conversation = { ...chat.conversation, lastReadSeq: lastSeq };
    this.conversations = this.conversations.map((c) =>
      c.id === chat.conversation.id ? { ...c, lastReadSeq: lastSeq } : c,
    );
  }

  #ingestMessage(conversationId: string, message: Message, own: boolean): void {
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
              c.id === this.currentId || message.senderType === 'user'
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
    const merged: ConversationView = {
      ...conversation,
      unreadCount:
        conversation.unreadCount ?? Math.max(0, conversation.lastSeq - conversation.lastReadSeq),
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
      };
      this.conversations = [...this.conversations];
    } else {
      this.conversations = [merged, ...this.conversations];
    }
    if (this.#chat?.conversation.id === conversation.id) {
      this.#chat.conversation = {
        ...merged,
        bot: conversation.bot ?? this.#chat.conversation.bot,
      };
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
        chat.activeRuns = [...chat.activeRuns, { run, progress: '', toolName: '', muted: false }];
      }
    } else {
      chat.activeRuns = chat.activeRuns.filter((a) => a.run.id !== run.id);
    }
    chat.failedRun =
      run.status === 'failed' && !this.#dismissedFailedRunIds.has(run.id)
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
