import { z } from 'zod';
import { connectorNameSchema } from './connector-catalog.js';
import { mailModeSchema, mailSecureSchema } from './mail.js';
import { sanitizeDisplayText } from './text-sanitize.js';

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

/** Contribution kinds (defined here so plugin-manifest.ts stays dependency-free; plugins.ts re-exports). */
export const pluginContributionKindSchema = z.enum(['skill', 'connector', 'mcp', 'mail']);
export type PluginContributionKind = z.infer<typeof pluginContributionKindSchema>;

// --- declarative fields / instances (D105, todo/plugin-platform README §2.2–2.3) ---------

/**
 * Form field keys shared by MCPB `user_config`, plugin `config.fields` and instance
 * fields — same rule as the MCPB loader (`apps/mcpb/manifest.ts`).
 */
export const PLUGIN_FIELD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Instantiable capability kinds a pure-instance manifest may declare. */
export const PLUGIN_INSTANCE_KINDS = ['mail', 'mcp'] as const;
export const pluginInstanceKindSchema = z.enum(PLUGIN_INSTANCE_KINDS);
export type PluginInstanceKind = z.infer<typeof pluginInstanceKindSchema>;
export const PLUGIN_MAX_INSTANCES = 4;
export const PLUGIN_MAX_CONFIG_FIELDS = 32;

/** One form value: MCPB user_config, plugin config and instance fields all use this union. */
export const pluginFieldValueSchema = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(10_000)).max(100),
]);
export type PluginFieldValue = z.infer<typeof pluginFieldValueSchema>;

/**
 * The single field schema (`PluginField`, README §4.1). Hosts auto-build every form
 * (MCPB user_config / plugin config / instance fields) from it; constraints mirror the
 * MCPB loader so shared-schema output checks never reject a validated MCPB field.
 */
