import { z } from 'zod';
import { connectorNameSchema } from './connector-catalog.js';
import { mailModeSchema, mailSecureSchema } from './mail.js';

/**
 * Plugin manifest (`plugin.json`, D104, docs/design/51-plugin-system.md §3).
 *
 * Pure zod schemas and pure functions only — no Node API (this file is consumed by the
 * renderer too). Core (`packages/core/src/plugins/manifest-loader.ts`) reads the text,
 * checks `format_version` / byte budget and runs the schema; every unknown field is a
 * rejection (`strictObject`), so a manifest can never self-declare trust (`tier`,
 * `permissions`, …).
 */

export const PLUGIN_FORMAT_VERSION = 1;
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
export const PLUGIN_SOURCE_PREFIX = 'plugin://';
/** Namespaces a marketplace / local install must never claim (builtin-only and local-connections). */
export const PLUGIN_RESERVED_NAMESPACES = ['com.kepcup', 'local.kepcup'] as const;
/** Package-stable contribution id (mcp / mail): keys become parts of server ids and template ids. */
export const PLUGIN_MCP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PLUGIN_MAX_SKILLS = 50;
export const PLUGIN_MAX_CONNECTORS = 20;
export const PLUGIN_MAX_MCP = 10;
export const PLUGIN_MAX_MAIL = 10;

/** Same shape as the Registry namespace rule (`反向域名/名字`). */
export const pluginIdSchema = connectorNameSchema;
export const pluginVersionSchema = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

/** `io.github.alice/doc-tools` → `io.github.alice`（lower-cased）。 */
export function pluginNamespaceOf(id: string): string {
  return id.slice(0, id.indexOf('/')).toLowerCase();
}

export function isReservedPluginNamespace(namespace: string): boolean {
  return (PLUGIN_RESERVED_NAMESPACES as readonly string[]).includes(namespace.toLowerCase());
}

/**
 * In-package relative POSIX path: non-empty, ≤300 chars, no backslash / colon / control
 * characters, not starting with `/`, and no empty / `.` / `..` segment (so no trailing slash).
 */
export function isSafePluginRelPath(value: string): boolean {
  if (value.length === 0 || value.length > 300) return false;
  if (value.includes('\\') || value.includes(':')) return false;
  if (value.startsWith('/')) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

export const pluginRelPathSchema = z
  .string()
  .refine(isSafePluginRelPath, { message: 'unsafe relative path' });

/** Skill source marker written into `skill_library.source_url`: `plugin://{pluginId}/{skillName}`. */
export function pluginSkillSource(pluginId: string, skillName: string): string {
  return `${PLUGIN_SOURCE_PREFIX}${pluginId}/${skillName}`;
}

/**
 * Splits a source marker after the prefix by `/` — exactly three segments
 * (namespace, name, skill name) yields the plugin id and skill name, anything else is null.
 */
export function parsePluginSkillSource(
  sourceUrl: string,
): { pluginId: string; skillName: string } | null {
  if (!sourceUrl.startsWith(PLUGIN_SOURCE_PREFIX)) return null;
  const rest = sourceUrl.slice(PLUGIN_SOURCE_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length !== 3) return null;
  const [namespace, name, skillName] = parts;
  if (
    namespace === undefined ||
    name === undefined ||
    skillName === undefined ||
    namespace.length === 0 ||
    name.length === 0 ||
    skillName.length === 0
  ) {
    return null;
  }
  return { pluginId: `${namespace}/${name}`, skillName };
}

// --- contributions -----------------------------------------------------------

const httpsUrl = (max: number) =>
  z
    .string()
    .url()
    .max(max)
    .refine((value) => value.startsWith('https://'), { message: 'must be an https URL' });

/** Display fields of a packaged skill folder; only builtin plugins use them, others may omit. */
export const pluginSkillContributionSchema = z.strictObject({
  dir: pluginRelPathSchema,
  displayName: z.string().max(100).optional(),
  summary: z.string().max(500).optional(),
  icon: z.string().max(64).optional(),
  section: z.string().max(64).optional(),
  tryIt: z.string().max(500).optional(),
  version: z.string().max(32).optional(),
  vendored: z.boolean().optional(),
});
export type PluginSkillContribution = z.infer<typeof pluginSkillContributionSchema>;

export const pluginConnectorContributionSchema = z.strictObject({
  file: pluginRelPathSchema.refine((value) => value.endsWith('.json'), {
    message: 'connector contribution must be a .json file',
  }),
});
export type PluginConnectorContribution = z.infer<typeof pluginConnectorContributionSchema>;

const pluginMcpIdSchema = z.string().regex(PLUGIN_MCP_KEY_PATTERN);
const pluginMcpDescriptionSchema = z.string().max(200);
const pluginMcpNameSchema = z.string().max(100);

export const pluginMcpContributionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mcpb'),
    id: pluginMcpIdSchema,
    name: pluginMcpNameSchema.optional(),
    description: pluginMcpDescriptionSchema.optional(),
    file: pluginRelPathSchema.refine((value) => value.endsWith('.mcpb'), {
      message: 'mcpb contribution must be a .mcpb file',
    }),
  }),
  z.strictObject({
    kind: z.literal('http'),
    id: pluginMcpIdSchema,
    name: pluginMcpNameSchema.optional(),
    description: pluginMcpDescriptionSchema.optional(),
    // The https / public-host check is core's job (it reuses isSafeDirectoryRemoteUrl).
    url: z.string().url().max(2000),
  }),
]);
export type PluginMcpContribution = z.infer<typeof pluginMcpContributionSchema>;

