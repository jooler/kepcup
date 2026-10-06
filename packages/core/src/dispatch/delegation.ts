import {
  DELEGATION_FOLLOWUP_EVENT,
  DELEGATION_MAX_DEPTH,
  DELEGATION_RESULT_MAX_CHARS,
  DELEGATION_TASK_MAX_CHARS,
  type Delegation,
  type Message,
  type Run,
} from '@kepcup/shared';
import type { RunIdentity } from '../agent/types.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { DelegationsService } from '../domain/delegations.js';
import type { JobRow, JobsService } from '../domain/jobs.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import { inQuietHours, parseQuietHours, quietHoursEndAt } from '../schedule/guard.js';
import type { DelegationToolFacade } from '../tools/delegation-tools.js';

/**
 * 跨 Bot 委派的宿主侧（D71，docs/design/27-butler-and-delegation.md §3）。
 *
 * - **投递闸门**（§3.5）：只有 B 的私聊邮箱空闲、且不在 B 的免打扰时段时才
 *   投递；否则保持 `submitted` 排队。原因：mailbox 在有在跑 loop 时会把批次
 *   steer 进那个已有 run——run_id / triggerReason / 终回复全会错位。排队保证
 *   每个委派都对应**自己起的** run。代发消息在投递瞬间才落 B 私聊。
 * - **结算**：B 的 run 进入终态时（`#settleRun` 钩子）按 `run_id` 匹配
 *   `working` 委派：A 侧贴结果卡（截断）+ internal follow-up 通知 A。
 * - **单跳**：被委派 run 内再调 `delegate_to_bot` 一律拒绝（执行时按 run_id
 *   反查，不依赖工具注册）。
 */

export interface DelegationHostDeps {
  delegations: DelegationsService;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  jobs: JobsService;
  clock: Clock;
  timeZone: string;
  logger: CoreLogger;
  publish: (event: string, payload: unknown) => void;
  /** True when a deliver() for this pair would start a fresh run right now. */
  isMailboxIdle(botId: string, conversationId: string): boolean;
  /**
   * Hands the proxied user message to B's mailbox (reason 'delegation');
   * returns the run that absorbed it (null = not started).
   */
  deliverToBot(input: {
    botId: string;
    conversationId: string;
    message: Message;
    extraAttributes: Record<string, string | number>;
  }): string | null;
  cancelRun(runId: string): void;
  /** deliverEventToBot (internal follow-up into A's conversation). */
  deliverEvent(
    botId: string,
    conversationId: string,
    event: string,
    text: string,
    options: { internal?: boolean },
  ): void;
}

/** Card types of the two A-side delegation cards. */
export const DELEGATION_SENT_CARD = 'delegation_sent';
export const DELEGATION_RESULT_CARD = 'delegation_result';

/** Characters of the task / result shown on a context line (cards stay short in context). */
const CONTEXT_PREVIEW_CHARS = 300;

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Truncates B's reply for the result card (character budget, not tokens). */
export function truncateDelegationResult(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DELEGATION_RESULT_MAX_CHARS
    ? `${trimmed.slice(0, DELEGATION_RESULT_MAX_CHARS)}…`
    : trimmed;
}

type DeliveryOutcome = 'delivered' | 'busy' | 'parked' | 'failed';

export class DelegationHost implements DelegationToolFacade {
  readonly #deps: DelegationHostDeps;

  constructor(deps: DelegationHostDeps) {
    this.#deps = deps;
  }

  // --- tools ------------------------------------------------------------------

