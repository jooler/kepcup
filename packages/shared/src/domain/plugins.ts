import { z } from 'zod';
import {
  pluginFieldSchema,
  pluginFieldSummarySchema,
  pluginFieldValueSchema,
  pluginIdSchema,
  pluginInstanceKindSchema,
  pluginVersionSchema,
} from './plugin-manifest.js';
import { imTransportSchema } from './im.js';
import {
  PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES,
  PLUGIN_RUNTIME_STATUS_VALUES,
} from '../plugin-runtime/protocol.js';

export { pluginFieldSchema, pluginFieldValueSchema } from './plugin-manifest.js';

/**
 * Plugin system RPC contracts (D104, docs/design/51-plugin-system.md §5 / §8):
 * `plugins.list` / `inspect` / `install` / `setEnabled` / `uninstall` payloads plus the
 * `plugins.changed` event. The inspect output is the single source both the consent
 * panel and core's inspect share — permissions are derived from contributions, never
 * taken from the manifest's word.
 */

export const pluginOriginSchema = z.enum(['builtin', 'marketplace', 'local']);
export type PluginOrigin = z.infer<typeof pluginOriginSchema>;

export const pluginTierSchema = z.enum(['builtin', 'verified', 'community', 'developer']);
export type PluginTier = z.infer<typeof pluginTierSchema>;

export const pluginStateSchema = z.enum(['installing', 'installed', 'uninstalling']);
export type PluginState = z.infer<typeof pluginStateSchema>;

// D105 P4: the kind enum moved to plugin-manifest.ts (its natural owner — no circular
// import for the capability-summary helpers); re-exported here for existing importers.
import { pluginContributionKindSchema } from './plugin-manifest.js';
export { pluginContributionKindSchema };
export type { PluginContributionKind } from './plugin-manifest.js';

export const pluginItemKindSchema = z.enum([
  'skill',
  'connector',
  'mcp',
  'mail',
  'im',
  // D124：能力模型条目照常记入 plugin_items 账本（ref = 条目 id），卸载可回滚。
  'capability-model',
  'disabled_connection',
]);
export type PluginItemKind = z.infer<typeof pluginItemKindSchema>;

// P1-1 adds { kind: 'marketplace', id, version? } (additive).
export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('marketplace'),
    id: pluginIdSchema,
    version: pluginVersionSchema.optional(),
  }),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;

/** One registered projection item (from the ledger); missing = deleted outside the app, yielded = connector conflict. */
export const pluginItemRefSchema = z.object({
  kind: pluginContributionKindSchema,
  ref: z.string(),
  missing: z.boolean().optional(),
  yielded: z.boolean().optional(),
});
export type PluginItemRef = z.infer<typeof pluginItemRefSchema>;

export const pluginSummarySchema = z.object({
  id: pluginIdSchema,
  name: z.string(),
  /**
   * Plugin icon as a data URI (manifest `icon`, read from the installed tree); null
   * when the plugin declares none or the file is unusable — the renderer then shows
   * its default icon.
   */
  iconDataUri: z.string().nullable(),
  version: pluginVersionSchema,
  description: z.string(),
  /** D105 §15.8: manifest `usage`（启用说明，2026-11-03 起新包必填）——插件卡 / 加号弹框展示。 */
  usage: z.string().default(''),
  author: z.string().nullable(),
  origin: pluginOriginSchema,
  tier: pluginTierSchema,
  state: pluginStateSchema,
  enabled: z.boolean(),
  /** Absolute path; null for builtin plugins. */
  dirPath: z.string().nullable(),
  marketplace: z.string().nullable(),
  installedAt: z.number().int().nullable(),
  updatedAt: z.number().int().nullable(),
  counts: z.object({
    skills: z.number().int(),
    connectors: z.number().int(),
    mcp: z.number().int(),
    mail: z.number().int(),
    im: z.number().int(),
  }),
  items: z.array(pluginItemRefSchema),
  /** P0a is always null; P1 fills it from the marketplace index. */
  updateAvailable: z.object({ version: z.string() }).nullable(),
  /** P1-1: revocation marker from the marketplace index (`warn` flags, `disable` auto-disabled). */
  revoked: z.enum(['warn', 'disable']).nullable().default(null),
  /** D105 P1: declared plugin config fields (safe projection — no `default`). */
  configFields: z.array(pluginFieldSummarySchema),
  /**
   * D105 P3: resolved instance form fields (kind built-ins + manifest `instanceFields`)
   * for `providesInstances` kinds — same safe projection, no `default`.
   */
  instanceFields: z.array(pluginFieldSummarySchema),
  /**
   * D105 P1: created instances per instantiable kind. P3 口径：mail 按
   * `mail_accounts` 的活跃账号统计（软删 / 无主不计）；mcp 仍按实例行数
   * （P4-M2 custom-mcp 落地时对齐「活跃」口径）。
   */
  instanceCounts: z.object({ mail: z.number().int(), mcp: z.number().int(), im: z.number().int() }),
  /** D105 P1: instantiable capability kinds the manifest declares. */
  providesInstances: z.array(pluginInstanceKindSchema),
});
export type PluginSummary = z.infer<typeof pluginSummarySchema>;

