import { z } from 'zod';

/**
 * 随附技能提示（D73 P3 §7.6）：目录条目 `_meta["app.kepcup/connector"].skills` 声明的技能，
 * 在连接成功后提示安装到被授权的 Bot。安装一律走既有 `skill_import` 审批（D63），本模块
 * 只有视图 / RPC / 事件 schema。
 */

/** 提示里的一个技能（不含来源细节之外的任何内容）。 */
export const appSkillOfferItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** HTTPS git 仓库地址（安装审批卡上显示的来源）。 */
  source: z.string(),
});
export type AppSkillOfferItem = z.infer<typeof appSkillOfferItemSchema>;

/** 某个 Bot 还缺的随附技能。 */
export const appSkillOfferBotSchema = z.object({
  botId: z.string(),
  botName: z.string(),
  skills: z.array(appSkillOfferItemSchema).min(1),
});
export type AppSkillOfferBot = z.infer<typeof appSkillOfferBotSchema>;

/** `apps.skills.offers` 的结果：这个连接的随附技能里，各被授权 Bot 尚未安装的部分（可能为空）。 */
export const appsSkillsOffersInputSchema = z.object({ connectionId: z.string().min(1) });
export const appsSkillsOffersOutputSchema = z.object({
  connectionId: z.string(),
  connectorId: z.string(),
  /** 应用显示名（目录条目标题）。 */
  title: z.string(),
  bots: z.array(appSkillOfferBotSchema),
});
export type AppsSkillsOffers = z.infer<typeof appsSkillsOffersOutputSchema>;

/** `apps.skills_offer` 事件：连接完成且有 Bot 缺随附技能时推送一次。 */
export const appSkillsOfferEventSchema = z.object({
  connectionId: z.string(),
  connectorId: z.string(),
  title: z.string(),
  /** 缺技能的 Bot。 */
  botIds: z.array(z.string()).min(1),
  /** 这些 Bot 缺的技能的并集。 */
  skills: z.array(appSkillOfferItemSchema).min(1),
});
export type AppSkillsOfferEvent = z.infer<typeof appSkillsOfferEventSchema>;

/**
 * `apps.skills.install`：对一个 Bot 发起安装（逐个技能各提交一张 `skill_import` 审批卡，批准前
 * 什么都不安装）。`names` 缺省 = 该条目声明且尚未安装的全部。
 */
export const appsSkillsInstallInputSchema = z.object({
  connectionId: z.string().min(1),
  botId: z.string().min(1),
  names: z.array(z.string().min(1)).max(32).optional(),
});
export const appSkillInstallResultSchema = z.object({
  name: z.string(),
  /**
   * `submitted`：审批卡已提交（`approvalId`）；`pending`：已有同来源的待审批卡；
   * `installed`：该 Bot 已有同名技能；`failed`：克隆 / 扫描失败等（`error`）；
   * `mismatch`：来源里 SKILL.md 的 name 与目录声明不一致（目录条目有误，不再提示）。
   */
  status: z.enum(['submitted', 'pending', 'installed', 'failed', 'mismatch']),
  approvalId: z.string().optional(),
  error: z.string().optional(),
});
export const appsSkillsInstallOutputSchema = z.object({
  results: z.array(appSkillInstallResultSchema),
});
export type AppsSkillsInstallOutput = z.infer<typeof appsSkillsInstallOutputSchema>;
