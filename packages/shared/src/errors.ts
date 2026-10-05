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
