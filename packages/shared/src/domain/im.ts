import { z } from 'zod';

/**
 * 即时通讯通道（D107–D111，docs/design/54-im-channel.md）。
 *
 * `im` 是与 mail 同配方的实例型能力类型：插件贡献是「实例供给规范」（transport /
 * 端点 / 建号方式 / 能力面），账号由用户逐个添加。宿主为 im 提供的不是工具面，而是
 * 入站管线（长轮询 → im_alert 唤醒私聊）+ 出站转发器（Bot 回复自动同步，Bot 无感）。
 * 协议客户端按 transport 隔离（首发 ilink = 个人微信 iLink Bot API）。
 */

export const IM_CARD_TYPE = 'im';
export const IM_ALERT_EVENT = 'im_alert';

/** 同一（账号, Bot）滚动 1 小时内的入站唤醒上限；超出则暂停该绑定的唤醒（同 mail）。 */
export const IM_MAX_ALERTS_PER_HOUR = 30;
/** 同一账号滚动 1 小时内的转发上限；超出合并降级（防 Bot 高频短回复刷屏微信）。 */
export const IM_MAX_FORWARDS_PER_HOUR = 60;
/** 转发正文的字符截断阈值（PoC §4-4 定案前先取保守值；尾部拼接「完整内容见 KepCup」）。 */
export const IM_FORWARD_MAX_CHARS = 2000;
/** 转发截断后追加的尾注文案。 */
export const IM_FORWARD_TRUNCATED_SUFFIX = '…（完整内容见 KepCup）';
/** 会话长轮询断开后的指数退避封顶。 */
export const IM_RECONNECT_CAP_MS = 15 * 60 * 1000;

export const imTransportSchema = z.enum(['ilink', 'wecom-app', 'telegram-bot', 'webhook']);
export type ImTransport = z.infer<typeof imTransportSchema>;

/** 贡献声明的媒体面；宿主按 transport 实际实现裁剪（首期文本入站 + 文本转发）。 */
export const imMediaKindSchema = z.enum(['text', 'image', 'voice', 'file', 'video']);
export type ImMediaKind = z.infer<typeof imMediaKindSchema>;

export const imSetupSchema = z.enum(['qrcode', 'secret']);
export type ImSetup = z.infer<typeof imSetupSchema>;

/** 账号会话状态（54 §3）。auth_failed = token 失效，等用户重扫；paused = -14 风控暂停。 */
export const imStatusSchema = z.enum(['connecting', 'ready', 'paused', 'auth_failed', 'error']);
export type ImStatus = z.infer<typeof imStatusSchema>;

export const imEventSchema = z.enum(['arrived']);
export type ImEvent = z.infer<typeof imEventSchema>;

/** 扫码登录轮询状态（iLink get_qrcode_status 的宿主侧投影，§4）。 */
export const imQrcodeStatusSchema = z.enum([
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'failed',
]);
export type ImQrcodeStatus = z.infer<typeof imQrcodeStatusSchema>;

/** 滚动 1 小时内的唤醒时间。超出上限的那一次不唤醒。 */
export function recentImAlerts(times: readonly number[], now: number): number[] {
  const HOUR_MS = 60 * 60 * 1000;
  return times.filter((at) => at > now - HOUR_MS && at <= now);
}

export function imAlertsExceeded(recentCount: number): boolean {
  return recentCount >= IM_MAX_ALERTS_PER_HOUR;
}

/** 滚动 1 小时内的转发时间。超出上限的那一次合并降级。 */
export function recentImForwards(times: readonly number[], now: number): number[] {
  const HOUR_MS = 60 * 60 * 1000;
  return times.filter((at) => at > now - HOUR_MS && at <= now);
}

export function imForwardsExceeded(recentCount: number): boolean {
  return recentCount >= IM_MAX_FORWARDS_PER_HOUR;
}

/** 会话断开重连：1s 起翻倍，封顶 {@link IM_RECONNECT_CAP_MS}。streak 从 1 计。 */
export function imBackoffMs(streak: number): number {
  const shift = Math.min(10, Math.max(0, streak - 1));
  return Math.min(IM_RECONNECT_CAP_MS, 1000 * 2 ** shift);
}

export function imAlertDedupeKey(accountId: string, msgId: string, botId: string): string {
  return `im:${accountId}:${msgId}:${botId}`;
}

