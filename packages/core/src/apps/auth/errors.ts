import { AppError, type AppAuthReason } from '@kepcup/shared';

/**
 * 运行时需要用户（重新）授权（D73，design 29 §5.6）：`ConnectionAuthProvider` 在令牌缺失 /
 * 失效 / 需追加 scope 时抛出。它**不是**连接失败——`McpService` 不累计失败次数、不停用
 * server，而是发 `needs_auth` 状态并原样上抛；`mcp/tools.ts` 把它映射成 `SETUP_REQUIRED`
 * （`connect-app`）。运行时从不因它自行打开浏览器。
 */
export class AppAuthRequiredError extends AppError {
  readonly connectionId: string;
  readonly reason: AppAuthReason;
  /** `reason: 'scope'`：追加授权时应申请的完整 scope 集合（已授予 ∪ 挑战）。 */
  readonly scopes: string[] | undefined;

  constructor(input: {
    connectionId: string;
    reason: AppAuthReason;
    scopes?: string[] | undefined;
    message?: string;
  }) {
    super(
      'APP_AUTH_REQUIRED',
      input.message ?? defaultMessage(input.reason),
      {
        connectionId: input.connectionId,
        reason: input.reason,
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
      },
    );
    this.name = 'AppAuthRequiredError';
    this.connectionId = input.connectionId;
    this.reason = input.reason;
    this.scopes = input.scopes;
  }
}

function defaultMessage(reason: AppAuthReason): string {
  switch (reason) {
    case 'not_connected':
      return '应用尚未连接';
    case 'expired':
      return '应用连接已失效，需要重新连接';
    case 'scope':
      return '应用需要追加权限，请重新连接';
  }
}

/**
 * 在错误（及其 `cause` 链 / `AggregateError`）里找 `AppAuthRequiredError`——传输层或调用方
 * 可能把它包了一层。pi-mcp 目前原样穿出（见 mcp-auth-transport.test.ts），这里仍做防御。
 */
export function findAppAuthRequiredError(error: unknown): AppAuthRequiredError | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): AppAuthRequiredError | null => {
    if (value instanceof AppAuthRequiredError) return value;
    if (depth > 5 || typeof value !== 'object' || value === null || seen.has(value)) return null;
    seen.add(value);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) {
      const found = visit(cause, depth + 1);
      if (found !== null) return found;
    }
    const errors = (value as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        const found = visit(entry, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(error, 0);
}
