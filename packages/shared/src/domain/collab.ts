import { z } from 'zod';

/**
 * 多客户端协作契约（D119，docs/design/57-multi-client-collaboration.md §3）。
 *
 * 这一层只描述「在线状态」：谁连着、在哪个会话、是否正在输入、编辑者光标在哪。
 * 不落库、不进审计、不进 Bot 上下文；草稿与远端光标见同文档 §4/§5（P2）。
 */

/** 客户端稳定标识：配对模式 = 已认证 deviceId；其他模式由客户端生成并持久化。 */
export const collabClientIdSchema = z.string().min(1).max(64);
/** 展示名（服务端会清洗控制字符并截断）。 */
export const collabClientNameSchema = z.string().min(1).max(80);
/** 每次页面加载的连接 id（多标签页去重与宿主清理用）。 */
export const collabConnectionIdSchema = z.string().min(1).max(64);

export const collabClientRefSchema = z.object({
  id: collabClientIdSchema,
  name: collabClientNameSchema,
});
export type CollabClientRef = z.infer<typeof collabClientRefSchema>;

/**
 * 光标位置：ProseMirror 文档位置，只对产生它的 `docVersion` 有效。
 * P1 不发送该字段（没有共享草稿），保留契约供 P2 使用。
 */
export const collabSelectionSchema = z.object({
  anchor: z.number().int().min(0),
  head: z.number().int().min(0),
  docVersion: z.number().int().min(0),
});
export type CollabSelection = z.infer<typeof collabSelectionSchema>;

export const collabPresenceStateSchema = z.enum(['viewing', 'typing', 'away']);
export type CollabPresenceState = z.infer<typeof collabPresenceStateSchema>;

export const collabPresenceEntrySchema = z.object({
  clientId: collabClientIdSchema,
  clientName: collabClientNameSchema,
  /** 由 clientId 派生的固定色（服务端计算，所有客户端一致）。 */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  connectionId: collabConnectionIdSchema,
  /** null = 在线但不在任何会话。 */
  conversationId: z.string().nullable(),
  state: collabPresenceStateSchema,
  selection: collabSelectionSchema.nullable(),
  /** 服务端时钟。 */
  updatedAt: z.number(),
});
export type CollabPresenceEntry = z.infer<typeof collabPresenceEntrySchema>;

export const collabPresenceUpdateInputSchema = z.object({
  clientId: collabClientIdSchema,
  clientName: collabClientNameSchema,
  connectionId: collabConnectionIdSchema,
  conversationId: z.string().min(1).nullable(),
  state: collabPresenceStateSchema.optional(),
  selection: collabSelectionSchema.nullable().optional(),
});
export type CollabPresenceUpdateInput = z.infer<typeof collabPresenceUpdateInputSchema>;

export const collabPresenceLeaveInputSchema = z.object({
  clientId: collabClientIdSchema,
  /** 省略 = 该客户端的所有连接一起离开。 */
  connectionId: collabConnectionIdSchema.optional(),
});
export type CollabPresenceLeaveInput = z.infer<typeof collabPresenceLeaveInputSchema>;

export const collabPresenceListInputSchema = z.object({
  /** 省略 = 返回所有会话的在线条目。 */
  conversationId: z.string().min(1).optional(),
});
export type CollabPresenceListInput = z.infer<typeof collabPresenceListInputSchema>;

export const collabPresenceListOutputSchema = z.object({
  entries: z.array(collabPresenceEntrySchema),
});
export type CollabPresenceListOutput = z.infer<typeof collabPresenceListOutputSchema>;

export const collabPresenceChangedPayloadSchema = z.object({
  conversationId: z.string().nullable(),
  entries: z.array(collabPresenceEntrySchema),
});
export type CollabPresenceChangedPayload = z.infer<typeof collabPresenceChangedPayloadSchema>;

// --- 共享草稿（D120，docs/design/57 §4） --------------------------------------

/** TipTap/ProseMirror 文档 JSON：服务端按不透明 JSON 存取，大小由 core 校验。 */
export const collabComposerDocSchema = z.object({ type: z.literal('doc') }).passthrough();
export type CollabComposerDoc = z.infer<typeof collabComposerDocSchema>;

/** 草稿里挂的待发送附件元数据（发送时只回传 id）。 */
export const collabDraftAttachmentSchema = z.object({
  attachmentId: z.string().min(1).max(64),
  fileName: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  size: z.number().int().min(0),
});
export type CollabDraftAttachment = z.infer<typeof collabDraftAttachmentSchema>;

