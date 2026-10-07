import { defaultClassifyError } from '../errors.js';
import type { AgentProvider } from '../types.js';

/**
 * 通用 ACP Provider：只用 ACP v1 标准字段 + 已核对的扩展（D72 §10）。目录
 * 条目与通用实现无差异时 `provider: 'generic-acp'` 即可接入。
 *
 * - 指令：`prompt-prefix`（会话级提示词作为会话首个 prompt 的前置段）；
 * - 工具名：`mcp__{server}__{tool}`（多数 Agent 对 MCP 工具的命名，可覆盖）；
 * - 权限：只认标准 optionId 写法；P1 宿主侧一律默认拒绝，档位映射留给各
 *   Provider（P3），通用实现不切换任何模式（`applyPermissionTier` 为 no-op，
 *   真实 Agent 不能只靠它进目录）；
 * - 错误：只把 ACP 标准的 -32000 判为 auth_required；
 * - features 一律按最保守取值（无 steering / load / resume / OS 沙箱）。
 */
export const genericAcpProvider: AgentProvider = {
  id: 'generic-acp',
  launch: ({ entry, target }) => ({
    command: target.command,
    args: [...target.args],
    env: { ...(entry.distribution.npx?.env ?? {}), ...target.env },
  }),
  instructionMode: 'prompt-prefix',
  sessionNew: () => ({}),
  applyPermissionTier: async () => {
    // Generic agents expose no verified mode mapping; the host's permission
    // handling (default deny in P1, PermissionBridge in P3) is the control.
  },
  permissionOptions: {
    allowOnce: ['allow_once', 'allow-once'],
    rejectOnce: ['reject_once', 'reject-once'],
  },
  toolName: (server, tool) => `mcp__${server}__${tool}`,
  features: {
    steering: false,
    loadSession: false,
    resume: false,
    osSandbox: false,
    httpMcp: true,
  },
  agentSideConfigFiles: ['AGENTS.md'],
  classifyError: (error) => defaultClassifyError(error),
};
