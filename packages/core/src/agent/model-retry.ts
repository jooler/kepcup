import type { CoreLogger } from '../infra/logger.js';

/**
 * Model request retry (pi-ai calls the OpenAI/Anthropic SDKs with
 * `maxRetries: 0`, so without this one dropped socket or one 429/503 failed
 * the whole run with "Connection error." / "429 …").
 *
 * Scheme reused from ZCode 3.14 (ZCODE_MODEL_RETRY_*: 10 retries, base 2s,
 * ×2, cap 60s, jitter ×[0.5,1], Retry-After honored up to 5 min) with the
 * official SDK classification (x-should-retry, 408/409/429/5xx incl. 529).
 * Comparable to Claude Code (10 retries, 500ms ×2, cap 32s) and Gemini CLI
 * (10 attempts, 5s ×2, cap 30s ±30%).
 *
 * Retries happen inside fetch, i.e. before the SDK sees a response: no token
 * has been streamed yet, so a retry can never duplicate visible output.
 * A stream that breaks after the 200 headers is NOT retried here (partial
 * text is already in the transcript/UI); the run fails and the banner's
 * 重试 replays it.
 */
export const MODEL_RETRY_MAX_RETRIES = 10;
export const MODEL_RETRY_BASE_DELAY_MS = 2_000;
export const MODEL_RETRY_MAX_DELAY_MS = 60_000;
/** A longer server-requested wait (quota windows) fails fast instead. */
export const MODEL_RETRY_MAX_RETRY_AFTER_MS = 5 * 60_000;

export interface ModelRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
  maxRetries: MODEL_RETRY_MAX_RETRIES,
  baseDelayMs: MODEL_RETRY_BASE_DELAY_MS,
  maxDelayMs: MODEL_RETRY_MAX_DELAY_MS,
  maxRetryAfterMs: MODEL_RETRY_MAX_RETRY_AFTER_MS,
};

/**
 * KEPCUP_MODEL_RETRY_MAX_RETRIES / _BASE_DELAY_MS / _MAX_DELAY_MS /
 * _MAX_RETRY_AFTER_MS override the defaults (0 retries disables retrying).
 */
export function modelRetryPolicyFromEnv(env: NodeJS.ProcessEnv | undefined): ModelRetryPolicy {
  const read = (name: string, fallback: number): number => {
    const raw = env?.[name];
    if (raw === undefined || raw.trim().length === 0) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };
  return {
    maxRetries: Math.min(read('KEPCUP_MODEL_RETRY_MAX_RETRIES', MODEL_RETRY_MAX_RETRIES), 100),
    baseDelayMs: read('KEPCUP_MODEL_RETRY_BASE_DELAY_MS', MODEL_RETRY_BASE_DELAY_MS),
    maxDelayMs: read('KEPCUP_MODEL_RETRY_MAX_DELAY_MS', MODEL_RETRY_MAX_DELAY_MS),
    maxRetryAfterMs: read('KEPCUP_MODEL_RETRY_MAX_RETRY_AFTER_MS', MODEL_RETRY_MAX_RETRY_AFTER_MS),
  };
}

/**
 * SDK policy (openai-node / anthropic-sdk-typescript `shouldRetry`):
 * x-should-retry wins; then 408 request timeout, 409 lock timeout, 429 rate
 * limit, every 5xx (502/503/504, Anthropic 529 overloaded …). Other 4xx
 * (400/401/403/404/422 …) are the caller's fault and fail at once.
 */
export function isRetryableStatus(status: number, headers?: Headers): boolean {
  const hint = headers?.get('x-should-retry')?.trim().toLowerCase();
  if (hint === 'true') return true;
  if (hint === 'false') return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Server-requested delay (retry-after-ms, then Retry-After seconds or HTTP
 * date), or undefined when absent/unparseable/non-positive.
 */
export function retryAfterMs(headers: Headers | undefined, now = Date.now()): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms) {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const raw = headers?.get('retry-after');
  if (raw) {
    const seconds = Number.parseFloat(raw);
    if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return undefined;
}

/** Exponential backoff (retry n ≥ 1), capped, with ZCode's ×[0.5,1] jitter. */
export function backoffDelayMs(
  retry: number,
  policy: ModelRetryPolicy,
  random: () => number = Math.random,
): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, retry - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  return Math.round(capped * (0.5 + random() * 0.5));
}

export interface ModelRetryNotice {
  /** 1-based retry number about to happen. */
  retry: number;
  maxRetries: number;
  delayMs: number;
  /** HTTP status, or null for a transport failure. */
  status: number | null;
  /** undici/libuv cause code for transport failures (ECONNRESET …). */
  code: string | null;
}

