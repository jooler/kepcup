import { z } from 'zod';

import { conversationTypeSchema, messageStatusSchema } from './types.js';

/**
 * AI 生成内容举报（Microsoft Store 11.16，todo/ai-content-reporting.md §5 / §6.5）。
 *
 * 契约分三段：
 *  1. report payload（§5.1）：渲染层点 👎 后 core 校验并构建，入 `report_outbox`
 *     队列异步发往 reports Worker；Worker 用同一套 canonicalJson 重算两个 hash，
 *     不等即拒（§5.4）。core 与 Worker 各有一份 hash 实现，以
 *     `packages/shared/test/fixtures/report-v1.json` 的固定向量为共同锚点。
 *  2. 去重窗口与内容上限常量（§5.3 / §5.5）：core 与 Worker 各自登记，默认值
 *     必须保持一致。
 *  3. reaction 集合（§5.6）：本机 main.db 专用，固定白名单枚举，core 校验与
 *     渲染层展示共用。
 */

/** report payload 契约版本（§5.1）；shape 变更时 +1 并同步 Worker 校验。 */
export const REPORT_SCHEMA_VERSION = 1;

/** 内容 hash 去重窗口（§5.5）：24 小时。 */
export const REPORT_CONTENT_DEDUPE_MS = 86_400_000;
/** 整份 payload hash 去重窗口（§5.5）：90 天；设 0 = 永久去重（bucket 恒为 0）。 */
export const REPORT_PAYLOAD_DEDUPE_MS = 7_776_000_000;

// --- 内容上限（§5.3；清洗与截断由 core 保证，schema 层不重复约束） -------------

/** message.text 的 UTF-8 字节上限（约 1 万汉字），超出截断并置 truncated。 */
export const REPORT_MESSAGE_TEXT_MAX_BYTES = 32 * 1024;
/** 卡片消息 message.content（JSON）的字节上限。 */
export const REPORT_MESSAGE_CONTENT_MAX_BYTES = 16 * 1024;
/** 被引用原文 replyTo.text 的字节上限。 */
export const REPORT_REPLY_TO_TEXT_MAX_BYTES = 2 * 1024;
/** 单条 context.text 的字节上限。 */
export const REPORT_CONTEXT_ITEM_MAX_BYTES = 2 * 1024;
/** context 最多带几条（最近可见消息；跳过 system_event / task_event）。 */
export const REPORT_CONTEXT_MAX_ITEMS = 4;
/** Renderer-hidden ids accepted by reports.submit for local reply/context filtering. */
export const REPORT_EXCLUDED_MESSAGE_IDS_MAX = 500;
/** bot.profile（裁剪后 JSON）的字节上限。 */
export const REPORT_BOT_PROFILE_MAX_BYTES = 8 * 1024;
/** attachments 最多条数（只带文件名 / MIME / 大小，不带内容）。 */
export const REPORT_ATTACHMENTS_MAX = 20;
/** 整个 payload 的字节上限（core 构建后检查；Worker 再按 body 上限拒绝）。 */
export const REPORT_PAYLOAD_MAX_BYTES = 128 * 1024;

/**
 * 消息 reaction 固定集合（§5.6）：只允许这 12 个 emoji 进 DB / payload，
 * 避免任意字符串。reaction 只存本机 main.db，不进消息内容、不参与团队同步。
 */
export const MESSAGE_REACTION_EMOJIS = [
  '👍',
  '👎',
  '❤️',
  '😂',
  '🎉',
  '🙏',
  '🔥',
  '👏',
  '😮',
  '😢',
  '🤔',
  '✅',
] as const;

/** reaction 作用域（§5.6）：本机会话为 `local`，团队会话为 `team:<serverHash>`。 */
export const MESSAGE_REACTION_SCOPE_PATTERN = /^local$|^team:[0-9a-f]{16}$/;

/** reportId 形状：`rep_` 前缀 + ULID（core `newId('rep')` 铸造）。 */
export const REPORT_ID_PATTERN = /^rep_/;
/** hash 形状：sha256 的小写 hex（§5.4；Worker 重算时逐字节比对）。 */
export const REPORT_HASH_PATTERN = /^[0-9a-f]{64}$/;

