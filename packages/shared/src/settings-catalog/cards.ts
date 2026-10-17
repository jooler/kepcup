import { z } from 'zod';
import {
  settingFieldTypeSchema,
  settingGroupSchema,
  settingOptionSchema,
  settingOwnerSchema,
  settingScopeSchema,
  settingWriteModeSchema,
} from './types.js';

/**
 * 对话内设置卡与三个 Bot 工具的结构化契约（todo/conversational-app-setup.md §5.2、§六）。
 * 本文件不引 `domain/types.ts`（后者的 `systemEventContentSchema` 反过来引用这里）。
 */

/** system_event 名：消息流里的设置卡（含 direct 档的回执卡）。 */
export const SETTING_CARD_EVENT = 'setting_card';
/**
 * 一次性内部事件名（§6.2）：用户「应用」或「不用了」之后唤醒 Bot 的对话轮。写入时带
 * `internal: true`（同 `task_setup_dismissed`），每张卡只通知一次；撤销回执卡不唤醒。
 */
export const SETTING_CARD_RESOLVED_EVENT = 'setting_card_resolved';

/** 三个工具名（core 注册、ACP 能力包 `settings` 与提示词门控共用）。 */
export const SETTINGS_SEARCH_TOOL = 'settings_search';
export const SETTINGS_READ_TOOL = 'settings_read';
export const SETTINGS_CHANGE_TOOL = 'settings_change';

/** 防刷屏（§6.1）：每个 run 最多出几张设置卡。 */
export const SETTING_CARDS_PER_RUN_MAX = 3;
/** 同一 Bot 在同一对话里对同一项窗口内被拒这么多次后，宿主拒绝再出卡（§6.1，参照 D80 按条目计）。 */
export const SETTING_CARD_DECLINE_MAX = 2;
export const SETTING_CARD_DECLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** direct 回执卡「撤销」的有效期（§5.3）。 */
export const SETTING_RECEIPT_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 条目字段值（只含非敏感字段；键 = `SettingFieldSpec.name`）。值是 JSON，具体形态由条目
 * 字段类型决定（model = "provider/modelId"，toggle = boolean，multiple = 数组……）。
 */
export const settingValuesSchema = z.record(z.string(), z.unknown());
export type SettingValues = z.infer<typeof settingValuesSchema>;

/**
 * 卡片状态（§6.1）：`pending` 待用户处理；`applied` 已应用（含 direct 回执卡的初始态）；
 * `dismissed` 用户「不用了」；`superseded` 同一对话同一项出了新卡；`expired` 过期；
 * `reverted` 回执卡被撤销。
 */
export const settingCardStateSchema = z.enum([
  'pending',
  'applied',
  'dismissed',
  'superseded',
  'expired',
  'reverted',
]);
export type SettingCardState = z.infer<typeof settingCardStateSchema>;
export const SETTING_CARD_TERMINAL_STATES: ReadonlySet<SettingCardState> = new Set([
  'dismissed',
  'superseded',
  'expired',
  'reverted',
]);

/**
 * 卡片作用对象（条目 `scope` 决定哪个非空）：`bot` 项 → 被修改的 Bot；`group` 项 → 群会话；
 * `workdir` 项 → 工作目录；`global` 项全空。卡片所在的对话由消息行给出，不重复。
 */
export const settingTargetSchema = z.object({
  botId: z.string().optional(),
  conversationId: z.string().optional(),
  workdirId: z.string().optional(),
});
export type SettingTarget = z.infer<typeof settingTargetSchema>;

/**
 * 设置卡内容（`systemEventContentSchema.setting`，event = `setting_card`），写回方式同
 * `schedule_offer`：core 按消息 id 改 `state` 并发 `message.updated`。
 */
export const settingCardContentSchema = z.object({
  /** 出卡的 Bot（`settings_change` 的调用方）。 */
  botId: z.string(),
  /** 出卡的 run；用户在卡上操作时为空不影响（如 run 已结束）。 */
  runId: z.string().nullable(),
  itemId: z.string(),
  /** 宿主裁定后的档位（`effectiveMode` 的结果，不会是 redirect / refused）。 */
  mode: settingWriteModeSchema,
  target: settingTargetSchema.default({}),
  /** Bot 建议的新值（user-only / link 卡恒为 null：宿主不采用 values）。 */
  proposed: settingValuesSchema.nullable(),
  /**
   * 出卡时的当前值快照（「当前 → 建议」的左边，也是 `settings.items.apply` 的 `expected`）；
   * 渲染层条目 core 读不到 → null。
   */
  before: settingValuesSchema.nullable(),
  /** 卡上的人话快照（模型名、厂商名等展示用文本），core 生成；缺省时卡片自己格式化。 */
  beforeText: z.string().optional(),
  proposedText: z.string().optional(),
  /** Bot 给的一句话理由（经清洗），显示在卡片上。 */
  reason: z.string(),
  /** 宿主收紧的原因（`effectiveMode` 的 reason，例如「群聊中只能出卡」）；没有收紧时缺省。 */
  modeReason: z.string().optional(),
  state: settingCardStateSchema,
  /** 实际应用后的值（applied 时；direct 回执卡 = 新值，用于撤销）。 */
  applied: settingValuesSchema.optional(),
  /** direct 回执卡的撤销截止时间（`SETTING_RECEIPT_UNDO_WINDOW_MS`）；其余卡缺省。 */
  undoUntil: z.number().optional(),
  /** 状态落定时间。 */
  decidedAt: z.number().optional(),
});
export type SettingCardContent = z.infer<typeof settingCardContentSchema>;

