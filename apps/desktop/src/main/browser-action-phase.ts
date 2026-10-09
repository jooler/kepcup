import { AppError, type BrowserActionPhase } from '@kepcup/shared';

/**
 * Electron-free helpers of the browser host (W1 浏览器动作确定性), unit-tested
 * in place: CDP error normalization and the `details.phase` tag core maps to
 * not_started / uncertain. The action flows live in browser-actions.ts.
 */

export function pageClosed(): AppError {
  return new AppError('BROWSER_PAGE_CLOSED', '浏览器页面已关闭');
}

/**
 * CDP / webContents failures → AppError. A gone target reads as PAGE_CLOSED;
 * a destroyed execution context (the page navigated or reloaded mid-call) is
 * not a closed page — it gets its own message without the reopen hint.
 */
export function toPageError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /execution context was destroyed|cannot find context with specified id|inspected target navigated/i.test(
      message,
    )
  ) {
    return new AppError('INTERNAL', '页面在操作过程中跳转或重载（执行上下文已销毁）');
  }
  if (/target closed|detached|destroyed/i.test(message)) {
    return pageClosed();
  }
  return new AppError('INTERNAL', message);
}

/**
 * Tags an action failure with the phase it happened in: 'pre' = before the
 * side-effecting CDP call was sent (nothing happened, safe to retry), 'post' =
 * after it (the effect may have landed). The tag rides in `details`, which the
 * RPC channel serializes across port B (packages/shared/src/rpc/channel.ts).
 */
export function withPhase(
  error: unknown,
  phase: BrowserActionPhase,
  extra: Record<string, unknown> = {},
): AppError {
  const base = toPageError(error);
  const prior =
    base.details !== null && typeof base.details === 'object' && !Array.isArray(base.details)
      ? (base.details as Record<string, unknown>)
      : base.details === undefined
        ? {}
        : { cause: base.details };
  return new AppError(base.code, base.message, { ...prior, ...extra, phase });
}
