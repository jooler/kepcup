import {
  scheduleDisplayTitle,
  type Bot,
  type Conversation,
  type HandoverAction,
  type MemoryItem,
  type Schedule,
} from '@kepcup/shared';
import type { HandoverAdapter, HandoverContext, HandoverEntry } from '../types.js';
import { keyId } from './common.js';
import { embedBestEffort, handoverMemoryCopy, type HandoverMemoryPort } from './memory.js';

/**
 * 定时任务（D88 §3）：只能移交。A 私聊里的 → 在 B 私聊重建；群里的 → B 是该群成员则在
 * 群里改为 B，否则不可执行。保留 title / note / kind / cron / run_at / timezone / origin；
 * 重建出新回执卡，A 侧取消、原回执卡标「已移交给 {B}」（`ScheduleService.transferTo`，
 * 一个事务）。
 *
 * 承诺联动的任务（P1，§3.1 的唯一例外）：承诺随任务迁移——B 得到承诺副本（新 id，来源
 * 记录同记忆复制），重建的任务接到这条副本上；A 的承诺置 `void`，不再进 A 的
 * `<my_state>`，也不会再提醒。顺序「复制承诺 → 移交任务（事务）→ 作废 A 的承诺」，每步
 * 可重入：崩溃后重跑时副本按来源记录找回、已移交的任务不再重建，只补做剩下的作废。
 * 承诺已失效、用户说过「只告诉 A」的不可执行。
 */

