import path from 'node:path';
import { z } from 'zod';
import { AppError, type McpbUserConfigField, type McpbUserConfigValue } from '@kepcup/shared';

/**
 * MCPB manifest v0.3 (https://github.com/modelcontextprotocol/mcpb): parsing,
 * compatibility check and launch-template expansion. Pure functions — nothing
 * here touches the file system or the environment manager.
 */

export const MCPB_SERVER_TYPES = ['node', 'python', 'binary', 'uv'] as const;
export type McpbServerType = (typeof MCPB_SERVER_TYPES)[number];
const SUPPORTED_MANIFEST_VERSIONS = new Set(['0.1', '0.2', '0.3']);
const PLATFORMS = ['darwin', 'win32', 'linux'] as const;

/** Names become directory names and server ids: no separators, no leading dot. */
export const MCPB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MCPB_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
/** Keys become secret names `mcp:{serverId}:env:{KEY}`. */
const CONFIG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const configValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const userConfigFieldSchema = z.looseObject({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  default: configValueSchema.optional(),
  sensitive: z.boolean().optional(),
  multiple: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const launchOverrideSchema = z.looseObject({
  command: z.string().min(1).max(2000).optional(),
  args: z.array(z.string().max(2000)).max(200).optional(),
  env: z.record(z.string(), z.string().max(4000)).optional(),
});

const mcpConfigSchema = launchOverrideSchema.extend({
  command: z.string().min(1).max(2000),
  platform_overrides: z.record(z.string(), launchOverrideSchema).optional(),
});

const manifestSchema = z.looseObject({
  manifest_version: z.string().optional(),
  dxt_version: z.string().optional(),
  name: z
    .string()
    .regex(MCPB_NAME_PATTERN, '只允许字母、数字、点、下划线与连字符，且不能以符号开头'),
  display_name: z.string().min(1).max(100).optional(),
  version: z.string().regex(MCPB_VERSION_PATTERN, '只允许字母、数字、点、下划线、加号与连字符'),
  description: z.string().max(2000).optional(),
  author: z.looseObject({ name: z.string().max(200) }).optional(),
  server: z.looseObject({
    type: z.string().min(1),
    entry_point: z.string().min(1).max(1000),
    mcp_config: mcpConfigSchema.optional(),
  }),
  user_config: z.record(z.string(), userConfigFieldSchema).optional(),
  compatibility: z
    .looseObject({
      platforms: z.array(z.string()).optional(),
      runtimes: z
        .looseObject({ node: z.string().optional(), python: z.string().optional() })
        .optional(),
    })
    .optional(),
});

export type McpbManifest = z.infer<typeof manifestSchema>;

function invalid(message: string): AppError {
  return new AppError('MCPB_INVALID', message);
}

/** Parses and validates `manifest.json`; throws `MCPB_INVALID` with a readable reason. */
export function parseMcpbManifest(input: unknown): McpbManifest {
  let json = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      throw invalid('manifest.json 不是合法的 JSON');
    }
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'manifest';
      return `${where}：${issue.message}`;
    });
    throw invalid(`manifest.json 不符合 MCPB 规范：${lines.join('；')}`);
  }
  const manifest = parsed.data;
  const version = manifest.manifest_version ?? manifest.dxt_version;
  if (version === undefined) throw invalid('manifest.json 缺少 manifest_version');
  if (!SUPPORTED_MANIFEST_VERSIONS.has(version)) {
    throw invalid(`不支持的 manifest_version：${version}（支持 0.1 / 0.2 / 0.3）`);
  }
  for (const key of Object.keys(manifest.user_config ?? {})) {
    if (!CONFIG_KEY_PATTERN.test(key)) {
      throw invalid(
        `user_config 键名不合法：${JSON.stringify(key)}（只允许字母、数字、下划线与连字符）`,
      );
    }
  }
  const type = manifest.server.type;
  if (
    manifest.server.mcp_config === undefined &&
    type !== 'uv' &&
    (MCPB_SERVER_TYPES as readonly string[]).includes(type)
  ) {
    throw invalid('manifest.json 缺少 server.mcp_config');
  }
  // The executable must not depend on user input (a user-chosen value would pick what runs).
  const config = manifest.server.mcp_config;
  const commands = [
    config?.command,
    ...Object.values(config?.platform_overrides ?? {}).map((override) => override.command),
  ];
  if (commands.some((command) => command?.includes('${user_config.') === true)) {
    throw invalid('server.mcp_config.command 不能引用 user_config（启动的程序不能由用户输入决定）');
  }
  // Every ${user_config.X} must be declared; other variables must be known.
  const known = new Set(Object.keys(manifest.user_config ?? {}));
  for (const template of launchTemplates(manifest)) {
    for (const variable of variablesIn(template)) {
      if (variable.startsWith('user_config.')) {
        const key = variable.slice('user_config.'.length);
        if (!known.has(key)) throw invalid(`启动配置引用了未声明的 user_config.${key}`);
      } else if (!BUILTIN_VARIABLES.has(variable)) {
        throw invalid(`启动配置里有不认识的变量：\${${variable}}`);
      }
    }
  }
  return manifest;
}

