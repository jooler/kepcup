import {
  AppError,
  BUTLER_PROPOSAL_FOLLOWUP_EVENT,
  ROUTE_SUGGESTION_EVENT,
  butlerProposalPayloadSchema,
  type Bot,
  type ButlerProposalPayload,
  type ChatModelOption,
  type Message,
} from '@kepcup/shared';
import type { RunIdentity } from '../agent/types.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { ProjectsService } from '../domain/projects.js';
import type { MessagesService } from '../domain/messages.js';
import type { ApprovalOutcome, ApprovalsService } from '../permissions/approvals.js';
import type { BotCardLine, ButlerToolFacade, RouteSuggestion } from '../tools/butler-tools.js';
import type { ScheduleToolFacade } from '../tools/schedule-tools.js';
import {
  announceCreatedBot,
  createProposedBotRecord,
  createProposedRoutines,
} from './bot-creation.js';

/**
 * 管家提议的宿主侧（D70，docs/design/27-butler-and-delegation.md §2.2）：
 * 提议卡走非阻塞审批（`submitNonBlocking`，卡片与管家的 run 脱钩），用户
 * 决定后在回调里**确定性**创建 Bot / 群——不经模型再编造任何字段；结果以
 * internal follow-up 唤醒管家，由它对用户说下一步。
 */

export interface ButlerHostDeps {
  bots: BotsService;
  conversations: ConversationsService;
  projects: ProjectsService;
  approvals: ApprovalsService;
  messages: MessagesService;
  logger: CoreLogger;
  /** D80: routines of proposed bots (optional in stripped setups: routines are dropped). */
  schedule?: Pick<ScheduleToolFacade, 'createFromWhen' | 'validateWhen' | 'describeWhen'> | undefined;
  /**
   * D88: the available chat models (same source as the Bot detail dropdown) a proposed
   * bot's `model` must be one of. Absent = no model can be named.
   */
  modelOptions?: (() => ChatModelOption[]) | undefined;
  /** Direct-chat delivery through the setup gate (a user message in the butler's chat). */
  deliverDirect(conversationId: string, botId: string, message: Message): void;
  publish: (event: string, payload: unknown) => void;
  /** deliverEventToBot (internal follow-up into the butler's conversation). */
  deliverEvent(
    botId: string,
    conversationId: string,
    event: string,
    text: string,
    options: { internal?: boolean },
  ): void;
}

export class ButlerHost implements ButlerToolFacade {
  readonly #deps: ButlerHostDeps;

  constructor(deps: ButlerHostDeps) {
    this.#deps = deps;
  }