export const pluginFieldSchema = z.strictObject({
  key: z.string().regex(PLUGIN_FIELD_KEY_PATTERN),
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  multiple: z.boolean().default(false),
  default: pluginFieldValueSchema.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type PluginField = z.infer<typeof pluginFieldSchema>;

/**
 * Safe projection of a declared field for `PluginSummary` / inspect output: the shape
 * the auto-built form needs, minus `default` (manifest-authored text never travels into
 * snapshots through the summary path).
 */
export const pluginFieldSummarySchema = z.strictObject({
  key: z.string(),
  title: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  required: z.boolean(),
  description: z.string().optional(),
  sensitive: z.boolean().optional(),
  multiple: z.boolean().optional(),
  /** number 字段的表单预约束（D105 P4）：数值本身无文案面，随安全投影携带。 */
  min: z.number().optional(),
  max: z.number().optional(),
});
export type PluginFieldSummary = z.infer<typeof pluginFieldSummarySchema>;

export function pluginFieldSummaryOf(field: PluginField): PluginFieldSummary {
  return {
    key: field.key,
    title: field.title,
    type: field.type,
    required: field.required,
    ...(field.description !== '' ? { description: field.description } : {}),
    ...(field.sensitive ? { sensitive: true } : {}),
    ...(field.multiple ? { multiple: true } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  };
}

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

// --- capability summary (README §2.3) -----------------------------------------

/** What the one-line capability summary is derived from (counts only — names where the manifest has them). */
export interface PluginCapabilityFacts {
  skills: number;
  connectors: number;
  mcp: number;
  mail: number;
  instances: readonly PluginInstanceKind[];
  /** Up to two skill display names from the manifest (shown in parentheses). */
  skillNames: readonly string[];
}

export function capabilityFactsOf(manifest: PluginManifest): PluginCapabilityFacts {
  return {
    skills: manifest.contributions.skills.length,
    connectors: manifest.contributions.connectors.length,
    mcp: manifest.contributions.mcp.length,
    mail: manifest.contributions.mail.length,
    instances: manifest.instances ?? [],
    skillNames: manifest.contributions.skills
      .map((skill) => skill.displayName ?? skill.dir.split('/').pop() ?? skill.dir)
      .slice(0, 2),
  };
}

/**
 * One readable line describing what an installed plugin provides (market card, installed
 * card and consent panel reuse it). Manifest text passes through {@link sanitizeDisplayText}
 * (control / bidi / zero-width characters collapsed or removed — same rule as every other
 * untrusted display string).
 */
export function pluginCapabilitySummary(facts: PluginCapabilityFacts): string {
  const parts: string[] = [];
  if (facts.skills > 0) {
    const names = facts.skillNames
      .slice(0, 2)
      .map((name) => sanitizeDisplayText(name, 30))
      .filter((name) => name !== '');
    parts.push(`${facts.skills} 个技能${names.length > 0 ? `（${names.join('、')}）` : ''}`);
  }
  if (facts.connectors > 0) parts.push(`${facts.connectors} 个连接`);
  if (facts.mcp > 0) parts.push(`${facts.mcp} 个工具`);
  // P3: a mail contribution is the instance provisioning spec, not a capability unit —
  // the instances tail below is the user-facing line for it.
  const tail: string[] = [];
  if (facts.instances.includes('mail')) tail.push('可添加多个邮箱账号');
  if (facts.instances.includes('mcp')) tail.push('可添加自定义工具');
  const head =
    parts.length > 0
      ? `提供 ${parts.slice(0, -1).join('、')}${parts.length > 1 ? ' 与 ' : ''}${parts[parts.length - 1]!}`
      : '';
  const summary =
    tail.length > 0 ? (head !== '' ? `${head}；${tail.join('；')}` : tail.join('；')) : head;
  return sanitizeDisplayText(summary === '' ? '提供扩展能力' : summary, 200);
}

/**
 * Market-card fallback (D105 P4): the signed index only guarantees the contribution
 * kinds (`categories`), so entries that predate the index's `capabilitySummary` field
 * get this coarser line derived from the kinds alone — same tone, no counts or names.
 */
export function pluginCapabilitySummaryFromCategories(
  categories: readonly PluginContributionKind[],
): string {
  const labels: string[] = [];
  if (categories.includes('skill')) labels.push('技能');
  if (categories.includes('connector')) labels.push('连接');
  if (categories.includes('mcp')) labels.push('工具');
  if (categories.includes('mail')) labels.push('邮件');
  return sanitizeDisplayText(
    labels.length === 0 ? '提供扩展能力' : `提供${labels.join('、')}能力`,
    200,
  );
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

/**
 * Mail contribution (D105 P3): the provisioning spec of ONE mail instance kind. The
 * kind adapter owns the built-in form fields ({@link PLUGIN_MAIL_BUILTIN_INSTANCE_FIELD_KEYS});
 * these manifest fields are instance DEFAULTS and LOCKS — a vendor plugin declares
 * non-empty hosts (locked, hidden from the form), the generic plugin declares empty
 * hosts and the endpoints become required per-instance fields. `defaultMode` /
 * `defaultPollSec` / `minPollSec` seed new accounts; the global 60 s poll floor stays a
 * hard limit. A manifest carries at most one entry and only alongside
 * `instances: ['mail']` (enforced in `pluginManifestSchema`).
 */
export const pluginMailContributionSchema = z
  .strictObject({
    id: pluginMcpIdSchema,
    label: z.string().min(1).max(60),
    imap: z.strictObject({
      // Trim discipline: a whitespace-padded host must not pass as a vendor lock
      // (core would only fail at create time with a confusing message).
      host: z
        .string()
        .max(253)
        .refine((value) => value === '' || value.trim() === value, {
          message: 'host must not have leading/trailing whitespace',
        }),
      port: z.number().int().min(1).max(65535).default(993),
      secure: mailSecureSchema.default('ssl'),
    }),
    smtp: z.strictObject({
      host: z
        .string()
        .max(253)
        .refine((value) => value === '' || value.trim() === value, {
          message: 'host must not have leading/trailing whitespace',
        }),
      port: z.number().int().min(1).max(65535).default(465),
      secure: mailSecureSchema.default('ssl'),
    }),
    defaultMode: mailModeSchema.default('auto'),
    defaultPollSec: z.number().int().min(60).max(21600).default(300),
    minPollSec: z.number().int().min(60).max(21600).default(60),
    helpUrl: httpsUrl(500).optional(),
    /** Vendor-extra form fields, appended after the kind's built-ins (≤16). */
    instanceFields: z.array(pluginFieldSchema).max(16).optional(),
  })
  .superRefine((contribution, ctx) => {
    // Locks are per-protocol pairs: locking one side only is a manifest authoring bug.
    if ((contribution.imap.host === '') !== (contribution.smtp.host === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['imap', 'host'],
        message: 'IMAP 与 SMTP 必须同时锁定或同时留空',
      });
    }
    const declared = contribution.instanceFields ?? [];
    const seen = new Set<string>();
    declared.forEach((field, index) => {
      if (PLUGIN_MAIL_BUILTIN_INSTANCE_FIELD_KEYS.includes(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instanceFields', index, 'key'],
          message: `字段与内置实例字段重名：${field.key}`,
        });
      }
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instanceFields', index, 'key'],
          message: `实例字段重复：${field.key}`,
        });
      }
      seen.add(field.key);
    });
  });
