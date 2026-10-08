import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import type { AgentProvider, ConfigCheckContext, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * OpenCode（原生 `opencode acp`，design 28 §9.2）：只覆盖与通用实现的差异。
 * 依据：opencode 1.18.35 二进制内嵌源码（离线核对，未运行）+ 离线 spike（todo
 * 附录 A.4）。
 *
 * - 指令：`prompt-prefix`；
 * - 配置加载顺序（1.18.35 `Config.loadInstanceState`）：全局配置（`$XDG_CONFIG_HOME/
 *   opencode`）→ `OPENCODE_CONFIG` → project 的 opencode.json（从会话目录向上到
 *   git worktree 根）→ 各 `.opencode/` 目录（agent / mode / command / plugin，
 *   并后台往其中安装 `@opencode-ai/plugin`）→ `OPENCODE_CONFIG_CONTENT`（最后的
 *   local 合并）→ 托管配置 → `mode.*` 并入 `agent.*` → `OPENCODE_PERMISSION` 并入
 *   顶层 permission；每个 agent 的有效权限 = 顶层 permission 再合并该 agent 的
 *   `permission`（agent 级优先）。审查 H1：project / 全局配置里的
 *   `agent.build.permission.bash:"allow"`、`.opencode/agent/*.md` 的 frontmatter
 *   或经 `task` 调用的自定义子代理都能让命令不发 request_permission。因此：
 *   - `OPENCODE_DISABLE_PROJECT_CONFIG=1`：project 的 opencode.json、`.opencode/`
 *     目录（含 agent / plugin，也就不再往 project 里装插件）与 AGENTS.md 一概
 *     不读（`ConfigPaths.directories` / `Instruction.systemPaths` 均受它控制）——
 *     AGENTS.md 改由宿主 `<project>` 段注入（`agentSideConfigFiles` 为空）；
 *   - 权限块只用**字符串**动作、`"*":"ask"` 打头（`findLast` 下未点名的权限
 *     一律询问）：`edit` / `bash` / `external_directory` / `task` / 联网一律
 *     `ask`——写入、命令、
 *     工作目录外的路径（数据目录由宿主权限桥拒绝）与子代理启动都经 ACP
 *     `request_permission` 交宿主按档位裁决；同一权限块既写顶层，也写进
 *     `agent.{build,plan,general,explore}.permission` 与 `mode.{build,plan}.permission`
 *     （CONTENT 晚于 project / `.opencode` 合并，同名覆盖；mode 在其后并入
 *     agent，也带同样的块）；`plan` / `explore` 的 `edit` 保持 `deny`（不放宽其
 *     只读语义）；顶层再经 `OPENCODE_PERMISSION` 合并一次；
 *   - 未开启「加载我的个人配置」时 `XDG_CONFIG_HOME` 指向私有目录（登录凭据在
 *     `XDG_DATA_HOME`，不受影响；它也作用于 OpenCode 执行的命令——gh / git
 *     等读 `~/.config` 的工具看不到用户配置，设置页条款提示中披露）；`~/.opencode/` 仍会被读（HOME 不改，否则
 *     命令里的 git 等也失去用户身份；无正式开关可关）；
 *   - **用户层不能被可靠覆盖（复审 #8）**：1.18.35 的各层以 remeda `mergeDeep`
 *     合并——已有键保持原位置、新键追加在末尾，`OPENCODE_PERMISSION` 同样如此
 *     且只作用于顶层；`mode.*` 在我们的层之后并入 `agent.*`。所以用户层里我们
 *     没点名的键（`"b*":"allow"`、`"**":"allow"`，或把 `"*"` 放在点名键之前再
 *     追加通配键、写在 `mode.build.permission` 里）会排在我们的规则之后，被
 *     `findLast` 选中而直接放行。没有任何机制能让我们的层「最后且按我们的键序」
 *     生效 → 启动前扫描 OpenCode 会读取的、用户可写的配置层
 *     （`opencodeUserConfigIssues`：`~/.opencode/opencode.json(c)`、
 *     `~/.opencode/{agent,agents}/**\/*.md`、`{mode,modes}/*.md` 的 frontmatter、
 *     `{tool,tools}/*.{js,ts}`；开启「加载我的个人配置」时另加
 *     `$XDG_CONFIG_HOME/opencode/` 的 `config.json` / `opencode.json(c)` / 旧版
 *     `config` 与同样的子目录；私有配置目录也扫），只要有一处对非只读权限给出
 *     `ask` / `deny` 以外的动作（含通配键、`tools: {x: true}`、整个 `permission`
 *     字符串；`{file:…}` / `{env:…}` 替换一律拒绝）、存在自定义工具代码、文件
 *     无法解析、或目录过深 / 文件过多，就拒绝运行（`AGENT_CONFIG_UNSAFE`，列出
 *     文件与键）——fail closed。markdown frontmatter 按 gray-matter 的规则切出
 *     （只接受 `---` / `---yaml`：`---js` 等语言会被 eval）、用 js-yaml 解析后
 *     只看 `permission` / `tools`（第三轮审查 #1 / #2）；JSON / JSONC 按 OpenCode
 *     所用 jsonc-parser 3.3.1 的词法切分（`//` 注释止于 `\n` 或 `\r`、空白只有
 *     空格 / 制表符、BOM 按 TextDecoder 去掉一个），`__proto__` 键一律拒绝（第三轮
 *     补充 #1）。扫描在进程启动前和每次
 *     建 / 恢复会话前各做一次（`checkConfig`，第三轮 #4），探测 / 登录 / 退出的
 *     控制进程不扫。残留：登录 OpenCode 控制台
 *     组织后的远程组织配置、`auth.json` 中 wellknown 远程配置（读取它们须读凭据
 *     文件，宿主不读）与管理员的 `/etc/opencode` 不在扫描范围内（后两者在我们的
 *     层之后合并），记入 todo §8.4 复审修复 #8 残留；
 *   - **残留（第三轮补充 #5，有意不拒绝）**：同样这些用户层里的 `mcp.<x>`
 *     （`type:"local"` + `command`）、`formatter.<x>.command`、`lsp.<x>.command`
 *     会由 OpenCode 直接拉起用户配置的命令，不经宿主裁决——用户真实的 MCP /
 *     格式化 / LSP 配置很常见，扫描不拒绝它们（只有用户自己能写这些文件），记入
 *     todo §8.4 第三轮补充修复与 design 28 OpenCode 行；
 *   - 改指配置位置的环境变量（`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、
 *     `OPENCODE_TEST_HOME`、`OPENCODE_TEST_MANAGED_CONFIG_DIR`、`XDG_CONFIG_HOME`）
 *     与宿主强制的键一样不接受目录 / 启动目标里的值（大小写不敏感剔除；宿主
 *     环境本就按白名单透传，第三轮补充 #2）；
 *   - `OPENCODE_PURE=1`：不加载外部插件（插件是在沙箱外运行的任意代码）；
 *   - `OPENCODE_DISABLE_CLAUDE_CODE=1`：关闭 CLAUDE.md 回退与 `~/.claude/skills`；
 *     `OPENCODE_DISABLE_AUTOUPDATE=1` + `autoupdate:false`：不得自我升级；
 *     `share:'disabled'`：会话永不公开分享；
 *   - 残留（无配置项可关）：全局配置目录（私有目录或用户的 `~/.config/opencode`）
 *     与 `~/.opencode` 仍会被后台安装 `@opencode-ai/plugin`（桥外写入，不在
 *     project 里），设置页条款提示中说明；
 * - 档位（session config option `mode`：build / plan）：read_only → `plan`，
 *   ask / workspace → `build`；
 * - 权限选项：`once` / `always` / `reject`（只选 once / reject）；
 * - MCP 工具在模型侧的名字是 `{server}_{tool}`（非字母数字替换为 `_`）；
 *   ACP `tool_call` 不带结构化名（title 是自由文本）→ 宿主桥工具的镜像更新
 *   无法识别（会多出一条原生步骤），待登录实测；
 * - 未登录不报错：自带匿名免费模型（目录 `auth.kinds` 含 `anonymous`）；terminal
 *   登录只在 `_meta['terminal-auth']`，由 terminal-auth.ts 改写为已安装路径；
 * - steering 视为不支持（spike 未见声明）；load / resume 有；
 * - 斜杠命令：ACP prompt 的文本（各 text 块拼接、trim）以 `/` 开头且命中命令
 *   名时走 `session.command`（命令模板可含 `` !`shell` ``，不经权限确认）——
 *   引擎保证发出的 prompt 从不以 `/` 开头（`slashSafePrompt`，第三轮 #7）。
 */

export function opencodeModeForTier(tier: AgentPermissionTier): string {
  return tier === 'read_only' ? 'plan' : 'build';
}

/**
 * 顶层权限块（只用字符串动作）。1.18.35 `Permission.fromConfig` 按对象键序
 * 展开成规则、`merge` 直接拼接、`evaluate` 取 `findLast` 命中（权限名与
 * pattern 都按通配匹配）——所以 `"*":"ask"` 放在最前：未点名的权限（含将来
 * 新增的）一律询问，点名的在其后覆盖（审查 #7）。点名放行的只有工作区内的
 * 只读与会话内部工具（`read` 读工作区外的路径时 OpenCode 另走
 * `external_directory`）；`question` / `plan_*` 拒绝（无人在线答题，模式只由
 * 宿主切换）。
 */
export function opencodePermissionConfig(): Record<string, string> {
  return {
    '*': 'ask',
    read: 'allow',
    list: 'allow',
    glob: 'allow',
    grep: 'allow',
    lsp: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
    question: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    task: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    codesearch: 'ask',
  };
}

/** 内置 agent 的权限块（plan / explore 保持只读：`edit: deny`）。 */
function agentPermission(name: string): Record<string, string> {
  const base = opencodePermissionConfig();
  return name === 'plan' || name === 'explore' ? { ...base, edit: 'deny' } : base;
}

const OPENCODE_BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore'] as const;
const OPENCODE_PRIMARY_MODES = ['build', 'plan'] as const;

/** `OPENCODE_CONFIG_CONTENT`：只放全局项（所有会话共用，不承载人设）。 */
export function opencodeProcessConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: opencodePermissionConfig(),
    agent: Object.fromEntries(
      OPENCODE_BUILTIN_AGENTS.map((name) => [name, { permission: agentPermission(name) }]),
    ),
    mode: Object.fromEntries(
      OPENCODE_PRIMARY_MODES.map((name) => [name, { permission: agentPermission(name) }]),
    ),
  };
}

/**
 * Permissions the host lets OpenCode run without asking (our block allows them
 * too): a user layer may allow these, nothing else.
 */
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
 * Keys of one `permission` value that allow something only the host may
 * decide (复审 #8). A key is safe only when it names a read-only permission
 * exactly — wildcard keys ("*", "b*", "**") may match bash / edit / task …
 * Any action other than exactly `ask` / `deny` counts as allowing (第三轮 #3:
 * `{env:…}` / `{file:…}` or an unknown value may turn into `allow`).
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

/** One agent's own settings (`agent.<name>` / markdown frontmatter): permission + tools only. */
function agentAllows(agent: Record<string, unknown>): string[] {
  return [...permissionAllows(agent.permission), ...toolsAllow(agent.tools)];
}

/** Allowing keys of a parsed opencode.json(c): top level, `agent.*`, `mode.*`. */
function configAllows(config: unknown): string[] {
  if (!isPlainObject(config)) return ['（不是 JSON 对象）'];
  const keys = agentAllows(config);
  for (const section of ['agent', 'mode'] as const) {
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
 * is parsed (第三轮 #3): what they expand to cannot be checked here.
 */
const SUBSTITUTION = /\{(?:file|env):/;

/** Characters that end a jsonc-parser literal / number / unknown token. */
const JSONC_SEPARATORS = ' \t\n\r{}[]:,"/';

/**
 * JSONC → JSON the way jsonc-parser 3.3.1 tokenizes it (bundled in opencode
 * 1.18.35, `ConfigParse.jsonc` = `parse(text, errors, {allowTrailingComma:
 * true})`, any error → the file is rejected; the package itself is not
 * available offline here, so its scanner is mirrored — 第三轮补充 #1):
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

/**
 * opencode 1.18.35 `ConfigMarkdown.sanitize` (verbatim logic): when the
 * frontmatter fails to parse, OpenCode retries with top-level `key: a:b`
 * values turned into block scalars.
 */
function sanitizeFrontmatter(text: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return text;
  const frontmatter = match[1]!;
  const lines = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (entry === null) return [line];
    const value = entry[2]!.trim();
    if (value === '' || value === '>' || value === '|' || value.startsWith('"')) return [line];
    if (value.startsWith("'") || !value.includes(':')) return [line];
    return [`${entry[1]}: |-`, `  ${value}`];
  });
  return text.replace(frontmatter, () => lines.join('\n'));
}

/**
 * gray-matter 4 (as bundled in opencode 1.18.35): BOM stripped; frontmatter
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
 * Agent / mode markdown (第三轮 #1, #2): the frontmatter is parsed with a
 * real YAML parser (js-yaml — OpenCode uses gray-matter + js-yaml 3
 * `safeLoad`) and checked like an `agent.<name>` entry (`permission` /
 * `tools` only — prose elsewhere is irrelevant). OpenCode re-parses a
 * sanitized text when the first parse fails: both readings are checked;
 * neither parsing → refused.
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

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Walk bounds (第三轮 #5): beyond them the scan is incomplete → refused. */
const MARKDOWN_SCAN_MAX_DEPTH = 8;
const MARKDOWN_SCAN_MAX_FILES = 2_000;

/**
 * Markdown files under `dir` (recursive when `deep`; `.md` in any case).
 * Symlinks are followed once (real paths visited at most once); `truncated`
 * = the depth or file cap was hit.
 */
function markdownFiles(dir: string, deep: boolean): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const visited = new Set<string>();
  let truncated = false;
  const walk = (current: string, depth: number) => {
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const name of listDir(current)) {
      if (truncated) return;
      const full = path.join(current, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
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
  return { files, truncated };
}

/**
 * User-writable OpenCode config layers that would let a tool run without the
 * host's decision (复审 #8; layer list from opencode 1.18.35
 * `Config.loadInstanceState` / `ConfigPaths.directories`). `configHome` is the
 * global config directory OpenCode reads (`$XDG_CONFIG_HOME/opencode` — the
 * private one, or the user's with 「加载我的个人配置」); `~/.opencode` is read
 * either way. Returns "file: key" findings; empty = safe to launch.
 */
export function opencodeUserConfigIssues(input: { home: string; configHome: string }): string[] {
  const issues: string[] = [];
  const dotDir = path.join(input.home, '.opencode');
  const configFiles: Array<[string, readonly string[]]> = [
    [dotDir, ['opencode.json', 'opencode.jsonc']],
    [input.configHome, ['config.json', 'opencode.json', 'opencode.jsonc']],
  ];
  for (const [dir, names] of configFiles) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (!existingFile(file)) continue;
      let keys: string[];
      try {
        keys = jsonConfigAllows(readFileSync(file, 'utf8'));
      } catch {
        keys = ['无法读取'];
      }
      for (const key of keys) issues.push(`${file}: ${key}`);
    }
  }
  // Legacy TOML global config: not checked here — refused if present.
  const legacy = path.join(input.configHome, 'config');
  if (existingFile(legacy)) issues.push(`${legacy}: 旧版 TOML 配置（无法检查）`);
  for (const dir of [dotDir, input.configHome]) {
    for (const [sub, deep] of [
      ['agent', true],
      ['agents', true],
      ['mode', false],
      ['modes', false],
    ] as const) {
      const root = path.join(dir, sub);
      const { files, truncated } = markdownFiles(root, deep);
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
    // Custom tools are imported and run without any permission request.
    for (const sub of ['tool', 'tools']) {
      for (const name of listDir(path.join(dir, sub))) {
        if (/\.(js|ts|mjs|cjs|mts|cts)$/i.test(name)) {
          issues.push(`${path.join(dir, sub, name)}: 自定义工具（不经权限确认执行）`);
        }
      }
    }
  }
  return issues;
}

/** 未开启「加载我的个人配置」时的私有全局配置根（`XDG_CONFIG_HOME`）。 */
export function opencodeConfigHome(stateDir: string): string {
  return path.join(stateDir, 'xdg-config');
}

/**
 * Fail closed (复审 #8 / 第三轮 #4, #6): a user layer allowing what only the
 * host may decide would win over our rules (key order + findLast). Run before
 * the run process starts and again before every session is opened (OpenCode
 * reads its config per instance / directory, so a later edit applies to the
 * next session) — not for control processes (probe / login / logout).
 */
function checkOpencodeConfig({ stateDir, loadUserConfig }: ConfigCheckContext): void {
  if (loadUserConfig !== true && stateDir === undefined) {
    throw new AppError('AGENT_UNAVAILABLE', 'OpenCode 缺少私有状态目录，无法隔离个人配置');
  }
  const home = os.homedir();
  const configHome =
    loadUserConfig === true
      ? path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
      : path.join(opencodeConfigHome(stateDir!), 'opencode');
  // Paths under the home directory as `~/…` (no user name in the setup card).
  const issues = opencodeUserConfigIssues({ home, configHome }).map((issue) =>
    issue.startsWith(home + path.sep) ? `~${issue.slice(home.length)}` : issue,
  );
  if (issues.length > 0) {
    throw new AppError(
      'AGENT_CONFIG_UNSAFE',
      `OpenCode 的配置放行了需要 KepCup 逐条确认的操作，已拒绝运行。请把下列文件中的这些键改为 ask / deny 或删除后重试：${issues.slice(0, 8).join('；')}${issues.length > 8 ? ` 等 ${issues.length} 处` : ''}`,
      { issues },
    );
  }
}

/**
 * Variables that point OpenCode at another config file / directory / home
 * (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, the test-only home and managed
 * config overrides) — none of them is scanned, so the catalog
 * (`distribution.npx.env`) / launch target must not set them (第三轮补充 #2).
 * `XDG_CONFIG_HOME` likewise: the host's own value (or the private root) only.
 */
const OPENCODE_CONFIG_REDIRECT_ENV = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'XDG_CONFIG_HOME',
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
      OPENCODE_PERMISSION: JSON.stringify(opencodePermissionConfig()),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
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
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
  },
  // OPENCODE_DISABLE_PROJECT_CONFIG：project 内的配置（opencode.json、.opencode/、
  // AGENTS.md）一概不读——AGENTS.md 由宿主 <project> 段注入。
  agentSideConfigFiles: [],
};
