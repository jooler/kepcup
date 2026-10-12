import { Type } from '@earendil-works/pi-ai';
import {
  HANDOVER_ITEMS_MAX,
  HANDOVER_MEMORY_MAX_ITEMS,
  HANDOVER_MEMORY_QUERY_LIMIT,
  HANDOVER_NOTE_MAX_CHARS,
  type ButlerProposedBot,
  type ChatModelOption,
  type HandoverAction,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import { neutralizeUntrusted } from '../infra/data-boundary.js';
import type { HandoverEntry } from '../handover/types.js';
import { cleanProposedBots, proposedBotSchema, type ProposedBotParams } from './butler-tools.js';

/**
 * Bot 资产移交工具（D88，docs/design/37 §4）：`inspect_bot_assets`（只读盘点）与
 * `propose_handover`（提交移交卡）。与 `propose_*` 同属对话轮工具面：立即返回、宿主干活；
 * 任务里不注册。管家：来源可以是任何 Bot，目标可以新建；普通 Bot（P1）：只能交出自己的
 * 资产、交给已有 Bot（宿主校验，工具说明同步）。
 */

/** `inspect_bot_assets` 的结果（宿主盘点，工具负责排版）。 */
export interface HandoverInspection {
  bot: { id: string; name: string; butler: boolean; responsibilities: string };
  entries: HandoverEntry[];
  /** 按条盘点的资产（记忆）的统计行。 */
  summaries: Array<{ type: string; text: string }>;
  /** 本次的记忆检索词（null = 没检索）。 */
  memoryQuery: string | null;
  /** 盘点的是发起方自己。 */
  self: boolean;
  modelOptions: ChatModelOption[];
}

/** `propose_handover` 清理过的入参。 */
export interface HandoverProposalInput {
  fromBotId: string;
  target:
    | { kind: 'existing'; botId: string }
    /** `model`：'inherit' / ''（跟随设置默认）/ 可用模型 ref。 */
    | { kind: 'new'; bot: ButlerProposedBot };
  items: Array<{ key: string; action?: HandoverAction | undefined }>;
  responsibilities?: { to?: string | undefined; from?: string | undefined } | undefined;
  handoverNote: string;
  note: string;
}

/** The slice of the host the handover tools need. */
export interface HandoverToolFacade {
  inspect(
    identity: RunIdentity,
    input: { botId: string; memoryQuery?: string | undefined; wikiQuery?: string | undefined },
  ): { ok: true; inspection: HandoverInspection } | { ok: false; message: string };
  /** Submits a bot_handover card (non-blocking); never moves anything itself. */
  propose(identity: RunIdentity, input: HandoverProposalInput): { ok: boolean; message: string };
  /** D80 routine `when` check of a new target (null = valid). */
  validateRoutineWhen(when: string, timezone: string | null): string | null;
  /** Available chat models (same source as the Bot detail dropdown). */
  modelOptions(): ChatModelOption[];
}

const ACTION_LABELS: Record<HandoverAction, string> = {
  move: '移交',
  share: '共享',
  copy: '复制',
};

const GROUP_LABELS: Record<string, string> = {
  model: '模型',
  app: '连接应用',
  mcp: 'MCP 服务',
  mail: '邮箱',
  schedule: '定时任务',
  watch: '网页监看',
  skill: '技能',
  memory: '记忆',
};

const MARK_LABELS: Record<string, string> = {
  external_import: '外部导入',
  sensitive: '敏感，卡上默认不勾',
};

const RESPONSIBILITIES_MAX_CHARS = 2000;

/** 不移交的东西（卡片底部同一行说明）。 */
const NOT_TRANSFERRED =
  '不移交：对话历史、路径授权、应用写授权、审批记录、浏览器资料与登录态、workspace、网络策略、进行中的委派与任务。';

function wrap(text: string, external: boolean): string {
  return external ? `<untrusted>${neutralizeUntrusted(text)}</untrusted>` : text;
}

function invalid(content: string): ToolResult {
  return { ok: false, content, errorCode: 'INVALID_INPUT' };
}

/** Renders the inventory for the model; external text stays inside `<untrusted>`. */
export function formatInspection(inspection: HandoverInspection): string {
  const { bot, entries, modelOptions, summaries } = inspection;
  const lines: string[] = [
    `${bot.name}（${bot.id}）${bot.butler ? '【管家】' : ''}名下的资产（key 填进 propose_handover 的 items）：`,
    `当前职责描述：${bot.responsibilities.length > 0 ? wrap(bot.responsibilities, true) : '（未填写）'}${bot.butler ? '（管家职责是固定模板，移交时不改写）' : ''}`,
  ];
  const groups = new Map<string, HandoverEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.type) ?? [];
    list.push(entry);
    groups.set(entry.type, list);
  }
  for (const [type, label] of Object.entries(GROUP_LABELS)) {
    const list = groups.get(type) ?? [];
    if (type === 'memory') {
      // 记忆默认只给统计；给了 memory_query 才列候选（内容是数据，包 untrusted）。
      const summary = summaries.find((line) => line.type === 'memory')?.text ?? '';
      lines.push(`${label}：${summary}`);
      if (inspection.memoryQuery !== null) {
        lines.push(
          list.length === 0
            ? `- memory_query「${wrap(inspection.memoryQuery, true)}」没有匹配到可复制的记忆`
            : `- memory_query「${wrap(inspection.memoryQuery, true)}」的候选（最多 ${HANDOVER_MEMORY_QUERY_LIMIT} 条；用户说过「只告诉你」的、自我笔记、承诺与已失效的不会出现）：`,
        );
      }
    } else {
      lines.push(`${label}：${list.length === 0 ? '（无）' : ''}`);
    }
    for (const entry of list) {
      const actions = entry.actions
        .map(
          (action) => `${ACTION_LABELS[action]}${action === entry.defaultAction ? '（默认）' : ''}`,
        )
        .join(' / ');
      const detail = entry.detail.length > 0 ? `（${wrap(entry.detail, entry.external)}）` : '';
      const blocked = entry.blocked !== undefined ? ` | 不可执行：${entry.blocked}` : '';
      const marks = (entry.marks ?? []).map((mark) => MARK_LABELS[mark] ?? mark);
      lines.push(
        `- ${entry.key} | ${wrap(entry.label, entry.external)}${detail} | 动作：${actions}${
          marks.length > 0 ? ` | ${marks.join('；')}` : ''
        }${blocked}`,
      );
    }
  }
  lines.push(
    modelOptions.length > 0
      ? `可用模型（新建目标的 new_bot.model，或给已有目标改模型的 model:<ref> 条目；model:inherit = 与 ${bot.name} 相同，model:default = 跟随设置默认）：`
      : '可用模型：（设置里还没有配置模型厂商的 Key；只能用 inherit / default）',
  );
  for (const option of modelOptions) lines.push(`- ${option.ref} | ${option.label}`);
  lines.push(NOT_TRANSFERRED);
  return lines.join('\n');
}

