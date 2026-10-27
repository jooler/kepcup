import { z } from 'zod';

/**
 * 邮件通道（D84，docs/design/35-mail-channel.md）。
 *
 * 平行于「连接应用」的本机通道：IMAP 收、SMTP 发，凭据是授权码而不是 OAuth。
 * 预设与间隔下限放在这里，core 的会话和 desktop 的扩展中心共用同一份。
 */

export const MAIL_CARD_TYPE = 'mail';
export const MAIL_ALERT_EVENT = 'mail_alert';

/** 同一（账号, Bot）滚动 1 小时内的唤醒上限；超出则暂停该绑定的唤醒。 */
export const MAIL_MAX_ALERTS_PER_HOUR = 30;
/** 唤醒摘要与卡片上的纯文本上限。全文仍由 mail_read 按需取。 */
export const MAIL_SNIPPET_MAX_CHARS = 500;
/** 全局轮询间隔硬限（秒）。厂商预设可以再抬高下限。 */
export const MAIL_POLL_MIN_SEC = 60;
export const MAIL_POLL_MAX_SEC = 6 * 60 * 60;
/** IDLE 主动 DONE 再进入的间隔：短于 RFC 2177 的 29 分钟，也短于 Gmail 的空闲超时。 */
export const MAIL_IDLE_REFRESH_MS = 9 * 60 * 1000;
/** 断开后的指数退避封顶。 */
export const MAIL_RECONNECT_CAP_MS = 15 * 60 * 1000;
/** RFC 2971 ID 的 name。163/126 在 SELECT 前必须见到它。 */
export const MAIL_IMAP_ID_NAME = 'KepCup';
export const MAIL_IMAP_ID_VERSION = '0.0.0';
/**
 * list / search 时 UID 窗口上限：只在 uidNext 往前这么多里搜，避免 SEARCH ALL
 * 把超大邮箱的全部 UID 拉进内存。catch-up（已有 minUid）不受此限。
 */
export const MAIL_SEARCH_UID_WINDOW = 5000;

/** 计算 SEARCH 用的 UID 下界（含）。 */
export function mailSearchUidLowerBound(
  uidNext: number,
  options: { minUid?: number; window?: number } = {},
): number {
  if (options.minUid !== undefined) return Math.max(1, Math.floor(options.minUid));
  const window = options.window ?? MAIL_SEARCH_UID_WINDOW;
  const next = Number.isFinite(uidNext) && uidNext > 1 ? Math.floor(uidNext) : 1;
  return Math.max(1, next - Math.max(1, window));
}

export const mailProviderSchema = z.enum([
  'qq',
  'netease_163',
  'netease_126',
  'gmail',
  'outlook',
  'custom',
]);
export type MailProvider = z.infer<typeof mailProviderSchema>;

export const mailSecureSchema = z.enum(['ssl', 'starttls']);
export type MailSecure = z.infer<typeof mailSecureSchema>;

export const mailModeSchema = z.enum(['auto', 'poll_only']);
export type MailMode = z.infer<typeof mailModeSchema>;

export const mailStatusSchema = z.enum(['idle', 'running', 'paused', 'error']);
export type MailStatus = z.infer<typeof mailStatusSchema>;

/** 运行中的收信方式：IMAP IDLE，或长连接上的轮询。 */
export const mailListenSchema = z.enum(['idle', 'poll']);
export type MailListen = z.infer<typeof mailListenSchema>;

export const mailEventSchema = z.enum(['arrived']);
export type MailEvent = z.infer<typeof mailEventSchema>;

export interface MailServerEndpoint {
  host: string;
  port: number;
  secure: MailSecure;
}

export interface MailProviderPreset {
  id: MailProvider;
  /** 能否用授权码在 P0 创建。Outlook 需要 OAuth，预设可见但不可保存。 */
  available: boolean;
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
  /** 新建账号的默认收信模式。163/126 无 IDLE，默认仅轮询。 */
  defaultMode: MailMode;
  defaultPollSec: number;
  /** 与全局下限取较大者。 */
  minPollSec: number;
  /** 授权码获取说明。空字符串 = 自定义，没有厂商帮助页。 */
  helpUrl: string;
}

