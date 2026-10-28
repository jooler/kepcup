import { z } from 'zod';
import {
  pluginFieldSchema,
  pluginFieldSummarySchema,
  pluginFieldValueSchema,
  pluginIdSchema,
  pluginInstanceKindSchema,
  pluginVersionSchema,
} from './plugin-manifest.js';

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

export const pluginContributionKindSchema = z.enum(['skill', 'connector', 'mcp', 'mail']);
export type PluginContributionKind = z.infer<typeof pluginContributionKindSchema>;

export const pluginItemKindSchema = z.enum([
  'skill',
  'connector',
  'mcp',
  'mail',
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
  version: pluginVersionSchema,
  description: z.string(),
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
  }),
  items: z.array(pluginItemRefSchema),
  /** P0a is always null; P1 fills it from the marketplace index. */
  updateAvailable: z.object({ version: z.string() }).nullable(),
  /** P1-1: revocation marker from the marketplace index (`warn` flags, `disable` auto-disabled). */
  revoked: z.enum(['warn', 'disable']).nullable().default(null),
  /** D105 P1: declared plugin config fields (safe projection — no `default`). */
  configFields: z.array(pluginFieldSummarySchema),
  /** D105 P1: created instances per instantiable kind. */
  instanceCounts: z.object({ mail: z.number().int(), mcp: z.number().int() }),
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

export const pluginConflictSchema = z.object({
  kind: z.enum(['plugin', 'skill', 'connector', 'mcpb', 'mail']),
  /** The conflicting item (skill name / slug / name@version / template id / plugin id). */
  ref: z.string(),
  /** Human-readable counterpart, e.g. 「公共技能 docx（预置）」. */
  withWhat: z.string(),
});
export type PluginConflict = z.infer<typeof pluginConflictSchema>;

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