export type PluginMailContribution = z.infer<typeof pluginMailContributionSchema>;

/**
 * Instance form keys the mail kind adapter generates itself — never manifest-declarable
 * (`instanceFields` entries with these keys are rejected by the schema above).
 */
export const PLUGIN_MAIL_BUILTIN_INSTANCE_FIELD_KEYS: readonly string[] = [
  'address',
  'username',
  'password',
  'imapHost',
  'imapPort',
  'imapSecure',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
] as const;

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
    contributions: z
      .strictObject({
        skills: z.array(pluginSkillContributionSchema).max(PLUGIN_MAX_SKILLS).default([]),
        connectors: z
          .array(pluginConnectorContributionSchema)
          .max(PLUGIN_MAX_CONNECTORS)
          .default([]),
        mcp: z.array(pluginMcpContributionSchema).max(PLUGIN_MAX_MCP).default([]),
        mail: z.array(pluginMailContributionSchema).max(PLUGIN_MAX_MAIL).default([]),
      })
      // D105：纯实例插件（只声明 `instances`）可以整个省略 contributions；解析输出恒为完整对象。
      .prefault({}),
    /** Plugin-level global config (host auto-builds the form; ≤32 fields). */
    config: z
      .strictObject({ fields: z.array(pluginFieldSchema).max(PLUGIN_MAX_CONFIG_FIELDS) })
      .optional(),
    /** Pure-instance capability kinds this plugin provides (no contributions needed). */
    instances: z.array(pluginInstanceKindSchema).max(PLUGIN_MAX_INSTANCES).optional(),
  })
  .superRefine((manifest, ctx) => {
    const { skills, connectors, mcp, mail } = manifest.contributions;
    if (skills.length + connectors.length + mcp.length + mail.length + (manifest.instances?.length ?? 0) < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions'],
        message: '插件至少要包含一类贡献或实例能力',
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
    // D105 P3: a mail contribution IS the mail-instance provisioning spec — exactly one
    // per manifest, and ONLY together with the `instances: ['mail']` declaration. The
    // reverse holds too (review P2-1): a declared mail instance kind without its
    // provisioning spec would render a form whose fields can never satisfy create.
    if (mail.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions', 'mail'],
        message: '邮件实例能力只能声明一个配置',
      });
    }
    if (mail.length > 0 && !manifest.instances?.includes('mail')) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions', 'mail'],
        message: '声明邮件贡献时必须同时声明 instances: [\'mail\']',
      });
    }
    if (mail.length === 0 && manifest.instances?.includes('mail')) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances'],
        message: '声明 instances: [\'mail\'] 时必须同时声明一份邮件贡献',
      });
    }
    // Declarative fields / instances (D105): duplicate config keys and duplicate
    // instance kinds are rejected up front — the host builds forms keyed by them.
    if (manifest.config !== undefined) {
      const seenFields = new Set<string>();
      manifest.config.fields.forEach((field, index) => {
        if (seenFields.has(field.key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['config', 'fields', index, 'key'],
            message: `配置字段重复：${field.key}`,
          });
        }
        seenFields.add(field.key);
      });
    }
    if (manifest.instances !== undefined) {
      const seenKinds = new Set<PluginInstanceKind>();
      manifest.instances.forEach((kind, index) => {
        if (seenKinds.has(kind)) {
          ctx.addIssue({
            code: 'custom',
            path: ['instances', index],
            message: `实例能力类型重复：${kind}`,
          });
        }
        seenKinds.add(kind);
      });
    }
  });
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
