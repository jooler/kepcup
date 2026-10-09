import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  createRetryingFetch,
  DEFAULT_MODEL_RETRY_POLICY,
  isRetryableStatus,
  MODEL_RETRY_MAX_RETRIES,
  modelRetryPolicyFromEnv,
  retryAfterMs,
  retryProgressText,
  type ModelRetryNotice,
} from '../../src/agent/model-retry.js';

/**
 * 模型请求重试（agent/model-retry.ts）：pi-ai 以 maxRetries 0 调 SDK，一次
 * 断连或 429/503 就整轮失败。这里在 fetch 层按 ZCode 方案重试：网络错误与
 * 408/409/429/5xx，指数退避 + 抖动，最多 10 次，遵守 Retry-After，可中止。
 */
const URL_ = 'https://api.example.com/v1/chat/completions';
const CONTEXT = { runId: 'run_x', provider: 'p', model: 'm' };

function socketError(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: `status ${code}` } }), {
    status: code,
    headers,
  });
}

function setup(inner: typeof fetch) {
  const warn = vi.fn();
  const notices: ModelRetryNotice[] = [];
  const recovered = vi.fn();
  const wrapped = createRetryingFetch({
    logger: { warn },
    context: CONTEXT,
    inner,
    random: () => 1, // no jitter: delays are exactly the capped exponential
    onRetry: (n) => notices.push(n),
    onRecovered: recovered,
  });
  return { warn, notices, recovered, wrapped };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('model retry policy', () => {
  it('classifies statuses like the official SDKs (x-should-retry wins)', () => {
    for (const code of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableStatus(code)).toBe(true);
    }
    for (const code of [400, 401, 403, 404, 422]) expect(isRetryableStatus(code)).toBe(false);
    expect(isRetryableStatus(503, new Headers({ 'x-should-retry': 'false' }))).toBe(false);
    expect(isRetryableStatus(400, new Headers({ 'x-should-retry': 'true' }))).toBe(true);
  });

  it('backs off 2s ×2 up to 60s with ×[0.5,1] jitter', () => {
    const p = DEFAULT_MODEL_RETRY_POLICY;
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffDelayMs(n, p, () => 1))).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
    expect(backoffDelayMs(1, p, () => 0)).toBe(1000);
  });

  it('parses retry-after-ms, Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3000);
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': 'Fri, 09 Oct 2026 00:00:07 GMT' }), now)).toBe(
      7000,
    );
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });

  it('reads KEPCUP_MODEL_RETRY_* overrides', () => {
    expect(modelRetryPolicyFromEnv({})).toEqual(DEFAULT_MODEL_RETRY_POLICY);
    expect(
      modelRetryPolicyFromEnv({
        KEPCUP_MODEL_RETRY_MAX_RETRIES: '3',
        KEPCUP_MODEL_RETRY_BASE_DELAY_MS: '100',
        KEPCUP_MODEL_RETRY_MAX_DELAY_MS: 'junk',
      }),
    ).toMatchObject({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 60_000 });
  });

  it('status line text names the reason, the wait and n/10', () => {
    expect(
      retryProgressText({ retry: 3, maxRetries: 10, delayMs: 8000, status: 503, code: null }),
    ).toBe('模型服务暂时不可用（503），8 秒后重试（3/10）');
    expect(
      retryProgressText({
        retry: 1,
        maxRetries: 10,
        delayMs: 2000,
        status: null,
        code: 'ECONNRESET',
      }),
    ).toBe('网络连接中断（ECONNRESET），2 秒后重试（1/10）');
  });
});

