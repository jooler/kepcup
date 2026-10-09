/**
 * Error codes shared across core, main and renderer.
 * Renderer maps these to user-facing Chinese messages (see 01-conventions.md, "Error handling").
 */
export const ERROR_CODES = [
  // generic
  'INVALID_INPUT',
  'INTERNAL',
  'NOT_IMPLEMENTED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'TIMEOUT',
  // startup / infra
  'KEYSTORE_UNAVAILABLE',
  'MASTER_KEY_LOCKED',
  'DB_OPEN_FAILED',
  'MIGRATION_FAILED',
  'MIGRATION_BACKUP_FAILED',
  // model providers
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNREACHABLE',
  // 模型能力未配置（inline setup 引导的机器可读信号，docs/design/18-inline-setup.md）
  'CAPABILITY_NOT_CONFIGURED',
  // model / context size
  'CONTEXT_TOO_LARGE',
  // runs
  'RUN_NOT_FOUND',
  'RUN_ALREADY_FINISHED',
  /**
   * W3（D78）：中断的任务有外部副作用台账行（已完成 / 结果未知），重试前须由
   * 用户在「检查后重试」面板核实（runs.retry 带 reviewed:true）。
   */
  'REVIEW_REQUIRED',
  // conversations / messages
  'CONVERSATION_READ_ONLY',
  'MESSAGE_NOT_RECALLABLE',
  // gateway / permissions
  'APPROVAL_DENIED',
  'APPROVAL_NOT_FOUND',
  'PATH_OUT_OF_SCOPE',
  'STALE_FILE',
  'LEASE_TIMEOUT',
  'LEASE_HELD',
  /**
   * D75 §2.1 / §5.1：执行期硬拒写——对话轮（loop_type='turn'）与只读任务
   * （task_writes=false）的写路径（文件写、会写入的命令）一律拒绝。
   */
  'RUN_READ_ONLY',
  // projects
  'PROJECT_MISSING',
  'PROJECT_SWITCH_BLOCKED',
  'GIT_CLI_MISSING',
  // environment (P06)
  'ENV_ITEM_UNKNOWN',
  'ENV_ITEM_UNSUPPORTED_PLATFORM',
  'ENV_ALREADY_INSTALLED',
  'ENV_INSTALL_FAILED',
  'ENV_VERIFY_FAILED',
  'ENV_CHECKSUM_MISMATCH',
  // skills (P08)
  'SKILL_IMPORT_FAILED',
  'SKILL_VALIDATION_FAILED',
  // sandbox
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_POLICY_DENIED',
  // browser (P11)
  'BROWSER_UNAVAILABLE',
  'BROWSER_PAGE_CLOSED',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_BLOCKED',
  'BROWSER_REF_UNKNOWN',
  'BROWSER_BOT_DELETED',
  'BROWSER_CONVERSATION_DELETED',
  // W1 浏览器动作确定性：ref 指纹不符（派发前）、动作结果未知（派发后出错）、
  // 同一动作反复执行页面不变（熔断）。
  'BROWSER_REF_STALE',
  'BROWSER_OUTCOME_UNKNOWN',
  'BROWSER_NO_PROGRESS',
  // MCP (D65)
  'MCP_CONNECT_FAILED',
  'MCP_TOOL_NOT_FOUND',
  'MCP_CALL_FAILED',
  'MCP_SERVER_FAILED',
  // butler & delegation (D70 / D71)
  'BOT_UNDELETABLE',
  // external agents (D72)
  'NOT_SUPPORTED',
  'AGENT_UNAVAILABLE',
  'AGENT_AUTH_REQUIRED',
  'AGENT_INCOMPATIBLE',
  /** Agent 自身的 OS 沙箱起不来（如 Linux 缺 bubblewrap / socat），run 不降级。 */
  'AGENT_SANDBOX_UNAVAILABLE',
  /** Agent 会读取的用户配置会绕过宿主的逐条确认（OpenCode 放行规则等），拒绝运行。 */
  'AGENT_CONFIG_UNSAFE',
  'AGENT_PROCESS_EXITED',
  'AGENT_FAILED',
  // connected apps / MCP OAuth (D73, docs/design/29-connected-apps.md)
  /** 运行时需要（重新）授权：未连接 / 令牌失效 / 需追加 scope；不计入 MCP 连接失败次数。 */
  'APP_AUTH_REQUIRED',
  'OAUTH_FLOW_FAILED',
  'OAUTH_FLOW_CANCELLED',
  'OAUTH_FLOW_TIMEOUT',
  /** 无任何客户端注册途径（无 CIMD / DCR / 预注册），需用户手填 client id。 */
  'OAUTH_CLIENT_REQUIRED',
  'OAUTH_ISSUER_MISMATCH',
  'OAUTH_INSECURE_ENDPOINT',
  'APP_CONNECTION_NOT_FOUND',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedAppError {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode | string;
  readonly details?: unknown;

  constructor(code: ErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): SerializedAppError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
