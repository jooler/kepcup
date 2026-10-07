import { AppError } from '@kepcup/shared';

/**
 * 外部 Agent 错误的分类（D72；P0 spike 结论见 todo 附录 A.4 第 1 条）：各家
 * 「未登录」的表现不同（Codex 在 `session/new` 报 -32000，Claude 到
 * `session/prompt` 才报，DeepSeek Harness 是 -32603 + 文案），所以由 Provider
 * 按阶段判定，通用实现只认 ACP 标准的 `auth_required`（-32000）。P4 的状态机
 * 与对话内设置卡读取分类结果。
 */
export type AgentErrorKind =
  | 'auth_required'
  | 'not_installed'
  | 'incompatible'
  /** Agent 自身的 OS 沙箱起不来（宿主要求 failIfUnavailable，不降级）。 */
  | 'sandbox_unavailable'
  | 'other';
export type AgentErrorPhase = 'initialize' | 'session_new' | 'prompt' | 'other';

/** 协议 / 传输错误的可判定部分（JSON-RPC code + message + data）。 */
export interface AgentErrorInfo {
  code: number | string | null;
  message: string;
  data?: unknown;
}

/** ACP `auth_required` 错误码。 */
export const ACP_AUTH_REQUIRED = -32000;

export function agentErrorInfo(error: unknown): AgentErrorInfo {
  const candidate = (error ?? {}) as { code?: unknown; data?: unknown };
  const code =
    typeof candidate.code === 'number' || typeof candidate.code === 'string'
      ? candidate.code
      : null;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(candidate.data !== undefined ? { data: candidate.data } : {}),
  };
}

export function defaultClassifyError(info: AgentErrorInfo): AgentErrorKind {
  return info.code === ACP_AUTH_REQUIRED ? 'auth_required' : 'other';
}

/** 分类后的 AppError（已是 AppError 的原样返回）。 */
export function toAgentError(
  error: unknown,
  agentName: string,
  classify: (info: AgentErrorInfo, phase: AgentErrorPhase) => AgentErrorKind = defaultClassifyError,
  phase: AgentErrorPhase = 'other',
): AppError {
  if (error instanceof AppError) return error;
  const info = agentErrorInfo(error);
  switch (classify(info, phase)) {
    case 'auth_required':
      return new AppError('AGENT_AUTH_REQUIRED', `智能体「${agentName}」未登录：请先完成官方登录`);
    case 'not_installed':
      return new AppError('AGENT_UNAVAILABLE', `智能体「${agentName}」未安装或不可用：${info.message}`);
    case 'incompatible':
      return new AppError('AGENT_INCOMPATIBLE', `智能体「${agentName}」版本不兼容：${info.message}`);
    case 'sandbox_unavailable':
      return new AppError(
        'AGENT_SANDBOX_UNAVAILABLE',
        `智能体「${agentName}」的沙箱无法启动：${info.message}`,
      );
    case 'other':
      return new AppError('AGENT_FAILED', `智能体「${agentName}」出错：${info.message}`);
  }
}

/** The provider's classifier with the ACP-standard default. */
export function classifierFor(provider: {
  classifyError?(error: AgentErrorInfo, phase: AgentErrorPhase): AgentErrorKind;
}): (info: AgentErrorInfo, phase: AgentErrorPhase) => AgentErrorKind {
  return (info, phase) => provider.classifyError?.(info, phase) ?? defaultClassifyError(info);
}
