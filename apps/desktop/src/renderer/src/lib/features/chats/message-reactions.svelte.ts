import {
  MESSAGE_REACTION_EMOJIS,
  reportTeamSnapshotSchema,
  type Conversation,
  type Message,
  type ReactionSummary,
  type ReportSource,
  type ReportTeamSnapshot,
  type ReportsSubmitOutput,
} from '@kepcup/shared';
import { clientIdentity } from '$lib/features/collab/client-identity';
import { core } from '$lib/rpc/client.svelte';

/**
 * 消息 reaction 状态（AI 内容举报 todo §4 / §5.6 / §6.6）：数据只存本机
 * core main.db（scope 隔离本机 / 团队会话 id），渲染层按 (scope,
 * conversationId) 缓存聚合 map（messageId → ReactionSummary[]），进入会话
 * 时 `messages.reactions` 预取一次、`messages.react` 返回后以响应整体替换
 * ——core 不发 reaction 事件，不做事件订阅。
 *
 * 👎 兼为举报入口（§4.3）：点击即「记 👎 reaction + reports.submit」两个
 * RPC 并发发出、互不等待；无弹窗、无 toast（已定稿决策），reports.submit
 * 的 queued / duplicate / rejected 只进 `reports` 内部状态（devtools 可
 * 观察），重复点击已 👎 的消息是 UI no-op（连 RPC 都不发）。
 */

/** reaction/report 作用域（§5.6）：本机 `local`；团队 `team:<serverHash>`。 */
export type ReactionScope = 'local' | `team:${string}`;

/** SourceId → scope：本机来源 'local'；团队来源本身就是 `team:${hash}` 形状，直通。 */
export function reactionScopeOf(source: 'local' | `team:${string}`): ReactionScope {
  return source;
}

/** SourceId → reports.submit 的 source 段（§5.2）：团队只带 serverHash，永不上传 URL。 */
export function reportSourceOf(source: 'local' | `team:${string}`): ReportSource {
  if (source === 'local') return { kind: 'local' };
  return { kind: 'team', serverHash: source.slice('team:'.length) };
}

/**
 * 面板快捷行（§4.2 第一行 5 个）与「＋」展开的常用表情都取 shared 固定集合
 * 的切片——emoji 集合只在 MESSAGE_REACTION_EMOJIS 一处定义，渲染层不复制。
 */
export const QUICK_REACTION_EMOJIS = MESSAGE_REACTION_EMOJIS.slice(0, 5);
export const MORE_REACTION_EMOJIS = MESSAGE_REACTION_EMOJIS.slice(5);

/** 举报入口 emoji（§4.3）：面板与 chips 的 👎 分支都按它判定。 */
export const REPORT_EMOJI = '👎';

/**
 * 快照所需的会话视图切片（§6.5）：团队来源举报时从渲染层会话视图构建
 * reportTeamSnapshot——消息不在本机 DB，core 无法重读。
 */
export interface ReactionTargetView {
  /** 会话类型（快照 conversation.type；null = 拿不到，快照省略该段）。 */
  conversationType: Conversation['type'] | null;
  /** 已加载的消息窗口（快照的 replyTo / context 从这里取）。 */
  messages: readonly Message[];
  /** 目标消息发送 Bot 的显示名（尽力；空串时快照回退 senderBotId）。 */
  botName: string | null;
}

/** 一次点击 reaction / 举报所需的全部输入（Bar 与右键菜单共用同一构造）。 */
export interface ReactionTarget {
  /** 会话来源（scope 与 reports.submit source 都由它映射）。 */
  source: 'local' | `team:${string}`;
  /** 目标消息（可举报：senderType bot + kind text|card + 未撤回，调用方保证）。 */
  message: Message;
  /** 会话视图切片（团队快照构建用；null = 视图不可得，团队举报将被 core 拒绝）。 */
  view: ReactionTargetView | null;
}

/** reports.submit 结果的内部状态（仅 devtools 观察，UI 不展示；异常记 failed）。 */
export type ReportSubmitState = ReportsSubmitOutput['status'] | 'failed';

