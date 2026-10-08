import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import type { AgentProvider, PermissionTierContext } from '../types.js';
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
 *     `allow`（含通配键、`tools: {x: true}`、整个 `permission:"allow"`）、存在
 *     自定义工具代码、或文件无法解析，就拒绝启动（`AGENT_INCOMPATIBLE`，列出
 *     文件与键）——fail closed。markdown frontmatter 不做完整 YAML 解析：出现
 *     `allow` 或 `tools` 下的 `true` 即视为放行。残留：登录 OpenCode 控制台
 *     组织后的远程组织配置、`auth.json` 中 wellknown 远程配置（读取它们须读凭据
 *     文件，宿主不读）与管理员的 `/etc/opencode` 不在扫描范围内（后两者在我们的
 *     层之后合并），记入 todo §8.4 复审修复 #8 残留；
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
 * - steering 视为不支持（spike 未见声明）；load / resume 有。
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
 */
function permissionAllows(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return value === 'allow' ? ['permission'] : [];
  if (!isPlainObject(value)) return ['permission'];
  const keys: string[] = [];
  for (const [name, action] of Object.entries(value)) {
    const allows =
      typeof action === 'string'
        ? action === 'allow'
        : isPlainObject(action)
          ? Object.values(action).some((inner) => inner !== 'ask' && inner !== 'deny')
          : true;
    if (allows && !OPENCODE_READ_ONLY_PERMISSIONS.has(name)) keys.push(`permission.${name}`);
  }
  return keys;
}

/** `tools: {name: true}` turns into an allow rule (write / patch → edit). */
function toolsAllow(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return ['tools'];
  return Object.entries(value)
    .filter(([name, enabled]) => enabled !== false && !OPENCODE_READ_ONLY_PERMISSIONS.has(name))
    .map(([name]) => `tools.${name}`);
}

/** Allowing keys of a parsed opencode.json(c): top level, `agent.*`, `mode.*`. */
function configAllows(config: unknown): string[] {
  if (!isPlainObject(config)) return ['（不是 JSON 对象）'];
  const keys = [...permissionAllows(config.permission), ...toolsAllow(config.tools)];
  for (const section of ['agent', 'mode'] as const) {
    const entries = config[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      keys.push(section);
      continue;
    }
    for (const [name, agent] of Object.entries(entries)) {
      if (!isPlainObject(agent)) continue;
      for (const key of [...permissionAllows(agent.permission), ...toolsAllow(agent.tools)]) {
        keys.push(`${section}.${name}.${key}`);
      }
    }
  }
  return keys;
}

/** JSONC → JSON: comments and trailing commas out, strings untouched. */
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Agent / mode markdown frontmatter (no YAML parser here): any `allow` value,
 * or `true` under a `tools` key, counts as allowing — fail closed.
 */
function frontmatterAllows(text: string): string[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return [];
  const end = normalized.indexOf('\n---', 3);
  const frontmatter = end < 0 ? normalized : normalized.slice(3, end);
  const keys: string[] = [];
  if (/\ballow\b/.test(frontmatter)) keys.push('frontmatter: allow');
  if (/^\s*tools\s*:/m.test(frontmatter) && /\btrue\b/.test(frontmatter)) {
    keys.push('frontmatter: tools … true');
  }
  return keys;
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

/** Markdown files under `dir` (recursive when `deep`). */
function markdownFiles(dir: string, deep: boolean): string[] {
  const files: string[] = [];
  for (const name of listDir(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (deep) files.push(...markdownFiles(full, true));
    } else if (name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
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
        keys = configAllows(JSON.parse(stripJsonc(readFileSync(file, 'utf8'))));
      } catch {
        keys = ['无法解析'];
      }
      for (const key of keys) issues.push(`${file}: ${key}`);
    }
  }
  // Legacy TOML global config: not checked here — refused if present.
  const legacy = path.join(input.configHome, 'config');
  if (existingFile(legacy)) issues.push(`${legacy}: 旧版 TOML 配置（无法检查）`);
  for (const dir of [dotDir, input.configHome]) {
    const markdown = [
      ...['agent', 'agents'].flatMap((sub) => markdownFiles(path.join(dir, sub), true)),
      ...['mode', 'modes'].flatMap((sub) => markdownFiles(path.join(dir, sub), false)),
    ];
    for (const file of markdown) {
      let keys: string[];
      try {
        keys = frontmatterAllows(readFileSync(file, 'utf8'));
      } catch {
        keys = ['无法读取'];
      }
      for (const key of keys) issues.push(`${file}: ${key}`);
    }
    // Custom tools are imported and run without any permission request.
    for (const sub of ['tool', 'tools']) {
      for (const name of listDir(path.join(dir, sub))) {
        if (/\.(js|ts|mjs|cjs|mts|cts)$/.test(name)) {
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
    // Fail closed (复审 #8): a user layer allowing what only the host may
    // decide would win over our rules (key order + findLast).
    const home = os.homedir();
    const configHome =
      loadUserConfig === true
        ? path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
        : path.join(opencodeConfigHome(stateDir!), 'opencode');
    const issues = opencodeUserConfigIssues({ home, configHome });
    if (issues.length > 0) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `OpenCode 的配置放行了需要 KepCup 逐条确认的操作，已拒绝启动（请改为 ask / deny 或移除后重试）：${issues.slice(0, 8).join('；')}${issues.length > 8 ? ` 等 ${issues.length} 处` : ''}`,
        { issues },
      );
    }
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...(entry.distribution.npx?.env ?? {}),
        ...target.env,
        // Host-enforced keys last: nothing merged above may override them.
        ...(loadUserConfig !== true ? { XDG_CONFIG_HOME: opencodeConfigHome(stateDir!) } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeProcessConfig()),
        OPENCODE_PERMISSION: JSON.stringify(opencodePermissionConfig()),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
    };
  },
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
