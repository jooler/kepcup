import { z } from 'zod';
import { agentVersionSchema } from './agent-catalog.js';
import { mcpToolRiskSchema } from './types.js';

/**
 * 连接应用目录（docs/design/29-connected-apps.md §4，D73）。
 *
 * 条目 = MCP Registry `server.json` 的子集 + `_meta["app.kepcup/connector"]`
 * 扩展；开放平台阶段第三方提交的就是同一份文件。本期是随应用打包
 * （`apps/desktop/resources/connectors/catalog.json`）的策展目录，可由
 * `scripts/import-mcp-registry.mjs` 从 Registry 导出骨架后人工补扩展字段。
 * 与 agent-catalog.ts 一样只承载描述性数据：授权、连接与工具策略在 core 的
 * `apps/`。
 */

/** `_meta` 里 KepCup 扩展的键（反向域名命名空间，不与 Registry 自己的键冲突）。 */
export const CONNECTOR_META_KEY = 'app.kepcup/connector';

/** 工具前缀 `app_{slug}_*` 的 slug：不含下划线，全局唯一。 */
export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9]{2,16}$/;
export const connectorSlugSchema = z.string().regex(CONNECTOR_SLUG_PATTERN);

/** Registry 命名空间名：`反向域名/名字`（如 `com.notion/mcp`、`io.github.x/y`）。 */
export const connectorNameSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** 图标文件名（相对 `resources/connectors/icons/`；不含路径分隔符）。 */
export const connectorIconSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png)$/);

export const connectorCategorySchema = z.enum([
  'productivity',
  'development',
  'project',
  'design',
  'payments',
  'crm',
  'communication',
  'data',
  'other',
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

/** 信任分级（设计 29 §11.3）：builtin 随应用打包；其余 P3 起由签名目录给出。 */
export const connectorTierSchema = z.enum(['builtin', 'verified', 'community', 'developer']);
export type ConnectorTier = z.infer<typeof connectorTierSchema>;

export const connectorAuthSchema = z
  .object({
    kind: z.enum(['oauth', 'api-key', 'none']),
    /** `auto`：CIMD → DCR 自动注册；`preregistered`：用 KepCup 预注册的客户端（P2）。 */
    registration: z.enum(['auto', 'preregistered']),
    /** `preregistered` 时：KepCup 预注册客户端的引用名。 */
    clientRef: z.string().min(1).nullable(),
    /** 空 = 按服务端 WWW-Authenticate / PRM 取；`write` = 写工具所需的额外权限（step-up，P2）。 */
    scopes: z
      .object({
        default: z.array(z.string().min(1)),
        write: z.array(z.string().min(1)),
      })
      .default({ default: [], write: [] }),
  })
  .refine((auth) => auth.registration !== 'preregistered' || auth.clientRef !== null, {
    message: 'registration "preregistered" requires a clientRef',
    path: ['clientRef'],
  });
export type ConnectorAuth = z.infer<typeof connectorAuthSchema>;

/**
 * 账号识别（设计 29 §6）：连接成功后调用一个**只读**工具，按结果字段路径取
 * 账号显示名 / 稳定标识（dot 路径，数组下标用数字，如 `user.name`、`data.0.email`）。
 */
export const connectorWhoamiSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  labelPath: z.string().min(1),
  subjectPath: z.string().min(1).optional(),
});
export type ConnectorWhoami = z.infer<typeof connectorWhoamiSchema>;

/** `toolPolicy` 只能把风险调高（设计 29 §4）：落地由 core 的 apps/policy.ts 保证。 */
export const connectorToolPolicySchema = z.record(
  z.string().min(1),
  z.object({ risk: mcpToolRiskSchema }),
);
export type ConnectorToolPolicy = z.infer<typeof connectorToolPolicySchema>;

