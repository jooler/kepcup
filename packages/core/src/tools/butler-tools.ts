import { Type } from '@earendil-works/pi-ai';
import {
  BUTLER_TEAM_SIZE_MAX,
  BUTLER_TEAM_SIZE_MIN,
  type ButlerProposalPayload,
  type ButlerProposedBot,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 管家工具（D70，docs/design/27-butler-and-delegation.md）：
 *
 * - `list_bots`：只读通讯录名片，**所有 Bot** 注册（非群对话的提示词里没有
 *   其他 Bot 的名单，委派 / 路由都要靠它拿到 bot_id）。
 * - `propose_team` / `propose_bot` / `propose_group`：仅管家注册。只提交
 *   审批卡（非阻塞），用户确认后由 core 确定性创建——模型永远不直接建 Bot / 群。
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
}

/** Where the butler suggests the user's request should go (D70 §2.4). */
export interface RouteSuggestion {
  kind: 'bot' | 'group' | 'delegate';
  botId?: string;
  conversationId?: string;
  task?: string;
  reason: string;
}

const NAME_MAX_CHARS = 40;
const FIELD_MAX_CHARS = 500;

const proposedBotSchema = Type.Object(
  {
    name: Type.String({ description: 'Bot 的名字（简短，2~8 个字为宜）' }),
    bio: Type.String({ description: '一句话简介：它是谁、帮用户做什么' }),
    expertise: Type.String({ description: '擅长的领域' }),
    responsibilities: Type.String({ description: '具体负责哪些事（群聊里据此判断「归不归我」）' }),
    reason: Type.String({ description: '为什么用户需要它（基于用户说过的情况，展示在提议卡上）' }),
  },
  { additionalProperties: false },
);

interface ProposedBotParams {
  name: string;
  bio: string;
  expertise: string;
  responsibilities: string;
  reason: string;
}

function invalid(content: string): ToolResult {
  return { ok: false, content, errorCode: 'INVALID_INPUT' };
}

/** Normalizes + validates proposed bots; returns an error text or the clean list. */
function cleanProposedBots(raw: ProposedBotParams[]): string | ButlerProposedBot[] {
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
    bots.push({
      name,
      bio: item.bio.trim().slice(0, FIELD_MAX_CHARS),
      expertise: item.expertise.trim().slice(0, FIELD_MAX_CHARS),
      responsibilities: responsibilities.slice(0, FIELD_MAX_CHARS),
      reason: item.reason.trim().slice(0, FIELD_MAX_CHARS),
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
    route: 'bot' | 'group' | 'delegate';
    bot_id?: string;
    conversation_id?: string;
    task?: string;
    reason: string;
  }> = {
    name: 'suggest_route',
    description:
      '给用户一张路由建议卡，说明这件事建议交给谁、为什么：route="bot" 建议直接去和某个 Bot 聊（给 bot_id）；route="group" 建议去某个已有的群（给 conversation_id）；route="delegate" 建议由你把任务转交给某个 Bot、结果贴回这里（给 bot_id 和 task）——用户点「交给它处理」确认后，你会收到用户的确认消息，那时再调用 delegate_to_bot。' +
      '卡片本身就是这一轮的答复：调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        route: Type.Union([Type.Literal('bot'), Type.Literal('group'), Type.Literal('delegate')], {
          description: 'bot=直聊某个 Bot；group=去已有的群；delegate=由你转交并把结果贴回这里',
        }),
        bot_id: Type.Optional(Type.String({ description: 'route 为 bot / delegate 时的目标 bot_id' })),
        conversation_id: Type.Optional(
          Type.String({ description: 'route 为 group 时的群 conversation_id' }),
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
      if (params.route === 'group' && !params.conversation_id?.trim()) {
        return invalid('route 为 group 时需要已有群的 conversation_id；没有合适的群就用 propose_group 提议建群');
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

/** `propose_team` / `propose_bot` / `propose_group` / `suggest_route`：仅管家注册。 */
export function buildButlerTools(input: {
  identity: RunIdentity;
  butler: ButlerToolFacade;
}): ToolDefinition[] {
  const { identity, butler } = input;

  const proposeTeam: ToolDefinition<{ bots: ProposedBotParams[]; note?: string }> = {
    name: 'propose_team',
    description:
      `向用户提议一组（${BUTLER_TEAM_SIZE_MIN}~${BUTLER_TEAM_SIZE_MAX} 个）领域 Bot，以审批卡展示（名字、职责、理由），用户可勾掉不要的再确认；确认后系统自动创建，你会收到结果通知。` +
      '你不能直接创建 Bot，只能提议。每个 Bot 职责要分得清、不重叠，理由要基于用户说过的情况。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        bots: Type.Array(proposedBotSchema, {
          description: `建议的 Bot（${BUTLER_TEAM_SIZE_MIN}~${BUTLER_TEAM_SIZE_MAX} 个）`,
        }),
        note: Type.Optional(Type.String({ description: '给用户的一句总体说明（可选）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      if (
        params.bots.length < BUTLER_TEAM_SIZE_MIN ||
        params.bots.length > BUTLER_TEAM_SIZE_MAX
      ) {
        return invalid(
          `组队提议需要 ${BUTLER_TEAM_SIZE_MIN}~${BUTLER_TEAM_SIZE_MAX} 个 Bot；只需要一个时用 propose_bot。`,
        );
      }
      const bots = cleanProposedBots(params.bots);
      if (typeof bots === 'string') return invalid(bots);
      return submitted(
        butler.propose(identity, {
          proposalType: 'team',
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
      const bots = cleanProposedBots([params.bot]);
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

  const proposeGroup: ToolDefinition<{
    title: string;
    description: string;
    member_bot_ids: string[];
    reason?: string;
  }> = {
    name: 'propose_group',
    description:
      '向用户提议建一个群，让多个已有 Bot 在群里协作处理一类事务（审批卡），用户确认后系统自动建群，你会收到结果通知。成员用 list_bots 查到的 bot_id，至少 2 个。调用后本轮立即结束，所以它必须是本轮最后一个动作。',
    parameters: Type.Object(
      {
        title: Type.String({ description: '群名称' }),
        description: Type.String({ description: '群的定位：主要处理什么事务（群里的 Bot 会以此了解自己的定位）' }),
        member_bot_ids: Type.Array(Type.String(), { description: '成员 bot_id（至少 2 个）' }),
        reason: Type.Optional(Type.String({ description: '为什么需要这个群（展示在提议卡上）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const title = params.title.trim();
      if (title.length === 0) return invalid('群名称不能为空');
      const members = [...new Set(params.member_bot_ids.map((id) => id.trim()))].filter(
        (id) => id.length > 0,
      );
      if (members.length < 2) return invalid('群聊至少需要 2 个成员');
      return submitted(
        butler.propose(identity, {
          proposalType: 'group',
          title: title.slice(0, NAME_MAX_CHARS),
          description: params.description.trim().slice(0, FIELD_MAX_CHARS),
          memberBotIds: members,
          reason: (params.reason ?? '').trim().slice(0, FIELD_MAX_CHARS),
        }),
      );
    },
  };

  return [
    proposeTeam,
    proposeBot,
    proposeGroup,
    buildSuggestRouteTool(identity, butler),
  ] as ToolDefinition[];
}