// --- payload 子结构（§5.1）--------------------------------------------------

/** 上报方的客户端环境（诊断用；id 是 localStorage 稳定 id，不是账号）。 */
export const reportClientSchema = z.object({
  id: z.string(),
  /** v1 只出桌面端 `desktop`；web / 其他 surface 后续按 §5.1 追加。 */
  surface: z.string(),
  appVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  /** `os.release()`；个别平台拿不到时为空串。 */
  osVersion: z.string(),
  /** `settings.appLanguage`（zh-CN / en-US）。 */
  locale: z.string(),
});
export type ReportClient = z.infer<typeof reportClientSchema>;

/** 举报来源（§5.2）：团队只带 serverHash，永不上传团队 URL。 */
export const reportSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('team'), serverHash: z.string().min(1) }),
]);
export type ReportSource = z.infer<typeof reportSourceSchema>;

/** 上报的 Bot 运行时配置（模型名可空串 = 跟随默认）。 */
export const reportBotRuntimeSchema = z.object({
  model: z.string(),
  lightModel: z.string(),
  backgroundModel: z.string(),
  agent: z.object({ id: z.string(), model: z.string(), effort: z.string() }),
});
export type ReportBotRuntime = z.infer<typeof reportBotRuntimeSchema>;

/**
 * 被举报消息所属的 Bot：只保留 identity / persona / role / boundaries /
 * behavior / runtime 等画像字段；`profile` 是裁剪后的 JSON（8KB 上限由 core
 * 递归截断保证，schema 层宽松），永不含插件 / 连接 / 密钥字段。
 */
export const reportBotSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 完整系统提示词永不上传（§5.3）；null = 未显式设置。 */
  systemRole: z.string().nullable(),
  runtime: reportBotRuntimeSchema,
  profile: z.unknown(),
});
export type ReportBot = z.infer<typeof reportBotSchema>;

/** 上报附件的元数据（只有文件名 / MIME / 大小，不带字节）。 */
export const reportAttachmentSchema = z.object({
  fileName: z.string(),
  mime: z.string(),
  size: z.number(),
});
export type ReportAttachment = z.infer<typeof reportAttachmentSchema>;

/**
 * 被举报的消息本体（§5.2）：local 来源由 core 从本地 DB 重读（不信任渲染层
 * 正文），team 来源来自渲染层快照。`content` 是卡片消息的原样 JSON（text 消息
 * 为 null）；`truncated` = 文本超出 32KB 被截断。
 *
 * 无 `senderType` 字段（已记录的取舍，§9）：可举报的只有 Bot 消息，本机来源由
 * core 在 `#collectLocal` 按 `senderType === 'bot'` 复核；team 快照不带该字段，
 * 「消息确为 Bot 所发」由 UI 入口（canReact）保证——已知取舍：被举报的团队消息
 * 是否真为 Bot 所发，Worker / triage 侧无从复核。
 */
export const reportMessageSchema = z.object({
  id: z.string(),
  seq: z.number().nullable(),
  kind: z.enum(['text', 'card']),
  status: messageStatusSchema,
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  runId: z.string().nullable(),
  text: z.string(),
  content: z.unknown().nullable(),
  truncated: z.boolean(),
  attachments: z.array(reportAttachmentSchema),
});
export type ReportMessage = z.infer<typeof reportMessageSchema>;

/** 被引用的原文（对判断上下文很有用）；整条可空。 */
export const reportReplyToSchema = z.object({
  messageId: z.string(),
  text: z.string(),
});
export type ReportReplyTo = z.infer<typeof reportReplyToSchema>;

/** 举报时附带的一条最近可见消息（最多 4 条，单条 2KB 截断）。 */
export const reportContextItemSchema = z.object({
  messageId: z.string(),
  senderType: z.enum(['user', 'bot']),
  kind: z.string(),
  text: z.string(),
  createdAt: z.number(),
});
export type ReportContextItem = z.infer<typeof reportContextItemSchema>;