  validateRoutineWhen(when: string, timezone: string | null): string | null {
    const schedule = this.#deps.schedule;
    if (schedule === undefined) return '当前环境不支持定时任务';
    try {
      schedule.validateWhen(when, timezone);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  validateModelRef(ref: string): string | null {
    const options = this.#deps.modelOptions?.() ?? [];
    if (options.some((option) => option.ref === ref)) return null;
    return options.length === 0
      ? '当前没有可选的模型（设置里还没有配置模型厂商的 Key）；不填即跟随设置默认'
      : `「${ref}」不在可用模型列表里（可用：${options.map((option) => option.ref).join('、')}）`;
  }

  listBots(selfBotId: string): BotCardLine[] {
    return this.#deps.bots
      .listActive()
      .filter((bot) => bot.id !== selfBotId && bot.setupState !== 'interviewing')
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        bio: bot.bio,
        expertise: bot.profile.role.expertise,
        responsibilities: bot.profile.role.responsibilities,
        butler: bot.systemRole === 'butler',
      }));
  }

  propose(identity: RunIdentity, payload: ButlerProposalPayload): { ok: boolean; message: string } {
    const { botId, conversationId } = identity;
    if (botId === null || conversationId === null) {
      return { ok: false, message: '当前执行没有对话上下文，无法提交提议' };
    }
    const butler = this.#deps.bots.get(botId);
    if (butler?.systemRole !== 'butler') {
      return { ok: false, message: '只有管家可以提议组队 / 建 Bot / 建群' };
    }
    // D88: a pending handover card blocks a proposal too (one pending proposal per chat).
    if (
      this.#deps.approvals.pendingOfKind(conversationId, 'butler_proposal').length > 0 ||
      this.#deps.approvals.pendingOfKind(conversationId, 'bot_handover').length > 0
    ) {
      return {
        ok: false,
        message: '已有一张提议卡在等用户确认：等用户处理完再提新的，不要叠加提议。',
      };
    }
    if (payload.proposalType === 'group') {
      const missing = payload.memberBotIds.filter((id) => {
        const bot = this.#deps.bots.get(id);
        return bot === null || bot.status !== 'active';
      });
      if (missing.length > 0) {
        return {
          ok: false,
          message: `这些 bot_id 不存在或已删除：${missing.join('、')}（先用 list_bots 查看通讯录）`,
        };
      }
    }
    this.#deps.approvals.submitNonBlocking(
      identity,
      'butler_proposal',
      payload as unknown as Record<string, unknown>,
      (outcome) => this.#onDecided(outcome),
    );
    // 管家访谈（D70）以提议为终点：提交即离开访谈态，卡片被拒后回到普通对话。
    if (butler.setupState === 'interviewing') {
      const updated = this.#deps.bots.clearSetupState(botId);
      this.#deps.publish('bot.updated', { bot: updated });
    }
    return {
      ok: true,
      message:
        '提议卡已发给用户，等用户确认（可能需要一段时间）。用户决定后宿主会通知你结果；在此之前不要声称已经创建，也不要重复提议。',
    };
  }

  suggestRoute(identity: RunIdentity, route: RouteSuggestion): { ok: boolean; message: string } {
    const { botId, conversationId } = identity;
    if (botId === null || conversationId === null) {
      return { ok: false, message: '当前执行没有对话上下文，无法给出路由建议' };
    }
    if (this.#deps.bots.get(botId)?.systemRole !== 'butler') {
      return { ok: false, message: '只有管家可以给出路由建议' };
    }
    let targetName: string;
    if (route.kind === 'group') {
      const group = this.#deps.conversations.get(route.conversationId ?? '');
      if (group === null || group.type !== 'project' || group.readOnly) {
        return { ok: false, message: `群 ${route.conversationId ?? ''} 不存在或不可用` };
      }
      targetName = group.title ?? group.id;
    } else {
      const target = this.#deps.bots.get(route.botId ?? '');
      if (target === null || target.status !== 'active' || target.id === botId) {
        return { ok: false, message: `Bot ${route.botId ?? ''} 不存在或不可用（先用 list_bots 查看通讯录）` };
      }
      if (target.systemRole === 'butler') return { ok: false, message: '不能把事情路由回管家自己' };
      targetName = target.name;
    }
    const headline =
      route.kind === 'bot'
        ? `管家建议：直接去和 ${targetName} 聊`
        : route.kind === 'group'
          ? `管家建议：去群「${targetName}」里处理`
          : `管家建议：交给 ${targetName} 处理，结果贴回这里`;
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: ROUTE_SUGGESTION_EVENT,
      text: `${headline}——${route.reason}`,
      route: {
        kind: route.kind,
        ...(route.botId !== undefined ? { botId: route.botId } : {}),
        ...(route.conversationId !== undefined ? { conversationId: route.conversationId } : {}),
        ...(route.task !== undefined ? { task: route.task } : {}),
      },
    });
    this.#deps.publish('message.created', { conversationId, message });
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation !== null) this.#deps.publish('conversation.updated', { conversation });
    return {
      ok: true,
      message:
        route.kind === 'delegate'
          ? '路由卡已展示给用户。用户点「交给它处理」后你会收到确认消息，那时再调用 delegate_to_bot；在此之前不要自行委派。'
          : '路由卡已展示给用户，用户可以一键跳转。',
    };
  }

  /**
   * The user clicked 「交给它处理」 on a delegate route card (D70 §2.4 「你安排」):
   * a real user message lands in the butler's chat and triggers its run — the
   * butler then calls delegate_to_bot with the user's go-ahead in context.
   */
  acceptRoute(messageId: string): Message {
    const card = this.#deps.messages.getById(messageId);
    const content = card?.content as
      | { event?: string; route?: { kind: string; botId?: string; task?: string } }
      | undefined;
    if (card === null || content?.event !== ROUTE_SUGGESTION_EVENT || content.route === undefined) {
      throw new AppError('INVALID_INPUT', '不是路由建议卡');
    }
    if (content.route.kind !== 'delegate') {
      throw new AppError('INVALID_INPUT', '这张路由卡不需要管家代办');
    }
    const conversation = this.#deps.conversations.getOrThrow(card.conversationId);
    if (conversation.readOnly) throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    const butlerId = conversation.directBotId;
    if (conversation.type !== 'direct' || butlerId === null) {
      throw new AppError('INVALID_INPUT', '路由卡只在管家的私聊里可用');
    }
    if (this.#deps.bots.get(butlerId)?.systemRole !== 'butler') {
      throw new AppError('INVALID_INPUT', '路由卡只在管家的私聊里可用');
    }
    const target = this.#deps.bots.get(content.route.botId ?? '');
    const name = target?.name || content.route.botId || '';
    const message = this.#deps.messages.append({
      conversationId: conversation.id,
      senderType: 'user',
      kind: 'text',
      text: `好，你安排吧：请把这件事交给 ${name}（${content.route.botId ?? ''}）处理${content.route.task ? `——${content.route.task}` : ''}。`,
      batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    this.#deps.publish('message.created', { conversationId: conversation.id, message });
    this.#deps.deliverDirect(conversation.id, butlerId, message);
    return message;
  }

  /** The user's decision on a butler_proposal card (unattended never auto-decides it). */
  #onDecided(outcome: ApprovalOutcome): void {
    const approval = outcome.approval;
    const butlerId = approval.botId;
    const conversationId = approval.conversationId;
    if (outcome.decision === 'cancelled' || butlerId === null || conversationId === null) return;
    const parsed = butlerProposalPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) {
      this.#deps.logger.warn({ approvalId: approval.id }, 'butler proposal with malformed payload');
      return;
    }
    const proposal = parsed.data;
    if (outcome.decision === 'denied') {
      this.#notify(
        butlerId,
        conversationId,
        [
          '提议处理结果（宿主系统注入，不是用户消息）：用户没有采纳你的提议。',
          '可以简短问问用户想怎么调整，或按用户的意见重新提议；不要原样重复同一个提议。',
        ].join('\n'),
      );
      return;
    }
    try {
      const lines =
        proposal.proposalType === 'group'
          ? this.#createProject(proposal)
          : this.#createBots(
              approval.id,
              proposal,
              approval.decision?.selection,
              approval.decision?.routineSelection,
            );
      this.#notify(butlerId, conversationId, lines.join('\n'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#deps.logger.warn({ approvalId: approval.id, error: reason }, 'butler proposal failed');
      this.#failApproval(approval.id, reason);
      this.#notify(
        butlerId,
        conversationId,
        `提议处理结果（宿主系统注入，不是用户消息）：用户确认了提议，但执行失败：${reason}。请如实告诉用户，必要时换个方式再提议。`,
      );
    }
  }

  #createBots(
    approvalId: string,
    proposal: Extract<ButlerProposalPayload, { proposalType: 'team' | 'bot' }>,
    selection: number[] | undefined,
    routineSelection: string[] | undefined,
  ): string[] {
    const indexes = selection ?? proposal.bots.map((_, index) => index);
    const keptRoutines = routineSelection !== undefined ? new Set(routineSelection) : null;
    const offset = this.#deps.bots.listActive().length;
    const created: Bot[] = [];
    const failed: string[] = [];
    const routineLines: string[] = [];
    const routineFailures: string[] = [];
    const modelNotes: string[] = [];
    for (const [order, index] of indexes.entries()) {
      const item = proposal.bots[index];
      if (item === undefined) continue;
      try {
        // D88: the proposed model (''= settings default) is written on creation — re-checked
        // here: the user may confirm days later, after the provider key was removed.
        const modelGone = item.model.length > 0 && this.validateModelRef(item.model) !== null;
        if (modelGone) {
          modelNotes.push(`「${item.name}」指定的模型 ${item.model} 已不可用，改为跟随设置默认`);
        }
        const record = createProposedBotRecord(
          this.#deps,
          item,
          offset + order,
          modelGone ? { model: '' } : undefined,
        );
        announceCreatedBot(this.#deps, record);
        created.push(record.bot);
        const routines = createProposedRoutines(
          this.#deps,
          record,
          item,
          (routineIndex) => keptRoutines === null || keptRoutines.has(`${index}:${routineIndex}`),
          { approvalId },
        );
        routineLines.push(...routines.lines);
        routineFailures.push(...routines.failures);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#deps.logger.warn(
          { approvalId, name: item.name, error: reason },
          'butler proposal bot creation failed',
        );
        failed.push(`${item.name}（${reason}）`);
      }
    }
    this.#deps.logger.info(
      {
        approvalId,
        proposalType: proposal.proposalType,
        created: created.map((bot) => ({ id: bot.id, name: bot.name })),
        failedCount: failed.length,
      },
      'butler proposal applied',
    );
    if (failed.length > 0) this.#failApproval(approvalId, `部分创建失败：${failed.join('、')}`);
    return [
      '提议处理结果（宿主系统注入，不是用户消息）：用户确认了提议。',
      created.length > 0
        ? `已创建：${created.map((bot) => `${bot.name}（${bot.id}）`).join('、')}。`
        : '没有创建任何 Bot。',
      ...(failed.length > 0 ? [`创建失败：${failed.join('、')}。`] : []),
      ...(routineLines.length > 0 ? [`已设置例行事项：${routineLines.join('；')}。`] : []),
      ...(routineFailures.length > 0
        ? [`例行事项设置失败：${routineFailures.join('、')}（Bot 已建好，用户可以之后再让它设）。`]
        : []),
      ...modelNotes.map((note) => `注意：${note}。`),
      '请用一两句话告诉用户结果和接下来怎么用（例如直接去找对应的 Bot 聊，需要多角色协作时可以建群；设了例行事项的顺带说一句它会到点主动找用户）；不要再把完整清单复述一遍。',
    ];
  }

  #createProject(proposal: Extract<ButlerProposalPayload, { proposalType: 'group' }>): string[] {
    // WP4: the proposal will carry an explicit lead_bot_id
    const project = this.#deps.projects.create({
      title: proposal.title,
      memberBotIds: proposal.memberBotIds,
      goal: proposal.description,
      leadBotId: proposal.memberBotIds[0]!,
    });
    this.#deps.logger.info(
      {
        proposalType: 'group',
        conversationId: project.id,
        memberCount: proposal.memberBotIds.length,
      },
      'butler proposal applied',
    );
    return [
      '提议处理结果（宿主系统注入，不是用户消息）：用户确认了建群提议。',
      `已创建群「${project.title ?? proposal.title}」（${project.id}），成员 ${proposal.memberBotIds.length} 位。`,
      '请用一两句话告诉用户群已建好、可以在群里怎么用；不要复述成员清单。',
    ];
  }

  #failApproval(approvalId: string, reason: string): void {
    try {
      this.#deps.approvals.fail(approvalId, reason);
    } catch (error) {
      this.#deps.logger.warn(
        { approvalId, error: error instanceof Error ? error.message : String(error) },
        'marking butler proposal failed did not succeed',
      );
    }
  }

  #notify(butlerId: string, conversationId: string, text: string): void {
    this.#deps.deliverEvent(butlerId, conversationId, BUTLER_PROPOSAL_FOLLOWUP_EVENT, text, {
      internal: true,
    });
  }
}
