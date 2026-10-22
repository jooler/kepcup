import { z } from 'zod';

/**
 * macOS Share Extension 分享接收（D94，docs/design/44-macos-share-extension.md）。
 *
 * 契约分三段：
 *  1. 扩展 → 主应用：App Group inbox 里的 `manifest.json`（扩展写，主进程校验）。
 *  2. 主应用 → core：平台方法 `share.targets` / `share.consume`。
 *  3. core → 渲染层：失败恢复用的 `share.failed.*` 与 `share.failed.changed` 事件。
 *
 * 硬约束（设计 §0）：分享只落地「附件 + 普通用户消息」，附件行只暴露
 * workspace 副本路径；本模块不承载文件正文，也不承载附言以外的正文。
 */

/** 分享单次最多带的文件数。 */
export const SHARE_MAX_FILES = 10;
/** 单文件字节上限（与附件上传的 30MB 上限一致）。 */
export const SHARE_MAX_FILE_BYTES = 30_000_000;
/** 单次分享的总字节上限。 */
export const SHARE_MAX_TOTAL_BYTES = 60_000_000;
/** 附言字符上限。 */
export const SHARE_NOTE_MAX_CHARS = 2000;
/** 失败记录保留时长（7 天）。 */
export const SHARE_FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `processing` 超过这个时长视为中断，启动清扫时重置为 `received`（10 分钟）。 */
export const SHARE_PROCESSING_STALE_MS = 10 * 60 * 1000;
/** 目标快照过期时长（24 小时）：过期只提示，core 确认时按实时数据校验。 */
export const SHARE_TARGETS_STALE_MS = 24 * 60 * 60 * 1000;
/** core inbox 里无对应 DB 行的残留目录清理时长（24 小时）。 */
export const SHARE_INBOX_STALE_MS = 24 * 60 * 60 * 1000;
/** `targets.v1.json` 体积上限。 */
export const SHARE_TARGETS_MAX_BYTES = 256 * 1024;

/**
 * 分享批次 id：扩展生成的 `shr_` + UUID。只接受这一形状，目录名必须与
 * manifest 里的 id 一致（防路径注入）。
 */
export const SHARE_INTAKE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{8,64}$/;

const sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/);

/** 分享目标：某个 Bot 的私聊，或某个项目组。 */
export const shareTargetSchema = z.object({
  kind: z.enum(['bot', 'project']),
  id: z.string().min(1),
});
export type ShareTarget = z.infer<typeof shareTargetSchema>;

/** 目标快照里的一条（只有 id、显示名、类型与归档状态）。 */
export const shareTargetEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['bot', 'project']),
  archived: z.boolean(),
});
export type ShareTargetEntry = z.infer<typeof shareTargetEntrySchema>;

/** 目标快照（`targets.v1.json` 的内容，也由 `share.targets` 返回）。 */
export const shareTargetsSchema = z.object({
  version: z.literal(1),
  generatedAt: z.number(),
  bots: z.array(shareTargetEntrySchema),
  projects: z.array(shareTargetEntrySchema),
});
export type ShareTargets = z.infer<typeof shareTargetsSchema>;

/**
 * 暂存文件名禁用字符：路径分隔符（`/` `\`，防路径注入；`\` 同时挡住 Windows
 * basename 语义）与控制字符。其余放开通——扩展 `sanitizeName` 产出的是 Unicode
 * 字母数字 + `._-` + 内部空格（如 `000-聊天记录.zip`），core / 主进程的
 * manifest 校验口径是「basename 一致 + 拒绝 `..` 段」，契约与实现一致。
 */
// eslint-disable-next-line no-control-regex -- 拒绝控制字符正是目的
export const SHARE_STAGED_NAME_FORBIDDEN = /[/\\\u0000-\u001f\u007f]/;

/** 扩展写入的 manifest 里的一个文件。 */
export const shareManifestFileSchema = z.object({
  /** 暂存文件名（`000-chat.zip`）：只作 inbox 内的相对名，不作路径。 */
  stagedName: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !SHARE_STAGED_NAME_FORBIDDEN.test(name), {
      message: 'stagedName 不允许路径分隔符 / 控制字符',
    })
    .refine((name) => name !== '.' && !name.includes('..'), {
      message: 'stagedName 不允许 `.` / `..` 段',
    }),
  /** 用户看到的原始文件名（已清洗 basename）。 */
  originalName: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().min(0),
  sha256: sha256Schema,
});
export type ShareManifestFile = z.infer<typeof shareManifestFileSchema>;

