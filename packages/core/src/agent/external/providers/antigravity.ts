import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentPermissionTier } from '@kepcup/shared';
import { defaultBridgeToolFromCall, type AcpAuthMethod } from '../acp/client.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Google Antigravity（原生 `agy_acp_server` 1.3.0，design 28 §9.2 / §9.3）：只
 * 覆盖与通用实现的差异。依据：离线探测（todo 附录 A.2）+ 二进制内嵌的 Python
 * 源码（离线 `strings` 阅读，未运行）。
 *
 * - **登录方式白名单**：只留 `gemini-api-key`（key = `GEMINI_API_KEY`，目录
 *   `auth.apiKeyEnv`）与 `agent-platform`（Vertex：`GOOGLE_API_KEY` 或
 *   `GOOGLE_CLOUD_PROJECT` / `_LOCATION` + ADC）；`oauth-personal`（条款第 6 条：
 *   第三方软件经个人账号访问可致封号）与 `oauth-business`（Gemini Enterprise，
 *   是否同样受限未确认，保守过滤）以及白名单外的一切（如 rollout 中的
 *   `gateway`）都不出现在 UI，也无法经 `authenticate` 触发（登录只接受过滤后
 *   列表里的 id）；
 * - **私有 `GEMINI_HOME`**（`{数据目录}/agents/antigravity-acp/gemini-home`）：
 *   Antigravity 在客户端不调 `authenticate` 时按 `$GEMINI_HOME/antigravity-acp/
 *   settings.json` 的 `auth.type` 推断登录方式——用户若在别的客户端选过
 *   `oauth-personal`，共用 `~/.gemini` 就会让 KepCup 的会话静默走个人账号。
 *   私有 home 同时隔离了全局 `config/mcp_config.json` 合并、全局 hooks 与
 *   工作区信任表；
 * - **工作区信任**：不设 `AGY_ACP_DISABLE_WORKSPACE_TRUST`（设了等于信任所有
 *   工作区，project 里的 `.agents/` / `.gemini/` hooks.json 会在沙箱外自动执行）；
 *   ACP 会话加载 hooks 时不弹信任询问，未知信任状态的工作区 hooks 被抑制——
 *   私有 home 下信任表为空，等于全部抑制；
 * - 档位（modes：default / auto_edit / yolo）：**一律 `default`**（每个工具调用都
 *   发权限请求，宿主权限桥按档位裁决：workspace 档 cwd 内写入自动放行）。偏离
 *   设计稿「workspace → auto_edit」：源码显示非 Enterprise 登录下 `auto_edit`
 *   自动批准所有文件编辑工具**不区分是否在工作区内**（只有 Enterprise 管理策略
 *   ALWAYS_ASK 才对工作区外强制询问），等于工作区外任意写入免确认；`auto_edit`
 *   与全局禁止的 `yolo` 一并禁止；
 * - 自身沙箱：个人 / key 方式无（仅 Enterprise 管理开关启用 exebox）→
 *   `osSandbox:false`，命令逐条确认；
 * - 权限选项：`allow` / `allow_always` / `deny`（只选 allow / deny）；
 * - MCP 工具：权限请求与 `tool_call` 都带 `_meta:{mcp:{server, tool},
 *   is_mcp_tool_call:true}`（宿主桥据此识别）；
 * - `initialize.clientInfo` 如实为 KepCup（进入其 User-Agent，宿主统一处理）。
 */

/** 允许的登录方式（白名单；其余一律过滤）。 */
export const ANTIGRAVITY_AUTH_METHODS: readonly string[] = ['gemini-api-key', 'agent-platform'];

/** 永不进入的模式（`yolo` 另在全局禁止表）。 */
export const ANTIGRAVITY_FORBIDDEN_MODES: readonly string[] = ['auto_edit', 'yolo'];

export function antigravityModeForTier(_tier: AgentPermissionTier): string {
  return 'default';
}

/** 私有 `GEMINI_HOME`（缺省状态目录时退到临时目录，仍不与用户的 `~/.gemini` 共用）。 */
export function antigravityGeminiHome(stateDir: string | undefined): string {
  return path.join(
    stateDir ?? path.join(os.tmpdir(), 'kepcup-agents', 'antigravity-acp'),
    'gemini-home',
  );
}

export function filterAntigravityAuthMethods(advertised: AcpAuthMethod[]): AcpAuthMethod[] {
  return advertised.filter((method) => ANTIGRAVITY_AUTH_METHODS.includes(method.id));
}

async function applyAntigravityTier(
  tier: AgentPermissionTier,
  ctx: PermissionTierContext,
): Promise<void> {
  await switchToMode('Google Antigravity', antigravityModeForTier(tier), ctx);
}

export const antigravityProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'antigravity',
  launch: ({ entry, target, stateDir }) => {
    const geminiHome = antigravityGeminiHome(stateDir);
    mkdirSync(geminiHome, { recursive: true });
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...(entry.distribution.npx?.env ?? {}),
        ...target.env,
        // Host-enforced last.
        GEMINI_HOME: geminiHome,
      },
    };
  },
  instructionMode: 'prompt-prefix',
  applyPermissionTier: applyAntigravityTier,
  forbiddenModes: ANTIGRAVITY_FORBIDDEN_MODES,
  permissionOptions: { allowOnce: ['allow'], rejectOnce: ['deny'] },
  execSandboxed: () => false,
  bridgeToolFromCall: (toolCall, serverName) => {
    const meta = toolCall._meta as
      { mcp?: { server?: unknown; tool?: unknown }; is_mcp_tool_call?: unknown } | null | undefined;
    if (
      meta !== null &&
      typeof meta === 'object' &&
      meta.is_mcp_tool_call === true &&
      meta.mcp?.server === serverName &&
      typeof meta.mcp.tool === 'string' &&
      meta.mcp.tool.length > 0
    ) {
      return meta.mcp.tool;
    }
    return defaultBridgeToolFromCall(toolCall, serverName, (server, tool) =>
      genericAcpProvider.toolName(server, tool),
    );
  },
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
  },
  agentSideConfigFiles: ['AGENTS.md', 'GEMINI.md', '.agents/', '.gemini/'],
  authMethods: filterAntigravityAuthMethods,
};
