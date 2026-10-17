import { Type } from '@earendil-works/pi-ai';
import {
  BUTLER_ROUTINES_PER_BOT_MAX,
  PROPOSE_BOTS_MAX,
  PROPOSE_BOTS_MIN,
  type ButlerProposalPayload,
  type ButlerProposedBot,
  type ButlerProposedRoutine,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 管家工具（D70，docs/design/27-butler-and-delegation.md）：
 *
 * - `list_bots`：只读通讯录名片，**所有 Bot** 注册（非项目组对话的提示词里没有
 *   其他 Bot 的名单，委派 / 路由都要靠它拿到 bot_id）。
 * - `propose_bots` / `propose_bot` / `propose_project`：仅管家注册。只提交
 *   审批卡（非阻塞），用户确认后由 core 确定性创建——模型永远不直接建 Bot /
 *   项目组（D92 T1a：管家本身不加入项目组）。
 */

/** Public card of one contact as list_bots returns it (no other Profile fields). */
export interface BotCardLine {
  id: string;
  name: string;
  bio: string;
  expertise: string;
  responsibilities: string;
  butler: boolean;
}

/** The slice of the host the butler tools need. */
export interface ButlerToolFacade {
  /** Active contacts except the caller. */
  listBots(selfBotId: string): BotCardLine[];
  /** Submits a butler_proposal card (non-blocking); never creates anything itself. */
  propose(identity: RunIdentity, payload: ButlerProposalPayload): { ok: boolean; message: string };
  /** Posts a route card (D70 §2.4); acting on it is the user's click. */
  suggestRoute(identity: RunIdentity, route: RouteSuggestion): { ok: boolean; message: string };
  /**
   * D80: checks a routine's `when` up front (ISO 8601 / cron, future, known
   * zone); null = valid, otherwise why not. Created only on confirmation.
   */
  validateRoutineWhen(when: string, timezone: string | null): string | null;
  /**
   * D88: checks a proposed bot's model ref against the available chat models (the same
   * source as the Bot detail model dropdown); null = valid, otherwise why not.
   */
  validateModelRef(ref: string): string | null;
}

/** Where the butler suggests the user's request should go (D70 §2.4). */
export interface RouteSuggestion {
  kind: 'bot' | 'project' | 'delegate';
  botId?: string;
  conversationId?: string;
  task?: string;
  reason: string;
}

const NAME_MAX_CHARS = 40;
const FIELD_MAX_CHARS = 500;

const TITLE_MAX_CHARS = 40;

const proposedRoutineSchema = Type.Object(
  {
    title: Type.String({ description: '给用户看的短名（如「工作日早报」）' }),
    when: Type.String({
      description: 'cron 表达式（周期，如 "0 9 * * 1-5"）或 ISO 8601 时间（一次性）',
    }),
    timezone: Type.Optional(Type.String({ description: 'IANA 时区；默认用户本地时区' })),
    note: Type.String({ description: '到点时这个 Bot 要做什么（它到时会看到这段话）' }),
  },
  { additionalProperties: false },
);

export const proposedBotSchema = Type.Object(
  {
    name: Type.String({ description: 'Bot 的名字（简短，2~8 个字为宜）' }),
    bio: Type.String({ description: '一句话简介：它是谁、帮用户做什么' }),
    expertise: Type.String({ description: '擅长的领域' }),
    responsibilities: Type.String({ description: '具体负责哪些事（项目组里据此判断「归不归我」）' }),
    reason: Type.String({ description: '为什么用户需要它（基于用户说过的情况，展示在提议卡上）' }),
    routines: Type.Optional(
      Type.Array(proposedRoutineSchema, {
        description: `例行事项（≤ ${BUTLER_ROUTINES_PER_BOT_MAX} 条）：用户说过的、有固定周期或时间点的事，确认后建到该 Bot 的私聊里由它到点去做；没有就不填`,
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          '对话模型：可用模型列表里的 ref（如 "openai/gpt-4o"，先用 inspect_bot_assets 查看可用模型）。只在用户指定了模型时填；不填 = 跟随设置默认',
      }),
    ),
  },
  { additionalProperties: false },
);

export interface ProposedRoutineParams {
  title: string;
  when: string;
  timezone?: string;
  note: string;
}

export interface ProposedBotParams {
  name: string;
  bio: string;
  expertise: string;
  responsibilities: string;
  reason: string;
  routines?: ProposedRoutineParams[];
  model?: string;
}

function invalid(content: string): ToolResult {
  return { ok: false, content, errorCode: 'INVALID_INPUT' };
}

/** Normalizes + validates one bot's routines (D80); an error text or the clean list. */
function cleanRoutines(
  botName: string,
  raw: ProposedRoutineParams[] | undefined,
  validateWhen: ButlerToolFacade['validateRoutineWhen'],
): string | ButlerProposedRoutine[] {
  const items = raw ?? [];
  if (items.length > BUTLER_ROUTINES_PER_BOT_MAX) {
    return `「${botName}」的例行事项太多（≤ ${BUTLER_ROUTINES_PER_BOT_MAX} 条）`;
  }
  const routines: ButlerProposedRoutine[] = [];
  for (const [index, item] of items.entries()) {
    const title = item.title.trim().slice(0, TITLE_MAX_CHARS);
    const note = item.note.trim().slice(0, FIELD_MAX_CHARS);
    if (title.length === 0 || note.length === 0) {
      return `「${botName}」的第 ${index + 1} 条例行事项缺少 title 或 note`;
    }
    const timezone = item.timezone?.trim() || null;
    const error = validateWhen(item.when, timezone);
    if (error !== null) return `「${botName}」的例行事项「${title}」时间不对：${error}`;
    routines.push({ title, when: item.when.trim(), timezone, note });
  }
  return routines;
}

/** Normalizes + validates proposed bots; returns an error text or the clean list. */
export function cleanProposedBots(
  raw: ProposedBotParams[],
  validateWhen: ButlerToolFacade['validateRoutineWhen'],
  validateModel: ButlerToolFacade['validateModelRef'],
): string | ButlerProposedBot[] {
  const bots: ButlerProposedBot[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const name = item.name.trim();
    if (name.length === 0) return `第 ${index + 1} 个 Bot 缺少名字`;
    if (name.length > NAME_MAX_CHARS) return `第 ${index + 1} 个 Bot 的名字太长（≤ ${NAME_MAX_CHARS} 字）`;
    if (seen.has(name)) return `Bot 名字「${name}」重复了`;
    seen.add(name);
    const responsibilities = item.responsibilities.trim();
    if (responsibilities.length === 0) return `「${name}」缺少职责说明`;
    const routines = cleanRoutines(name, item.routines, validateWhen);
    if (typeof routines === 'string') return routines;
    const model = (item.model ?? '').trim();
    if (model.length > 0) {
      const error = validateModel(model);
      if (error !== null) return `「${name}」的模型不可用：${error}`;
    }
    bots.push({
      name,
      bio: item.bio.trim().slice(0, FIELD_MAX_CHARS),
      expertise: item.expertise.trim().slice(0, FIELD_MAX_CHARS),
      responsibilities: responsibilities.slice(0, FIELD_MAX_CHARS),
      reason: item.reason.trim().slice(0, FIELD_MAX_CHARS),
      routines,
      model,
    });
  }
  return bots;
}

function submitted(result: { ok: boolean; message: string }): ToolResult {
  // 提议卡已落库：本轮到此为止（卡片就是这一轮的交付），等用户决定后宿主
  // 会以内部事件通知你结果。
  return result.ok
    ? { ok: true, content: result.message, terminate: true }
    : { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
}

/** `list_bots`：所有 Bot 都注册（只读名片）。 */
export function buildListBotsTool(input: {
  identity: RunIdentity;
  butler: ButlerToolFacade;
}): ToolDefinition {
  const { identity, butler } = input;
  const listBots: ToolDefinition<Record<string, never>> = {
    name: 'list_bots',
    description:
      '列出用户通讯录里的其他 Bot 名片（id、名字、简介、擅长、职责），只读。需要知道某个 Bot 的 bot_id、或判断某件事该交给谁时使用；不要凭记忆编造 bot_id。',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const cards = butler.listBots(identity.botId ?? '');
      if (cards.length === 0) return { ok: true, content: '通讯录里还没有其他 Bot。' };
      const lines = cards.map(
        (card) =>
          `- ${card.id} | ${card.name}${card.butler ? '（管家）' : ''} | ${card.bio || '（无简介）'} | 擅长：${card.expertise || '（未填写）'} | 职责：${card.responsibilities || '（未填写）'}`,
      );
      return { ok: true, content: `通讯录（${cards.length} 个 Bot）：\n${lines.join('\n')}` };
    },
  };
  return listBots as ToolDefinition;
}

/** `suggest_route`：仅管家注册（D70 §2.4，早期产品「先卡后办」）。 */
function buildSuggestRouteTool(identity: RunIdentity, butler: ButlerToolFacade): ToolDefinition {
  const suggestRoute: ToolDefinition<{
    route: 'bot' | 'project' | 'delegate';
    bot_id?: string;
    conversation_id?: string;
    task?: string;
    reason: string;
  }> = {
    name: 'suggest_route',
    description:
      '给用户一张路由建议卡，说明这件事建议交给谁、为什么：route="bot" 建议直接去和某个 Bot 聊（给 bot_id）；route="project" 建议去某个已有的项目组（给 conversation_id）；route="delegate" 建议由你把任务转交给某个 Bot、结果贴回这里（给 bot_id 和 task）——用户点「交给它处理」确认后，你会收到用户的确认消息，那时再调用 delegate_to_bot。' +
      '卡片本身就是这一轮的答复：调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        route: Type.Union([Type.Literal('bot'), Type.Literal('project'), Type.Literal('delegate')], {
          description: 'bot=直聊某个 Bot；project=去已有的项目组；delegate=由你转交并把结果贴回这里',
        }),
        bot_id: Type.Optional(Type.String({ description: 'route 为 bot / delegate 时的目标 bot_id' })),
        conversation_id: Type.Optional(
          Type.String({ description: 'route 为 project 时的已有项目组会话 id' }),
        ),
        task: Type.Optional(
          Type.String({ description: 'route 为 delegate 时要转交的事（一句话概括）' }),
        ),
        reason: Type.String({ description: '为什么这样建议（展示在卡片上，一两句话）' }),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const reason = params.reason.trim();
      if (reason.length === 0) return invalid('reason 不能为空：告诉用户为什么这样建议');
      if ((params.route === 'bot' || params.route === 'delegate') && !params.bot_id?.trim()) {
        return invalid('route 为 bot / delegate 时需要 bot_id（先用 list_bots 查）');
      }
      if (params.route === 'project' && !params.conversation_id?.trim()) {
        return invalid(
          'route 为 project 时需要已有项目组的 conversation_id；没有合适的项目组就用 propose_project 提议建一个',
        );
      }
      if (params.route === 'delegate' && !params.task?.trim()) {
        return invalid('route 为 delegate 时需要 task：一句话说明要转交的事');
      }
      return submitted(
        butler.suggestRoute(identity, {
          kind: params.route,
          ...(params.bot_id?.trim() ? { botId: params.bot_id.trim() } : {}),
          ...(params.conversation_id?.trim()
            ? { conversationId: params.conversation_id.trim() }
            : {}),
          ...(params.task?.trim() ? { task: params.task.trim().slice(0, FIELD_MAX_CHARS) } : {}),
          reason: reason.slice(0, FIELD_MAX_CHARS),
        }),
      );
    },
  };
  return suggestRoute as ToolDefinition;
}