describe('createRetryingFetch', () => {
  it('retries a dropped connection and logs its network cause', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(socketError())
      .mockResolvedValueOnce(new Response('ok'));
    const { warn, notices, recovered, wrapped } = setup(inner);

    const pending = wrapped(URL_, { method: 'POST', body: '{}' });
    await vi.advanceTimersByTimeAsync(2000);
    const response = await pending;

    expect(await response.text()).toBe('ok');
    expect(inner).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([
      { retry: 1, maxRetries: 10, delayMs: 2000, status: null, code: 'UND_ERR_SOCKET' },
    ]);
    expect(recovered).toHaveBeenCalledWith(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      runId: 'run_x',
      provider: 'p',
      model: 'm',
      host: 'api.example.com',
      attempt: 1,
      willRetry: true,
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });
    expect(warn.mock.calls[0]![1]).toBe('model request network error');
  });

  it('500 then success: retried after the backoff delay', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(new Response('ok'));
    const { notices, wrapped } = setup(inner);

    const pending = wrapped(URL_, { body: '{}' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(inner).toHaveBeenCalledTimes(1); // still backing off
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(notices[0]).toMatchObject({ retry: 1, status: 500, delayMs: 2000 });
  });

  it('429 honors Retry-After instead of the backoff', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(status(429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(new Response('ok'));
    const { warn, notices, wrapped } = setup(inner);

    const pending = wrapped(URL_, { body: '{}' });
    await vi.advanceTimersByTimeAsync(6999);
    expect(inner).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(200);
    expect(notices[0]).toMatchObject({ status: 429, delayMs: 7000 });
    expect(warn.mock.calls[0]![0]).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  it('a quota-length Retry-After (> 5 min) is surfaced at once', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(status(429, { 'retry-after': '3600' }));
    const { notices, wrapped } = setup(inner);

    expect((await wrapped(URL_, { body: '{}' })).status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it('401 (and other non-retryable 4xx) fail immediately', async () => {
    for (const code of [400, 401, 403, 404, 422]) {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(status(code));
      const { notices, wrapped } = setup(inner);
      expect((await wrapped(URL_, { body: '{}' })).status).toBe(code);
      expect(inner).toHaveBeenCalledTimes(1);
      expect(notices).toEqual([]);
    }
  });

  it('gives up after 10 retries (11 attempts) and returns the last error response', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(status(503));
    const { notices, wrapped } = setup(inner);

    const pending = wrapped(URL_, { body: '{}' });
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(503);
    expect(inner).toHaveBeenCalledTimes(MODEL_RETRY_MAX_RETRIES + 1);
    expect(notices.map((n) => `${n.retry}/${n.maxRetries}:${n.delayMs}`)).toEqual([
      '1/10:2000',
      '2/10:4000',
      '3/10:8000',
      '4/10:16000',
      '5/10:32000',
      '6/10:60000',
      '7/10:60000',
      '8/10:60000',
      '9/10:60000',
      '10/10:60000',
    ]);
  });

  it('exhausted network retries rethrow the original error', async () => {
    const error = socketError();
    const inner = vi.fn<typeof fetch>().mockRejectedValue(error);
    const { warn, wrapped } = setup(inner);

    const pending = wrapped(URL_, { body: '{}' });
    const assertion = expect(pending).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await assertion;
    expect(inner).toHaveBeenCalledTimes(MODEL_RETRY_MAX_RETRIES + 1);
    expect(warn.mock.calls.at(-1)![0]).toMatchObject({ attempt: 11, willRetry: false });
  });

  it('abort during the backoff stops at once without another attempt', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(status(503));
    const { wrapped } = setup(inner);
    const controller = new AbortController();

    const pending = wrapped(URL_, { body: '{}', signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await assertion;
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('an aborted request is neither retried nor logged', async () => {
    const controller = new AbortController();
    controller.abort();
    const inner = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { warn, wrapped } = setup(inner);

    await expect(wrapped(URL_, { signal: controller.signal })).rejects.toThrow();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('x-should-retry: false is obeyed', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValue(status(503, { 'x-should-retry': 'false' }));
    const { wrapped } = setup(inner);
    expect((await wrapped(URL_, { body: '{}' })).status).toBe(503);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
