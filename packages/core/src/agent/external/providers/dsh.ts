import { ACP_AUTH_REQUIRED, type AgentErrorInfo, type AgentErrorKind } from '../errors.js';
import type { AgentProvider } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * DeepSeek Harness（原生 `dsh --profile acp`，`@deepseek-ai/dsh` 0.2.0-rc.2，
 * design 28 §9.2）：只覆盖与通用实现的差异。依据：离线 spike（todo 附录 A.4）+
 * `@deepseek-ai/dsh-acp` README（协议面）+ 其 lib 中的权限选项。
 *
 * - 指令：`prompt-prefix`；启动参数 `--profile acp` 在目录 `distribution.npx.args`；
 * - 无登录流程（`authMethods` 为空、`authenticate` 直接成功）：只认
 *   `DEEPSEEK_API_KEY`（目录 `auth.apiKeyEnv`，存 secrets 注入）；没配 key 时
 *   `session/new` 成功、`session/prompt` 才报 **-32603** + 「no API key for
 *   provider route …」→ 判为 auth_required（任何阶段）；
 * - 不支持 `session/load` / modes / 图片 / steering（每会话同时只有一个 prompt）；
 *   支持 `session/resume`（不重放历史）与 `close`；MCP 只 http；
 * - 档位：没有模式可切（无 modes、config 只有 model / reasoning_effort），只靠
 *   宿主权限桥裁决它发来的一次性 allow-once / reject-once 请求；它在哪些工具上
 *   发请求、有无自身沙箱待配 key 后实测——`preview` 档默认 `ask`；
 * - 冷启动很慢（首启约 77 s，约 760 MB）：安装后预热留待安装器支持
 *   postInstall 钩子（todo §8.3 遗留）。
 */

/** `-32603` + 「no API key for provider route」（dsh 的未配 key 形态，精确匹配）。 */
export function isDshMissingApiKey(error: AgentErrorInfo): boolean {
  return error.code === -32603 && error.message.includes('no API key for provider route');
}

export function classifyDshError(error: AgentErrorInfo): AgentErrorKind {
  return error.code === ACP_AUTH_REQUIRED || isDshMissingApiKey(error) ? 'auth_required' : 'other';
}

export const dshProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'dsh',
  instructionMode: 'prompt-prefix',
  applyPermissionTier: async () => {
    // No session modes / mode option: the host PermissionBridge (per tier) is
    // the only control over the requests dsh sends.
  },
  // @deepseek-ai/dsh-acp 0.2.0-rc.2：allow-once / reject-once（一次性）。
  permissionOptions: { allowOnce: ['allow-once'], rejectOnce: ['reject-once'] },
  execSandboxed: () => false,
  features: {
    steering: false,
    loadSession: false,
    resume: true,
    osSandbox: false,
    httpMcp: true,
  },
  agentSideConfigFiles: ['AGENTS.md'],
  classifyError: (error) => classifyDshError(error),
};