/** `propose_bots` / `propose_bot` / `propose_project` / `suggest_route`：仅管家注册。 */
export function buildButlerTools(input: {
  identity: RunIdentity;
  butler: ButlerToolFacade;
}): ToolDefinition[] {
  const { identity, butler } = input;

  const proposeBots: ToolDefinition<{ bots: ProposedBotParams[]; note?: string }> = {
    name: 'propose_bots',
    description:
      `向用户提议一组（${PROPOSE_BOTS_MIN}~${PROPOSE_BOTS_MAX} 个）领域 Bot，以审批卡展示（名字、职责、理由），用户可勾掉不要的再确认；确认后系统自动创建，你会收到结果通知。` +
      '你不能直接创建 Bot，只能提议。每个 Bot 职责要分得清、不重叠，理由要基于用户说过的情况；用户说过的周期事项放进对应 Bot 的 routines。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        bots: Type.Array(proposedBotSchema, {
          description: `建议的 Bot（${PROPOSE_BOTS_MIN}~${PROPOSE_BOTS_MAX} 个）`,
        }),
        note: Type.Optional(Type.String({ description: '给用户的一句总体说明（可选）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      if (params.bots.length < PROPOSE_BOTS_MIN || params.bots.length > PROPOSE_BOTS_MAX) {
        return invalid(
          `组队提议需要 ${PROPOSE_BOTS_MIN}~${PROPOSE_BOTS_MAX} 个 Bot；只需要一个时用 propose_bot。`,
        );
      }
      const bots = cleanProposedBots(
        params.bots,
        (when, tz) => butler.validateRoutineWhen(when, tz),
        (ref) => butler.validateModelRef(ref),
      );
      if (typeof bots === 'string') return invalid(bots);
      return submitted(
        butler.propose(identity, {
          proposalType: 'bots',
          bots,
          note: (params.note ?? '').trim().slice(0, FIELD_MAX_CHARS),
        }),
      );
    },
  };

  const proposeBot: ToolDefinition<{ bot: ProposedBotParams; note?: string }> = {
    name: 'propose_bot',
    description:
      '向用户提议新建一个领域 Bot（审批卡），用户确认后系统自动创建，你会收到结果通知。你不能直接创建 Bot，只能提议。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        bot: proposedBotSchema,
        note: Type.Optional(Type.String({ description: '给用户的一句说明（可选）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const bots = cleanProposedBots(
        [params.bot],
        (when, tz) => butler.validateRoutineWhen(when, tz),
        (ref) => butler.validateModelRef(ref),
      );
      if (typeof bots === 'string') return invalid(bots);
      return submitted(
        butler.propose(identity, {
          proposalType: 'bot',
          bots,
          note: (params.note ?? '').trim().slice(0, FIELD_MAX_CHARS),
        }),
      );
    },
  };

  const proposeProject: ToolDefinition<{
    title: string;
    goal: string;
    lead_bot_id: string;
    member_bot_ids: string[];
    reason?: string;
  }> = {
    name: 'propose_project',
    description:
      '向用户提议建一个项目组，让多个已有 Bot 围绕一个目标协作（审批卡），用户确认后系统自动创建，你会收到结果通知。成员用 list_bots 查到的 bot_id，至少 2 个且必须含负责人；管家自己不加入项目组，负责人与成员都从领域 Bot 里选。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        title: Type.String({ description: '项目组名称' }),
        goal: Type.String({ description: '项目目标：主要处理什么事务、要达成什么（成员会以此了解自己的定位）' }),
        lead_bot_id: Type.String({ description: '负责人的 bot_id（必须是 member_bot_ids 之一）' }),
        member_bot_ids: Type.Array(Type.String(), {
          description: '成员 bot_id（至少 2 个，含负责人；不含管家）',
        }),
        reason: Type.Optional(Type.String({ description: '为什么需要这个项目组（展示在提议卡上）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const title = params.title.trim();
      if (title.length === 0) return invalid('项目组名称不能为空');
      const goal = params.goal.trim();
      if (goal.length === 0) return invalid('项目目标不能为空：成员靠它理解自己的定位');
      const members = [...new Set(params.member_bot_ids.map((id) => id.trim()))].filter(
        (id) => id.length > 0,
      );
      if (members.length < 2) return invalid('项目组至少需要 2 个成员（含负责人）');
      const lead = params.lead_bot_id.trim();
      if (lead.length === 0) return invalid('缺少负责人（lead_bot_id）');
      if (!members.includes(lead)) return invalid('负责人必须在成员列表（member_bot_ids）里');
      return submitted(
        butler.propose(identity, {
          proposalType: 'project',
          title: title.slice(0, NAME_MAX_CHARS),
          goal: goal.slice(0, FIELD_MAX_CHARS),
          leadBotId: lead,
          memberBotIds: members,
          reason: (params.reason ?? '').trim().slice(0, FIELD_MAX_CHARS),
        }),
      );
    },
  };

  return [
    proposeBots,
    proposeBot,
    proposeProject,
    buildSuggestRouteTool(identity, butler),
  ] as ToolDefinition[];
}