/** 扩展写入的 `manifest.json`。 */
export const shareManifestSchema = z.object({
  version: z.literal(1),
  intakeId: z.string().regex(SHARE_INTAKE_ID_PATTERN),
  createdAt: z.number(),
  target: shareTargetSchema,
  /** 用户附言（可为空）。 */
  note: z.string().max(SHARE_NOTE_MAX_CHARS),
  files: z.array(shareManifestFileSchema).min(1).max(SHARE_MAX_FILES),
});
export type ShareManifest = z.infer<typeof shareManifestSchema>;

/** `share.consume` 的一个文件：路径必须落在 core inbox 前缀下。 */
export const shareFileSchema = z.object({
  /** core inbox 内的绝对路径。 */
  path: z.string().min(1),
  originalName: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().min(0),
  sha256: sha256Schema,
});
export type ShareFile = z.infer<typeof shareFileSchema>;

/** `share.consume` 输入（主进程把 App Group inbox 移进 core inbox 后调用）。 */
export const shareConsumeInputSchema = z.object({
  intakeId: z.string().regex(SHARE_INTAKE_ID_PATTERN),
  target: shareTargetSchema,
  note: z.string().max(SHARE_NOTE_MAX_CHARS),
  files: z.array(shareFileSchema).min(1).max(SHARE_MAX_FILES),
});
export type ShareConsumeInput = z.infer<typeof shareConsumeInputSchema>;

/** 分享批次的投递状态。 */
export const shareIntakeStateSchema = z.enum([
  'received',
  'processing',
  'done',
  'failed_target',
  'failed',
]);
export type ShareIntakeState = z.infer<typeof shareIntakeStateSchema>;

/** `share.consume` 输出。 */
export const shareConsumeOutputSchema = z.object({
  state: z.enum(['done', 'processing', 'failed_target', 'failed']),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ShareConsumeOutput = z.infer<typeof shareConsumeOutputSchema>;

/** 失败恢复列表里的一项。 */
export const shareFailedItemSchema = z.object({
  intakeId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  errorCode: z.string(),
  errorMessage: z.string(),
  target: shareTargetSchema,
  files: z.array(
    z.object({
      originalName: z.string(),
      size: z.number().int().min(0),
      mime: z.string(),
    }),
  ),
});
export type ShareFailedItem = z.infer<typeof shareFailedItemSchema>;

/** `share.failed.list` 输出。 */
export const shareFailedListOutputSchema = z.object({
  items: z.array(shareFailedItemSchema),
});
export type ShareFailedListOutput = z.infer<typeof shareFailedListOutputSchema>;

/** `share.failed.retry` 输入：重选目标并重试。 */
export const shareFailedRetryInputSchema = z.object({
  intakeId: z.string().regex(SHARE_INTAKE_ID_PATTERN),
  target: shareTargetSchema,
});
export type ShareFailedRetryInput = z.infer<typeof shareFailedRetryInputSchema>;

/** `share.failed.retry` 输出。 */
export const shareFailedRetryOutputSchema = z.object({
  state: z.enum(['done', 'processing', 'failed_target', 'failed']),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ShareFailedRetryOutput = z.infer<typeof shareFailedRetryOutputSchema>;

/** `share.failed.discard` 输入。 */
export const shareFailedDiscardInputSchema = z.object({
  intakeId: z.string().regex(SHARE_INTAKE_ID_PATTERN),
});
export type ShareFailedDiscardInput = z.infer<typeof shareFailedDiscardInputSchema>;

/** `share.failed.changed` 事件（app 事件，core → 渲染层）。 */
export const shareFailedChangedPayloadSchema = z.object({
  intakeId: z.string(),
  state: z.enum(['failed_target', 'failed', 'done']),
});
export type ShareFailedChanged = z.infer<typeof shareFailedChangedPayloadSchema>;

/**
 * `share.targets.changed` 事件（platform 事件，core → 主进程）。`reason` 只区分
 * 目标来源（Bot / 项目组），主进程不按 reason 分流——统一防抖后重拉快照；快照
 * 是否归档由快照内容本身携带。
 */
export const shareTargetsChangedPayloadSchema = z.object({
  reason: z.enum(['bot', 'project']),
});
export type ShareTargetsChanged = z.infer<typeof shareTargetsChangedPayloadSchema>;

/** intake id 是否合法（扩展生成的 `shr_` + UUID）。 */
export function isShareIntakeId(value: string): boolean {
  return SHARE_INTAKE_ID_PATTERN.test(value);
}