export const collabDraftSchema = z.object({
  conversationId: z.string(),
  doc: collabComposerDocSchema,
  mentions: z.array(z.string()).max(200),
  replyTo: z.string().nullable(),
  attachments: z.array(collabDraftAttachmentSchema).max(50),
  version: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type CollabDraft = z.infer<typeof collabDraftSchema>;

export const collabLeaseSchema = z.object({
  ownerClientId: collabClientIdSchema,
  /** 连接级租约归属：同一设备的两个标签页不会都自认持有者。 */
  ownerConnectionId: collabConnectionIdSchema.nullable(),
  ownerName: collabClientNameSchema,
  expiresAt: z.number(),
});
export type CollabLease = z.infer<typeof collabLeaseSchema>;

export const collabDraftGetInputSchema = z.object({
  conversationId: z.string().min(1),
});
export const collabDraftGetOutputSchema = z.object({
  draft: collabDraftSchema,
  lease: collabLeaseSchema.nullable(),
});

export const collabDraftClaimInputSchema = z.object({
  conversationId: z.string().min(1),
  clientId: collabClientIdSchema,
  clientName: collabClientNameSchema,
  /** D120 审查修复：连接级租约，避免同一设备两个标签页都自认持有者。 */
  connectionId: collabConnectionIdSchema.optional(),
  force: z.boolean().optional(),
});
export const collabDraftClaimOutputSchema = z.object({
  draft: collabDraftSchema,
  lease: collabLeaseSchema,
});

export const collabDraftUpdateInputSchema = z.object({
  conversationId: z.string().min(1),
  clientId: collabClientIdSchema,
  connectionId: collabConnectionIdSchema.optional(),
  baseVersion: z.number().int().min(0),
  doc: collabComposerDocSchema,
  mentions: z.array(z.string().max(4096)).max(200).optional(),
  replyTo: z.string().max(128).nullable().optional(),
  attachments: z.array(collabDraftAttachmentSchema).max(50).optional(),
});
export const collabDraftUpdateOutputSchema = z.object({
  version: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});

export const collabDraftReleaseInputSchema = z.object({
  conversationId: z.string().min(1),
  clientId: collabClientIdSchema,
  connectionId: collabConnectionIdSchema.optional(),
});

export const collabDraftSendInputSchema = z.object({
  conversationId: z.string().min(1),
  clientId: collabClientIdSchema,
  connectionId: collabConnectionIdSchema.optional(),
  baseVersion: z.number().int().min(0),
  text: z.string().max(100_000),
  mentions: z.array(z.string().max(4096)).max(200).optional(),
  replyTo: z.string().max(128).nullable().optional(),
  attachmentIds: z.array(z.string().max(128)).max(50).optional(),
  voiceMode: z.boolean().optional(),
  /** D121：消息归属（渲染层显示「来自 X」）。 */
  client: collabClientRefSchema.optional(),
});
export type CollabDraftSendInput = z.infer<typeof collabDraftSendInputSchema>;

export const collabDraftChangedPayloadSchema = z.object({
  conversationId: z.string(),
  draft: collabDraftSchema,
});
export type CollabDraftChangedPayload = z.infer<typeof collabDraftChangedPayloadSchema>;

export const collabDraftOwnerChangedPayloadSchema = z.object({
  conversationId: z.string(),
  owner: collabClientRefSchema.nullable(),
  /** owner 的连接 id（null = 无主或旧客户端未上报）。 */
  ownerConnectionId: collabConnectionIdSchema.nullable(),
  expiresAt: z.number().nullable(),
});
export type CollabDraftOwnerChangedPayload = z.infer<typeof collabDraftOwnerChangedPayloadSchema>;

export const collabDraftClearedPayloadSchema = z.object({
  conversationId: z.string(),
  byClientId: collabClientIdSchema,
});
export type CollabDraftClearedPayload = z.infer<typeof collabDraftClearedPayloadSchema>;

/**
 * 客户端颜色：8 色面板，按 clientId 稳定散列。明暗主题下都保持可辨识度；
 * 服务端与离线客户端共用同一函数，避免各端颜色不一致。
 */
const COLLAB_CLIENT_COLORS = [
  '#e11d48',
  '#d97706',
  '#65a30d',
  '#0d9488',
  '#0284c7',
  '#7c3aed',
  '#c026d3',
  '#475569',
] as const;

export function collabColorForClient(clientId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < clientId.length; index += 1) {
    hash ^= clientId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return COLLAB_CLIENT_COLORS[(hash >>> 0) % COLLAB_CLIENT_COLORS.length]!;
}
