import {
  scheduleDisplayTitle,
  type Bot,
  type Conversation,
  type HandoverAction,
  type Schedule,
} from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';

/**
 * 定时任务（D88 §3）：只能移交。A 私聊里的 → 在 B 私聊重建；群里的 → B 是该群成员则在
 * 群里改为 B，否则不可执行。保留 title / note / kind / cron / run_at / timezone / origin；
 * 重建出新回执卡，A 侧取消、原回执卡标「已移交给 {B}」（`ScheduleService.transferTo`，
 * 一个事务）。与承诺联动的置灰（P1 随承诺一起迁移）。
 */

export interface ScheduleAdapterDeps {
  schedules: {
    listActiveForBot(botId: string): Schedule[];
    get(scheduleId: string): Schedule | null;
    transferTo(
      scheduleId: string,
      target: { botId: string; botName: string; conversationId: string },
    ): Schedule;
    transferredTo(scheduleId: string, botId: string): boolean;
    describeWhen(row: Schedule): string;
  };
  conversations: {
    get(conversationId: string): Conversation | null;
    memberBotIds(conversationId: string): string[];
    /** The bot's direct chat id (opened when missing). */
    directIdFor(botId: string): string;
  };
}

const COMMITMENT_BLOCKED = '这条定时任务与一条承诺联动，要随承诺一起迁移（之后的版本支持）';

export class ScheduleAdapter implements HandoverAdapter {
  readonly type = 'schedule' as const;
  readonly stage = 4;
  readonly #deps: ScheduleAdapterDeps;

  constructor(deps: ScheduleAdapterDeps) {
    this.#deps = deps;
  }

  owns(key: string): boolean {
    return keyId(key, 'schedule') !== null;
  }

  /** A 私聊里的任务（null = 群里的，或对话已不存在）。 */
  #isDirectOf(conversationId: string, botId: string): boolean {
    const conversation = this.#deps.conversations.get(conversationId);
    return conversation?.type === 'direct' && conversation.directBotId === botId;
  }

  #where(row: Schedule): string {
    if (this.#isDirectOf(row.conversationId, row.botId)) return '私聊';
    const conversation = this.#deps.conversations.get(row.conversationId);
    return `群「${conversation?.title ?? row.conversationId}」`;
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.schedules.listActiveForBot(botId).map((row) => ({
      key: `schedule:${row.id}`,
      type: 'schedule' as const,
      label: scheduleDisplayTitle(row),
      detail: `${this.#deps.schedules.describeWhen(row)}，${this.#where(row)}`,
      actions: ['move'],
      defaultAction: 'move',
      blocked: row.commitmentId !== null ? COMMITMENT_BLOCKED : undefined,
      // 标题 / 说明来自模型或用户；群名来自用户。
      external: true,
    }));
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'move') return '定时任务只能移交';
    const row = this.#deps.schedules.get(keyId(key, 'schedule') ?? '');
    if (row === null) return '这条定时任务已被删除';
    if (row.status !== 'active') return '这条定时任务已结束或已取消';
    if (row.botId !== ctx.fromBot.id) return `这条定时任务已不属于 ${ctx.fromBot.name}`;
    if (row.commitmentId !== null) return COMMITMENT_BLOCKED;
    if (this.#isDirectOf(row.conversationId, row.botId)) return null;
    const conversation = this.#deps.conversations.get(row.conversationId);
    if (conversation === null || conversation.readOnly) return '这条定时任务所在的对话已不可用';
    const member =
      ctx.toBot !== null &&
      this.#deps.conversations.memberBotIds(row.conversationId).includes(ctx.toBot.id);
    return member ? null : `${ctx.toName} 不在群「${conversation.title ?? conversation.id}」里`;
  }

  async apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
  ): Promise<{ result: Record<string, unknown> }> {
    const scheduleId = keyId(key, 'schedule') ?? '';
    const row = this.#deps.schedules.get(scheduleId);
    if (row === null) throw new Error('这条定时任务已被删除');
    const conversationId = this.#isDirectOf(row.conversationId, row.botId)
      ? this.#deps.conversations.directIdFor(ctx.toBot.id)
      : row.conversationId;
    const created = this.#deps.schedules.transferTo(scheduleId, {
      botId: ctx.toBot.id,
      botName: ctx.toBot.name,
      conversationId,
    });
    return { result: { scheduleId: created.id, conversationId } };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    return this.#deps.schedules.transferredTo(keyId(key, 'schedule') ?? '', ctx.toBot.id);
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    return `把定时任务「${entry.label}」（${entry.detail}）移交给 ${toName}`;
  }
}