export interface RetryingFetchOptions {
  policy?: ModelRetryPolicy;
  logger: Pick<CoreLogger, 'warn'>;
  /** Log context: runId / provider / model. */
  context: { runId?: string | null; provider: string; model: string; baseUrl?: string };
  inner?: typeof globalThis.fetch;
  /** A retry is scheduled (UI status: 「n 秒后第 x/10 次重试」). */
  onRetry?: (notice: ModelRetryNotice) => void;
  /** A request succeeded after at least one retry. */
  onRecovered?: (retries: number) => void;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * fetch for model requests: retries transport failures and retryable HTTP
 * statuses before the SDK sees them, honoring Retry-After, abortable during
 * backoff, logging every failed attempt with its cause.
 */
export function createRetryingFetch(options: RetryingFetchOptions): typeof globalThis.fetch {
  const policy = options.policy ?? DEFAULT_MODEL_RETRY_POLICY;
  const random = options.random ?? Math.random;
  const wait = options.sleep ?? abortableSleep;
  const { logger, context } = options;

  return async (input, init) => {
    const inner = options.inner ?? globalThis.fetch;
    const signal = init?.signal ?? undefined;
    // A string body (the SDKs' JSON) can be re-sent; a stream cannot.
    const replayable =
      init?.body === undefined || init.body === null || typeof init.body === 'string';
    const base = {
      ...(context.runId ? { runId: context.runId } : {}),
      provider: context.provider,
      model: context.model,
      host: hostOf(input) ?? hostOf(context.baseUrl ?? ''),
    };

    for (let retry = 0; ; retry++) {
      if (retry > 0) throwIfAborted(signal);
      const canRetry = replayable && retry < policy.maxRetries;
      let response: Response;
      try {
        response = await inner(input, init);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        const cause = causeOf(error);
        const delayMs = canRetry ? backoffDelayMs(retry + 1, policy, random) : null;
        logger.warn(
          {
            ...base,
            attempt: retry + 1,
            willRetry: delayMs !== null,
            ...(delayMs !== null ? { delayMs } : {}),
            err: error,
            cause,
          },
          'model request network error',
        );
        if (delayMs === null) throw error;
        options.onRetry?.({
          retry: retry + 1,
          maxRetries: policy.maxRetries,
          delayMs,
          status: null,
          code: typeof cause?.['code'] === 'string' ? cause['code'] : null,
        });
        await wait(delayMs, signal);
        continue;
      }

      if (response.ok) {
        if (retry > 0) options.onRecovered?.(retry);
        return response;
      }
      if (!isRetryableStatus(response.status, response.headers)) return response;

      const serverDelay = retryAfterMs(response.headers);
      const tooLong = serverDelay !== undefined && serverDelay > policy.maxRetryAfterMs;
      const delayMs =
        canRetry && !tooLong ? (serverDelay ?? backoffDelayMs(retry + 1, policy, random)) : null;
      logger.warn(
        {
          ...base,
          attempt: retry + 1,
          status: response.status,
          willRetry: delayMs !== null,
          ...(delayMs !== null ? { delayMs } : {}),
          ...(serverDelay !== undefined ? { retryAfterMs: serverDelay } : {}),
        },
        'model request retryable status',
      );
      // Out of retries (or a quota-length Retry-After): the SDK turns the
      // response into its usual APIError.
      if (delayMs === null) return response;
      // Release the connection; the body of an error response is not needed.
      await response.body?.cancel().catch(() => undefined);
      options.onRetry?.({
        retry: retry + 1,
        maxRetries: policy.maxRetries,
        delayMs,
        status: response.status,
        code: null,
      });
      await wait(delayMs, signal);
    }
  };
}

/** Resolves early on abort; the caller then rethrows the abort. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('The model request was aborted.', 'AbortError');
}

function hostOf(input: unknown): string | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw).host;
  } catch {
    return null;
  }
}

/** `fetch failed` → its undici/libuv cause: { code, name, message }. */
function causeOf(error: unknown): Record<string, unknown> | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause === undefined || cause === null) return undefined;
  if (typeof cause !== 'object') return { message: String(cause) };
  const c = cause as { code?: unknown; name?: unknown; message?: unknown; errno?: unknown };
  return {
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.errno !== undefined ? { errno: c.errno } : {}),
    ...(c.name !== undefined ? { name: c.name } : {}),
    ...(c.message !== undefined ? { message: c.message } : {}),
  };
}

/** Status-line text for a scheduled retry (zh-CN, like other progress text). */
export function retryProgressText(notice: ModelRetryNotice): string {
  const seconds = Math.max(1, Math.round(notice.delayMs / 1000));
  const why =
    notice.status === null
      ? `网络连接中断${notice.code ? `（${notice.code}）` : ''}`
      : notice.status === 429
        ? '模型服务限流（429）'
        : `模型服务暂时不可用（${notice.status}）`;
  return `${why}，${seconds} 秒后重试（${notice.retry}/${notice.maxRetries}）`;
}