export const connectorMetaSchema = z.object({
  slug: connectorSlugSchema,
  icon: connectorIconSchema,
  category: connectorCategorySchema,
  tier: connectorTierSchema,
  auth: connectorAuthSchema,
  toolPolicy: connectorToolPolicySchema.default({}),
  /** [P3] 随附 Agent Skills（技能库引用）。 */
  skills: z.array(z.string().min(1)).default([]),
  /** [P3] 是否提供 MCP Apps 界面。 */
  ui: z.boolean().default(false),
  privacyPolicy: z.string().url(),
  whoami: connectorWhoamiSchema.optional(),
  /**
   * 发行门禁：发行构建只收录门禁已放行的条目；必填，缺省的条目无法被放行
   * （fail-closed，见 {@link filterReleasedConnectors}）。开发构建与测试不受影响。
   */
  releaseGate: z.string().min(1),
});
export type ConnectorMeta = z.infer<typeof connectorMetaSchema>;

/** `remotes[]`：P1 只认 `streamable-http`；`sse`（旧版）仅为兼容 Registry 同构而保留。 */
export const connectorRemoteSchema = z.object({
  type: z.enum(['streamable-http', 'sse']),
  url: z.string().url(),
});
export type ConnectorRemote = z.infer<typeof connectorRemoteSchema>;

/** `packages[]`（P2 MCPB 本地包）：Registry 形状，P1 不消费。 */
export const connectorPackageSchema = z.looseObject({
  registryType: z.string().min(1),
  identifier: z.string().min(1),
  version: z.string().optional(),
  fileSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ConnectorPackage = z.infer<typeof connectorPackageSchema>;

/**
 * 目录条目 = `server.json` 子集 + `_meta["app.kepcup/connector"]`。
 * `_meta` 里其它命名空间（如 Registry 自己的 `io.modelcontextprotocol.registry/*`）原样放行。
 */
export const connectorCatalogEntrySchema = z
  .object({
    $schema: z.string().optional(),
    name: connectorNameSchema,
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    version: agentVersionSchema,
    websiteUrl: z.string().url().optional(),
    remotes: z.array(connectorRemoteSchema).default([]),
    packages: z.array(connectorPackageSchema).default([]),
    _meta: z.looseObject({ [CONNECTOR_META_KEY]: connectorMetaSchema }),
  })
  .refine((entry) => entry.remotes.length > 0 || entry.packages.length > 0, {
    message: 'entry needs at least one of remotes[] / packages[]',
    path: ['remotes'],
  });
export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntrySchema>;

/** `catalog.json` 文件形状。 */
export const connectorCatalogFileSchema = z.object({
  version: z.literal(1),
  connectors: z.array(z.unknown()),
});
export type ConnectorCatalogFile = z.infer<typeof connectorCatalogFileSchema>;

/** 取条目的 KepCup 扩展（schema 已保证存在）。 */
export function connectorMetaOf(entry: ConnectorCatalogEntry): ConnectorMeta {
  return entry._meta[CONNECTOR_META_KEY] as ConnectorMeta;
}

/** 连接用的远程端点：P1 只认第一个 `streamable-http`；无则 null。 */
export function connectorRemoteOf(entry: ConnectorCatalogEntry): ConnectorRemote | null {
  return entry.remotes.find((remote) => remote.type === 'streamable-http') ?? null;
}

export function findConnectorBySlug(
  catalog: readonly ConnectorCatalogEntry[],
  slug: string,
): ConnectorCatalogEntry | null {
  return catalog.find((entry) => connectorMetaOf(entry).slug === slug) ?? null;
}

/** 该 slug 下应用工具的名字前缀（`app_{slug}_`）。 */
export function connectorToolPrefix(slug: string): string {
  return `app_${slug}_`;
}

/**
 * 按发行门禁过滤目录（fail-closed，照 {@link filterReleasedAgents}）。
 * `approvedGates === null` = 不过滤（开发构建 / 测试）；否则只留 `releaseGate`
 * 在放行清单里的条目，没有 `releaseGate` 的视为未放行。
 */
export function filterReleasedConnectors(
  catalog: readonly ConnectorCatalogEntry[],
  approvedGates: readonly string[] | null,
): ConnectorCatalogEntry[] {
  if (approvedGates === null) return [...catalog];
  return catalog.filter((entry) => {
    const gate = (entry._meta?.[CONNECTOR_META_KEY] as { releaseGate?: unknown } | undefined)
      ?.releaseGate;
    return typeof gate === 'string' && gate.length > 0 && approvedGates.includes(gate);
  });
}
