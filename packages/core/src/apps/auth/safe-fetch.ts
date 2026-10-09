import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError, OAUTH_METADATA_MAX_BYTES } from '@kepcup/shared';
import type { McpFetch } from '@earendil-works/pi-mcp';
import {
  assertNoPrivateAddress,
  connectRejectionText,
  sharedSafeDispatcher,
} from '../../infra/safe-dispatcher.js';

/**
 * 给 pi-mcp 的发现 / 注册 / 令牌请求注入的 `McpFetch`（D73，design 29 §5.1 第 2 步）：
 *
 * - 只允许 `https:`；
 * - 走共享的连接守卫 dispatcher（`infra/safe-dispatcher.ts`，连接时逐跳校验解析地址，
 *   私网 / 保留地址直接拒绝，无 DNS rebinding 窗口）；IP 字面量不经 lookup，这里先行校验；
 * - **唯一例外**：回环主机白名单（`loopbackHosts`）里的主机可用 `http:` / `https:` 访问，且不做
 *   私网校验——来源只有两个：用户配置的自定义 server 自身的回环主机（本机开发），
 *   以及测试注入的 `oauthLoopbackAllowlist`；
 * - 响应体上限 {@link OAUTH_METADATA_MAX_BYTES}（流式计数，超限即中止）；
 * - 只跟随同源重定向（≤3 跳），跨源重定向直接拒绝。
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_SAME_ORIGIN_REDIRECTS = 3;

export interface SafeFetchOptions {
  /**
   * 允许明文 / 私网访问的回环主机。条目为 `hostname` 或 `host:port`（如 `127.0.0.1` 或
   * `127.0.0.1:8123`）；`hostname` 条目放行该主机的任意端口。可传函数以便按当前流程动态决定。
   */
  loopbackHosts?: Iterable<string> | (() => Iterable<string>);
  /** 响应体上限，缺省 `OAUTH_METADATA_MAX_BYTES`。 */
  maxBytes?: number;
  /** 总超时，缺省 15s。 */
  timeoutMs?: number;
  /** 非回环请求的 dispatcher，缺省共享的守卫 Agent（测试可换）。 */
  dispatcher?: Agent;
}

/** 回环例外用的无守卫 Agent（仅对白名单主机使用）。 */
let loopbackAgent: Agent | undefined;
function loopbackDispatcher(): Agent {
  loopbackAgent ??= new Agent();
  return loopbackAgent;
}

function isLoopbackLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || (net.isIPv4(bare) && bare.startsWith('127.'));
}

/** 自定义 server URL 是回环地址时，返回应放行的主机名；否则 null。 */
export function loopbackHostOf(serverUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  return isLoopbackLiteral(url.hostname) ? url.hostname : null;
}

/** `url` 的主机在回环白名单里（条目为 `hostname` 或 `host:port`）。 */
export function isLoopbackAllowed(url: URL, hosts: Iterable<string>): boolean {
  for (const entry of hosts) {
    if (entry === url.host || entry === url.hostname) return true;
  }
  return false;
}

function insecure(message: string, url: string): AppError {
  return new AppError('OAUTH_INSECURE_ENDPOINT', message, { endpoint: redactUrl(url) });
}

/** 错误信息里只保留 origin + path，不带 query（可能含 code / state）。 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError('OAUTH_FLOW_FAILED', `授权服务器响应过大（>${maxBytes} 字节）`);
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('OAUTH_FLOW_FAILED', `授权服务器响应过大（>${maxBytes} 字节）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function createSafeFetch(options: SafeFetchOptions = {}): McpFetch {
  const maxBytes = options.maxBytes ?? OAUTH_METADATA_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  const isAllowedLoopback = (url: URL): boolean => {
    const source = options.loopbackHosts;
    if (source === undefined) return false;
    return isLoopbackAllowed(url, typeof source === 'function' ? source() : source);
  };

  /** 校验一跳并返回应使用的 dispatcher。 */
  const checkHop = (url: URL): Agent => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw insecure(`不支持的协议 ${url.protocol}`, url.href);
    }
    if (isAllowedLoopback(url)) return loopbackDispatcher();
    if (url.protocol !== 'https:') {
      throw insecure('授权相关端点必须使用 https', url.href);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) !== 0) {
      try {
        assertNoPrivateAddress([{ address: hostname }]);
      } catch (error) {
        throw insecure((error as Error).message, url.href);
      }
    }
    return options.dispatcher ?? sharedSafeDispatcher();
  };

  return async (input, init) => {
    let url = new URL(typeof input === 'string' ? input : input.href);
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = init?.body ?? undefined;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(init?.signal ? [init.signal] : []),
    ]);
    const origin = url.origin;

    for (let hop = 0; hop <= MAX_SAME_ORIGIN_REDIRECTS; hop += 1) {
      const dispatcher = checkHop(url);
      let response: Response;
      try {
        response = (await undiciFetch(url, {
          method,
          headers: init?.headers as Record<string, string> | undefined,
          body: body as never,
          redirect: 'manual',
          signal,
          dispatcher,
        })) as unknown as Response;
      } catch (error) {
        const rejection = connectRejectionText(error);
        if (rejection !== null) throw insecure(rejection, url.href);
        throw error;
      }

      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        void response.body?.cancel().catch(() => undefined);
        const next = new URL(response.headers.get('location') as string, url);
        if (next.origin !== origin) {
          throw insecure('授权相关请求不允许跨源重定向', next.href);
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }

      const bytes = await readCapped(response, maxBytes);
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    throw insecure('重定向跳数过多', url.href);
  };
}
