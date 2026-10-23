/**
 * Worker 入口(设计 46 §4.3):`/ws/{sid}` 按 query `role=anchor|viewer` 路由到
 * RelaySession DO(idFromName = sid);`/healthz` 存活检查;其余路径交给静态资产
 * (PWA,SPA 回退)。wrangler.jsonc 的 `run_worker_first` 只把 `/ws/*` 与
 * `/healthz` 先交给脚本,资产请求不耗 Worker 调用。
 *
 * 滥用防护的 Worker 侧部分:每 isolate 的 per-IP 并发会话上限(内存 Map,
 * 不落盘、不记录 IP 本身——IP 只作为计数键存活于内存,见设计 §7)。
 */

import { RELAY_SESSION_ID_PATTERN } from './envelope';
import { IpSessionLimiter } from './ip-limiter';
import { RelaySession } from './relay-session';

export interface Env {
  /** `durable_objects` 绑定:每会话一个 RelaySession 实例。 */
  RELAY_SESSION: DurableObjectNamespace;
  /** `assets.binding`:Worker 侧兜底取静态资产。 */
  ASSETS: Fetcher;
}

/** 每 isolate 一份(模块级单例):Worker 无跨请求共享存储,这是尽力而为的上限。 */
const limiter = new IpSessionLimiter();

const WS_PATH = /^\/ws\/([^/]+)$/;

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Origin 缺省(非浏览器客户端)或与请求同源才放行;畸形 Origin 一律拒绝。 */
function sameOriginOrAbsent(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') {
    return textResponse(200, 'ok');
  }
  const match = WS_PATH.exec(url.pathname);
  if (match) {
    // sid 必须匹配 ULID 形状(26 位 Crockford Base32):DO 按名字隔离,拒绝任意串
    const sid = match[1] ?? '';
    if (!RELAY_SESSION_ID_PATTERN.test(sid)) return textResponse(400, 'invalid session id');
    const role = url.searchParams.get('role');
    if (role !== 'anchor' && role !== 'viewer') {
      return textResponse(400, 'role must be anchor or viewer');
    }
    // CSWSH 防护(审查修复):任意网页都能让访客浏览器匿名开 viewer 连接,把第三
    // 方访客的 IP 拉进 per-IP 名额、制造 DO。viewer(PWA 同源页面)要求 Origin
    // 缺省(Node 客户端)或与请求同源;anchor 是桌面 Node 外连,本就不带 Origin,
    // 且 sid 不可猜,不额外限制。
    if (role === 'viewer' && !sameOriginOrAbsent(request, url)) {
      return textResponse(403, 'cross-origin viewer connections are not allowed');
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return textResponse(426, 'websocket required');
    }
    // per-IP 并发会话上限:IP 只作内存计数键,不写日志、不传给 DO;同 sid 重连幂等续期
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!limiter.acquire(ip, sid)) {
      return textResponse(429, 'too many sessions from this address');
    }
    const id = env.RELAY_SESSION.idFromName(sid);
    return env.RELAY_SESSION.get(id).fetch(request);
  }
  // 兜底:正常配置下非 /ws、/healthz 的请求由资产层直接服务,不会进脚本
  return env.ASSETS.fetch(request);
}

export default {
  fetch: handleRequest,
};

/** wrangler 从入口模块发现 DO 类。 */
export { RelaySession };