/** Fields mirror `MailProviderPreset`; the template only pre-fills the add-account form. */
export const pluginMailContributionSchema = z.strictObject({
  id: pluginMcpIdSchema,
  label: z.string().min(1).max(60),
  imap: z.strictObject({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    secure: mailSecureSchema,
  }),
  smtp: z.strictObject({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    secure: mailSecureSchema,
  }),
  defaultMode: mailModeSchema.default('auto'),
  defaultPollSec: z.number().int().min(60).max(21600).default(300),
  minPollSec: z.number().int().min(60).max(21600).default(60),
  helpUrl: httpsUrl(500).optional(),
});
export type PluginMailContribution = z.infer<typeof pluginMailContributionSchema>;

// --- manifest ----------------------------------------------------------------

export const pluginManifestSchema = z
  .strictObject({
    format_version: z.literal(PLUGIN_FORMAT_VERSION),
    id: pluginIdSchema,
    name: z.string().min(1).max(100),
    version: pluginVersionSchema,
    description: z.string().max(1000).default(''),
    author: z
      .strictObject({
        name: z.string().min(1).max(200),
        url: httpsUrl(500).optional(),
      })
      .optional(),
    homepage: httpsUrl(500).optional(),
    engines: z.strictObject({ kepcup: z.string().min(1).max(100) }).optional(),
    platforms: z
      .array(z.enum(['darwin', 'win32', 'linux']))
      .min(1)
      .optional(),
    contributions: z.strictObject({
      skills: z.array(pluginSkillContributionSchema).max(PLUGIN_MAX_SKILLS).default([]),
      connectors: z.array(pluginConnectorContributionSchema).max(PLUGIN_MAX_CONNECTORS).default([]),
      mcp: z.array(pluginMcpContributionSchema).max(PLUGIN_MAX_MCP).default([]),
      mail: z.array(pluginMailContributionSchema).max(PLUGIN_MAX_MAIL).default([]),
    }),
  })
  .superRefine((manifest, ctx) => {
    const { skills, connectors, mcp, mail } = manifest.contributions;
    if (skills.length + connectors.length + mcp.length + mail.length < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions'],
        message: '插件至少要包含一类贡献',
      });
    }
    // Entries carry their index in the containing array so the issue path points at the
    // offending item even when the duplicated values come from a filtered subset (mcpb files).
    const dup = (
      entries: ReadonlyArray<readonly [string, number]>,
      path: readonly (string | number)[],
      field: string,
    ) => {
      const seen = new Set<string>();
      for (const [value, index] of entries) {
        const key = value.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, index, field],
            message: `包内有重复项：${value}`,
          });
        }
        seen.add(key);
      }
    };
    dup(
      skills.map((skill, index) => [skill.dir, index] as const),
      ['contributions', 'skills'],
      'dir',
    );
    dup(
      connectors.map((connector, index) => [connector.file, index] as const),
      ['contributions', 'connectors'],
      'file',
    );
    dup(
      mcp.map((contribution, index) => [contribution.id, index] as const),
      ['contributions', 'mcp'],
      'id',
    );
    dup(
      mcp.flatMap((contribution, index) =>
        contribution.kind === 'mcpb' ? [[contribution.file, index] as const] : [],
      ),
      ['contributions', 'mcp'],
      'file',
    );
    dup(
      mail.map((template, index) => [template.id, index] as const),
      ['contributions', 'mail'],
      'id',
    );
  });
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