/** 单个会话的 reaction 缓存：聚合按 messageId 分组；举报状态按 messageId 记一条。 */
class ConversationReactions {
  summaries = $state<Record<string, ReactionSummary[]>>({});
  reports = $state<Record<string, ReportSubmitState>>({});
}

class MessageReactionsState {
  /** (scope, conversationId) → 缓存。键是簿记，响应式在值对象的 $state 字段上。 */
  #conversations = new Map<string, ConversationReactions>();
  /** 已预取过的会话（core 无 reaction 事件，本会话内一次即可；失败移除允许重试）。 */
  #prefetched = new Set<string>();

  /** 取（或建）一个会话的缓存对象；读取方经由它的 $state 字段建立依赖。 */
  state(scope: ReactionScope, conversationId: string): ConversationReactions {
    const key = conversationKey(scope, conversationId);
    let entry = this.#conversations.get(key);
    if (entry === undefined) {
      entry = new ConversationReactions();
      this.#conversations.set(key, entry);
    }
    return entry;
  }

  /** 进入会话时预取一次整个 conversation 的聚合（幂等；失败可重试）。 */
  async prefetch(source: 'local' | `team:${string}`, conversationId: string): Promise<void> {
    const scope = reactionScopeOf(source);
    const key = conversationKey(scope, conversationId);
    if (this.#prefetched.has(key)) return;
    this.#prefetched.add(key);
    try {
      const result = (await core.call('messages.reactions', {
        scope,
        conversationId,
        clientId: clientIdentity.id,
      })) as { reactions: ReactionSummary[] };
      this.#applySummaries(scope, conversationId, result.reactions);
    } catch (error) {
      this.#prefetched.delete(key);
      console.error('[kepcup] messages.reactions prefetch failed', { conversationId, error });
    }
  }

  /** 目标消息的全部聚合 chip（无 reaction 返回空数组）。 */
  summariesOf(
    source: 'local' | `team:${string}`,
    conversationId: string,
    messageId: string,
  ): ReactionSummary[] {
    return this.state(reactionScopeOf(source), conversationId).summaries[messageId] ?? [];
  }

  /** 本 client 在该消息上的当前 emoji（最多一条；无则 null）。 */
  mineEmojiOf(
    source: 'local' | `team:${string}`,
    conversationId: string,
    messageId: string,
  ): string | null {
    return (
      this.summariesOf(source, conversationId, messageId).find((entry) => entry.mine)?.emoji ??
      null
    );
  }

  /** 最近一次 reports.submit 的内部状态（devtools 观察；无记录 null）。 */
  reportStatusOf(
    source: 'local' | `team:${string}`,
    conversationId: string,
    messageId: string,
  ): ReportSubmitState | null {
    return this.state(reactionScopeOf(source), conversationId).reports[messageId] ?? null;
  }

  /**
   * 点击语义（§4.2 / §4.3）：非 👎 切换本机 reaction（同一个再点 = 取消）；
   * 👎 若已是 👎 则 UI no-op（不发任何 RPC），否则「记 👎 + reports.submit」
   * 两个 RPC 并发、互不等待，全部静默。切换到非 👎 emoji 会替换（含替换 👎
   * 的 reaction 行——举报记录本身不受影响，§4.3「举报不可撤回」）。
   */
  handleReact(target: ReactionTarget, emoji: string): void {
    const conversationId = target.message.conversationId;
    const messageId = target.message.id;
    const mine = this.mineEmojiOf(target.source, conversationId, messageId);
    if (emoji === REPORT_EMOJI) {
      if (mine === REPORT_EMOJI) return;
      void this.#setReaction(target, REPORT_EMOJI);
      void this.#submitReport(target);
      return;
    }
    void this.#setReaction(target, mine === emoji ? null : emoji);
  }

  /** messages.react 往返：以响应整体替换该会话的聚合缓存。 */
  async #setReaction(target: ReactionTarget, emoji: string | null): Promise<void> {
    const conversationId = target.message.conversationId;
    const messageId = target.message.id;
    try {
      const result = (await core.call('messages.react', {
        scope: reactionScopeOf(target.source),
        conversationId,
        messageId,
        clientId: clientIdentity.id,
        emoji,
      })) as { reactions: ReactionSummary[] };
      this.#applySummaries(reactionScopeOf(target.source), conversationId, result.reactions);
    } catch (error) {
      console.error('[kepcup] messages.react failed', { messageId, emoji, error });
    }
  }

