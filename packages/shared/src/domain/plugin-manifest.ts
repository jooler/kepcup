import { z } from 'zod';
import { connectorNameSchema } from './connector-catalog.js';
import { imMediaKindSchema, imSetupSchema, imTransportSchema } from './im.js';
import { MCP_HEADER_SCHEMES } from './mcp-header.js';
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
export const PLUGIN_MAX_IM = 10;

/** Contribution kinds (defined here so plugin-manifest.ts stays dependency-free; plugins.ts re-exports). */
export const pluginContributionKindSchema = z.enum(['skill', 'connector', 'mcp', 'mail', 'im']);
export type PluginContributionKind = z.infer<typeof pluginContributionKindSchema>;

// --- declarative fields / instances (D105, todo/plugin-platform README §2.2–2.3) ---------

/**
 * Form field keys shared by MCPB `user_config`, plugin `config.fields` and instance
 * fields — same rule as the MCPB loader (`apps/mcpb/manifest.ts`).
 */
export const PLUGIN_FIELD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Instantiable capability kinds a pure-instance manifest may declare. */
export const PLUGIN_INSTANCE_KINDS = ['mail', 'mcp', 'im'] as const;
export const pluginInstanceKindSchema = z.enum(PLUGIN_INSTANCE_KINDS);
export type PluginInstanceKind = z.infer<typeof pluginInstanceKindSchema>;
export const PLUGIN_MAX_INSTANCES = 4;
export const PLUGIN_MAX_CONFIG_FIELDS = 32;
/** Icon bytes cap: larger files are ignored (the UI falls back to the default icon). */
export const PLUGIN_ICON_MAX_BYTES = 256 * 1024;
/**
 * Marketplace index icon cap: the signed index carries the package icon inline (data URI),
 * so it stays much smaller than the installed-tree cap. A declared icon above this is not
 * embedded; market cards fall back to the default icon.
 */
export const PLUGIN_MARKET_ICON_MAX_BYTES = 64 * 1024;

const PLUGIN_ICON_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const PLUGIN_ICON_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    out += PLUGIN_ICON_BASE64[first >> 2]!;
    out += PLUGIN_ICON_BASE64[((first & 0x03) << 4) | (second >> 4)]!;
    out +=
      index + 1 < bytes.length ? PLUGIN_ICON_BASE64[((second & 0x0f) << 2) | (third >> 6)]! : '=';
    out += index + 2 < bytes.length ? PLUGIN_ICON_BASE64[third & 0x3f]! : '=';
  }
  return out;
}

