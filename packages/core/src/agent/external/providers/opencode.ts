import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import type { AgentProvider, ConfigCheckContext, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * OpenCode 2.4.2 (`opencode acp`): host-controlled permissions and config isolation.
 * V2 normalizes V1 `permission` / `agent` / `mode` fields into ordered `permissions`
 * arrays; layers append and evaluation is last-match-wins. We emit native V2 rules and
 * retain the V1 fields (and legacy environment switches) for compatibility only.
 *
 * - `OPENCODE_CONFIG_CONTENT` is the enforced layer: unknown actions ask, writes,
 *   shell, external paths, subagents and network access ask, Code Mode and OpenCode
 *   session/worktree/automation tools deny, and plan/explore deny edits. The same
 *   rules are repeated per built-in agent because agent rules append after global rules.
 * - Both project-config disable variables are set because V2 prefers
 *   `OPENCODE_CONFIG_PROJECT_DISABLE`. File watching is disabled so a live edit cannot
 *   reload unscanned configuration. AGENTS.md is supplied by the host instead.
 * - V2 ignores `OPENCODE_PERMISSION` / `OPENCODE_PURE`. Plugins are disabled with a
 *   `plugin.use` deny policy; user policies, auto-discovered plugin directories and
 *   configured external plugins are scanned fail-closed before launch/session reuse.
 * - User-writable config roots (`~/.opencode`, the active global config root,
 *   and `configHome/project/**`) are scanned for V1 and V2 permission
 *   allows, plugin code/policies and dangerous experimental flags. Managed system
 *   config and remote Console/well-known documents remain outside the scan and load
 *   with higher authority. User-configured local MCP/formatter/LSP commands remain
 *   an accepted residual: they can spawn processes outside the host permission bridge.
 * - Config/home/data redirects from the catalog or launch target are reserved. HOME is
 *   otherwise retained so git and other child commands keep the user's identity.
 * - ACP 2.4.2 supplies structured `tool_call.name` and supports steering. Login accepts
 *   both standard `type:'terminal', args:['--login']` and legacy `_meta` terminal auth.
 * - read_only maps to plan; ask/workspace map to build. Only once/reject permission
 *   replies are selected. Host prompts must stay slash-safe: command templates can run
 *   shell snippets without a permission request.
 */

export function opencodeModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'build';
}

export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'ask' | 'deny';
}

const permissionRule = (
  action: string,
  effect: OpencodePermissionRule['effect'],
): OpencodePermissionRule => ({ action, resource: '*', effect });

/**
 * Native V2 rules. The broad ask comes first so unnamed and future actions ask;
 * read-only actions are the only unconditional allows. `external_directory` is
 * checked before read/edit, so allowing read does not grant external path access.
 */
export function opencodePermissionConfig(): OpencodePermissionRule[] {
  return [
    permissionRule('*', 'ask'),
    ...['read', 'list', 'glob', 'grep', 'lsp', 'todoread', 'todowrite'].map((action) =>
      permissionRule(action, 'allow'),
    ),
    permissionRule('question', 'deny'),
    permissionRule('plan_enter', 'deny'),
    permissionRule('plan_exit', 'deny'),
    ...[
      'edit',
      'shell',
      'external_directory',
      'subagent',
      'webfetch',
      'websearch',
      'codesearch',
    ].map((action) => permissionRule(action, 'ask')),
    permissionRule('execute', 'deny'),
    permissionRule('opencode_session_*', 'deny'),
    permissionRule('opencode_worktree_*', 'deny'),
    permissionRule('automation_*', 'deny'),
  ];
}

/** V1 compatibility: native V2 `agents` wins during V2 normalization. */
function legacyPermissionConfig(rules: readonly OpencodePermissionRule[]): Record<string, string> {
  const v1Action: Record<string, string> = { shell: 'bash', subagent: 'task' };
  return Object.fromEntries(
    rules.map((rule) => [v1Action[rule.action] ?? rule.action, rule.effect]),
  );
}

/** Built-in agent rules (plan / explore stay read-only: `edit: deny`). */
function agentPermission(name: string): OpencodePermissionRule[] {
  const base = opencodePermissionConfig();
  if (name === 'plan') return [...base, permissionRule('edit', 'deny')];
  if (name === 'explore') {
    return [...base, permissionRule('edit', 'deny'), permissionRule('subagent', 'deny')];
  }
  return name === 'general' ? [...base, permissionRule('subagent', 'deny')] : base;
}

