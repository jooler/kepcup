import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError, type AgentPermissionTier } from '@kepcup/shared';
import { defaultBridgeToolFromCall, type AcpAuthMethod } from '../acp/client.js';
import type { AgentProvider, PermissionTierContext } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';
import { switchToMode } from './mode-tier.js';

/**
 * Google Antigravity（原生 `agy_acp_server` 1.5.2，design 28 §9.2 / §9.3）：只
 * 覆盖与通用实现的差异。依据：离线探测（todo 附录 A.2）+ 二进制内嵌的 Python
 * 源码（离线 `strings` 阅读，未运行）。
 *
 * - **登录方式白名单**（2026-11-26 凭据策略修订：能力开放 + 风险提示，用户
 *   自决）：`gemini-api-key`（key = `GEMINI_API_KEY`，目录 `auth.apiKeyEnv`）、
 *   `oauth-personal`（Google 个人账号，浏览器授权；UI 二次确认——条款第 6 条
 *   禁止第三方软件经个人账号访问，可致封号）与 `oauth-business`（Gemini
 *   Enterprise，Google 建议的合规通道）；白名单外的一切（rollout 中的
 *   `gateway`、未来新增方式）仍不出现，也无法经 `authenticate` 触发。
 *   `agent-platform`（Vertex：`GOOGLE_API_KEY` / `GOOGLE_CLOUD_PROJECT` 等）
 *   继续隐藏——宿主环境白名单不透传且无配置入口（审查 M3），属技术缺口；
 * - **私有 `GEMINI_HOME`**（`{数据目录}/agents/antigravity-acp/gemini-home`，
 *   默认开）：Antigravity 在客户端不调 `authenticate` 时按
 *   `$GEMINI_HOME/antigravity-acp/settings.json` 的 `auth.type` 推断登录方式
 *   ——隔离后 KepCup 的会话不会静默沿用用户在别的客户端选过的 `oauth-personal`
 *   等登录，也隔离全局 `config/mcp_config.json` 合并、全局 hooks 与工作区
 *   信任表。用户显式开启「复用本机登录」（`reuseLocalAuth`）后不设
 *   `GEMINI_HOME`：Agent 回落默认 `~/.gemini`，直接沿用本机官方登录与个人
 *   配置（凭据策略第一级「本地直读」），上述隔离随之取消，风险经 UI 提示；
 * - **工作区信任**：不设 `AGY_ACP_DISABLE_WORKSPACE_TRUST`（设了等于信任所有
 *   工作区，workdir 里的 `.agents/` / `.gemini/` hooks.json 会在沙箱外自动执行）；
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

/**
 * 允许的登录方式（白名单；其余一律过滤）。`oauth-personal` 在 UI 侧有二次
 * 确认（条款第 6 条封号风险，用户自决）；`agent-platform`（Vertex AI）需要
 * `GOOGLE_API_KEY` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` /
 * `GOOGLE_APPLICATION_CREDENTIALS`，宿主环境白名单不透传、也还没有配置入口 →
 * 在入口做好之前隐藏（审查 M3）。
 */
export const ANTIGRAVITY_AUTH_METHODS: readonly string[] = [
  'gemini-api-key',
  'oauth-personal',
  'oauth-business',
];

/** 永不进入的模式（`yolo` 另在全局禁止表）。 */
export const ANTIGRAVITY_FORBIDDEN_MODES: readonly string[] = ['auto_edit', 'yolo'];

export function antigravityModeForTier(_tier: AgentPermissionTier): string {
  return 'default';
}

/**
 * 私有 `GEMINI_HOME`。没有私有状态目录时拒绝启动（审查 M4，fail closed）：
 * 共享的临时目录可被本机其他用户预置 settings.json / hooks。
 */
export function antigravityGeminiHome(stateDir: string | undefined): string {
  if (stateDir === undefined) {
    throw new AppError(
      'AGENT_UNAVAILABLE',
      'Google Antigravity 缺少私有状态目录（GEMINI_HOME），拒绝启动',
    );
  }
  return path.join(stateDir, 'gemini-home');
}

/**
 * 启动 env：「复用本机登录」开启时不设 `GEMINI_HOME`（Agent 回落默认
 * `~/.gemini`，沿用本机官方登录与个人配置——不建私有目录，stateDir 缺失也
 * 不再是错误）；关闭时维持私有 home（fail closed，默认路径）。
 */
export function antigravityLaunchEnv(ctx: {
  stateDir?: string;
  reuseLocalAuth?: boolean;
}): Record<string, string> {
  if (ctx.reuseLocalAuth === true) return {};
  const geminiHome = antigravityGeminiHome(ctx.stateDir);
  mkdirSync(geminiHome, { recursive: true });
  return { GEMINI_HOME: geminiHome };
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
  launch: ({ entry, target, stateDir, reuseLocalAuth }) => {
    return {
      command: target.command,
      args: [...target.args],
      env: {
        ...(entry.distribution.npx?.env ?? {}),
        ...target.env,
        // Host-enforced last.
        ...antigravityLaunchEnv({ stateDir, reuseLocalAuth }),
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
  // parallelSessions：agy-acp-server 1.5.2 是原生二进制，无可读源码证实
  // 多会话并发 → false（fail-safe：并发恒为 1，不跑后台任务）。
  features: {
    steering: false,
    loadSession: true,
    resume: true,
    osSandbox: false,
    httpMcp: true,
    parallelSessions: false,
    isolatesLocalAuth: true,
  },
  agentSideConfigFiles: ['AGENTS.md', 'GEMINI.md', '.agents/', '.gemini/'],
  authMethods: filterAntigravityAuthMethods,
};
