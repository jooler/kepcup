import { defaultClassifyError, type AgentErrorInfo } from '../errors.js';
import type { AgentProvider } from '../types.js';
import { genericAcpProvider } from './generic-acp.js';

/**
 * Devin（`devin acp` 3000.11.234，D118 新目标）：只覆盖与通用实现的差异。
 * 来源：OpenBot 0.62.0 的 DEVIN_ACP_FLAVOR（acp-flavor.ts:231-234，其实跑
 * 观察）——**未真机复核**，接入 spike 须先验证。
 *
 * - 「会话不存在」的错误形态：`-32016` + `data['cognition.ai/errorKind']:
 *   'session_not_found'`（协议标准的 -32002 之外，引擎的透明重试靠它识别）；
 * - 登录：ACP authenticate method `devin-browser`（Agent 自行开浏览器），凭证
 *   在其 credentials.toml——KepCup 侧不经手；登出 `devin auth logout`；
 * - 其余（权限 optionId、modes、原生工具）待 spike。
 */
export const devinProvider: AgentProvider = {
  ...genericAcpProvider,
  id: 'devin',
  sessionNotFound: (error) => {
    const candidate = error as { code?: unknown; data?: unknown };
    if (candidate.code !== -32016) return false;
    const data = candidate.data as Record<string, unknown> | null | undefined;
    return (
      data !== null && typeof data === 'object' && data['cognition.ai/errorKind'] === 'session_not_found'
    );
  },
  classifyError: (error: AgentErrorInfo) => defaultClassifyError(error),
};
