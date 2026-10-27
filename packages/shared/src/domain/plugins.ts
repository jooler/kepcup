import { z } from 'zod';
import { mcpbUserConfigFieldSchema, mcpbUserConfigValueSchema } from './mcpb.js';
import { pluginIdSchema, pluginVersionSchema } from './plugin-manifest.js';

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

// P1 adds { kind: 'marketplace', id, version? } (additive).
export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1).max(4096) }),
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
    userConfigFields: z.array(mcpbUserConfigFieldSchema),
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
  userConfig: z.record(z.string(), z.record(z.string(), mcpbUserConfigValueSchema)).default({}),
});
export type PluginsInstallInput = z.infer<typeof pluginsInstallInputSchema>;

export const pluginsInstallOutputSchema = z.object({ plugin: pluginSummarySchema });
export type PluginsInstallOutput = z.infer<typeof pluginsInstallOutputSchema>;

export const pluginsSetEnabledInputSchema = z.object({
  id: pluginIdSchema,
  enabled: z.boolean(),
});
export type PluginsSetEnabledInput = z.infer<typeof pluginsSetEnabledInputSchema>;

export const pluginsSetEnabledOutputSchema = z.object({ plugin: pluginSummarySchema });
export type PluginsSetEnabledOutput = z.infer<typeof pluginsSetEnabledOutputSchema>;

export const pluginsUninstallInputSchema = z.object({ id: pluginIdSchema });
export type PluginsUninstallInput = z.infer<typeof pluginsUninstallInputSchema>;

/** `plugins.changed` (P0a): the renderer refreshes every projected view. */
export const pluginsChangedPayloadSchema = z.object({ ids: z.array(pluginIdSchema).max(200) });
export type PluginsChangedPayload = z.infer<typeof pluginsChangedPayloadSchema>;
