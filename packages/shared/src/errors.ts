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
  /**
   * W4（D78）：`approvals.decide` 带的 payloadHash 与服务端审批内容不符（界面
   * 显示的是过期的卡片），决定不生效。
   */
  'APPROVAL_STALE',
  /**
   * W4（D78）：同一任务链里完全相同的外部操作已经完成，审批去重门不再建卡、
   * 不再执行（工具结果的错误码）。
   */
  'DUPLICATE_EFFECT',
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
  // W8 自动接管：用户在查看窗口里点击 / 键入后该页面归用户操作（派发前拒绝）。
  'BROWSER_USER_CONTROL',
  // W7 确定性监看：后台页上找不到监看的元素（选择器未匹配）。
  'BROWSER_SELECTOR_NOT_FOUND',
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
  /** MCPB 本地包（D73 P2 §6.5）：包损坏 / 清单非法 / 路径越界 / sha256 不符 / 运行时缺失。 */
  'MCPB_INVALID',
  'MCPB_INCOMPATIBLE',
  'MCPB_RUNTIME_MISSING',
  /** MCP Apps 渲染（D73 P3 §7.5）：资源已过期 / 无效（MIME、体积）/ 界面调用了未声明给 app 的工具 / 限流。 */
  'APP_UI_EXPIRED',
  'APP_UI_INVALID',
  'APP_UI_TOOL_NOT_ALLOWED',
  'APP_UI_RATE_LIMITED',
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