/** 这次生成真实调用过的厂商 / 模型分组用量（可能多于一条：重试 / 压缩）。 */
export const reportUsageItemSchema = z.object({
  provider: z.string(),
  model: z.string(),
  loopType: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type ReportUsageItem = z.infer<typeof reportUsageItemSchema>;

/** 这次生成用过的工具（只有名字与次数，不带工具输出全文）。 */
export const reportToolItemSchema = z.object({
  name: z.string(),
  calls: z.number(),
});
export type ReportToolItem = z.infer<typeof reportToolItemSchema>;

/** usage 命中的供应商实例（只带 id / name / vendor / api，不带 baseUrl 与 Key）。 */
export const reportProviderItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  api: z.string(),
});
export type ReportProviderItem = z.infer<typeof reportProviderItemSchema>;

/** 两个 hash（§5.4）：客户端计算，Worker 重算校验，不等则 400。 */
export const reportHashesSchema = z.object({
  content: z.string().regex(REPORT_HASH_PATTERN),
  payload: z.string().regex(REPORT_HASH_PATTERN),
});
export type ReportHashes = z.infer<typeof reportHashesSchema>;

/**
 * report payload 顶层结构（§5.1）。hash 定义（§5.4，两侧实现必须逐字节一致）：
 *  - content：`message.kind === 'text' ? message.text : canonicalJson(message
 *    .content ?? { text: message.text })`，utf8 编码，小写 hex；
 *  - payload：去掉 reportId / createdAt / hashes 后的 dedupePayload 的
 *    canonicalJson（递归按 key 字典序排序、数组保序、JSON.stringify 风格），
 *    utf8 编码，小写 hex。去掉 reportId / createdAt 是为了让同一内容重复点击
 *    产生相同 hash，去重才能命中。
 */
export const reportPayloadSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  reportId: z.string().regex(REPORT_ID_PATTERN),
  createdAt: z.number(),
  /** v1 只有这一个举报原因；后续追加时同步 Worker 枚举。 */
  reason: z.enum(['inappropriate']),
  client: reportClientSchema,
  source: reportSourceSchema,
  conversation: z.object({ id: z.string(), type: conversationTypeSchema }),
  bot: reportBotSchema,
  message: reportMessageSchema,
  replyTo: reportReplyToSchema.nullable(),
  context: z.array(reportContextItemSchema),
  usage: z.array(reportUsageItemSchema),
  tools: z.array(reportToolItemSchema),
  providers: z.array(reportProviderItemSchema),
  hashes: reportHashesSchema,
});
export type ReportPayload = z.infer<typeof reportPayloadSchema>;

/**
 * 团队来源的渲染层快照（§5.2）：团队消息不在本地 DB，core 无法重读，只能信
 * 渲染层带来的快照。Bot 部分放宽为 partial（团队会话可能拿不到完整 profile /
 * runtime）；usage / tools / providers 可选（拿不到就省略）；conversation.type
 * 可选（团队会话类型渲染层拿得到就带，core 缺省时回退本地查询 / 'dm'）。
 */
export const reportTeamSnapshotSchema = z.object({
  message: reportMessageSchema,
  replyTo: reportReplyToSchema.nullable(),
  context: z.array(reportContextItemSchema),
  bot: reportBotSchema.partial(),
  /** 团队会话类型；缺省 = core 回退本地 conversations 查询，再回退 'dm'。 */
  conversation: z.object({ type: conversationTypeSchema }).optional(),
  usage: z.array(reportUsageItemSchema).optional(),
  tools: z.array(reportToolItemSchema).optional(),
  providers: z.array(reportProviderItemSchema).optional(),
});
export type ReportTeamSnapshot = z.infer<typeof reportTeamSnapshotSchema>;

// --- reaction（§5.6）--------------------------------------------------------

/** reaction emoji 白名单（固定集合之外一律拒绝）。 */
export const reportReactionEmojiSchema = z.enum(MESSAGE_REACTION_EMOJIS);
export type ReportReactionEmoji = (typeof MESSAGE_REACTION_EMOJIS)[number];

/** `messages.reactions` 返回的一条聚合：整个 conversation 按 (message, emoji) 分组。 */
export const reactionSummarySchema = z.object({
  messageId: z.string(),
  emoji: z.string(),
  count: z.number(),
  /** 当前 client 是否点过这个 emoji（chip 高亮用）。 */
  mine: z.boolean(),
});
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;
