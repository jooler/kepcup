import { z } from 'zod';
import {
  connectorCategorySchema,
  connectorOriginSchema,
  connectorTierSchema,
} from './connector-catalog.js';
import { mcpToolApprovalModeSchema, mcpToolPolicySchema, mcpToolRiskSchema } from './types.js';

/**
 * 连接应用（D73 P1）RPC / 事件用到的视图 schema：目录条目视图、首连工具复核、工具清单视图、
 * 持续授权视图。全部**不含令牌**。
 */

/** `apps.connect_flow` 的 `reviewing_tools` 阶段：待用户确认的工具（名称、标题、描述、风险档）。 */
export const appConnectReviewToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  risk: mcpToolRiskSchema,
});
export type AppConnectReviewTool = z.infer<typeof appConnectReviewToolSchema>;

/** `apps.catalog.list` 的一个条目（仅发行门禁放行后的目录）。 */
export const appCatalogEntrySchema = z.object({
  /** 目录 slug：`apps.connect({ target: { kind: 'catalog', connectorId } })` 用它。 */
  connectorId: z.string(),
  /** Registry 命名空间名（`com.notion/mcp`）。 */
  name: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string(),
  websiteUrl: z.string().optional(),
  privacyPolicy: z.string(),
  category: connectorCategorySchema,
  tier: connectorTierSchema,
  /** 来源（本机连接 = `local`）；缺省按 `bundled` 处理。 */
  origin: connectorOriginSchema.optional(),
  authKind: z.enum(['oauth', 'api-key', 'none']),
  registration: z.enum(['auto', 'preregistered']),
  /** false = 当前版本不能连接（预注册客户端 / 非 OAuth，P2）；界面置灰并显示 `unavailableReason`。 */
  connectable: z.boolean(),
  unavailableReason: z.string().optional(),
  /** 将申请的权限（空 = 按服务端 WWW-Authenticate / PRM 取）。 */
  scopes: z.object({ default: z.array(z.string()), write: z.array(z.string()) }),
  /** 图标：SVG 内联成的 data URI；缺失 / 非 SVG 为 null。 */
  iconDataUri: z.string().nullable(),
  /** 已连接账号数（该应用的连接行数，含需重连的）。 */
  connectedAccounts: z.number().int().min(0),
  connectionIds: z.array(z.string()),
});
export type AppCatalogEntry = z.infer<typeof appCatalogEntrySchema>;

/** 工具定义（`tools/list` 的结构化子集；复核 diff 用）。 */
export const appToolDefinitionSchema = z.looseObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});
export type AppToolDefinition = z.infer<typeof appToolDefinitionSchema>;

export const appToolStateSchema = z.enum(['approved', 'new', 'changed']);
export type AppToolState = z.infer<typeof appToolStateSchema>;

/** 一个连接下的工具：风险档、锁定状态、逐工具策略与定义（新旧对比）。 */
export const appToolViewSchema = z.object({
  toolName: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  risk: mcpToolRiskSchema,
  /** `new` = 从未批准；`changed` = 批准过但定义已变；二者都不暴露给模型。 */
  state: appToolStateSchema,
  /** 用户设置的策略（null = 按风险档默认）。 */
  policy: mcpToolPolicySchema.nullable(),
  /** 策略未停用该工具。 */
  enabled: z.boolean(),
  /** 有效审批方式（工具策略 > 风险档默认；自定义 server 另含 server autoApprove）。 */
  approval: mcpToolApprovalModeSchema,
  /** 当前对模型可见：已批准 + 未停用。 */
  exposed: z.boolean(),
  /** 最近一次 `tools/list` 的定义（新）。 */
  definition: appToolDefinitionSchema,
  /** 上次批准时的定义（旧）；从未批准为 null。 */
  approvedDefinition: appToolDefinitionSchema.nullable(),
});
export type AppToolView = z.infer<typeof appToolViewSchema>;

export const appToolsPendingSchema = z.object({
  added: z.number().int().min(0),
  changed: z.number().int().min(0),
});

/** Bot 级 / 对话级持续授权（`app_tool_grants` 一行）。 */
export const appToolGrantViewSchema = z.object({
  id: z.string(),
  botId: z.string(),
  botName: z.string().nullable(),
  connectionId: z.string(),
  toolName: z.string(),
  /** null = 对该 Bot 总是允许。 */
  conversationId: z.string().nullable(),
  createdAt: z.number(),
});
export type AppToolGrantView = z.infer<typeof appToolGrantViewSchema>;