  /** reports.submit（§6.5）：只入队不等网络；团队来源必须带渲染层快照。 */
  async #submitReport(target: ReactionTarget): Promise<void> {
    const { source, message, view } = target;
    const scope = reactionScopeOf(source);
    const conversationId = message.conversationId;
    const snapshot =
      source === 'local' ? undefined : (buildTeamSnapshot(message, view) ?? undefined);
    try {
      const result = (await core.call('reports.submit', {
        clientId: clientIdentity.id,
        source: reportSourceOf(source),
        messageId: message.id,
        conversationId,
        surface: 'desktop',
        ...(snapshot !== undefined ? { snapshot } : {}),
      })) as ReportsSubmitOutput;
      this.state(scope, conversationId).reports[message.id] = result.status;
    } catch (error) {
      console.error('[kepcup] reports.submit failed', { messageId: message.id, error });
      this.state(scope, conversationId).reports[message.id] = 'failed';
    }
  }

  /** RPC 返回的是整个 conversation 的聚合：按 messageId 重分组后整体替换。 */
  #applySummaries(scope: ReactionScope, conversationId: string, reactions: ReactionSummary[]): void {
    const byMessage: Record<string, ReactionSummary[]> = {};
    for (const entry of reactions) {
      (byMessage[entry.messageId] ??= []).push(entry);
    }
    this.state(scope, conversationId).summaries = byMessage;
  }
}

function conversationKey(scope: ReactionScope, conversationId: string): string {
  return `${scope}::${conversationId}`;
}

export const messageReactions = new MessageReactionsState();

/** 消息正文（与 core reports 的 messageTextOf 同口径）：content.text 非字符串时为空。 */
export function messageTextOf(message: Message): string {
  const content: unknown = message.content;
  if (content !== null && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * 团队快照（§5.2 / §6.5）：从渲染层会话视图构建 reportTeamSnapshot。message
 * 按现有文本直取（截断由 core 做，渲染层不重复）；replyTo 从已加载窗口找
 * （找不到 = null）；context 取目标消息之前最近 4 条可见消息（跳过
 * system_event / task_event，升序，与 core #contextOf 同口径）。形状以
 * shared schema 自检，非法输入降级返回 null（调用方省略 snapshot，core
 * 以 rejected 静默拒绝）。
 */
export function buildTeamSnapshot(
  message: Message,
  view: ReactionTargetView | null,
): ReportTeamSnapshot | null {
  if (view === null) return null;
  if (message.kind !== 'text' && message.kind !== 'card') return null;
  const replyToMessage =
    message.replyTo !== null
      ? (view.messages.find((item) => item.id === message.replyTo) ?? null)
      : null;
  const context = view.messages
    .filter(
      (item) =>
        item.seq < message.seq &&
        item.kind !== 'system_event' &&
        item.kind !== 'task_event' &&
        item.senderType !== 'system',
    )
    .slice(-4)
    .map((item) => ({
      messageId: item.id,
      senderType: item.senderType as 'user' | 'bot',
      kind: item.kind,
      text: messageTextOf(item),
      createdAt: item.createdAt,
    }));
  const candidate = {
    message: {
      id: message.id,
      seq: message.seq,
      kind: message.kind,
      status: message.status,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      runId: message.runId,
      text: messageTextOf(message),
      content: message.kind === 'card' ? (message.content ?? null) : null,
      truncated: false,
      attachments: message.attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mime: attachment.mime,
        size: attachment.size,
      })),
    },
    replyTo:
      replyToMessage === null ? null : { messageId: replyToMessage.id, text: messageTextOf(replyToMessage) },
    context,
    bot: {
      id: message.senderBotId ?? '',
      name: view.botName || message.senderBotId || '',
    },
    ...(view.conversationType !== null
      ? { conversation: { type: view.conversationType } }
      : {}),
  };
  const parsed = reportTeamSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