const OPENCODE_BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore'] as const;
const OPENCODE_PRIMARY_MODES = ['build', 'plan'] as const;
/** Every boolean experimental flag in the 2.4.2 schema is forced off. */
const OPENCODE_DANGEROUS_FLAGS = [
  'portable_shell_scanner',
  'codemode_vm',
  'todo',
  'media_blob',
  'artifacts',
  'console_watches',
  'recommended_api',
  'model_speeds',
  'full_codemode',
  'codemode_agents',
  'machines',
  'home_memory',
  'project_overlay',
  'opencode_api',
  'mcp_skills',
  'compaction_jobs',
  'sqlite_fts',
  'browser_stream_tunnel',
  'video_generate',
  'part_rows',
  'image_generate',
  'disable_paste_summary',
  'batch_tool',
  'openTelemetry',
  'continue_loop_on_deny',
] as const;

/** `OPENCODE_CONFIG_CONTENT`: process-wide only; never carries a persona. */
export function opencodeProcessConfig(): Record<string, unknown> {
  const top = opencodePermissionConfig();
  return {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    autoupdate: false,
    share: 'disabled',
    automations: false,
    permissions: top,
    permission: legacyPermissionConfig(top),
    policies: [{ action: 'plugin.use', resource: '*', effect: 'deny' }],
    experimental: {
      all_flags: false,
      ...Object.fromEntries(OPENCODE_DANGEROUS_FLAGS.map((flag) => [flag, false])),
    },
    agent: Object.fromEntries(
      OPENCODE_BUILTIN_AGENTS.map((name) => [
        name,
        { permission: legacyPermissionConfig(agentPermission(name)) },
      ]),
    ),
    agents: Object.fromEntries(
      // V2 schema: agents.<id> accepts `permissions`, not V1 `permission`.
      OPENCODE_BUILTIN_AGENTS.map((name) => [name, { permissions: agentPermission(name) }]),
    ),
    mode: Object.fromEntries(
      OPENCODE_PRIMARY_MODES.map((name) => {
        const rules = agentPermission(name);
        return [name, { permissions: rules, permission: legacyPermissionConfig(rules) }];
      }),
    ),
  };
}

/** Permissions the host lets OpenCode run without asking (our block allows them too). */
const OPENCODE_READ_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  'read',
  'list',
  'glob',
  'grep',
  'lsp',
  'todoread',
  'todowrite',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys of one V1 `permission` value that allow something only the host may
 * decide. A key is safe only when it names a read-only permission exactly —
 * wildcard keys ("*", "b*", "**") may match shell / edit / subagent. Any action
 * other than exactly `ask` / `deny` counts as allowing.
 */
function permissionAllows(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return isAskOrDeny(value) ? [] : ['permission'];
  if (!isPlainObject(value)) return ['permission'];
  const keys: string[] = [];
  for (const [name, action] of Object.entries(value)) {
    const allows = isPlainObject(action)
      ? Object.values(action).some((inner) => !isAskOrDeny(inner))
      : !isAskOrDeny(action);
    if (allows && !OPENCODE_READ_ONLY_PERMISSIONS.has(name)) keys.push(`permission.${name}`);
  }
  return keys;
}

/** Native V2 rules are arrays; only an exact read-only action may allow. */
function permissionsAllows(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return ['permissions'];
  const keys: string[] = [];
  value.forEach((rule, index) => {
    const at = `permissions.${index}`;
    if (!isPlainObject(rule)) {
      keys.push(at);
      return;
    }
    const { action, resource, effect } = rule;
    if (
      typeof action !== 'string' ||
      typeof resource !== 'string' ||
      (effect !== 'allow' && !isAskOrDeny(effect))
    ) {
      keys.push(at);
      return;
    }
    if (effect === 'allow' && !OPENCODE_READ_ONLY_PERMISSIONS.has(action))
      keys.push(`${at}.action`);
  });
  return keys;
}

function isAskOrDeny(action: unknown): boolean {
  return action === 'ask' || action === 'deny';
}

/** `tools: {name: true}` turns into an allow rule (write / patch → edit). */
function toolsAllow(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) return ['tools'];
  return Object.entries(value)
    .filter(([name, enabled]) => enabled !== false && !OPENCODE_READ_ONLY_PERMISSIONS.has(name))
    .map(([name]) => `tools.${name}`);
}