function looksLikeSvgIcon(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

function looksLikeIcon(bytes: Uint8Array, ext: string): boolean {
  if (ext === '.png') {
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
  }
  return looksLikeSvgIcon(bytes);
}

/**
 * Inlines package icon bytes as a data URI, using the same extension / magic-byte / size
 * rules everywhere they are read (installed tree and the signed marketplace index).
 * Returns null for an unsupported extension, an empty / oversized payload or bad bytes.
 */
export function pluginIconDataUriFromBytes(
  iconPath: string,
  bytes: Uint8Array,
  options: { maxBytes?: number } = {},
): string | null {
  const ext = iconPath.slice(iconPath.lastIndexOf('.')).toLowerCase();
  const mime = PLUGIN_ICON_MIME_BY_EXT[ext];
  if (mime === undefined) return null;
  const maxBytes = options.maxBytes ?? PLUGIN_ICON_MAX_BYTES;
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  if (!looksLikeIcon(bytes, ext)) return null;
  return `data:${mime};base64,${base64Encode(bytes)}`;
}

/**
 * True for a value the renderer can safely put in `<img src>` as an icon: an SVG / PNG
 * data URI within the installed-icon cap. Used to sanitize signed-index input (an old or
 * custom index may carry anything) before it reaches `PluginMarketEntry`.
 */
export function isPluginIconDataUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(?:svg\+xml|png);base64,(.*)$/.exec(value);
  if (match === null) return false;
  const body = match[1]!;
  if (body.length === 0 || body.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
  return Math.floor((body.length * 3) / 4) <= PLUGIN_ICON_MAX_BYTES;
}

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

/**
 * Plugin icon file (top-level `icon`): a plain in-package path ending in `.svg` or
 * `.png`. The host reads it for `PluginSummary.iconDataUri` and falls back to its
 * built-in default icon when the field is absent or the file is unusable.
 */
export const pluginIconPathSchema = pluginRelPathSchema.refine(
  (value) => /\.(svg|png)$/i.test(value),
  { message: 'icon must end in .svg or .png' },
);

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
  im: number;
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
    im: manifest.contributions.im.length,
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
  // the instances tail below is the user-facing line for it. D107: im is the same shape.
  const tail: string[] = [];
  if (facts.instances.includes('mail')) tail.push('可添加多个邮箱账号');
  if (facts.instances.includes('mcp')) tail.push('可添加自定义工具');
  if (facts.instances.includes('im')) tail.push('可添加 IM 账号（如微信），收发消息');
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
  if (categories.includes('im')) labels.push('即时通讯');
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

/**
 * Header name for an http MCP template. Narrower than the RFC 7230 token set on
 * purpose: the value lands in secrets as `mcp:{serverId}:header:{name}`
 * (`SECRET_NAME_PATTERN` = alnum / `:` / `_` / `-`, ≤128 total incl. the ≤64-char
 * server id), so `. ! # $ % …` names would only fail later at instance create with
 * an opaque keystore error. Real-world header names stay covered.
 */
const PLUGIN_MCP_HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * One locked header of an http MCP template (P4-M2): `name` is the wire header, `key`
 * is the instance field supplying its value (defaults to the lower-cased header name).
 * The value itself never lives in the manifest — the materializer writes it to secrets.
 */
export const pluginMcpHeaderTemplateSchema = z.strictObject({
  name: z.string().regex(PLUGIN_MCP_HEADER_NAME_PATTERN, {
    message: 'invalid HTTP header name',
  }),
  key: z.string().regex(PLUGIN_FIELD_KEY_PATTERN).optional(),
  /**
   * 凭据方案（可选）：声明后该 header 的值按方案归一化——保存时 strip 前缀只存裸凭据，
   * 发送时按需补前缀（见 `mcp-header.ts`）。未声明的 header 值原样透传，所以这条规则
   * 不会波及通用 MCP / 其他 header / API key 类 secret。
   */
  scheme: z.enum(MCP_HEADER_SCHEMES).optional(),
});
export type PluginMcpHeaderTemplate = z.infer<typeof pluginMcpHeaderTemplateSchema>;

/** 清单里某个 http 模板声明的 header（按名字，大小写不敏感）；未声明时 undefined。 */
export function mcpHeaderTemplateOf(
  contribution: Pick<Extract<PluginMcpContribution, { kind: 'http' }>, 'headers'> | undefined,
  headerName: string,
): PluginMcpHeaderTemplate | undefined {
  const wanted = headerName.toLowerCase();
  return contribution?.headers?.find((header) => header.name.toLowerCase() === wanted);
}

/** The instance field key a header template feeds when the manifest omits an explicit one. */
export function mcpHeaderFieldKey(header: PluginMcpHeaderTemplate): string {
  return header.key ?? header.name.toLowerCase();
}

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
    // '' (P4-M2) declares a GENERIC template — the URL becomes a required per-instance
    // field; a non-empty value is a vendor LOCK. Only meaningful alongside
    // `instances: ['mcp']` (pairing is enforced in `pluginManifestSchema`); without that
    // declaration the contribution keeps its legacy fixed-projection semantics and ''
    // is rejected (a fixed server needs a real endpoint).
    url: z
      .string()
      .max(2000)
      .refine((value) => value === '' || value.trim() === value, {
        message: 'url must not have leading/trailing whitespace',
      })
      .refine((value) => value === '' || z.string().url().safeParse(value).success, {
        message: 'url must be a valid URL',
      }),
    auth: z.enum(['none', 'headers']).default('none'),
    headers: z.array(pluginMcpHeaderTemplateSchema).max(8).optional(),
    /**
     * Generic-template only: when the URL itself carries the credential (e.g. a
     * per-user key embedded in the endpoint), mark the built-in `url` instance field
     * sensitive so it lands in secrets instead of `config_json`.
     */
    urlSensitive: z.boolean().optional(),
    /** Vendor-extra form fields, appended after the kind's built-ins (≤16). */
    instanceFields: z.array(pluginFieldSchema).max(16).optional(),
  }).superRefine((contribution, ctx) => refineMcpHttpTemplate(contribution, ctx)),
]);
export type PluginMcpContribution = z.infer<typeof pluginMcpContributionSchema>;

