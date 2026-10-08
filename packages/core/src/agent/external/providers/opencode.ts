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
 *     命令里的 git 等也失去用户身份）——其中的自定义子代理只能经 `task`（ask）
 *     启动，内置 agent 的权限被上面的块覆盖；
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