/** One agent's own settings (`agent.*` / `agents.*` / markdown frontmatter). */
function agentAllows(agent: Record<string, unknown>): string[] {
  return [
    ...permissionAllows(agent.permission),
    ...permissionsAllows(agent.permissions),
    ...toolsAllow(agent.tools),
  ];
}

/** Any configured plugin addition can execute code outside the host sandbox. */
function pluginEntriesAllows(value: unknown, key: 'plugin' | 'plugins'): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [key];
  const keys: string[] = [];
  value.forEach((entry, index) => {
    const at = `${key}.${index}`;
    if (typeof entry === 'string') {
      if (entry.length > 1 && entry.startsWith('-')) return;
      keys.push(at);
      return;
    }
    if (key === 'plugin' && Array.isArray(entry) && typeof entry[0] === 'string') {
      keys.push(at);
      return;
    }
    if (key === 'plugins' && isPlainObject(entry) && typeof entry.package === 'string') {
      keys.push(at);
      return;
    }
    keys.push(at);
  });
  return keys;
}

/** User plugin allows outrank our CONTENT deny because policy layers evaluate in reverse. */
function pluginPolicyAllows(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [key];
  const keys: string[] = [];
  value.forEach((policy, index) => {
    if (!isPlainObject(policy) || policy.effect !== 'allow') return;
    const native = policy.action === 'plugin.use';
    const legacy =
      policy.action === 'integration.use' &&
      typeof policy.resource === 'string' &&
      policy.resource.startsWith('plugin:');
    if (native || legacy) keys.push(`${key}.${index}`);
  });
  return keys;
}

const OPENCODE_UNSAFE_EXPERIMENTAL_FLAGS = new Set<string>([
  'all_flags',
  ...OPENCODE_DANGEROUS_FLAGS,
]);

function experimentalAllows(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!isPlainObject(value)) return ['experimental'];
  const keys = pluginPolicyAllows(value.policies, 'experimental.policies');
  for (const [flag, enabled] of Object.entries(value)) {
    if (OPENCODE_UNSAFE_EXPERIMENTAL_FLAGS.has(flag) && enabled !== false) {
      keys.push(`experimental.${flag}`);
    }
  }
  return keys;
}

/** Allowing keys of a parsed opencode.json(c): V1 + V2 permissions, agents and plugins. */
function configAllows(config: unknown): string[] {
  if (!isPlainObject(config)) return ['（不是 JSON 对象）'];
  const keys = [
    ...agentAllows(config),
    ...pluginEntriesAllows(config.plugin, 'plugin'),
    ...pluginEntriesAllows(config.plugins, 'plugins'),
    ...pluginPolicyAllows(config.policies, 'policies'),
    ...experimentalAllows(config.experimental),
  ];
  for (const section of ['agent', 'agents', 'mode'] as const) {
    const entries = config[section];
    if (entries === undefined || entries === null) continue;
    if (!isPlainObject(entries)) {
      keys.push(section);
      continue;
    }
    for (const [name, agent] of Object.entries(entries)) {
      if (!isPlainObject(agent)) continue;
      for (const key of agentAllows(agent)) keys.push(`${section}.${name}.${key}`);
    }
  }
  return keys;
}

/**
 * `{file:…}` / `{env:…}` are substituted into the raw config text before it
 * is parsed: what they expand to cannot be checked here.
 */
const SUBSTITUTION = /\{(?:file|env):/;

/** Characters that end a jsonc-parser literal / number / unknown token. */
const JSONC_SEPARATORS = ' \t\n\r{}[]:,"/';

/**
 * JSONC → JSON the way jsonc-parser 3.3.1 tokenizes it (bundled in OpenCode
 * 2.4.2; any parse error rejects the document, so its scanner is mirrored):
 * whitespace is only space / tab, line breaks `\n` / `\r` (a `//` comment
 * ends at either — a comment ended only at `\n` would hide keys after a lone
 * `\r`), `/* … *\/` comments, a trailing comma before `}` / `]`. Every other
 * character stays in its token (NBSP / BOM are not whitespace there: invalid
 * for both parsers) and the tokens are joined with spaces, so JSON.parse sees
 * jsonc-parser's token stream: wherever jsonc-parser reports no error, the
 * two read the same value (`__proto__` aside — see `hasProtoKey`). Null = an
 * unterminated comment / string.
 */
function jsoncToJson(text: string): string | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
    } else if (char === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\n' || text[j] === '\r') return null;
        j += text[j] === '\\' ? 2 : 1;
      }
      if (j >= text.length) return null;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
    } else if ('{}[]:,'.includes(char)) {
      tokens.push(char);
      i += 1;
    } else {
      let j = i + 1;
      while (j < text.length && !JSONC_SEPARATORS.includes(text[j]!)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
    }
  }
  return tokens
    .filter((token, k) => token !== ',' || (tokens[k + 1] !== '}' && tokens[k + 1] !== ']'))
    .join(' ');
}