export function manifestDisplayName(manifest: McpbManifest): string {
  return manifest.display_name ?? manifest.name;
}

export function manifestFields(manifest: McpbManifest): McpbUserConfigField[] {
  return Object.entries(manifest.user_config ?? {}).map(([key, field]) => ({
    key,
    type: field.type,
    title: field.title,
    description: field.description ?? '',
    required: field.required === true,
    sensitive: field.sensitive === true,
    multiple: field.multiple === true,
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  }));
}

// --- compatibility ---------------------------------------------------------

export interface CompatibilityContext {
  platform: string;
  arch?: string;
  /** Versions of the runtimes that are available; an absent entry is not a mismatch here. */
  runtimes?: { node?: string | undefined; python?: string | undefined };
}

export type CompatibilityResult = { ok: true } | { ok: false; reason: string };

export function checkCompatibility(
  manifest: McpbManifest,
  context: CompatibilityContext,
): CompatibilityResult {
  const type = manifest.server.type;
  if (!(MCPB_SERVER_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      reason: `不支持的 server.type：${type}（支持 ${MCPB_SERVER_TYPES.join(' / ')}）`,
    };
  }
  const platforms = manifest.compatibility?.platforms;
  if (platforms !== undefined && platforms.length > 0 && !platforms.includes(context.platform)) {
    return {
      ok: false,
      reason: `此包只支持 ${platforms.join(' / ')}，当前系统是 ${context.platform}`,
    };
  }
  const runtimes = manifest.compatibility?.runtimes;
  for (const runtime of ['node', 'python'] as const) {
    const range = runtimes?.[runtime];
    const have = context.runtimes?.[runtime];
    if (range !== undefined && have !== undefined && !satisfiesRange(have, range)) {
      return {
        ok: false,
        reason: `此包需要 ${runtime} ${range}，环境里的版本是 ${have}`,
      };
    }
  }
  return { ok: true };
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Tiny semver range check: space-separated comparators (>=, >, <=, <, =, ^, ~, bare). */
export function satisfiesRange(version: string, range: string): boolean {
  const have = parseVersion(version);
  if (have === null) return true; // unparsable runtime version: do not block
  for (const clause of range.split(/\s+/).filter((part) => part.length > 0)) {
    const match = /^(>=|<=|>|<|=|\^|~)?v?(.+)$/.exec(clause);
    const want = match === null ? null : parseVersion(match[2]!);
    if (match === null || want === null) continue; // unknown clause shape: ignore
    const cmp = compareVersions(have, want);
    switch (match[1]) {
      case '>=':
        if (cmp < 0) return false;
        break;
      case '>':
        if (cmp <= 0) return false;
        break;
      case '<=':
        if (cmp > 0) return false;
        break;
      case '<':
        if (cmp >= 0) return false;
        break;
      case '^':
        if (cmp < 0 || have[0] !== want[0]) return false;
        break;
      case '~':
        if (cmp < 0 || have[0] !== want[0] || have[1] !== want[1]) return false;
        break;
      default:
        if (cmp !== 0 && match[1] === '=') return false;
        if (match[1] === undefined && cmp < 0) return false;
    }
  }
  return true;
}

// --- user_config -----------------------------------------------------------

export type McpbConfigValues = Record<string, McpbUserConfigValue>;

/** Validates user input against the declared fields; returns the normalized values. */
export function validateUserConfig(
  fields: readonly McpbUserConfigField[],
  input: Record<string, McpbUserConfigValue>,
): McpbConfigValues {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) throw invalid(`未声明的配置项：${key}`);
  }
  const values: McpbConfigValues = {};
  for (const field of fields) {
    const raw = input[field.key] ?? field.default;
    const empty = raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (field.required) throw invalid(`请填写必填配置项：${field.title}`);
      continue;
    }
    const label = field.title;
    const list = field.multiple ? (Array.isArray(raw) ? raw : [String(raw)]) : null;
    if (!field.multiple && Array.isArray(raw)) throw invalid(`${label} 只接受单个值`);
    const items: unknown[] = list ?? [raw];
    for (const item of items) checkScalar(field, label, item);
    if (field.multiple) {
      values[field.key] = (list as unknown[]).map((item) => String(item));
    } else if (field.type === 'number') {
      values[field.key] = Number(raw);
    } else if (field.type === 'boolean') {
      values[field.key] = raw === true || raw === 'true';
    } else {
      values[field.key] = String(raw);
    }
  }
  return values;
}

