import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORTS, OAUTH_FLOW_TIMEOUT_MS } from '@kepcup/shared';

/**
 * 本机 OAuth 回调服务（D73，design 29 §5.1 第 4 步 / todo §4.6）。
 *
 * 自建而不用 pi-mcp 的 `OAuthCallbackServer`（它不校验 `Host`）：
 * - `node:http` 只监听 `127.0.0.1`；端口依次尝试固定候选端口，全部被占用再用 0（随机）；
 * - 只接受 `GET {OAUTH_CALLBACK_PATH}`；`Host` 头必须恰为 `127.0.0.1:{port}`
 *   （挡 DNS rebinding / 伪造 Host 的跨站请求）；
 * - 按 `state` 匹配：`state` 不符的请求（本机其他进程的伪造回调）只得到 400，**不消耗**
 *   这次流程——合法回调仍可到达；
 * - 一次性：第一个 `state` 匹配的回调结算后服务即关闭，后续请求得不到响应；
 * - 超时（默认 `OAUTH_FLOW_TIMEOUT_MS`）→ `OAUTH_FLOW_TIMEOUT`；`close()` / 取消 →
 *   `OAUTH_FLOW_CANCELLED`；
 * - 浏览器看到的结果页是**无脚本**的本地化静态 HTML（CSP `default-src 'none'`）。页面由流程
 *   在换令牌结束后经 `respond()` 决定成功还是失败，所以「已连接」只在真正连上之后才显示；
 *   令牌与 code 从不写进页面。
 */

export interface CallbackParams {
  code?: string;
  /** RFC 9207 `iss`。 */
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackDelivery {
  params: CallbackParams;
  /**
   * 结束这次浏览器请求并显示结果页。只调用一次（再调用无效）；不调用时 30 秒后自动以
   * 中性文案收尾，`close()` 会立即销毁未结束的连接。
   */
  respond(result: { ok: true } | { ok: false; reason: string }): void;
}

export interface CallbackServer {
  readonly port: number;
  /** `http://127.0.0.1:{port}/callback`。 */
  readonly redirectUri: string;
  /** 固定候选端口全被占用、回落到随机端口。 */
  readonly usedFallbackPort: boolean;
  /**
   * 等待 `state` 匹配的回调：成功得到 {@link CallbackDelivery}，超时 / 取消时 reject。
   * 超时从调用本方法起算，每个服务只能调用一次。
   */
  waitForCallback(options?: { timeoutMs?: number }): Promise<CallbackDelivery>;
  /** 关闭监听并销毁未结束的连接；未结算的等待者以 `OAUTH_FLOW_CANCELLED` 失败。幂等。 */
  close(): Promise<void>;
}

export interface StartCallbackServerOptions {
  /** 本次流程的 `state`（不可预测的随机串）。 */
  state: string;
  /** 候选端口，缺省 {@link OAUTH_CALLBACK_PORTS}；之后一律回落到 0。 */
  ports?: readonly number[];
}

const PENDING_RESPONSE_GRACE_MS = 30_000;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 无脚本的结果页（导出供测试）。 */
export function renderResultPage(result: { ok: true } | { ok: false; reason: string }): string {
  const title = result.ok ? '已连接' : '连接失败';
  const body = result.ok
    ? '已连接，可回到 KepCup。你可以关闭此页面。'
    : `连接未完成：${escapeHtml(result.reason)}。请回到 KepCup 重试。`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KepCup · ${title}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#1c1f23}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.6;color:#4a5058}@media(prefers-color-scheme:dark){body{background:#16181b;color:#eceef1}p{color:#a9afb8}}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  connection: 'close',
} as const;

function sendPage(
  res: ServerResponse,
  status: number,
  result: { ok: true } | { ok: false; reason: string },
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, PAGE_HEADERS);
  res.end(renderResultPage(result));
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

export async function startCallbackServer(
  options: StartCallbackServerOptions,
): Promise<CallbackServer> {
  const candidates = [...(options.ports ?? OAUTH_CALLBACK_PORTS), 0];
  let port = 0;
  let usedFallbackPort = false;
  let server: Server | null = null;

  type Waiter = {
    resolve: (delivery: CallbackDelivery) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  };
  let waiter: Waiter | null = null;
  /** 回调先于 waitForCallback 到达（理论上不会，但不丢）。 */
  let early: CallbackDelivery | null = null;
  let settled = false;
  let closed = false;
  const pending = new Set<ServerResponse>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (settled || closed) {
      res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
      res.end();
      return;
    }
    if (req.headers.host !== `127.0.0.1:${port}`) {
      sendPage(res, 400, { ok: false, reason: '请求的 Host 不是本机回调地址' });
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store', connection: 'close' });
      res.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      sendPage(res, 400, { ok: false, reason: '请求无法解析' });
      return;
    }
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
      res.end();
      return;
    }
    const state = url.searchParams.get('state');
    if (state === null || !safeEqual(state, options.state)) {
      // 不结算：本机其他进程的伪造回调不能让合法流程失败。
      sendPage(res, 400, { ok: false, reason: '回调参数无效（state 不匹配）' });
      return;
    }