/**
 * jsonc-parser assigns `__proto__` (setting the object's prototype, so the
 * keys under it are inherited) where JSON.parse makes an own key: such a
 * config cannot be checked.
 */
function hasProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProtoKey);
  if (!isPlainObject(value)) return false;
  return Object.hasOwn(value, '__proto__') || Object.values(value).some(hasProtoKey);
}

/** Allowing keys of an opencode.json(c) text (unparsable / substitutions → refused). */
function jsonConfigAllows(text: string): string[] {
  if (SUBSTITUTION.test(text)) return ['含 {file:…} / {env:…} 替换（无法检查）'];
  // OpenCode reads the file with TextDecoder: one leading BOM is dropped and
  // an empty file is an empty config.
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (content === '') return [];
  const json = jsoncToJson(content);
  if (json === null) return ['无法解析'];
  let config: unknown;
  try {
    config = JSON.parse(json);
  } catch {
    return ['无法解析'];
  }
  if (hasProtoKey(config)) return ['含 __proto__ 键（无法检查）'];
  return configAllows(config);
}

/** OpenCode 2.4.2 `ConfigMarkdown.sanitize`, used after the first YAML parse fails. */
function sanitizeFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return text;
  const frontmatter = match[1]!;
  let flow: FlowState | undefined;
  const lines = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (flow) {
      flow = scanFlow(line, flow).state;
      return [line];
    }
    if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (entry === null) return [line];
    const value = entry[2]!.trim();
    if (value === '' || value.startsWith('"') || value.startsWith("'")) return [line];
    if (value.startsWith('[') || value.startsWith('{')) {
      const scanned = scanFlow(value, { stack: [], quote: undefined });
      if (scanned.status === 'open') flow = scanned.state;
      if (scanned.status !== 'trailing') return [line];
      return [`${entry[1]}: |-`, `  ${value}`];
    }
    if (!value.includes(':') || isValidYaml(line)) return [line];
    return [`${entry[1]}: |-`, `  ${value}`];
  });
  return text.replace(frontmatter, () => lines.join('\n'));
}

function isValidYaml(line: string): boolean {
  try {
    loadYaml(line);
    return true;
  } catch {
    return false;
  }
}

interface FlowState {
  stack: string[];
  quote: string | undefined;
}

function scanFlow(
  text: string,
  state: FlowState,
): { status: 'open' | 'invalid' | 'closed' | 'trailing'; state?: FlowState } {
  const stack = [...state.stack];
  let quote = state.quote;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === '"') {
      if (char === '\\') i += 1;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") i += 1;
      else if (char === "'") quote = undefined;
      continue;
    }
    if ((char === '"' || char === "'") && (i === 0 || /[\s[{,:]/.test(text[i - 1]!))) {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(text[i - 1]!))) break;
    if (char === '[') stack.push(']');
    else if (char === '{') stack.push('}');
    else if (char === ']' || char === '}') {
      if (stack.at(-1) !== char) return { status: 'invalid' };
      stack.pop();
      if (stack.length === 0) {
        const rest = text.slice(i + 1).trim();
        if (rest === '' || rest.startsWith('#')) return { status: 'closed' };
        return { status: 'trailing' };
      }
    }
  }
  return { status: 'open', state: { stack, quote } };
}

/**
 * gray-matter 4.0.3 (as bundled in opencode 2.4.2): BOM stripped; frontmatter
 * only when the text starts with `---` not followed by a fourth `-`; the
 * rest of the opening line names the language (yaml when empty — `js` /
 * `javascript` would be eval'ed, `json`, `coffee` … other engines); the
 * matter runs to the next `\n---`. Null = no frontmatter.
 */