export interface ScheduleAdapterDeps {
  schedules: {
    listActiveForBot(botId: string): Schedule[];
    get(scheduleId: string): Schedule | null;
    transferTo(
      scheduleId: string,
      target: { botId: string; botName: string; conversationId: string; commitmentId?: string },
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
  /** 承诺联动（缺省 = 承诺联动的任务不可执行）。 */
  memory?: Pick<HandoverMemoryPort, 'get' | 'findCopy' | 'insertCopy' | 'embed' | 'voidCommitment'>;
}

/** 关联私密承诺的定时任务在盘点 / 卡片上的名字（不露承诺原文）。 */
export const PRIVATE_COMMITMENT_LABEL = '一条私密承诺的提醒';
const WITH_COMMITMENT = '；连同承诺「';

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

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

  #commitment(row: Schedule): MemoryItem | null {
    if (row.commitmentId === null || this.#deps.memory === undefined) return null;
    return this.#deps.memory.get(row.botId, row.commitmentId);
  }

  /** Why a commitment-linked task cannot move (null = it can, or it has no commitment). */
  #commitmentBlocked(row: Schedule, ownerName: string): string | null {
    if (row.commitmentId === null) return null;
    if (this.#deps.memory === undefined)
      return '这条定时任务与一条承诺联动，当前环境不支持迁移承诺';
    const commitment = this.#commitment(row);
    if (commitment === null || commitment.status !== 'active') {
      return '这条定时任务关联的承诺已失效';
    }
    if (commitment.privateToBot) return `关联的承诺用户说过只告诉 ${ownerName}，不能移交`;
    return null;
  }

  inventory(botId: string): HandoverEntry[] {
    return this.#deps.schedules.listActiveForBot(botId).map((row) => {
      const commitment = this.#commitment(row);
      // 私密承诺（用户说过「只告诉 A」）：任务标题 / 说明就是承诺原文，盘点与卡片里一律
      // 换成中性说法（这一项本来就不可执行）。
      const secret = commitment?.privateToBot === true;
      const sensitive = !secret && commitment?.sensitivity === 'sensitive';
      const where = `${this.#deps.schedules.describeWhen(row)}，${this.#where(row)}`;
      return {
        key: `schedule:${row.id}`,
        type: 'schedule' as const,
        label: secret ? PRIVATE_COMMITMENT_LABEL : scheduleDisplayTitle(row),
        detail: secret
          ? where
          : `${where}${commitment !== null ? `${WITH_COMMITMENT}${clip(commitment.content)}」` : ''}`,
        actions: ['move'],
        defaultAction: 'move',
        blocked: this.#commitmentBlocked(row, '来源 Bot') ?? undefined,
        // 标题 / 说明 / 承诺内容来自模型或用户；群名来自用户。
        external: true,
        // 敏感承诺跟记忆一样：卡上标「敏感」、默认不勾。
        ...(sensitive ? { marks: ['sensitive' as const], defaultSelected: false } : {}),
      };
    });
  }

  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null {
    if (action !== 'move') return '定时任务只能移交';
    const scheduleId = keyId(key, 'schedule') ?? '';
    const row = this.#deps.schedules.get(scheduleId);
    if (row === null) return '这条定时任务已被删除';
    // 崩溃恢复：本次移交已经把任务交给 B、只差作废 A 的承诺——继续执行（apply 只补剩下的）。
    if (ctx.toBot !== null && this.#resumable(ctx, row)) return null;
    if (row.status !== 'active') return '这条定时任务已结束或已取消';
    if (row.botId !== ctx.fromBot.id) return `这条定时任务已不属于 ${ctx.fromBot.name}`;
    const blocked = this.#commitmentBlocked(row, ctx.fromBot.name);
    if (blocked !== null) return blocked;
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
    const memory = this.#deps.memory;
    if (this.#resumable(ctx, row)) {
      // Resumed after a crash between the transfer and voiding A's commitment.
      if (row.commitmentId !== null && memory !== undefined) {
        memory.voidCommitment(row.botId, row.commitmentId);
      }
      return { result: { resumed: true } };
    }
    const conversationId = this.#isDirectOf(row.conversationId, row.botId)
      ? this.#deps.conversations.directIdFor(ctx.toBot.id)
      : row.conversationId;
    let commitmentId: string | undefined;
    if (row.commitmentId !== null) {
      if (memory === undefined) throw new Error('当前环境不支持迁移承诺');
      // 1. B 的承诺副本（按来源记录幂等；上一次没移交成而被作废的不复用，重新复制）。
      let copy = memory.findCopy(ctx.toBot.id, ctx.handoverId, row.commitmentId);
      if (copy === null || copy.status !== 'active') {
        const commitment = memory.get(row.botId, row.commitmentId);
        if (commitment === null || commitment.status !== 'active') {
          throw new Error('这条定时任务关联的承诺已失效');
        }
        copy = memory.insertCopy(
          ctx.toBot.id,
          handoverMemoryCopy(
            commitment,
            { handoverId: ctx.handoverId, fromBotId: ctx.fromBot.id },
            // 承诺随任务所在的对话走（删除对话 / 移出群时按它作废，P07 级联）。
            conversationId,
          ),
        );
        await embedBestEffort(memory, ctx.toBot.id, copy);
      }
      commitmentId = copy.id;
    }
    // 2. 重建 + 取消 + 回执卡（一个事务）。没成（用户在 embed 期间取消了任务、B 退群、
    //    对话变只读……）就作废刚才给 B 的承诺副本，否则 B 的 <my_state> 里会多一条没有
    //    任务、A 也照旧负责的承诺。
    let created: Schedule;
    try {
      created = this.#deps.schedules.transferTo(scheduleId, {
        botId: ctx.toBot.id,
        botName: ctx.toBot.name,
        conversationId,
        ...(commitmentId !== undefined ? { commitmentId } : {}),
      });
    } catch (error) {
      if (row.commitmentId !== null) this.#dropOrphanCopy(ctx, row.commitmentId);
      throw error;
    }
    // 3. A 的承诺作废（不再进 <my_state>、不再提醒）。
    if (row.commitmentId !== null && memory !== undefined) {
      memory.voidCommitment(row.botId, row.commitmentId);
    }
    return {
      result: {
        scheduleId: created.id,
        conversationId,
        ...(commitmentId !== undefined ? { commitmentId } : {}),
      },
    };
  }

  isApplied(ctx: HandoverContext & { toBot: Bot }, key: string): boolean {
    const scheduleId = keyId(key, 'schedule') ?? '';
    if (!this.#deps.schedules.transferredTo(scheduleId, ctx.toBot.id)) return false;
    const row = this.#deps.schedules.get(scheduleId);
    if (row === null || row.commitmentId === null) return true;
    // 承诺联动的：本次移交确实给了 B 承诺副本，且 A 的承诺也作废了才算完成。
    if (!this.#resumable(ctx, row)) return false;
    const commitment = this.#deps.memory?.get(row.botId, row.commitmentId) ?? null;
    return commitment === null || commitment.status !== 'active';
  }

  /** 没做成的一项（跳过 / 失败）：作废本次移交留给 B 的、没接上任务的承诺副本。 */
  abandon(ctx: HandoverContext & { toBot: Bot }, key: string): void {
    const row = this.#deps.schedules.get(keyId(key, 'schedule') ?? '');
    if (row !== null && row.commitmentId !== null) this.#dropOrphanCopy(ctx, row.commitmentId);
  }

  /**
   * 崩溃恢复的捷径只在**本次移交**确实做过第 1 步时走：任务已移交给 B（回执卡标记，或
   * 字段比对兜底），且承诺联动的任务在 B 那里有本次移交的承诺副本——不单靠宽松的字段比对。
   */
  #resumable(ctx: HandoverContext & { toBot: Bot | null }, row: Schedule): boolean {
    if (ctx.toBot === null) return false;
    if (row.commitmentId === null) return false;
    const memory = this.#deps.memory;
    if (memory === undefined || ctx.handoverId.length === 0) return false;
    if (memory.findCopy(ctx.toBot.id, ctx.handoverId, row.commitmentId) === null) return false;
    return this.#deps.schedules.transferredTo(row.id, ctx.toBot.id);
  }

  /**
   * 本次移交给 B 的承诺副本若没有接上 B 的任何 active 任务，就作废它（可重入；已接上的不动——
   * 同一承诺的另一条任务可能已经移交成功）。
   */
  #dropOrphanCopy(ctx: HandoverContext & { toBot: Bot }, commitmentId: string): void {
    const memory = this.#deps.memory;
    if (memory === undefined) return;
    const copy = memory.findCopy(ctx.toBot.id, ctx.handoverId, commitmentId);
    if (copy === null || copy.status !== 'active') return;
    const linked = this.#deps.schedules
      .listActiveForBot(ctx.toBot.id)
      .some((schedule) => schedule.commitmentId === copy.id);
    if (!linked) memory.voidCommitment(ctx.toBot.id, copy.id);
  }

  describe(entry: HandoverEntry, _action: HandoverAction, toName: string): string {
    return entry.detail.includes(WITH_COMMITMENT)
      ? `把定时任务「${entry.label}」（${entry.detail}）移交给 ${toName}：${toName} 接手这条承诺并按时提醒，原来的承诺作废、不再提醒`
      : `把定时任务「${entry.label}」（${entry.detail}）移交给 ${toName}`;
  }
}