export const MAIL_PROVIDER_PRESETS: Record<MailProvider, MailProviderPreset> = {
  qq: {
    id: 'qq',
    available: true,
    imap: { host: 'imap.qq.com', port: 993, secure: 'ssl' },
    smtp: { host: 'smtp.qq.com', port: 465, secure: 'ssl' },
    defaultMode: 'auto',
    defaultPollSec: 300,
    minPollSec: 120,
    helpUrl: 'https://help.mail.qq.com/detail/108/1089/',
  },
  netease_163: {
    id: 'netease_163',
    available: true,
    imap: { host: 'imap.163.com', port: 993, secure: 'ssl' },
    smtp: { host: 'smtp.163.com', port: 465, secure: 'ssl' },
    defaultMode: 'poll_only',
    defaultPollSec: 300,
    minPollSec: 180,
    helpUrl: 'https://help.mail.163.com/',
  },
  netease_126: {
    id: 'netease_126',
    available: true,
    imap: { host: 'imap.126.com', port: 993, secure: 'ssl' },
    smtp: { host: 'smtp.126.com', port: 465, secure: 'ssl' },
    defaultMode: 'poll_only',
    defaultPollSec: 300,
    minPollSec: 180,
    helpUrl: 'https://help.mail.126.com/',
  },
  gmail: {
    id: 'gmail',
    available: true,
    imap: { host: 'imap.gmail.com', port: 993, secure: 'ssl' },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: 'ssl' },
    defaultMode: 'auto',
    defaultPollSec: 300,
    minPollSec: MAIL_POLL_MIN_SEC,
    helpUrl: 'https://developers.google.com/workspace/gmail/imap/imap-smtp',
  },
  outlook: {
    id: 'outlook',
    available: false,
    imap: { host: 'outlook.office365.com', port: 993, secure: 'ssl' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: 'starttls' },
    defaultMode: 'auto',
    defaultPollSec: 300,
    minPollSec: MAIL_POLL_MIN_SEC,
    helpUrl:
      'https://support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040',
  },
  custom: {
    id: 'custom',
    available: true,
    imap: { host: '', port: 993, secure: 'ssl' },
    smtp: { host: '', port: 465, secure: 'ssl' },
    defaultMode: 'auto',
    defaultPollSec: 300,
    minPollSec: MAIL_POLL_MIN_SEC,
    helpUrl: '',
  },
};

/** 把用户填的间隔夹进全局硬限和该厂商的下限。 */
export function clampMailPollInterval(provider: MailProvider, seconds: number): number {
  const preset = MAIL_PROVIDER_PRESETS[provider];
  const min = Math.max(MAIL_POLL_MIN_SEC, preset.minPollSec);
  const rounded = Number.isFinite(seconds) ? Math.round(seconds) : preset.defaultPollSec;
  return Math.min(MAIL_POLL_MAX_SEC, Math.max(min, rounded));
}

/**
 * 连接成功后的收信路径。有 IDLE 且模式为 auto 才走 IDLE；否则轮询。
 * 厂商「是否尝试 IDLE」体现在默认 mode（163 默认 poll_only），运行时以 CAPABILITY 为准。
 */
export function resolveMailListen(mode: MailMode, capabilities: readonly string[]): MailListen {
  const hasIdle = capabilities.some((item) => item.toUpperCase() === 'IDLE');
  return mode === 'auto' && hasIdle ? 'idle' : 'poll';
}