function grayMatterBlock(text: string): { language: string; matter: string } | null {
  const content = text.charAt(0) === '\uFEFF' ? text.slice(1) : text;
  if (!content.startsWith('---') || content.charAt(3) === '-') return null;
  let rest = content.slice(3);
  const languageRaw = rest.slice(0, rest.search(/\r?\n/));
  const language = languageRaw.trim();
  if (language.length > 0) rest = rest.slice(languageRaw.length);
  const close = rest.indexOf('\n---');
  return { language, matter: close < 0 ? rest : rest.slice(0, close) };
}

/** Allowing keys of one markdown text's frontmatter as gray-matter + js-yaml parse it. */
function frontmatterTextAllows(text: string): string[] {
  const block = grayMatterBlock(text);
  if (block === null) return [];
  if (block.language !== '' && block.language.toLowerCase() !== 'yaml') {
    return [`frontmatter 语言「${block.language}」（只接受 YAML）`];
  }
  if (SUBSTITUTION.test(block.matter)) return ['frontmatter 含 {file:…} / {env:…}'];
  // Comment-only matter is empty for gray-matter.
  if (block.matter.replace(/^\s*#[^\n]+/gm, '').trim() === '') return [];
  let data: unknown;
  try {
    data = loadYaml(block.matter);
  } catch {
    return ['frontmatter 无法解析'];
  }
  if (data === null || data === undefined) return [];
  if (!isPlainObject(data)) return ['frontmatter 不是键值映射'];
  return agentAllows(data).map((key) => `frontmatter ${key}`);
}

/**
 * Agent / mode markdown: gray-matter + YAML, checked like an `agents.<name>`
 * entry (`permission`, `permissions`, `tools`; prose elsewhere is irrelevant).
 * OpenCode retries sanitized text after a parse failure, so both readings are
 * checked and neither parsing successfully fails closed.
 */
function frontmatterAllows(text: string): string[] {
  const raw = frontmatterTextAllows(text);
  const sanitizedText = sanitizeFrontmatter(text);
  if (sanitizedText === text) return raw;
  const sanitized = frontmatterTextAllows(sanitizedText);
  const unparsable = (keys: string[]) => keys.includes('frontmatter 无法解析');
  if (unparsable(raw) && !unparsable(sanitized)) return sanitized;
  return [...new Set([...raw, ...(unparsable(sanitized) ? [] : sanitized)])];
}

function existingFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Missing directories are empty; any other listing error is an incomplete scan. */
function listDir(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? [] : null;
  }
}

/** Walk bounds: beyond them the scan is incomplete and fails closed. */
const MARKDOWN_SCAN_MAX_DEPTH = 8;
const MARKDOWN_SCAN_MAX_FILES = 2_000;

/**
 * Markdown files under `dir` (recursive when `deep`; `.md` in any case).
 * Symlinks are followed once (real paths visited at most once); `truncated`
 * = the depth or file cap was hit.
 */
function markdownFiles(
  dir: string,
  deep: boolean,
): { files: string[]; truncated: boolean; unreadable: boolean } {
  const files: string[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let unreadable = false;
  const walk = (current: string, depth: number) => {
    let real: string;
    try {
      real = realpathSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable = true;
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    const names = listDir(current);
    if (names === null) {
      unreadable = true;
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const full = path.join(current, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        unreadable = true;
        continue;
      }
      if (stat.isDirectory()) {
        if (!deep) continue;
        if (depth >= MARKDOWN_SCAN_MAX_DEPTH) {
          truncated = true;
          return;
        }
        walk(full, depth + 1);
      } else if (name.toLowerCase().endsWith('.md')) {
        if (files.length >= MARKDOWN_SCAN_MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(full);
      }
    }
  };
  walk(dir, 0);
  return { files, truncated, unreadable };
}

function scanConfigRoot(
  dir: string,
  names: readonly string[],
  issues: string[],
  visited: Set<string>,
  scanSubdirs = true,
): void {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Missing roots have no files; unreadable files are reported below.
  }
  if (visited.has(real)) return;
  visited.add(real);
  for (const name of names) {
    const file = path.join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      issues.push(`${file}: 无法读取`);
      continue;
    }
    for (const key of jsonConfigAllows(text)) issues.push(`${file}: ${key}`);
  }
  // Plain project directories only carry `opencode.json(c)`; agent / plugin /
  // tool discovery is rooted at `.opencode`, handled by the caller.
  if (!scanSubdirs) return;
  for (const [sub, deep] of [
    ['agent', true],
    ['agents', true],
    ['mode', false],
    ['modes', false],
  ] as const) {
    const root = path.join(dir, sub);
    const { files, truncated, unreadable } = markdownFiles(root, deep);
    if (unreadable) issues.push(`${root}: 无法读取目录`);
    if (truncated) {
      issues.push(
        `${root}: 目录过深（>${MARKDOWN_SCAN_MAX_DEPTH} 层）或文件过多（>${MARKDOWN_SCAN_MAX_FILES}），无法完整检查`,
      );
    }
    for (const file of files) {
      let keys: string[];
      try {
        keys = frontmatterAllows(readFileSync(file, 'utf8'));
      } catch {
        keys = ['无法读取'];
      }
      for (const key of keys) issues.push(`${file}: ${key}`);
    }
  }
  // V1 custom tools are imported and run without a permission request.
  for (const sub of ['tool', 'tools']) {
    const root = path.join(dir, sub);
    const names = listDir(root);
    if (names === null) {
      issues.push(`${root}: 无法读取目录`);
      continue;
    }
    for (const name of names) {
      if (/\.(js|ts|mjs|cjs|mts|cts)$/i.test(name)) {
        issues.push(`${path.join(root, name)}: 自定义工具（不经权限确认执行）`);
      }
    }
  }
  // V2 discovers direct .ts/.js files and immediate package directories.
  for (const sub of ['plugin', 'plugins']) {
    const root = path.join(dir, sub);
    const names = listDir(root);
    if (names === null) {
      issues.push(`${root}: 无法读取目录`);
      continue;
    }
    for (const name of names) {
      const file = path.join(root, name);
      try {
        const stat = statSync(file);
        if (stat.isDirectory() || (stat.isFile() && /\.(js|ts)$/i.test(name))) {
          issues.push(`${file}: 自动发现插件（不经权限确认执行）`);
        }
      } catch {
        issues.push(`${file}: 无法检查插件目录项`);
      }
    }
  }
}

/**
 * User-writable V2.4.2 config layers that could bypass host decisions. Returns
 * "file: key" findings; empty = safe to launch. `configHome` is the active
 * `$XDG_CONFIG_HOME/opencode` root (private unless user config is enabled).
 */
export function opencodeUserConfigIssues(input: { home: string; configHome: string }): string[] {
  const issues: string[] = [];
  const visited = new Set<string>();
  const dotDir = path.join(input.home, '.opencode');
  scanConfigRoot(dotDir, ['opencode.json', 'opencode.jsonc'], issues, visited);
  scanConfigRoot(
    input.configHome,
    ['config.json', 'opencode.json', 'opencode.jsonc'],
    issues,
    visited,
  );
  // Legacy TOML global config: not checked here — refused if present.
  const legacy = path.join(input.configHome, 'config');
  if (existingFile(legacy)) issues.push(`${legacy}: 旧版 TOML 配置（无法检查）`);
  // project_overlay is forced off, but scan its would-be layers fail-closed.
  const projectRoot = path.join(input.configHome, 'project');
  const projects = listDir(projectRoot);
  if (projects === null) {
    issues.push(`${projectRoot}: 无法读取目录`);
  } else {
    for (const name of projects) {
      const dir = path.join(projectRoot, name);
      try {
        if (statSync(dir).isDirectory()) {
          scanConfigRoot(dir, ['opencode.json', 'opencode.jsonc'], issues, visited);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR')
          issues.push(`${dir}: 无法读取项目 overlay 目录`);
      }
    }
  }
  return issues;
}

/** 未开启「加载我的个人配置」时的私有全局配置根（`XDG_CONFIG_HOME`）。 */
export function opencodeConfigHome(stateDir: string): string {
  return path.join(stateDir, 'xdg-config');
}

function gitRootAbove(start: string): string | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Project layers are disabled by env, but scan them too as defence in depth. */
function scanProjectConfig(cwd: string, issues: string[], visited: Set<string>): void {
  const root = gitRootAbove(cwd) ?? path.resolve(cwd);
  const relative = path.relative(root, cwd);
  const parts = relative === '' ? [] : relative.split(path.sep);
  const dirs = [root, ...parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)))];
  for (const dir of dirs) {
    scanConfigRoot(dir, ['opencode.json', 'opencode.jsonc'], issues, visited, false);
    // Project config also lives in `<dir>/.opencode` (config, agents, plugins,
    // tools) and is read alongside the root files.
    scanConfigRoot(
      path.join(dir, '.opencode'),
      ['opencode.json', 'opencode.jsonc'],
      issues,
      visited,
    );
  }
}