    settled = true;
    pending.add(res);
    let answered = false;
    const grace = setTimeout(() => {
      answered = true;
      pending.delete(res);
      sendPage(res, 200, { ok: false, reason: '处理超时' });
    }, PENDING_RESPONSE_GRACE_MS);
    grace.unref();
    res.on('close', () => {
      clearTimeout(grace);
      pending.delete(res);
    });

    const get = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
    const params: CallbackParams = {
      ...(get('code') !== undefined ? { code: get('code') as string } : {}),
      ...(get('iss') !== undefined ? { iss: get('iss') as string } : {}),
      ...(get('error') !== undefined ? { error: get('error') as string } : {}),
      ...(get('error_description') !== undefined
        ? { errorDescription: get('error_description') as string }
        : {}),
    };
    const delivery: CallbackDelivery = {
      params,
      respond: (result) => {
        if (answered) return;
        answered = true;
        clearTimeout(grace);
        pending.delete(res);
        sendPage(res, 200, result);
        // 一次性：结果页发出后关闭监听（keep-alive 连接随之关闭）。
        void closeServer();
      },
    };
    if (waiter !== null) {
      const current = waiter;
      waiter = null;
      if (current.timer !== null) clearTimeout(current.timer);
      current.resolve(delivery);
    } else {
      early = delivery;
    }
  };

  /** `force`：连同未结束的连接一并销毁；否则只关监听与空闲连接，结果页发完后连接自行关闭。 */
  const closeServer = (force = false): Promise<void> => {
    const current = server;
    if (current === null) return Promise.resolve();
    server = null;
    return new Promise((resolve) => {
      current.close(() => resolve());
      if (force) current.closeAllConnections();
      else current.closeIdleConnections();
    });
  };

  for (const candidate of candidates) {
    const attempt = createServer(handle);
    try {
      await listenOn(attempt, candidate);
    } catch (error) {
      attempt.close();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && candidate !== 0) continue;
      throw new AppError('OAUTH_FLOW_FAILED', `无法在本机监听 OAuth 回调端口：${(error as Error).message}`);
    }
    server = attempt;
    port = (attempt.address() as AddressInfo).port;
    usedFallbackPort = candidate === 0;
    break;
  }
  if (server === null) {
    throw new AppError('OAUTH_FLOW_FAILED', '无法在本机监听 OAuth 回调端口');
  }

  const failWaiter = (error: Error): void => {
    if (waiter === null) return;
    const current = waiter;
    waiter = null;
    if (current.timer !== null) clearTimeout(current.timer);
    current.reject(error);
  };

  let waiting = false;
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`,
    usedFallbackPort,
    waitForCallback(waitOptions = {}) {
      if (closed) {
        return Promise.reject(new AppError('OAUTH_FLOW_CANCELLED', '授权流程已取消'));
      }
      if (waiting) {
        return Promise.reject(new AppError('INTERNAL', 'waitForCallback 只能调用一次'));
      }
      waiting = true;
      if (early !== null) return Promise.resolve(early);
      return new Promise<CallbackDelivery>((resolve, reject) => {
        const timeoutMs = waitOptions.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
        const timer = setTimeout(() => {
          failWaiter(new AppError('OAUTH_FLOW_TIMEOUT', '等待浏览器授权超时'));
          void closeServer(true);
        }, timeoutMs);
        timer.unref();
        waiter = { resolve, reject, timer };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      failWaiter(new AppError('OAUTH_FLOW_CANCELLED', '授权流程已取消'));
      for (const res of pending) res.destroy();
      pending.clear();
      await closeServer(true);
    },
  };
}