export function mailAlertDedupeKey(accountId: string, uid: number, botId: string): string {
  return `mail:${accountId}:${uid}:${botId}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isMailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export const mailAccountSchema = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string(),
  provider: mailProviderSchema,
  imapHost: z.string(),
  imapPort: z.number().int(),
  imapSecure: mailSecureSchema,
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecure: mailSecureSchema,
  username: z.string(),
  mode: mailModeSchema,
  pollIntervalSec: z.number().int(),
  status: mailStatusSchema,
  listen: mailListenSchema.nullable(),
  lastError: z.string().nullable(),
  lastOkAt: z.number().nullable(),
  unseenCount: z.number().int().nullable(),
  botIds: z.array(z.string()),
  /** 提醒风暴后暂停唤醒的 Bot；账号会话仍在，UID 游标照常前进。 */
  alertPausedBotIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

export const mailAccountsListOutputSchema = z.object({
  accounts: z.array(mailAccountSchema),
});

export const mailAccountIdInputSchema = z.object({
  id: z.string().min(1),
});

export const mailAccountGetOutputSchema = z.object({
  account: mailAccountSchema,
});

const mailEndpointInput = {
  imapHost: z.string().optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: mailSecureSchema.optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: mailSecureSchema.optional(),
};

export const mailAccountTestInputSchema = z.object({
  provider: mailProviderSchema,
  address: z.string().min(3),
  password: z.string().min(1),
  username: z.string().optional(),
  ...mailEndpointInput,
});
export type MailAccountTestInput = z.infer<typeof mailAccountTestInputSchema>;

export const mailAccountTestOutputSchema = z.object({
  ok: z.literal(true),
  idle: z.boolean(),
  smtp: z.boolean(),
});

export const mailAccountCreateInputSchema = mailAccountTestInputSchema.extend({
  label: z.string().optional(),
  mode: mailModeSchema.optional(),
  pollIntervalSec: z.number().int().optional(),
  botIds: z.array(z.string()).optional(),
});
export type MailAccountCreateInput = z.infer<typeof mailAccountCreateInputSchema>;

export const mailAccountUpdateInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  mode: mailModeSchema.optional(),
  pollIntervalSec: z.number().int().optional(),
  username: z.string().optional(),
  ...mailEndpointInput,
});
export type MailAccountUpdateInput = z.infer<typeof mailAccountUpdateInputSchema>;

export const mailAccountSetBotsInputSchema = z.object({
  id: z.string().min(1),
  botIds: z.array(z.string()),
});

export const mailBotSetAccountsInputSchema = z.object({
  botId: z.string().min(1),
  accountIds: z.array(z.string()),
});

export const mailBindingResumeInputSchema = z.object({
  accountId: z.string().min(1),
  botId: z.string().min(1),
});

/**
 * 邮件预填模板（D104 P1-3，设计 51 §4「mail」行）：插件贡献的 overlay，不落库。
 * `id` = `${pluginId}#${localId}`；端点 / 模式 / 轮询下限只用于预填「添加邮箱」表单，
 * 创建出的账号仍是 `provider:'custom'`，全局 60 秒轮询下限照常生效。
 */
export const mailProviderTemplateSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  label: z.string(),
  imap: z.object({ host: z.string(), port: z.number().int(), secure: mailSecureSchema }),
  smtp: z.object({ host: z.string(), port: z.number().int(), secure: mailSecureSchema }),
  defaultMode: mailModeSchema,
  defaultPollSec: z.number().int(),
  minPollSec: z.number().int(),
  helpUrl: z.string().nullable(),
});
export type MailProviderTemplate = z.infer<typeof mailProviderTemplateSchema>;

export const mailProviderTemplatesListOutputSchema = z.object({
  templates: z.array(mailProviderTemplateSchema),
});

/** 发信审批卡的载荷：收件人与正文完整列出，不走摘要截断。 */
export const mailSendApprovalPayloadSchema = z.object({
  accountId: z.string(),
  accountLabel: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  tainted: z.boolean().optional(),
  taintedSince: z.number().optional(),
});
export type MailSendApprovalPayload = z.infer<typeof mailSendApprovalPayloadSchema>;
