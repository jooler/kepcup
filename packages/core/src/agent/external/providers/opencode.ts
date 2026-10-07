import type { AgentPermissionTier } from '@kepcup/shared';
import { defaultHome } from '../../../infra/paths.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * OpenCode（原生 `opencode acp`，design 28 §9.2）：只覆盖与通用实现的差异。
 * 依据：opencode 1.18.35 二进制内嵌源码（离线核对，未运行）+ 离线 spike（todo
 * 附录 A.4）。
 *
 * - 指令：`prompt-prefix`；
 * - 进程级配置只放全局项（所有会话共用，不承载人设）：
 *   - `OPENCODE_DISABLE_CLAUDE_CODE=1`：关闭 CLAUDE.md 提示词回退与
 *     `~/.claude/skills` 扫描（`disableClaudeCodePrompt` / `disableClaudeCodeSkills`）；
 *   - `OPENCODE_DISABLE_AUTOUPDATE=1` + `autoupdate:false`：不得自我升级（安装件
 *     以 sha256 锁定）；`share:'disabled'`：会话永不公开分享；
 *   - 权限（`OPENCODE_CONFIG_CONTENT` 的 `permission`，并以 `OPENCODE_PERMISSION`
 *     在全部配置〔含 project 的 opencode.json〕合并之后再合并一次，规则「后者
 *     匹配优先」）：`edit` / `bash` 一律 `ask`——每次写入与命令都经 ACP
 *     `request_permission` 交宿主权限桥按档位裁决（OpenCode 无 OS 沙箱，命令
 *     逐条确认）；`external_directory` 缺省 `ask`、数据目录 `deny`（会话 cwd 是
 *     数据目录内的 workspace 时，cwd 本身不算 external，其余数据目录仍拒绝）；
 * - 档位（session config option `mode`：build / plan）：read_only → `plan`
 *   （其提示词告诉模型不改文件；写入仍由上面的 `edit: ask` + 宿主拒绝兜底），
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

/** opencode 的路径通配用 `/`（`external_directory` 资源同样被归一为 `/`）。 */
function slashPath(target: string): string {
  return target.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** 进程级权限规则（opencode permission 配置格式；对象内后写的规则优先）。 */
export function opencodePermissionConfig(dataHome: string): Record<string, unknown> {
  const home = slashPath(dataHome);
  return {
    edit: 'ask',
    bash: 'ask',
    external_directory: { '*': 'ask', [home]: 'deny', [`${home}/*`]: 'deny' },
  };
}

/** `OPENCODE_CONFIG_CONTENT`：只放全局项。 */
export function opencodeProcessConfig(dataHome: string): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: opencodePermissionConfig(dataHome),
  };
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
  launch: ({ entry, target, dataHome }) => {
    const home = dataHome ?? defaultHome();
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...(entry.distribution.npx?.env ?? {}),
        ...target.env,
        // Host-enforced keys last: nothing merged above may override them.
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeProcessConfig(home)),
        OPENCODE_PERMISSION: JSON.stringify(opencodePermissionConfig(home)),
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
  // project 内无法关闭的配置：AGENTS.md、opencode.json(c)、.opencode/（agent /
  // command / plugin 定义）。
  agentSideConfigFiles: ['AGENTS.md', 'opencode.json', 'opencode.jsonc', '.opencode/'],
};