// --- consent panel (plugins.inspect output) ----------------------------------

export const pluginConsentSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  runtimeDeps: z.array(z.string()),
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable(),
});
export type PluginConsentSkill = z.infer<typeof pluginConsentSkillSchema>;

export const pluginConsentConnectorSchema = z.object({
  slug: z.string(),
  name: z.string(),
  title: z.string(),
  hosts: z.array(z.string()),
  scopes: z.array(z.string()),
  authKind: z.string(),
});
export type PluginConsentConnector = z.infer<typeof pluginConsentConnectorSchema>;

export const pluginConsentMcpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mcpb'),
    id: z.string(),
    displayName: z.string(),
    serverType: z.enum(['node', 'python', 'binary', 'uv']),
    launchCommand: z.string(),
    runtime: z
      .object({ kind: z.enum(['node', 'python', 'uv']), available: z.boolean() })
      .nullable(),
    mcpbSha256: z.string(),
    unpackedSize: z.number().int(),
    userConfigFields: z.array(pluginFieldSchema),
    compatible: z.boolean(),
    incompatibleReason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('http'),
    id: z.string(),
    displayName: z.string(),
    url: z.string(),
    host: z.string(),
  }),
]);
export type PluginConsentMcp = z.infer<typeof pluginConsentMcpSchema>;

export const pluginConsentMailSchema = z.object({
  id: z.string(),
  label: z.string(),
  imapHost: z.string(),
  smtpHost: z.string(),
});
export type PluginConsentMail = z.infer<typeof pluginConsentMailSchema>;

/** D107：im 贡献的同意视图——transport、端点主机与收发能力面。 */
export const pluginConsentImSchema = z.object({
  id: z.string(),
  label: z.string(),
  transport: imTransportSchema,
  apiHost: z.string(),
  inbound: z.boolean(),
  outbound: z.boolean(),
});
export type PluginConsentIm = z.infer<typeof pluginConsentImSchema>;

export const pluginConflictSchema = z.object({
  kind: z.enum(['plugin', 'skill', 'connector', 'mcpb', 'mail']),
  /** The conflicting item (skill name / slug / name@version / template id / plugin id). */
  ref: z.string(),
  /** Human-readable counterpart, e.g. 「公共技能 docx（预置）」. */
  withWhat: z.string(),
});
export type PluginConflict = z.infer<typeof pluginConflictSchema>;

/**
 * 执行型插件的能力披露（D125，61 §7「同意卡披露」）：联网域名清单、凭据字段名
 * （**不含值**）与存储配额。P2 只落数据（inspect payload），渲染在 P3/P4。
 * `null` = 数据型插件（清单无 runtime 段）。
 */
export const pluginRuntimeDisclosureSchema = z.strictObject({
  /** 清单 `runtime.hostApi` 的 semver 范围原文（如 '^1'）。 */
  hostApi: z.string(),
  /** `runtime.network.allow` 域名白名单（精确 host 或 '*.domain'）。 */
  networkDomains: z.array(z.string()),
  /** 实例凭据字段名（键名；D125 P4 起 = `runtime.instanceFields` 的敏感键 ∪ 引擎凭据）。 */
  credentialFields: z.array(z.string()),
  /** `host.storage` 配额（字节，10MB）。 */
  storageQuotaBytes: z.number().int().positive().default(PLUGIN_RUNTIME_STORAGE_QUOTA_BYTES),
});
export type PluginRuntimeDisclosure = z.infer<typeof pluginRuntimeDisclosureSchema>;

