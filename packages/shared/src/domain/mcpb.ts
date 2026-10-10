import { z } from 'zod';

/**
 * MCPB 本地包（D73 P2，todo/connected-apps.md §6.5）的 RPC 契约。manifest 本身的解析在
 * core（`apps/mcpb/manifest.ts`）；这里只放界面需要的摘要与 `mcpb.*` 入参 / 出参。
 */

export const mcpbUserConfigValueSchema = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(10_000)).max(100),
]);
export type McpbUserConfigValue = z.infer<typeof mcpbUserConfigValueSchema>;

export const mcpbUserConfigFieldSchema = z.object({
  key: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string(),
  description: z.string().default(''),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  multiple: z.boolean().default(false),
  default: mcpbUserConfigValueSchema.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type McpbUserConfigField = z.infer<typeof mcpbUserConfigFieldSchema>;

export const mcpbInspectInputSchema = z.object({ path: z.string().min(1).max(4096) });
export type McpbInspectInput = z.infer<typeof mcpbInspectInputSchema>;

export const mcpbInspectOutputSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string().default(''),
  author: z.string().default(''),
  serverType: z.enum(['node', 'python', 'binary', 'uv']),
  /** 包文件 sha256（小写十六进制）与字节数；`mcpb.install` 必须回传同一个 sha256。 */
  sha256: z.string(),
  size: z.number().int().min(0),
  unpackedSize: z.number().int().min(0),
  /** 完整启动命令预览：`${__dirname}` 已替换为解包目录，`${user_config.*}` 原样保留。 */
  launchCommand: z.string(),
  installDir: z.string(),
  compatible: z.boolean(),
  incompatibleReason: z.string().optional(),
  /** 所需运行时在环境管理器里是否已就绪；null = 不需要（binary）。 */
  runtime: z.object({ kind: z.enum(['node', 'python', 'uv']), available: z.boolean() }).nullable(),
  userConfigFields: z.array(mcpbUserConfigFieldSchema),
});
export type McpbInspectOutput = z.infer<typeof mcpbInspectOutputSchema>;

export const mcpbInstallInputSchema = z.object({
  path: z.string().min(1).max(4096),
  /** 用户在确认面板上看到的 sha256；与现读文件不符 → 拒绝（文件在确认后被替换）。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  userConfig: z.record(z.string(), mcpbUserConfigValueSchema).default({}),
  /** 给出对话 id 时安装经审批卡（`environment` 类，D41 规则）；设置页内的确认面板不需要。 */
  conversationId: z.string().min(1).optional(),
  /** 来自目录条目 `packages[]`（registryType 'mcpb'）：按 slug 取条目校验 `fileSha256`，且不标 developer。 */
  fromCatalog: z.object({ slug: z.string().min(1) }).optional(),
});
export type McpbInstallInput = z.infer<typeof mcpbInstallInputSchema>;

export const mcpbInstallOutputSchema = z.object({ serverId: z.string() });
export type McpbInstallOutput = z.infer<typeof mcpbInstallOutputSchema>;