function checkScalar(field: McpbUserConfigField, label: string, item: unknown): void {
  switch (field.type) {
    case 'number': {
      const number = typeof item === 'number' ? item : Number(item);
      if (typeof item === 'boolean' || !Number.isFinite(number)) {
        throw invalid(`${label} 需要是数字`);
      }
      if (field.min !== undefined && number < field.min)
        throw invalid(`${label} 不能小于 ${field.min}`);
      if (field.max !== undefined && number > field.max)
        throw invalid(`${label} 不能大于 ${field.max}`);
      return;
    }
    case 'boolean':
      if (typeof item !== 'boolean' && item !== 'true' && item !== 'false') {
        throw invalid(`${label} 需要是 true / false`);
      }
      return;
    case 'directory':
    case 'file':
      if (typeof item !== 'string' || !path.isAbsolute(item)) {
        throw invalid(`${label} 需要填写绝对路径`);
      }
      return;
    default:
      if (typeof item !== 'string') throw invalid(`${label} 需要是文本`);
  }
}

// --- launch template -------------------------------------------------------

const BUILTIN_VARIABLES = new Set([
  '__dirname',
  'HOME',
  'DESKTOP',
  'DOCUMENTS',
  'DOWNLOADS',
  'pathSeparator',
  '/',
]);
const VARIABLE_PATTERN = /\$\{([^}]*)\}/g;

function variablesIn(template: string): string[] {
  return [...template.matchAll(VARIABLE_PATTERN)].map((match) => match[1]!);
}