export function imForwardDedupeKey(messageId: string, accountId: string): string {
  return `im_forward:${messageId}:${accountId}`;
}

/** 扫码登录会话（内存态，不落库；confirmed 后 token 进实例 secrets）。 */
export interface ImQrcodeSession {
  /** iLink `qrcode`（轮询键）。 */
  qrcode: string;
  /** 宿主已渲染的二维码内容（iLink `qrcode_img_content`）。 */
  content: string;
  createdAt: number;
}

export const imQrcodeCreateOutputSchema = z.object({
  sessionKey: z.string().min(1),
  qrcodeContent: z.string().min(1),
});
export type ImQrcodeCreateOutput = z.infer<typeof imQrcodeCreateOutputSchema>;

/** 传入 accountId = 既有账号的重扫（更新流程）；缺省 = 新建。 */
export const imQrcodeCreateInputSchema = z.object({
  pluginId: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

export const imQrcodePollInputSchema = z.object({
  sessionKey: z.string().min(1),
});
export const imQrcodePollOutputSchema = z.object({
  status: imQrcodeStatusSchema,
  /** confirmed 时回填：建号继续走 plugins.instances.update 语义之外的直接落地。 */
  instanceId: z.string().nullable(),
  label: z.string().nullable(),
});
export type ImQrcodePollOutput = z.infer<typeof imQrcodePollOutputSchema>;

// --- rows ----------------------------------------------------------------------

export interface ImAccountRecord {
  id: string;
  /** 所属插件实例；im 插件无遗留账号，恒非空。 */
  instanceId: string;
  transport: ImTransport;
  apiBase: string;
  label: string;
  status: ImStatus;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  /** 非敏感会话元数据（ilink_bot_id、登录时间、getUpdates 游标等）。 */
  configJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImBindingRecord {
  accountId: string;
  botId: string;
  /** D111「同步消息到此微信」：绑定即入站，勾选才出站；永不自动取消。 */
  forwardEnabled: boolean;
  forwardUpdatedAt: number | null;
  /** 入站唤醒暂停（风暴护栏）与滚动窗口，同 mail。 */
  alertsPaused: boolean;
  alertTimes: number[];
  createdAt: number;
}

// --- public shapes（RPC / 渲染层） ----------------------------------------------

export const imAccountSchema = z.object({
  id: z.string(),
  transport: imTransportSchema,
  apiBase: z.string(),
  label: z.string(),
  status: imStatusSchema,
  lastError: z.string().nullable(),
  lastInboundAt: z.number().nullable(),
  lastOutboundAt: z.number().nullable(),
  /** 非敏感元数据投影（ilink_bot_id、登录时间）。 */
  config: z.record(z.string(), z.unknown()),
  botIds: z.array(z.string()),
  /** 开启了转发的 Bot（D111 渲染开关的初值来源）。 */
  forwardBotIds: z.array(z.string()),
  /** 提醒风暴后暂停唤醒的 Bot。 */
  alertPausedBotIds: z.array(z.string()),
  instanceId: z.string(),
  pluginId: z.string(),
  pluginName: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ImAccount = z.infer<typeof imAccountSchema>;

export const imAccountsListOutputSchema = z.object({
  accounts: z.array(imAccountSchema),
});

export const imAccountGetOutputSchema = z.object({
  account: imAccountSchema,
});

export const imAccountIdInputSchema = z.object({
  id: z.string().min(1),
});

export const imAccountSetBotsInputSchema = z.object({
  id: z.string().min(1),
  botIds: z.array(z.string()),
});

/** D111：绑定行内的「同步消息到此微信」开关。 */
export const imBindingSetForwardInputSchema = z.object({
  accountId: z.string().min(1),
  botId: z.string().min(1),
  forwardEnabled: z.boolean(),
});

// --- 审批卡 / 唤醒文本 -----------------------------------------------------------

/** 入站卡片与唤醒文本的纯文本上限（54 §5：摘要不自动展开全文）。 */
export const IM_SNIPPET_MAX_CHARS = 500;

/** 一行化并截断入站摘要字段（微信文本是外部内容，控制字符折叠同 mail）。 */
export function imSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > IM_SNIPPET_MAX_CHARS ? oneLine.slice(0, IM_SNIPPET_MAX_CHARS) : oneLine;
}