  delegate(
    identity: RunIdentity,
    input: { botId: string; task: string },
  ): { ok: boolean; message: string } {
    const { botId: fromBotId, conversationId } = identity;
    if (fromBotId === null || conversationId === null) {
      return { ok: false, message: '当前执行没有对话上下文，无法委派' };
    }
    const task = input.task.trim();
    if (task.length === 0) return { ok: false, message: 'task 不能为空：写清楚要 B 做什么' };
    if (task.length > DELEGATION_TASK_MAX_CHARS) {
      return {
        ok: false,
        message: `task 太长（≤ ${DELEGATION_TASK_MAX_CHARS} 字）：大段材料先写进文件，再在 task 里说明位置`,
      };
    }
    // 单跳（§3.3）：被委派 run 内不能再委派——执行时按 run_id 反查。
    const parent = this.#deps.delegations.workingByRun(identity.runId);
    const depth = (parent?.depth ?? 0) + 1;
    if (parent !== null || depth > DELEGATION_MAX_DEPTH) {
      const fromName = parent !== null ? this.#botName(parent.fromBotId) : '其他 Bot';
      return {
        ok: false,
        message: `你正在处理 ${fromName} 转交的任务，被委派的执行不能再委派：请自己完成，或在回复里说明需要谁来协助。`,
      };
    }
    const toBotId = input.botId.trim();
    if (toBotId === fromBotId) return { ok: false, message: '不能委派给自己' };
    const target = this.#deps.bots.get(toBotId);
    if (target === null || target.status !== 'active') {
      return { ok: false, message: `Bot ${toBotId} 不存在或已删除（先用 list_bots 查看通讯录）` };
    }
    if (target.systemRole === 'butler') {
      return { ok: false, message: '不能委派给管家：管家负责分诊和路由，不接受转交的任务' };
    }
    if (target.setupState === 'interviewing') {
      return { ok: false, message: `${target.name} 还在初始化访谈中，暂时不能接收任务` };
    }
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation === null || conversation.readOnly) {
      return { ok: false, message: '当前对话不可用，无法委派' };
    }
    if (conversation.type === 'group') {
      // 群降级（§3.3）：同群用 @；B 不在群里则首期不支持。
      return this.#deps.conversations.memberBotIds(conversationId).includes(toBotId)
        ? {
            ok: false,
            message: `${target.name} 就在这个群里：直接用 send_message 并在 mention_bot_ids 里 @ 它，不需要委派。`,
          }
        : {
            ok: false,
            message: `${target.name} 不在这个群里。群聊里不支持跨对话委派：可以建议用户把它拉进群后再 @，或请用户去私聊里处理。`,
          };
    }
    const duplicate = this.#deps.delegations.activeBetween(conversationId, toBotId);
    if (duplicate !== null) {
      return {
        ok: false,
        message: `已有一个转交给 ${target.name} 的任务还没结束（${duplicate.id}）：等它的结果，不要重复委派。`,
      };
    }