export const pluginInspectOutputSchema = z.object({
  id: pluginIdSchema,
  name: z.string(),
  version: pluginVersionSchema,
  description: z.string(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  origin: z.enum(['marketplace', 'local']),
  tier: z.enum(['verified', 'community', 'developer']),
  packageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(0),
  skills: z.array(pluginConsentSkillSchema),
  connectors: z.array(pluginConsentConnectorSchema),
  mcp: z.array(pluginConsentMcpSchema),
  mail: z.array(pluginConsentMailSchema),
  im: z.array(pluginConsentImSchema),
  conflicts: z.array(pluginConflictSchema),
  /** Same id already installed (a local source goes through the update flow). */
  existing: z.object({ version: z.string() }).nullable(),
  /** P0a is always null; P1 describes permission expansion on updates. */
  update: z
    .object({ from: z.string(), permissionsExpanded: z.boolean(), added: z.array(z.string()) })
    .nullable(),
  installable: z.boolean(),
  /** Human-readable blockers (conflicts, incompatibility, missing runtimes, …). */
  blockers: z.array(z.string()),
  /** D105 P1: declared plugin config fields (safe projection — no `default`). */
  configFields: z.array(pluginFieldSummarySchema),
  /** D105 P1: one-line capability summary derived from the manifest. */
  capabilitySummary: z.string(),
  /**
   * D125 P2：执行型插件能力披露（数据先行；null = 数据型插件）。核心恒提供，渲染在
   * P3/P4；可选保持旧渲染端载荷兼容。
   */
  runtime: pluginRuntimeDisclosureSchema.nullable().optional(),
});
export type PluginInspectOutput = z.infer<typeof pluginInspectOutputSchema>;

// --- methods -----------------------------------------------------------------

export const pluginsListOutputSchema = z.object({ plugins: z.array(pluginSummarySchema) });
export type PluginsListOutput = z.infer<typeof pluginsListOutputSchema>;

export const pluginsInspectInputSchema = z.object({ source: pluginSourceSchema });
export type PluginsInspectInput = z.infer<typeof pluginsInspectInputSchema>;

export const pluginsInstallInputSchema = z.object({
  source: pluginSourceSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** mcp contribution id → that MCPB's user_config values. */
  userConfig: z.record(z.string(), z.record(z.string(), pluginFieldValueSchema)).default({}),
  /**
   * P1-2: required when the update expands the derived permission set
   * (`inspect.update.permissionsExpanded`); without it core refuses the update.
   */
  acknowledgeDiff: z.boolean().default(false),
});
export type PluginsInstallInput = z.infer<typeof pluginsInstallInputSchema>;

export const pluginsInstallOutputSchema = z.object({ plugin: pluginSummarySchema });
export type PluginsInstallOutput = z.infer<typeof pluginsInstallOutputSchema>;

/** `plugins.update` (D104 P1-2): marketplace updates; local plugins reinstall via install. */
export const pluginsUpdateInputSchema = z.object({
  id: pluginIdSchema,
  /** Absent = the highest compatible version in the current market's index. */
  version: pluginVersionSchema.optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  userConfig: z.record(z.string(), z.record(z.string(), pluginFieldValueSchema)).default({}),
  /** Required when the update expands the derived permission set. */
  acknowledgeDiff: z.boolean().default(false),
});
export type PluginsUpdateInput = z.infer<typeof pluginsUpdateInputSchema>;

export const pluginsUpdateOutputSchema = z.object({ plugin: pluginSummarySchema });
export type PluginsUpdateOutput = z.infer<typeof pluginsUpdateOutputSchema>;

export const pluginsSetEnabledInputSchema = z.object({
  id: pluginIdSchema,
  enabled: z.boolean(),
});
export type PluginsSetEnabledInput = z.infer<typeof pluginsSetEnabledInputSchema>;

export const pluginsSetEnabledOutputSchema = z.object({ plugin: pluginSummarySchema });
export type PluginsSetEnabledOutput = z.infer<typeof pluginsSetEnabledOutputSchema>;

export const pluginsUninstallInputSchema = z.object({ id: pluginIdSchema });
export type PluginsUninstallInput = z.infer<typeof pluginsUninstallInputSchema>;

// --- plugin config & instances (D105 P1, todo/plugin-platform README §4.1) -------------------

export const pluginInstanceIdSchema = z.string().regex(/^pli_[0-9A-Za-z]{26}$/);
export type PluginInstanceId = z.infer<typeof pluginInstanceIdSchema>;

/**
 * Non-sensitive stored values plus which sensitive fields have a stored secret — the
 * auto-built edit form never receives secret plaintext back.
 */
export const pluginInstanceSummarySchema = z.object({
  id: pluginInstanceIdSchema,
  pluginId: pluginIdSchema,
  kind: pluginInstanceKindSchema,
  title: z.string().max(200),
  values: z.record(z.string(), pluginFieldValueSchema),
  storedSensitiveKeys: z.array(z.string()),
  /** P4-M2，仅 `kind: 'mcp'`：实例落地的 MCP server id（`plg_` + sha256 前缀），Bot 详情勾选授权用。 */
  serverId: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PluginInstanceSummary = z.infer<typeof pluginInstanceSummarySchema>;

export const pluginsConfigGetInputSchema = z.object({ id: pluginIdSchema });
export type PluginsConfigGetInput = z.infer<typeof pluginsConfigGetInputSchema>;

export const pluginsConfigGetOutputSchema = z.object({
  /** Non-sensitive stored values keyed by field key. */
  values: z.record(z.string(), pluginFieldValueSchema),
  /** Sensitive fields with a stored secret (the form shows a「已设置」placeholder). */
  storedSensitiveKeys: z.array(z.string()),
});
export type PluginsConfigGetOutput = z.infer<typeof pluginsConfigGetOutputSchema>;

/**
 * `plugins.config.set`: replaces the plugin config with the submitted form — sensitive
 * fields absent from `values` keep their stored secret; required fields must end with a
 * value (submitted or previously stored secret).
 */
export const pluginsConfigSetInputSchema = z.object({
  id: pluginIdSchema,
  values: z.record(z.string(), pluginFieldValueSchema),
});
export type PluginsConfigSetInput = z.infer<typeof pluginsConfigSetInputSchema>;

export const pluginsInstancesListInputSchema = z.object({ pluginId: pluginIdSchema });
export type PluginsInstancesListInput = z.infer<typeof pluginsInstancesListInputSchema>;

export const pluginsInstancesListOutputSchema = z.object({
  instances: z.array(pluginInstanceSummarySchema),
});
export type PluginsInstancesListOutput = z.infer<typeof pluginsInstancesListOutputSchema>;

export const pluginsInstancesCreateInputSchema = z.object({
  pluginId: pluginIdSchema,
  /** May be omitted when the plugin declares exactly one instance kind. */
  kind: pluginInstanceKindSchema.optional(),
  values: z.record(z.string(), pluginFieldValueSchema),
});
export type PluginsInstancesCreateInput = z.infer<typeof pluginsInstancesCreateInputSchema>;

export const pluginsInstancesCreateOutputSchema = z.object({
  instance: pluginInstanceSummarySchema,
});
export type PluginsInstancesCreateOutput = z.infer<typeof pluginsInstancesCreateOutputSchema>;

/** `plugins.instances.update`: non-sensitive values MERGE over stored ones (unlike config.set's full replace); sensitive keep-stored when absent. */
export const pluginsInstancesUpdateInputSchema = z.object({
  id: pluginInstanceIdSchema,
  values: z.record(z.string(), pluginFieldValueSchema),
});
export type PluginsInstancesUpdateInput = z.infer<typeof pluginsInstancesUpdateInputSchema>;

export const pluginsInstancesUpdateOutputSchema = z.object({
  instance: pluginInstanceSummarySchema,
});
export type PluginsInstancesUpdateOutput = z.infer<typeof pluginsInstancesUpdateOutputSchema>;

export const pluginsInstancesDeleteInputSchema = z.object({ id: pluginInstanceIdSchema });
export type PluginsInstancesDeleteInput = z.infer<typeof pluginsInstancesDeleteInputSchema>;

/**
 * D105 P2 注入模型：写 Bot 的插件启用集（`profile_json.runtime.plugin_ids`，整体替换）。
 * 插件 id 均须已安装；Bot 的其他 Profile 字段保持三方合并语义不变。
 */
export const pluginsSetBotPluginsInputSchema = z.object({
  botId: z.string().min(1),
  pluginIds: z.array(pluginIdSchema).max(200),
});
export type PluginsSetBotPluginsInput = z.infer<typeof pluginsSetBotPluginsInputSchema>;

/**
 * `plugins.enableForBots`（D105 P5，P4 审查 P2-2 处置）：把一个已安装插件**合并追加**进
 * 多个 Bot 的启用集（`profile.runtime.plugin_ids` 并集，已启用 = 幂等 no-op）。与
 * `plugins.setBotPlugins`（整集替换 = 编辑器 / 初始化语义）互补：安装引导、对话内设置卡
 * 等「添加」流程用它——读-并-写在 core 一侧同步完成，渲染端不再跨进程读-改-写。
 */
export const pluginsEnableForBotsInputSchema = z.object({
  pluginId: pluginIdSchema,
  botIds: z.array(z.string().min(1)).min(1).max(200),
});
export type PluginsEnableForBotsInput = z.infer<typeof pluginsEnableForBotsInputSchema>;

// --- capability model entries (D124, docs/design/60-capability-model-plugins.md §3/§5) ------

/** 一个已装能力模型插件及其条目视图（`plugins.listCapabilityEntries` 的分组行）。 */
export const pluginCapabilityEntryGroupSchema = z.object({
  pluginId: pluginIdSchema,
  pluginName: z.string(),
  tier: pluginTierSchema,
  entries: z.array(
    z.object({
      entryId: z.string(),
      capability: z.enum(['image', 'video', 'tts', 'asr', 'embedding', 'rerank', 'multimodal']),
      model: z.string(),
      displayName: z.string().nullable(),
      /** 数据型条目的绑定引擎 id；执行型条目 `source: 'plugin'`（`engine` 恒 null，61 §2）。 */
      engine: z.string().nullable(),
      /**
       * D125 P2：条目的执行体来源——数据型 = 'engine'（第一方引擎注册表），执行型 =
       * 'plugin'（所属插件含 `runtime` 段，解析到 HostedAdapter）。核心恒提供；
       * 可选是为了让 P3 之前的渲染端载荷继续兼容（新增字段不构成破坏性变更）。
       */
      source: z.enum(['engine', 'plugin']).optional(),
      /** 该插件当前 capability-model 实例数口径：0 / 1 / 多。 */
      instanceState: z.enum(['none', 'single', 'multi']),
      /** 条目生效实例的必填凭据是否齐备（未配齐 = 置灰 + 「去配置」）。 */
      configured: z.boolean(),
    }),
  ),
});
export type PluginCapabilityEntryGroup = z.infer<typeof pluginCapabilityEntryGroupSchema>;

export const pluginsListCapabilityEntriesOutputSchema = z.object({
  plugins: z.array(pluginCapabilityEntryGroupSchema),
});

// --- 插件运行时（D125 P2，61 §3.1 / §6） ---------------------------------------------

/**
 * 一次调用的历史记录（内存环形缓冲，每插件 50 条）：时间 / 契约.方法 / 时长 / 结果 /
 * 错误码与人话消息。`errorCode` 是运行时错误码或插件 `error.code`（PROVIDER_* 族）。
 */
export const pluginRuntimeCallRecordSchema = z.strictObject({
  at: z.number().int(),
  contract: z.string().min(1),
  method: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  ok: z.boolean(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
});
export type PluginRuntimeCallRecord = z.infer<typeof pluginRuntimeCallRecordSchema>;

/** `plugins.runtime.list` 的每个执行型插件行：状态机 + 最近错误 + 调用历史。 */
export const pluginRuntimePluginStateSchema = z.strictObject({
  pluginId: pluginIdSchema,
  status: z.enum(PLUGIN_RUNTIME_STATUS_VALUES),
  /** 状态说明（error 时的原因文本等）。 */
  detail: z.string().nullable(),
  /** 最近一次错误（人话；null = 无）。 */
  lastError: z.string().nullable(),
  /** 最近调用历史，最新的在前（≤50 条）。 */
  recent: z.array(pluginRuntimeCallRecordSchema).max(50),
});
export type PluginRuntimePluginState = z.infer<typeof pluginRuntimePluginStateSchema>;

export const pluginsRuntimeListOutputSchema = z.strictObject({
  plugins: z.array(pluginRuntimePluginStateSchema),
});
export type PluginsRuntimeListOutput = z.infer<typeof pluginsRuntimeListOutputSchema>;

/** `plugins.runtime.restart`：终止并重新拉起指定执行型插件进程。 */
export const pluginsRuntimeRestartInputSchema = z.strictObject({ pluginId: pluginIdSchema });
export type PluginsRuntimeRestartInput = z.infer<typeof pluginsRuntimeRestartInputSchema>;
export type PluginsListCapabilityEntriesOutput = z.infer<
  typeof pluginsListCapabilityEntriesOutputSchema
>;

/**
 * D124：整体替换 Bot 的启用条目集（`profile_json.runtime.capability_entries`，≤16 软引用）。
 * 写入前校验插件已装且条目存在，未知 ref 整批拒绝（INVALID_INPUT 列出违规项）。
 */
export const pluginsSetBotCapabilityEntriesInputSchema = z.object({
  botId: z.string().min(1),
  entries: z
    .array(
      z.object({
        plugin: z.string().min(1),
        entry: z.string().min(1),
      }),
    )
    .max(16),
});
export type PluginsSetBotCapabilityEntriesInput = z.infer<
  typeof pluginsSetBotCapabilityEntriesInputSchema
>;

/** `plugins.testCapabilityEntry`（D124）：条目级最小真实探测（复用 testCapability 探针）。 */
export const pluginsTestCapabilityEntryInputSchema = z.object({
  pluginId: pluginIdSchema,
  entryId: z.string().min(1),
  /** 缺省按条目 instance / 唯一实例解析；多实例未指定拒绝。 */
  instanceId: z.string().min(1).optional(),
  /** 未保存先测：覆盖实例的 API Key。 */
  keyOverride: z.string().optional(),
});
export type PluginsTestCapabilityEntryInput = z.infer<typeof pluginsTestCapabilityEntryInputSchema>;

/** `plugins.changed` (P0a): the renderer refreshes every projected view. */
export const pluginsChangedPayloadSchema = z.object({ ids: z.array(pluginIdSchema).max(200) });
export type PluginsChangedPayload = z.infer<typeof pluginsChangedPayloadSchema>;

// --- marketplace views (P1-1, docs/design/51-plugin-system.md §6.1 / §8) --------------------

export const pluginMarketStatusSchema = z.object({
  state: z.enum(['disabled', 'ok', 'degraded', 'stale']),
  /** `disabled` 时：no_keys = 官方公钥列表为空；no_custom_key = 自建市场没登记公钥。 */
  disabledReason: z.enum(['no_keys', 'no_custom_key']).nullable(),
  lastSync: z.number().nullable(),
  generatedAt: z.number().nullable(),
  error: z.string().nullable(),
  endpoint: z.enum(['official', 'custom']),
});
export type PluginMarketStatus = z.infer<typeof pluginMarketStatusSchema>;

export const pluginMarketEntrySchema = z.object({
  id: pluginIdSchema,
  version: z.string(),
  tier: z.enum(['verified', 'community']),
  name: z.string(),
  description: z.string(),
  author: z.string().nullable(),
  categories: z.array(pluginContributionKindSchema),
  /** D105 P4: one-line capability summary (index-carried; kinds-derived fallback for old indexes). */
  capabilitySummary: z.string(),
  /**
   * The plugin's own icon as a data URI (market index `summary.icon`, sanitized by core).
   * Null when the index / package has no usable icon — the market card shows the host's
   * default icon (never the name's first letter).
   */
  iconDataUri: z.string().nullable().default(null),
  size: z.number().int(),
  updatedAt: z.number().int(),
  compatible: z.boolean(),
  incompatibleReason: z.string().nullable(),
  installed: z.object({ version: z.string(), updateAvailable: z.boolean() }).nullable(),
  revoked: z.enum(['warn', 'disable']).nullable(),
});
export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema>;

export const pluginsMarketplaceListOutputSchema = z.object({
  status: pluginMarketStatusSchema,
  entries: z.array(pluginMarketEntrySchema),
});
export type PluginsMarketplaceListOutput = z.infer<typeof pluginsMarketplaceListOutputSchema>;

export const pluginsMarketplaceRefreshOutputSchema = z.object({
  status: pluginMarketStatusSchema,
});
export type PluginsMarketplaceRefreshOutput = z.infer<typeof pluginsMarketplaceRefreshOutputSchema>;

/** `plugins.marketplace.updated`：索引采纳 / 端点切换后广播；null = 视图清空待重同步。 */
export const pluginsMarketplaceUpdatedPayloadSchema = z.object({
  generatedAt: z.number().nullable(),
});
export type PluginsMarketplaceUpdatedPayload = z.infer<
  typeof pluginsMarketplaceUpdatedPayloadSchema
>;

/**
 * `plugins.package.progress`（P1-1）：市场包流式下载进度（内容寻址缓存未命中才发生，节流
 * 推送）。`total` 是索引声明并逐字节强制的包体积，因此进度恒可算百分比。
 */
export const pluginsPackageProgressPayloadSchema = z.object({
  id: pluginIdSchema,
  version: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  received: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type PluginsPackageProgressPayload = z.infer<typeof pluginsPackageProgressPayloadSchema>;
