import { defaultClassifyError, type AgentErrorInfo } from '../errors.js';
import type { AgentProvider } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * Kimi CLI（`kimi acp` 1.52.0，D118 新目标）：只覆盖与通用实现的差异。
 * 来源：OpenBot 0.62.0 的 KIMI_ACP_FLAVOR（acp-flavor.ts:213-225，其实跑
 * 观察）——**未真机复核**，接入 spike 须先验证。
 *
 * - 「会话不存在」的错误形态：`-32602`（invalid params）+ `data.session_id`
 *   （协议标准的 -32002 之外，引擎的透明重试靠它识别）；
 * - 登录：`kimi login`（Python CLI 与 Kimi Code 2.x 的参数形态不同）——KepCup
 *   侧暂以官方 CLI 自行登录为准（目录 auth.note），宿主不经手；
 * - 其余（权限 optionId、modes、原生工具）待 spike。
 */
export const kimiProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'kimi',
  sessionNotFound: (error) => {
    const candidate = error as { code?: unknown; data?: unknown };
    if (candidate.code !== -32602) return false;
    const data = candidate.data as { session_id?: unknown } | null | undefined;
    return data !== null && typeof data === 'object' && typeof data.session_id === 'string';
  },
  classifyError: (error: AgentErrorInfo) => defaultClassifyError(error),
};