/**
 * Fail closed: custom agents and higher-authority layers can append after our
 * rules. Run before the process starts and every session open/reuse; control
 * processes (probe / login / logout) do not execute tools and skip the scan.
 */
function checkOpencodeConfig({ stateDir, loadUserConfig, cwd }: ConfigCheckContext): void {
  if (loadUserConfig !== true && stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'OpenCode 缺少私有状态目录，无法隔离个人配置');
  }
  const home = os.homedir();
  const configHome =
    loadUserConfig === true
      ? path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
      : path.join(opencodeConfigHome(stateDir!), 'opencode');
  const issues = opencodeUserConfigIssues({ home, configHome });
  if (cwd !== undefined) {
    scanProjectConfig(cwd, issues, new Set<string>());
  }
  // Paths under the home directory as `~/…` (no user name in the setup card).
  const shownIssues = issues.map((issue) =>
    issue.startsWith(home + path.sep) ? `~${issue.slice(home.length)}` : issue,
  );
  if (shownIssues.length > 0) {
    throw new AppError(
      'AGENT_CONFIG_UNSAFE',
      `OpenCode 的配置放行了需要 KepCup 逐条确认的操作或可执行插件，已拒绝运行。请把下列文件中的这些键改为 ask / deny、关闭危险开关或删除后重试：${shownIssues.slice(0, 8).join('；')}${shownIssues.length > 8 ? ` 等 ${shownIssues.length} 处` : ''}`,
      { issues },
    );
  }
}