/** Every launch string in the manifest (incl. platform overrides) — for static validation. */
function launchTemplates(manifest: McpbManifest): string[] {
  const config = manifest.server.mcp_config;
  if (config === undefined) return [];
  const result: string[] = [];
  const collect = (part: z.infer<typeof launchOverrideSchema>) => {
    if (part.command !== undefined) result.push(part.command);
    result.push(...(part.args ?? []), ...Object.values(part.env ?? {}));
  };
  collect(config);
  for (const override of Object.values(config.platform_overrides ?? {})) collect(override);
  return result;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LaunchOptions {
  /** Directory the bundle is (to be) extracted into: `${__dirname}`. */
  dir: string;
  home: string;
  platform: string;
  /**
   * `preview`: `${user_config.*}` stays literal (the user has not filled the form yet).
   * `install`: values are substituted; sensitive fields become `secret:env:{KEY}` placeholders
   * (whole-value only) so the secret never enters settings JSON.
   */
  mode: 'preview' | 'install';
  values?: McpbConfigValues;
  /** Replaces `mcp_config.command` once the runtime is resolved (managed node, ...). */
  commandOverride?: string | undefined;
}

export function renderLaunch(manifest: McpbManifest, options: LaunchOptions): LaunchSpec {
  const base = manifest.server.mcp_config;
  let command: string;
  let args: string[];
  let env: Record<string, string>;
  if (base === undefined) {
    // `uv` bundles may omit mcp_config: uv runs the entry point inside the bundle directory.
    command = 'uv';
    args = ['run', '--directory', '${__dirname}', manifest.server.entry_point];
    env = {};
  } else {
    const override = base.platform_overrides?.[options.platform];
    command = override?.command ?? base.command;
    args = override?.args ?? base.args ?? [];
    env = { ...(base.env ?? {}), ...(override?.env ?? {}) };
  }
  const fields = new Map(manifestFields(manifest).map((field) => [field.key, field]));
  const home = options.home;
  const builtin = (name: string): string | null => {
    switch (name) {
      case '__dirname':
        return options.dir;
      case 'HOME':
        return home;
      case 'DESKTOP':
        return path.join(home, 'Desktop');
      case 'DOCUMENTS':
        return path.join(home, 'Documents');
      case 'DOWNLOADS':
        return path.join(home, 'Downloads');
      case 'pathSeparator':
      case '/':
        return options.platform === 'win32' ? '\\' : '/';
      default:
        return null;
    }
  };

  /** One template string → string, or null when it is a lone unset optional value. */
  const expand = (template: string, location: string): string | string[] | null => {
    const whole = /^\$\{user_config\.([^}]+)\}$/.exec(template);
    if (whole !== null && options.mode === 'install') {
      const key = whole[1]!;
      const field = fields.get(key)!;
      const value = options.values?.[key];
      if (value === undefined) return null;
      if (field.sensitive) return `secret:env:${key}`;
      return Array.isArray(value) ? value : stringifyValue(value);
    }
    return template.replace(VARIABLE_PATTERN, (match, name: string) => {
      if (name.startsWith('user_config.')) {
        if (options.mode === 'preview') return match;
        const key = name.slice('user_config.'.length);
        const field = fields.get(key)!;
        if (field.sensitive) {
          throw invalid(
            `敏感配置项 ${key} 只能整体作为 ${location} 的值使用，不能拼在其它文字里（密钥无法安全内联）`,
          );
        }
        const value = options.values?.[key];
        if (value === undefined) return '';
        return Array.isArray(value) ? value.join(',') : stringifyValue(value);
      }
      return builtin(name) ?? match;
    });
  };
  const expandBuiltinOnly = (template: string): string =>
    template.replace(VARIABLE_PATTERN, (match, name: string) =>
      name.startsWith('user_config.') ? match : (builtin(name) ?? match),
    );

  const outArgs: string[] = [];
  for (const arg of args) {
    if (options.mode === 'preview') {
      outArgs.push(expandBuiltinOnly(arg));
      continue;
    }
    const expanded = expand(arg, '参数');
    if (expanded === null) continue;
    if (Array.isArray(expanded)) outArgs.push(...expanded);
    else outArgs.push(expanded);
  }
  const outEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (options.mode === 'preview') {
      outEnv[key] = expandBuiltinOnly(value);
      continue;
    }
    const expanded = expand(value, '环境变量');
    if (expanded === null) continue;
    outEnv[key] = Array.isArray(expanded) ? expanded.join(',') : expanded;
  }
  const outCommand = expandBuiltinOnly(options.commandOverride ?? command);
  return { command: outCommand, args: outArgs, env: outEnv };
}

function stringifyValue(value: string | number | boolean): string {
  return String(value);
}

/** Human-readable one-line command (env assignments first); quoting is for display only. */
export function formatLaunch(
  spec: LaunchSpec,
  sensitiveKeys: ReadonlySet<string> = new Set(),
): string {
  const quote = (text: string): string =>
    /^[A-Za-z0-9_@%+=:,./\\${}-]+$/.test(text) ? text : JSON.stringify(text);
  const envPart = Object.entries(spec.env).map(([key, value]) => {
    const secret = value.startsWith('secret:env:') && sensitiveKeys.has(value.slice(11));
    return `${key}=${secret ? '***' : quote(value)}`;
  });
  const argPart = spec.args.map((arg) =>
    arg.startsWith('secret:env:') && sensitiveKeys.has(arg.slice(11)) ? '***' : quote(arg),
  );
  return [...envPart, quote(spec.command), ...argPart].join(' ');
}

export function manifestAuthor(manifest: McpbManifest): string {
  return manifest.author?.name ?? '';
}
export { PLATFORMS as MCPB_PLATFORMS };