interface ProposeHandoverParams {
  from_bot_id?: string;
  to: { bot_id?: string; new_bot?: ProposedBotParams };
  items: Array<{ key: string; action?: HandoverAction }>;
  responsibilities?: { to?: string; from?: string };
  handover_note: string;
  note?: string;
}

/**
 * `inspect_bot_assets` / `propose_handover`：对话轮注册（任务不注册）。`butler` 决定说明
 * 与参数面：管家可以盘点 / 交出任何 Bot 的资产、可以新建目标；普通 Bot 只能是自己、目标只能
 * 是已有 Bot（没有 `to.new_bot`）。宿主侧同样校验。
 */
export function buildHandoverTools(input: {
  identity: RunIdentity;
  handover: HandoverToolFacade;
  butler: boolean;
}): ToolDefinition[] {
  const { identity, handover, butler } = input;

  const inspect: ToolDefinition<{ bot_id?: string; memory_query?: string; wiki_query?: string }> = {
    name: 'inspect_bot_assets',
    description:
      `盘点${butler ? '某个 Bot' : '你自己'}名下的资产（只读）：模型、连接应用、MCP 服务、邮箱、定时任务、网页监看、技能、记忆（默认只给统计，用 memory_query 检索候选条目），以及可用模型列表。每项带 key、可用动作与默认动作、不可执行的原因。` +
      '用 propose_handover 移交之前必须先调用它，key 只能用这里返回的，不要凭记忆编造。',
    parameters: Type.Object(
      {
        bot_id: Type.Optional(
          Type.String({
            description: butler
              ? '要盘点的 Bot 的 id（不填 = 你自己；用 list_bots 查其他 Bot）'
              : '只能是你自己（不填即可）',
          }),
        ),
        memory_query: Type.Optional(
          Type.String({
            description: `记忆检索词：列出匹配的可复制记忆条目（每次最多 ${HANDOVER_MEMORY_QUERY_LIMIT} 条）；"*" = 最近的。不填只给统计`,
          }),
        ),
        wiki_query: Type.Optional(Type.String({ description: '（暂不支持）Wiki 检索词' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const botId = params.bot_id?.trim() ?? '';
      const result = handover.inspect(identity, {
        botId,
        memoryQuery: params.memory_query,
        wikiQuery: params.wiki_query,
      });
      if (!result.ok) return invalid(result.message);
      return { ok: true, content: formatInspection(result.inspection) };
    },
  };

  const newBotSchema = Type.Object(
    {
      ...proposedBotSchema.properties,
      model: Type.Optional(
        Type.String({
          description:
            '新 Bot 的模型："inherit"（默认，与来源 Bot 相同）、"default"（跟随设置默认），或 inspect_bot_assets 列出的可用模型 ref',
        }),
      ),
    },
    { additionalProperties: false },
  );

  const propose: ToolDefinition<ProposeHandoverParams> = {
    name: 'propose_handover',
    description:
      `把${butler ? '一个 Bot' : '你自己'}名下的资产（邮箱、连接应用、MCP、模型、定时任务、网页监看、技能、记忆）和对应的职责长期交给另一个 Bot 负责，以移交卡给用户确认；用户逐项勾选确认后由系统执行，你会收到结果通知。` +
      '移交不是委派：委派（delegate_to_bot）是请对方办一件事，不改变谁负责什么；「交给它负责 / 让它接管 / 以后由它管」以及涉及邮箱、应用、定时任务归属的说法都用移交。技能与记忆是复制（原 Bot 保留）；与承诺联动的定时任务连同承诺一起移交。' +
      (butler
        ? '目标可以是已有 Bot（to.bot_id），也可以是一个待新建的 Bot（to.new_bot，字段同 propose_bot）——「新建一个 Bot 并把 X 交给它」只提交这一张卡，不要先 propose_bot。'
        : '你只能交出自己的资产（from_bot_id 是你自己或不填），目标必须是通讯录里已有的 Bot（to.bot_id，用 list_bots 查）；要新建 Bot 请用户去找管家。') +
      `调用前先用 inspect_bot_assets 盘点，items 的 key 只能用盘点结果里的。移交邮箱等职责时，同时给出 responsibilities：to = 接手方改写后的职责全文${butler ? '（已有目标时）' : ''}，from = 移交方删去移交内容后的职责全文（来源是管家时不填）。` +
      `调用后本轮立即结束，所以它必须是本轮最后一个动作；收到结果通知前不要声称已经移交。条目 ≤ ${HANDOVER_ITEMS_MAX} 个（记忆另计，≤ ${HANDOVER_MEMORY_MAX_ITEMS} 条）。`,
    parameters: Type.Object(
      {
        from_bot_id: Type.Optional(
          Type.String({
            description: butler
              ? '交出资产的 Bot 的 id（不填 = 你自己）'
              : '只能是你自己（不填即可）',
          }),
        ),
        to: Type.Object(
          butler
            ? {
                bot_id: Type.Optional(
                  Type.String({ description: '接手的已有 Bot 的 id（与 new_bot 二选一）' }),
                ),
                new_bot: Type.Optional(newBotSchema),
              }
            : {
                bot_id: Type.String({ description: '接手的已有 Bot 的 id（用 list_bots 查）' }),
              },
          {
            additionalProperties: false,
            description: butler
              ? '接手方：已有 Bot（bot_id）或新建（new_bot），二选一'
              : '接手方：通讯录里已有的 Bot',
          },
        ),
        items: Type.Array(
          Type.Object(
            {
              key: Type.String({ description: 'inspect_bot_assets 返回的 key' }),
              action: Type.Optional(
                Type.Union([Type.Literal('move'), Type.Literal('share'), Type.Literal('copy')], {
                  description:
                    'move=移交（对方得到、原 Bot 失去）；share=共享（两边都有）；copy=复制。不填用默认动作',
                }),
              ),
            },
            { additionalProperties: false },
          ),
          { description: '要移交的资产条目' },
        ),
        responsibilities: Type.Optional(
          Type.Object(
            {
              to: Type.Optional(
                Type.String({
                  description: '接手方（已有 Bot）改写后的职责全文：在原职责上追加接手的内容',
                }),
              ),
              from: Type.Optional(
                Type.String({
                  description: '移交方改写后的职责全文：删去交出去的内容（来源是管家时不填）',
                }),
              ),
            },
            { additionalProperties: false },
          ),
        ),
        handover_note: Type.String({
          description: `交接要点：接手方需要知道的背景与习惯（会写进接手方的私聊），≤ ${HANDOVER_NOTE_MAX_CHARS} 字`,
        }),
        note: Type.Optional(Type.String({ description: '给用户的一句话说明（卡片上，可选）' })),
      },
      { additionalProperties: false },
    ),
    execute: async (params) => {
      const fromBotId = params.from_bot_id?.trim() || identity.botId || '';
      if (fromBotId.length === 0) return invalid('from_bot_id 不能为空');
      const existing = params.to.bot_id?.trim() ?? '';
      const fresh = params.to.new_bot;
      if (existing.length > 0 === (fresh !== undefined)) {
        return invalid('to 里 bot_id 与 new_bot 必须二选一');
      }
      let target: HandoverProposalInput['target'];
      if (fresh !== undefined) {
        const rawModel = (fresh.model ?? 'inherit').trim();
        const model = rawModel === 'default' ? '' : rawModel.length === 0 ? 'inherit' : rawModel;
        const bots = cleanProposedBots(
          [{ ...fresh, model: '' }],
          (when, tz) => handover.validateRoutineWhen(when, tz),
          () => null,
        );
        if (typeof bots === 'string') return invalid(bots);
        if (
          model !== 'inherit' &&
          model !== '' &&
          !handover.modelOptions().some((o) => o.ref === model)
        ) {
          return invalid(
            `new_bot.model「${model}」不在可用模型列表里：用 "inherit"、"default"，或 inspect_bot_assets 列出的 ref`,
          );
        }
        target = { kind: 'new', bot: { ...bots[0]!, model } };
      } else {
        target = { kind: 'existing', botId: existing };
      }
      const memoryItems = params.items.filter((item) => item.key.trim().startsWith('memory:'));
      if (memoryItems.length > HANDOVER_MEMORY_MAX_ITEMS) {
        return invalid(`记忆条目太多（≤ ${HANDOVER_MEMORY_MAX_ITEMS} 条），挑最重要的，或分几张卡提交`);
      }
      if (params.items.length - memoryItems.length > HANDOVER_ITEMS_MAX) {
        return invalid(`条目太多（记忆之外 ≤ ${HANDOVER_ITEMS_MAX} 个），分几张卡提交`);
      }
      const note = params.handover_note.trim();
      if (note.length === 0) {
        return invalid('handover_note 不能为空：写下接手方需要知道的背景与习惯');
      }
      const responsibilities =
        params.responsibilities !== undefined
          ? {
              ...(params.responsibilities.to?.trim()
                ? { to: params.responsibilities.to.trim().slice(0, RESPONSIBILITIES_MAX_CHARS) }
                : {}),
              ...(params.responsibilities.from?.trim()
                ? { from: params.responsibilities.from.trim().slice(0, RESPONSIBILITIES_MAX_CHARS) }
                : {}),
            }
          : undefined;
      const result = handover.propose(identity, {
        fromBotId,
        target,
        items: params.items.map((item) => ({ key: item.key.trim(), action: item.action })),
        responsibilities,
        handoverNote: note.slice(0, HANDOVER_NOTE_MAX_CHARS),
        note: (params.note ?? '').trim().slice(0, 500),
      });
      // 移交卡已落库：本轮到此为止，等用户决定后宿主以内部事件通知结果。
      return result.ok
        ? { ok: true, content: result.message, terminate: true }
        : invalid(result.message);
    },
  };

  return [inspect, propose] as ToolDefinition[];
}