/** Catalog/target values that could redirect config, credentials, state or feature flags. */
const OPENCODE_CONFIG_REDIRECT_ENV = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'OPENCODE_DB',
  'OPENCODE_FLAGS',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
];

async function applyOpencodeTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  await switchToMode('OpenCode', opencodeModeForTier(tier), ctx);
}

export const opencodeProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'opencode',
  launch: ({ entry, target, stateDir, loadUserConfig }) => {
    if (loadUserConfig !== true && stateDir === undefined) {
      // Fail closed: without a private config root the user's global config
      // (agent permission overrides) would apply.
      throw new AppError('AGENT_UNAVAILABLE', 'OpenCode 缺少私有状态目录，无法隔离个人配置');
    }
    const enforced: Record<string, string> = {
      ...(loadUserConfig !== true ? { XDG_CONFIG_HOME: opencodeConfigHome(stateDir!) } : {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeProcessConfig()),
      OPENCODE_FLAGS: OPENCODE_DANGEROUS_FLAGS.map((flag) => `-${flag}`).join(','),
      OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_FILEWATCHER_DISABLE: '1',
      OPENCODE_DISABLE_FILEWATCHER: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      // Legacy V1 switches are retained but V2 relies on CONTENT policies/rules.
      OPENCODE_PERMISSION: JSON.stringify(legacyPermissionConfig(opencodePermissionConfig())),
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    // Host-enforced and config-redirect keys never come from the catalog /
    // target — compared case-insensitively (Windows environment names).
    const reserved = new Set(
      [...Object.keys(enforced), ...OPENCODE_CONFIG_REDIRECT_ENV].map((key) => key.toUpperCase()),
    );
    const configured = Object.entries({
      ...(entry.distribution.npx?.env ?? {}),
      ...target.env,
    }).filter(([key]) => !reserved.has(key.toUpperCase()));
    return {
      command: target.command,
      args: [...target.args],
      env: { ...Object.fromEntries(configured), ...enforced },
    };
  },
  checkConfig: checkOpencodeConfig,
  instructionMode: 'prompt-prefix',
  applyPermissionTier: applyOpencodeTier,
  permissionOptions: { allowOnce: ['once'], rejectOnce: ['reject'] },
  toolName: (server, tool) =>
    `${server.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  // 无 OS 沙箱：命令一律逐条确认（宿主看不出的一律当沙箱外）。
  execSandboxed: () => false,
  // OpenCode 2.4.2 ACP keeps a per-session attachment/turn map and the server
  // keeps a runner per session; prompt/cancel state is not process-global.
  features: {
    steering: true,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    parallelSessions: true,
  },
  // Both project-config variables disable workdir opencode.json, .opencode and
  // AGENTS.md; the host injects AGENTS.md through its <workdir> segment instead.
  agentSideConfigFiles: [],
};
