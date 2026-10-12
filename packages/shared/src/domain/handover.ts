import { z } from 'zod';
import { butlerProposedBotSchema } from './types.js';

/**
 * Bot 资产移交（D88，docs/design/37-bot-asset-handover.md）的契约。
 *
 * 发起方（管家可以以任何 Bot 为来源；普通 Bot 只能交出自己的，P1）用 `inspect_bot_assets`
 * 盘点、`propose_handover` 提交一张
 * `bot_handover` 审批卡；卡片渲染所需的展示字段在提交时由 core 生成并快照进 payload
 * （渲染端不再查询）。用户逐项勾选后确认（`handoverSelection`），core 按清单确定性执行，
 * 进度经 `handover.updated` 推送。
 */

/**
 * 资产类型（适配器的 `type`）。P0：model / app / mcp / mail / schedule；P1：watch / skill /
 * memory；wiki / widget 为 P2 预留。
 */
export const handoverAssetTypeSchema = z.enum([
  'model',
  'app',
  'mcp',
  'mail',
  'schedule',
  'watch',
  'skill',
  'memory',
  'wiki',
  'widget',
]);
export type HandoverAssetType = z.infer<typeof handoverAssetTypeSchema>;

/** 移交 = B 获得、A 失去；共享 = 同一份资源两边都有；复制 = B 得到独立副本。 */
export const handoverActionSchema = z.enum(['move', 'share', 'copy']);
export type HandoverAction = z.infer<typeof handoverActionSchema>;

/** 职责改写的保留条目 key（`handoverSelection` 里与资产 key 并列）。 */
export const HANDOVER_RESP_TO_KEY = 'resp:to';
export const HANDOVER_RESP_FROM_KEY = 'resp:from';

/**
 * 条目标记（P1）：`external_import` = 外部导入的技能（卡上标「外部导入」：确认移交卡即
 * 授权，不再走 skill_import 审批）；`sensitive` = 敏感记忆（标「敏感」，默认不勾）。
 */
export const handoverMarkSchema = z.enum(['external_import', 'sensitive']);
export type HandoverMark = z.infer<typeof handoverMarkSchema>;

/** 卡片上的一行资产（core 生成的展示快照）。 */
export const handoverCardItemSchema = z.object({
  key: z.string(),
  assetType: handoverAssetTypeSchema,
  action: handoverActionSchema,
  /** 名称（邮箱地址、应用账号、定时任务标题……）。 */
  label: z.string(),
  /** 会发生什么（一句话）。 */
  detail: z.string().default(''),
  /** 风险 / 副作用提示（如「A 正在运行的任务会被中断」）。 */
  warnings: z.array(z.string()).default([]),
  /** 不可执行的原因：卡上置灰、不能勾选、不会执行。缺省 = 可勾选。 */
  blocked: z.string().optional(),
  /** 标记（外部导入 / 敏感）。 */
  marks: z.array(handoverMarkSchema).default([]),
  /** 卡上默认是否勾选（敏感记忆默认不勾）；不影响可勾选性。 */
  defaultSelected: z.boolean().default(true),
});
export type HandoverCardItem = z.infer<typeof handoverCardItemSchema>;

/**
 * 新建目标（字段同 `propose_bot`）。`model`：`'inherit'` = 与来源 Bot 当下的模型相同；
 * `''` = 跟随设置默认；否则是可用模型列表里的 ref。`modelLabel` 是卡片显示用的快照。
 */
export const handoverNewBotSchema = butlerProposedBotSchema.extend({
  model: z.string().default('inherit'),
  modelLabel: z.string().default(''),
});
export type HandoverNewBot = z.infer<typeof handoverNewBotSchema>;

export const handoverTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), botId: z.string(), botName: z.string().default('') }),
  z.object({ kind: z.literal('new'), bot: handoverNewBotSchema }),
]);
export type HandoverTarget = z.infer<typeof handoverTargetSchema>;

/** 职责改写：模型给出的改后全文与提交时的原文（卡上前后对照）。 */
export const handoverResponsibilitiesSchema = z.object({
  /** B 改写后的 `role.responsibilities` 全文（新建目标时不出现：直接用 bot.responsibilities）。 */
  to: z.string().optional(),
  /** A 改写后的全文（A 是管家时不出现）。 */
  from: z.string().optional(),
  toBefore: z.string().default(''),
  fromBefore: z.string().default(''),
});
export type HandoverResponsibilities = z.infer<typeof handoverResponsibilitiesSchema>;

/** Payload of a `bot_handover` approval. */
export const botHandoverPayloadSchema = z.object({
  handoverId: z.string(),
  fromBotId: z.string(),
  fromBotName: z.string().default(''),
  target: handoverTargetSchema,
  items: z.array(handoverCardItemSchema),
  responsibilities: handoverResponsibilitiesSchema.optional(),
  /** 交接要点（发起方写，写进 B 的私聊；卡上只读展示）。 */
  handoverNote: z.string().default(''),
  /** 给用户的一句话说明（卡上）。 */
  note: z.string().default(''),
});
export type BotHandoverPayload = z.infer<typeof botHandoverPayloadSchema>;

/**
 * 卡上可以勾选的 key：未置灰的资产条目 + 出现了的职责改写。core 校验
 * `handoverSelection` 不得超出这个集合；缺省选择 = 全部。
 */
export function selectableHandoverKeys(payload: BotHandoverPayload): string[] {
  const keys = payload.items.filter((item) => item.blocked === undefined).map((item) => item.key);
  if (payload.responsibilities?.to !== undefined) keys.push(HANDOVER_RESP_TO_KEY);
  if (payload.responsibilities?.from !== undefined) keys.push(HANDOVER_RESP_FROM_KEY);
  return keys;
}

/**
 * 卡上默认勾选的 key：可勾选的里去掉 `defaultSelected: false` 的（敏感记忆）。卡片的
 * 初始勾选与「决定里没带 handoverSelection」时 core 的缺省都用它。
 */
export function defaultHandoverKeys(payload: BotHandoverPayload): string[] {
  const optOut = new Set(
    payload.items.filter((item) => !item.defaultSelected).map((item) => item.key),
  );
  return selectableHandoverKeys(payload).filter((key) => !optOut.has(key));
}

export const handoverStatusSchema = z.enum([
  'proposed',
  'applying',
  'completed',
  'partial',
  'failed',
  'denied',
  'cancelled',
]);
export type HandoverStatus = z.infer<typeof handoverStatusSchema>;

export const handoverItemStatusSchema = z.enum(['pending', 'done', 'skipped', 'failed']);
export type HandoverItemStatus = z.infer<typeof handoverItemStatusSchema>;

/** 一项的执行状态（卡片进度 / 结果态）。 */
export const handoverItemViewSchema = z.object({
  key: z.string(),
  assetType: z.string(),
  status: handoverItemStatusSchema,
  /** skipped / failed 的原因。 */
  error: z.string().nullable(),
});
export type HandoverItemView = z.infer<typeof handoverItemViewSchema>;

/** 一次移交的执行视图（`handovers.get` 与 `handover.updated`）。 */
export const handoverViewSchema = z.object({
  id: z.string(),
  approvalId: z.string().nullable(),
  conversationId: z.string(),
  status: handoverStatusSchema,
  fromBotId: z.string(),
  /** 新建目标在建好后回填。 */
  toBotId: z.string().nullable(),
  items: z.array(handoverItemViewSchema),
  updatedAt: z.number(),
});
export type HandoverView = z.infer<typeof handoverViewSchema>;