/**
 * Instance form keys the mcp kind adapter generates itself — never manifest-declarable
 * (`instanceFields` entries with these keys are rejected by the schema below): `label`
 * is the per-instance display name, `url` the generic-template endpoint.
 */
export const PLUGIN_MCP_BUILTIN_INSTANCE_FIELD_KEYS: readonly string[] = ['label', 'url'] as const;

/** The static shape of an http mcp contribution (avoids a circular `z.infer` in the helper). */
type PluginMcpHttpTemplateShape = {
  kind: 'http';
  id: string;
  name?: string;
  description?: string;
  url: string;
  auth: 'none' | 'headers';
  headers?: PluginMcpHeaderTemplate[];
  urlSensitive?: boolean;
  instanceFields?: PluginField[];
};

/** Template-level validation shared by the http branch: header shape + field-key clashes. */
function refineMcpHttpTemplate(
  contribution: PluginMcpHttpTemplateShape,
  ctx: z.RefinementCtx,
): void {
  const headers = contribution.headers ?? [];
  if (contribution.auth === 'headers' && headers.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['auth'],
      message: "auth: 'headers' 需要至少声明一个 headers 条目",
    });
  }
  if (contribution.auth === 'none' && headers.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['headers'],
      message: "auth: 'none' 时不能声明 headers",
    });
  }
  const seen = new Set<string>(PLUGIN_MCP_BUILTIN_INSTANCE_FIELD_KEYS);
  headers.forEach((header, index) => {
    const key = mcpHeaderFieldKey(header);
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers', index],
        message: `header 字段键与内置字段或其它 header 冲突：${key}`,
      });
    }
    seen.add(key);
  });
  (contribution.instanceFields ?? []).forEach((field, index) => {
    if (PLUGIN_MCP_BUILTIN_INSTANCE_FIELD_KEYS.includes(field.key)) {
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
}

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

/**
 * IM 贡献（D107，docs/design/54-im-channel.md §2）：一个 `im` 实例 kind 的供给规范——
 * transport 决定宿主会话实现与建号 UI（首发 `ilink` = 个人微信 iLink Bot API，D108），
 * `apiBase` 在 transport 要求端点时必填且锁定（https 公网），`features` 是声明面
 * （宿主按 transport 实际实现裁剪）。与 mail 同规则：至多一份、必须与
 * `instances: ['im']` 双向配对（enforced in `pluginManifestSchema`）。
 * 建号交叉规则：`qrcode` 扫码流程没有表单，不得声明 sensitive 实例字段；
 * `secret` 表单建号至少声明一个 sensitive 字段作为密钥。
 */
export const pluginImContributionSchema = z
  .strictObject({
    id: pluginMcpIdSchema,
    label: z.string().min(1).max(60),
    transport: imTransportSchema,
    // Trim 纪律同 mail host：空白填充的端点不能当锁定值通过（否则 core 到建号时才报错）。
    // 注意 z.string().url() 走 WHATWG 解析会先吞首尾空白，trim 校验必须在其之前对原始值做。
    apiBase: z
      .string()
      .max(500)
      .refine((value) => value.trim() === value, {
        message: 'apiBase must not have leading/trailing whitespace',
      })
      .refine((value) => value.startsWith('https://'), { message: 'must be an https URL' })
      .refine((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      }),
    setup: imSetupSchema,
    features: z.strictObject({
      inbound: z.boolean(),
      outbound: z.boolean(),
      media: z.array(imMediaKindSchema).max(8).default([]),
    }),
    /** Vendor-extra form fields, appended after the kind's built-ins (≤16). */
    instanceFields: z.array(pluginFieldSchema).max(16).optional(),
  })
  .superRefine((contribution, ctx) => {
    const declared = contribution.instanceFields ?? [];
    const seen = new Set<string>();
    declared.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instanceFields', index, 'key'],
          message: `实例字段重复：${field.key}`,
        });
      }
      seen.add(field.key);
      // 扫码流程没有表单：sensitive 字段没有收集入口，声明了就永远建不成号。
      if (contribution.setup === 'qrcode' && field.sensitive) {
        ctx.addIssue({
          code: 'custom',
          path: ['instanceFields', index, 'sensitive'],
          message: 'qrcode 建号不得声明敏感实例字段（扫码流程没有表单）',
        });
      }
    });
    if (contribution.setup === 'secret' && !declared.some((field) => field.sensitive)) {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceFields'],
        message: 'secret 建号至少声明一个敏感实例字段作为密钥',
      });
    }
    // webhook 单向推送没有入站面；声明 inbound 是清单笔误（54 §2.4 路标）。
    if (contribution.transport === 'webhook' && contribution.features.inbound) {
      ctx.addIssue({
        code: 'custom',
        path: ['features', 'inbound'],
        message: 'webhook 传输不支持入站',
      });
    }
  });