/**
 * `setting_card_resolved` 内部事件的结构化部分（`systemEventContentSchema.settingResolved`）：
 * 消息 `text` 是给 Bot 的人话（「用户已应用：X（旧→新）」/「用户没有修改 X」），这里留机器
 * 可读的同一份事实。
 */
export const settingCardResolvedSchema = z.object({
  /** 设置卡的消息 id。 */
  cardMessageId: z.string(),
  itemId: z.string(),
  outcome: z.enum(['applied', 'dismissed']),
  before: settingValuesSchema.nullable(),
  after: settingValuesSchema.nullable(),
});
export type SettingCardResolved = z.infer<typeof settingCardResolvedSchema>;

// --- Bot 工具的结构化结果（参数的 TypeBox schema 在 core）-------------------------

/**
 * 条目当前状态（core 适配器读取）：`unknown` = 渲染层条目，core 看不到（「只在本机界面可见」）；
 * `readonly` = 只读项（诊断 / 用量）的概要。
 */
export const settingItemStatusSchema = z.enum([
  'configured',
  'unconfigured',
  'partial',
  'unknown',
  'readonly',
]);
export type SettingItemStatus = z.infer<typeof settingItemStatusSchema>;

/** 宿主裁定结果的可序列化形态（`effectiveMode` → 工具返回 / 卡片）。 */
export const settingModeDecisionSchema = z.object({
  mode: z.union([settingWriteModeSchema, z.enum(['redirect', 'refused'])]),
  acceptValues: z.boolean(),
  tool: z.string().nullable(),
  rules: z.array(z.string()),
  reason: z.string().nullable(),
});

/** `settings_search` 无 query：每组一行就绪概况（§5.2，≤2KB）。 */
export const settingsOverviewRowSchema = z.object({
  group: settingGroupSchema,
  title: z.string(),
  /** 一行人话，如「主模型已配；图像能力未配」。 */
  summary: z.string(),
});

/** `settings_search` 有 query：一个命中条目。 */
export const settingsSearchHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  status: settingItemStatusSchema,
  /** 本次上下文里可用的最宽松档（`effectiveMode` 的 mode）。 */
  mode: settingModeDecisionSchema.shape.mode,
});

export const settingsSearchResultSchema = z.union([
  z.object({ kind: z.literal('overview'), groups: z.array(settingsOverviewRowSchema) }),
  z.object({
    kind: z.literal('results'),
    query: z.string(),
    items: z.array(settingsSearchHitSchema),
  }),
]);
export type SettingsSearchResult = z.infer<typeof settingsSearchResultSchema>;

/** `settings_read` 的一个字段：敏感字段只给 `configured`，永不给值。 */
export const settingsReadFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: settingFieldTypeSchema,
  sensitive: z.boolean(),
  /** 非敏感字段的当前值（脱敏后）；渲染层条目 / 敏感字段缺省。 */
  value: z.unknown().optional(),
  /** 敏感字段：是否已配置。 */
  configured: z.boolean().optional(),
  /** 可选值（≤ `SETTINGS_READ_OPTIONS_MAX`）。 */
  options: z.array(settingOptionSchema).optional(),
});

export const settingsReadResultSchema = z.union([
  z.object({
    kind: z.literal('item'),
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    group: settingGroupSchema,
    scope: settingScopeSchema,
    owner: settingOwnerSchema,
    status: settingItemStatusSchema,
    fields: z.array(settingsReadFieldSchema),
    /** 本次上下文里实际可用的档位与原因（如「群聊中只能出卡」）。 */
    decision: settingModeDecisionSchema,
  }),
  /** 未知 id：最接近的候选。 */
  z.object({ kind: z.literal('unknown'), id: z.string(), candidates: z.array(z.string()) }),
]);
export type SettingsReadResult = z.infer<typeof settingsReadResultSchema>;

/**
 * `settings_change` 的结果：
 * - `applied`：direct 档已执行，出了回执卡（可撤销）；
 * - `card`：出了 confirm / form / user-only / link 卡，等用户处理（完成后会收到通知）；
 * - `setup_required`：任务里带 `required: true` 且需要用户处理 → 走失败续跑链（§6.2）；
 * - `redirect`：条目经专门工具，请改用 `tool`；
 * - `rejected`：values 含敏感 / 未知字段、档位 refused、防刷屏限制等。
 */
export const settingsChangeResultSchema = z.object({
  outcome: z.enum(['applied', 'card', 'setup_required', 'redirect', 'rejected']),
  itemId: z.string(),
  mode: settingModeDecisionSchema.shape.mode.nullable(),
  /** 回执卡 / 设置卡的消息 id。 */
  cardMessageId: z.string().nullable(),
  tool: z.string().nullable(),
  before: settingValuesSchema.nullable(),
  after: settingValuesSchema.nullable(),
  /** 给 Bot 的人话结果。 */
  message: z.string(),
});
export type SettingsChangeResult = z.infer<typeof settingsChangeResultSchema>;