    const created = this.#deps.delegations.create({
      fromBotId,
      toBotId,
      fromConversationId: conversationId,
      taskText: task,
      depth,
      fromRunId: identity.runId,
    });
    const card = this.#appendCard(conversationId, DELEGATION_SENT_CARD, created.id);
    this.#publish(this.#deps.delegations.patch(created.id, { sentMessageId: card.id }));
    this.deliverPending(toBotId);

    const after = this.#deps.delegations.getOrThrow(created.id);
    if (after.status === 'working') {
      return {
        ok: true,
        message: `已转交给 ${target.name}（delegation_id: ${after.id}），它正在处理。结果会以结果卡展示给用户，并以内部通知告诉你。现在简短告诉用户已转交即可，然后结束本轮：不要等待、不要轮询。`,
      };
    }
    if (after.status === 'submitted') {
      return {
        ok: true,
        message: `已登记转交给 ${target.name}（delegation_id: ${after.id}）：它现在正忙或处于免打扰时段，会在空闲后自动发送。结果出来时会通知你。现在简短告诉用户即可，然后结束本轮。`,
      };
    }
    return {
      ok: false,
      message: `转交给 ${target.name} 失败：${after.errorText ?? '投递失败'}`,
    };
  }

  cancelFromTool(identity: RunIdentity, delegationId: string): { ok: boolean; message: string } {
    const delegation = this.#deps.delegations.get(delegationId.trim());
    if (delegation === null || delegation.fromBotId !== identity.botId) {
      return { ok: false, message: `没有找到你发起的委派 ${delegationId}` };
    }
    if (delegation.status !== 'submitted' && delegation.status !== 'working') {
      return { ok: false, message: `委派 ${delegation.id} 已经结束（${delegation.status}），无需取消` };
    }
    this.cancel(delegation.id, '发起方取消');
    return { ok: true, message: `已取消委派 ${delegation.id}。` };
  }

  // --- lifecycle of one delegation ----------------------------------------------

  /**
   * Cancels a non-terminal delegation (A's tool, A-side card, lifecycle). The
   * row turns `cancelled` BEFORE B's run is aborted, so the settle hook sees a
   * non-working row and stays silent (no result card / follow-up for a
   * cancel A itself asked for).
   */
  cancel(delegationId: string, reason: string): Delegation | null {
    const cancelled = this.#deps.delegations.transition(
      delegationId,
      ['submitted', 'working'],
      'cancelled',
      { errorText: reason },
    );
    if (cancelled === null) return this.#deps.delegations.get(delegationId);
    this.#publish(cancelled);
    if (cancelled.runId !== null) {
      try {
        this.#deps.cancelRun(cancelled.runId);
      } catch (error) {
        this.#deps.logger.warn(
          { delegationId, error: error instanceof Error ? error.message : String(error) },
          'aborting delegated run failed',
        );
      }
    }
    return cancelled;
  }

  /**
   * Delivers the oldest undelivered delegation to `toBotId` if the gate is
   * open; further ones wait for that run to release B's mailbox (FIFO, one at
   * a time — each delegation gets its own run).
   */
  deliverPending(toBotId: string): void {
    for (const delegation of this.#deps.delegations.submittedFor(toBotId)) {
      const outcome = this.#tryDeliver(delegation);
      // 'failed' rows are terminal now: move on to the next one.
      if (outcome !== 'failed') return;
    }
  }

  #tryDeliver(delegation: Delegation): DeliveryOutcome {
    const target = this.#deps.bots.get(delegation.toBotId);
    if (target === null || target.status !== 'active') {
      this.#fail(delegation, `${target?.name || delegation.toBotId} 已不存在`);
      return 'failed';
    }
    // 免打扰（开放决策 6）：委派属于主动打扰 B 的一类，遵守 B 的 quiet hours。
    const quiet = parseQuietHours(target.profile.behavior.quiet_hours);
    const now = this.#deps.clock.now();
    if (quiet !== null && inQuietHours(now, quiet, this.#deps.timeZone)) {
      this.#deps.jobs.enqueue({
        type: 'delegation_delivery',
        botId: delegation.toBotId,
        conversationId: delegation.fromConversationId,
        priority: 2,
        payload: { delegationId: delegation.id },
        runAfter: quietHoursEndAt(now, quiet, this.#deps.timeZone),
        dedupeKey: `delegation_delivery:${delegation.toBotId}`,
      });
      return 'parked';
    }
    const { conversation, created } = this.#deps.conversations.openDirect(delegation.toBotId);
    if (created) this.#deps.publish('conversation.updated', { conversation });
    if (!this.#deps.isMailboxIdle(delegation.toBotId, conversation.id)) return 'busy';

    const fromName = this.#botName(delegation.fromBotId);
    const message = this.#deps.messages.append({
      conversationId: conversation.id,
      senderType: 'user',
      kind: 'text',
      text: delegation.taskText,
      delegation: { delegationId: delegation.id, delegatedBy: delegation.fromBotId },
      batchId: `batch_${now}_${Math.random().toString(36).slice(2, 8)}`,
    });
    this.#deps.publish('message.created', { conversationId: conversation.id, message });
    const runId = this.#deps.deliverToBot({
      botId: delegation.toBotId,
      conversationId: conversation.id,
      message,
      extraAttributes: { from_bot: fromName, delegation_id: delegation.id },
    });
    if (runId === null) {
      this.#fail(delegation, '投递失败：B 的对话暂时无法接收消息', {
        toConversationId: conversation.id,
        toMessageId: message.id,
      });
      return 'failed';
    }
    const working = this.#deps.delegations.transition(delegation.id, ['submitted'], 'working', {
      toConversationId: conversation.id,
      toMessageId: message.id,
      runId,
    });
    if (working !== null) this.#publish(working);
    return 'delivered';
  }

  /** B's mailbox released: the next queued delegation to B (if any) may go now. */
  onMailboxIdle(botId: string, conversationId: string): void {
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation === null || conversation.type !== 'direct') return;
    if (conversation.directBotId !== botId) return;
    this.deliverPending(botId);
  }

  /** jobs-runner `delegation_delivery`: quiet hours ended — re-run the gate. */
  deliverParked(job: JobRow): void {
    if (job.bot_id === null) return;
    this.deliverPending(job.bot_id);
  }

  /**
   * Settle hook (`#settleRun`, any terminal status): the `working` delegation
   * B's run was executing gets its result. Non-response runs and runs without
   * a working delegation are ignored.
   */
  onRunSettled(run: Run): void {
    if (run.loopType !== 'response') return;
    const delegation = this.#deps.delegations.workingByRun(run.id);
    if (delegation === null) return;
    this.#settle(delegation, run);
  }

  #settle(delegation: Delegation, run: Run): void {
    const toName = this.#botName(delegation.toBotId);
    if (run.status === 'completed') {
      const reply = this.#finalReply(delegation, run.id);
      const excerpt =
        reply !== null ? truncateDelegationResult(textOf(reply)) : '（B 没有给出文字回复）';
      const card = this.#conversationAlive(delegation.fromConversationId)
        ? this.#appendCard(delegation.fromConversationId, DELEGATION_RESULT_CARD, delegation.id)
        : null;
      const completed = this.#deps.delegations.transition(
        delegation.id,
        ['working'],
        'completed',
        {
          resultExcerpt: excerpt,
          resultMessageId: reply?.id ?? null,
          resultCardId: card?.id ?? null,
        },
      );
      if (completed === null) return;
      this.#publish(completed);
      this.#notifyA(
        completed,
        [
          `委派结果通知（来源：delegate_to_bot，delegation_id: ${completed.id}；宿主系统注入，不是用户消息）。`,
          `${toName} 已完成你转交的任务。它的回复已作为结果卡展示给用户（用户能看到原文，可点开查看全文）：`,
          `<untrusted>\n${excerpt}\n</untrusted>`,
          '不要把上面的内容再复述一遍；如有必要只做一两句转述，或说明下一步。',
        ].join('\n'),
      );
      return;
    }
    const status = run.status === 'cancelled' ? 'cancelled' : 'failed';
    const errorText =
      status === 'cancelled'
        ? `${toName} 的执行被取消`
        : `${toName} 的执行失败${run.error ? `：${preview(run.error, 200)}` : ''}`;
    this.#fail(delegation, errorText, {}, status);
  }

  /** Terminal failure / cancellation with an A-side result card + follow-up. */
  #fail(
    delegation: Delegation,
    errorText: string,
    patch: { toConversationId?: string; toMessageId?: string } = {},
    status: 'failed' | 'cancelled' = 'failed',
  ): void {
    const card = this.#conversationAlive(delegation.fromConversationId)
      ? this.#appendCard(delegation.fromConversationId, DELEGATION_RESULT_CARD, delegation.id)
      : null;
    const ended = this.#deps.delegations.transition(
      delegation.id,
      ['submitted', 'working'],
      status,
      { ...patch, errorText, resultCardId: card?.id ?? null },
    );
    if (ended === null) return;
    this.#publish(ended);
    this.#notifyA(
      ended,
      [
        `委派结果通知（来源：delegate_to_bot，delegation_id: ${ended.id}；宿主系统注入，不是用户消息）。`,
        `转交给 ${this.#botName(ended.toBotId)} 的任务没有完成：${errorText}。`,
        '请如实告诉用户，并决定是否换个方式处理；不要原样重复委派。',
      ].join('\n'),
    );
  }

  /** B's last text reply in the delegated run (the final reply lands before settle). */
  #finalReply(delegation: Delegation, runId: string): Message | null {
    if (delegation.toConversationId === null) return null;
    const messages = this.#deps.messages.list(delegation.toConversationId, { limit: 200 });
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (
        message.runId === runId &&
        message.senderType === 'bot' &&
        message.kind === 'text' &&
        message.status !== 'recalled' &&
        textOf(message).trim().length > 0
      ) {
        return message;
      }
    }
    return null;
  }

  // --- recovery & lifecycle -------------------------------------------------------

  /**
   * Startup (after runs were marked interrupted): working delegations whose
   * run is terminal are settled (interrupted → failed, D49 ephemeral — never
   * resumed); undelivered ones re-enter the gate (mailboxes are empty now).
   */
  recover(): void {
    const targets = new Set<string>();
    for (const delegation of this.#deps.delegations.listActive()) {
      if (delegation.status === 'submitted') {
        targets.add(delegation.toBotId);
        continue;
      }
      const run = delegation.runId !== null ? this.#deps.runs.get(delegation.runId) : null;
      if (run === null) {
        this.#fail(delegation, '应用重启时执行记录已不存在');
      } else if (isTerminalRun(run.status)) {
        this.#settle(delegation, {
          ...run,
          ...(run.status === 'interrupted' && run.error === null
            ? { error: '上次执行因应用退出而中断' }
            : {}),
        });
      }
    }
    for (const botId of targets) this.deliverPending(botId);
  }

  /** A conversation is being deleted: delegations on either side end (no follow-up). */
  onConversationDeleted(conversationId: string): void {
    for (const delegation of this.#deps.delegations.listActiveForConversation(conversationId)) {
      this.cancel(delegation.id, '对话已删除');
    }
  }

  /** A bot is being deleted: delegations it sent or received end (no follow-up). */
  onBotDeleted(botId: string): void {
    for (const delegation of this.#deps.delegations.listActiveForBot(botId)) {
      this.cancel(delegation.id, 'Bot 已删除');
    }
  }

  // --- rendering ---------------------------------------------------------------

  /** One context line for an A-side delegation card (status + short preview, never B's full text). */
  renderContextLine(cardType: string, delegationId: string): string {
    const delegation = this.#deps.delegations.get(delegationId);
    if (delegation === null) return '（委派记录已清理）';
    const toName = this.#botName(delegation.toBotId);
    if (cardType === DELEGATION_SENT_CARD) {
      return `[系统] 已委托给 ${toName}（${delegation.id}，${STATUS_TEXT[delegation.status]}）：${preview(delegation.taskText, CONTEXT_PREVIEW_CHARS)}`;
    }
    if (delegation.status === 'completed') {
      return `[系统] ${toName} 的回复（${delegation.id}，结果卡，用户可见）：${preview(delegation.resultExcerpt ?? '', CONTEXT_PREVIEW_CHARS)}`;
    }
    return `[系统] 转交给 ${toName} 的任务${STATUS_TEXT[delegation.status]}（${delegation.id}）：${delegation.errorText ?? ''}`;
  }

  get(delegationId: string): Delegation | null {
    return this.#deps.delegations.get(delegationId);
  }

  // --- internals ---------------------------------------------------------------

  #appendCard(conversationId: string, cardType: string, delegationId: string): Message {
    const card = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'card',
      cardType,
      cardDelegationId: delegationId,
    });
    this.#deps.publish('message.created', { conversationId, message: card });
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation !== null) this.#deps.publish('conversation.updated', { conversation });
    return card;
  }

  #notifyA(delegation: Delegation, text: string): void {
    this.#deps.deliverEvent(
      delegation.fromBotId,
      delegation.fromConversationId,
      DELEGATION_FOLLOWUP_EVENT,
      text,
      { internal: true },
    );
  }

  #publish(delegation: Delegation): void {
    this.#deps.publish('delegation.updated', { delegation });
  }

  #conversationAlive(conversationId: string): boolean {
    const conversation = this.#deps.conversations.get(conversationId);
    return conversation !== null && !conversation.readOnly;
  }

  #botName(botId: string): string {
    const bot = this.#deps.bots.get(botId);
    return bot?.name || botId;
  }
}

const STATUS_TEXT: Record<Delegation['status'], string> = {
  submitted: '排队中，B 空闲后发送',
  working: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function isTerminalRun(status: Run['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function textOf(message: Message): string {
  const content = message.content as { text?: unknown };
  return typeof content.text === 'string' ? content.text : '';
}