export type PluginImContribution = z.infer<typeof pluginImContributionSchema>;

/**
 * Instance form keys the im kind adapter generates itself — never manifest-declarable
 * (`instanceFields` entries with these keys are rejected by the schema above).
 */
export const PLUGIN_IM_BUILTIN_INSTANCE_FIELD_KEYS: readonly string[] = ['bot_token'] as const;

// --- manifest ----------------------------------------------------------------

export const pluginManifestSchema = z
  .strictObject({
    format_version: z.literal(PLUGIN_FORMAT_VERSION),
    id: pluginIdSchema,
    name: z.string().min(1).max(100),
    /** Package-relative icon file (`.svg` / `.png`); absent = the host's default icon. */
    icon: pluginIconPathSchema.optional(),
    version: pluginVersionSchema,
    description: z.string().max(1000).default(''),
    /**
     * 启用说明（2026-11-03，docs/design/51-plugin-system.md §15.8）：插件自己的
     * 「启用之后要做什么」——「启用即用」还是「需要连接 / 添加账号再勾选绑定」。
     * 用户在 Bot 详情操作插件 30 秒后，core 把操作状态连同此说明一起发给 Bot，
     * 由它判断是否提醒用户完成遗漏的步骤。清单作者文案不可信：进提示词前经
     * `sanitizeDisplayText` 清洗。
     *
     * 新安装 / 市场发布**必填**（安装管线 `requireUsage`、`kepcup-app validate` 与
     * 签名脚本拒绝空值）；schema 对存量已装清单回落空串，保证 2026-11-03 之前装的
     * 旧版本仍可读取与更新。
     */
    usage: z.string().max(500).default(''),
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
        im: z.array(pluginImContributionSchema).max(PLUGIN_MAX_IM).default([]),
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
    const { skills, connectors, mcp, mail, im } = manifest.contributions;
    if (
      skills.length +
        connectors.length +
        mcp.length +
        mail.length +
        im.length +
        (manifest.instances?.length ?? 0) <
      1
    ) {
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
        message: "声明邮件贡献时必须同时声明 instances: ['mail']",
      });
    }
    if (mail.length === 0 && manifest.instances?.includes('mail')) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances'],
        message: "声明 instances: ['mail'] 时必须同时声明一份邮件贡献",
      });
    }
    // D107：im 贡献 = im 实例供给规范，与 mail 同规则（双向配对、至多一份）。
    if (im.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions', 'im'],
        message: 'IM 实例能力只能声明一个配置',
      });
    }
    if (im.length > 0 && !manifest.instances?.includes('im')) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions', 'im'],
        message: "声明 IM 贡献时必须同时声明 instances: ['im']",
      });
    }
    if (im.length === 0 && manifest.instances?.includes('im')) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances'],
        message: "声明 instances: ['im'] 时必须同时声明一份 IM 贡献",
      });
    }
    // P4-M2 mcp instance templates: an `mcpb` contribution is a bundled server and is
    // never instantiable; an `http` contribution is a per-instance TEMPLATE only when
    // the manifest declares `instances: ['mcp']` (at most one — a pure-instance generic
    // plugin declares none and gets the built-in url/label form), and keeps the legacy
    // fixed-projection semantics otherwise. The generic '' URL is template-mode-only.
    if (manifest.instances?.includes('mcp') === true) {
      if (manifest.contributions.mcp.some((entry) => entry.kind === 'mcpb')) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributions', 'mcp'],
          message: "mcpb 贡献不支持实例化（instances: ['mcp']）",
        });
      }
      if (manifest.contributions.mcp.filter((entry) => entry.kind === 'http').length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributions', 'mcp'],
          message: 'MCP 实例能力只能声明一个模版配置',
        });
      }
    } else if (manifest.contributions.mcp.some((entry) => entry.kind === 'http' && entry.url === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['contributions', 'mcp'],
        message: "url 留空表示通用模版，必须同时声明 instances: ['mcp']",
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
