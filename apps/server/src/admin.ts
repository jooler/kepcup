import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  isAppError,
  type PairedDevice,
  type PairingOffer,
  type PendingPairingRequest,
  type RemoteStatusOutput,
} from '@kepcup/shared';

/**
 * 本机 admin 接口（D102 §3.3）：`kepcup-server pair / devices` 子命令的后端。
 * 只接受环回地址 + Bearer token（token 首启生成，0600 存数据目录）——管理面
 * 不暴露到网络，业务流量走 /ws 直连的 D96 配对边界。
 */

export interface AdminDeps {
  token: string;
  pair(): PairingOffer;
  status(): RemoteStatusOutput;
  pendingRequests(): PendingPairingRequest[];
  confirmPairing(requestId: string, accept: boolean): { status: string };
  devices(): { devices: PairedDevice[] };
  revoke(deviceId: string): PairedDevice;
  /** D104 P2: admin-token-guarded local plugin install (the web shell has no file picker). */
  pluginsInspect(input: unknown): Promise<unknown>;
  pluginsInstall(input: unknown): Promise<unknown>;
  /**
   * Called for failures that become a 500: the admin path bypasses the RPC layer's error
   * logging, so without this the cause would be lost (the response body stays `internal`).
   */
  onInternalError?: ((path: string, error: unknown) => void) | undefined;
}

const MAX_BODY_BYTES = 64 * 1024;
/** Client-side timeouts: plugin inspect / install may unpack large archives and set up runtimes. */
const ADMIN_CALL_TIMEOUT_MS = 30_000;
const PLUGIN_CALL_TIMEOUT_MS = 5 * 60_000;

export function isAdminPath(pathname: string): boolean {
  return (
    pathname === '/admin/pair' ||
    pathname === '/admin/status' ||
    pathname === '/admin/devices' ||
    pathname === '/admin/devices/revoke' ||
    pathname === '/admin/pairing/confirm' ||
    pathname === '/admin/plugins/inspect' ||
    pathname === '/admin/plugins/install'
  );
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 常量时间比较（审查后议）：token 是环回 + 随机 32B，早退比较的时序面很小，顺手闭环。 */
function adminTokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(payload);
}

export function handleAdminRequest(
  deps: AdminDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  if (!isLoopback(req)) {
    send(res, 403, { error: 'admin endpoints are loopback-only' });
    return;
  }
  const provided = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  if (!adminTokenMatches(provided, deps.token)) {
    send(res, 401, { error: 'invalid admin token' });
    return;
  }
  if (pathname === '/admin/status' && req.method === 'GET') {
    send(res, 200, { remote: deps.status(), pendingPairing: deps.pendingRequests() });
    return;
  }
  if (pathname === '/admin/pair' && req.method === 'POST') {
    send(res, 200, deps.pair());
    return;
  }
  if (pathname === '/admin/pairing/confirm' && req.method === 'POST') {
    readJson(req)
      .then((body) => {
        const requestId = String((body as { requestId?: unknown }).requestId ?? '');
        const accept = (body as { accept?: unknown }).accept !== false;
        if (requestId.length === 0) {
          send(res, 400, { error: 'requestId required' });
          return;
        }
        send(res, 200, deps.confirmPairing(requestId, accept));
      })
      .catch((error) => send(res, 400, { error: String(error) }));
    return;
  }
  if (pathname === '/admin/devices' && req.method === 'GET') {
    send(res, 200, deps.devices());
    return;
  }
  if (pathname === '/admin/devices/revoke' && req.method === 'POST') {
    readJson(req)
      .then((body) => {
        const deviceId = String((body as { deviceId?: unknown }).deviceId ?? '');
        if (deviceId.length === 0) {
          send(res, 400, { error: 'deviceId required' });
          return;
        }
        send(res, 200, deps.revoke(deviceId));
      })
      .catch((error) => send(res, 400, { error: String(error) }));
    return;
  }
  if (pathname === '/admin/plugins/inspect' && req.method === 'POST') {
    handlePluginCall(deps, deps.pluginsInspect, pathname, req, res);
    return;
  }
  if (pathname === '/admin/plugins/install' && req.method === 'POST') {
    handlePluginCall(deps, deps.pluginsInstall, pathname, req, res);
    return;
  }
  send(res, 404, { error: 'unknown admin endpoint' });
}

/**
 * Body read failures are 400 `invalid request body`; the dep is expected to turn schema
 * failures into `AppError('INVALID_INPUT')` (400 with the code); anything else is a 500 whose
 * cause is handed to `onInternalError` and never echoed to the caller.
 */
function handlePluginCall(
  deps: Pick<AdminDeps, 'onInternalError'>,
  handle: (input: unknown) => Promise<unknown>,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  readJson(req)
    .then(async (body) => {
      try {
        send(res, 200, await handle(body));
      } catch (error) {
        if (isAppError(error)) {
          send(res, 400, { error: error.message, code: error.code });
          return;
        }
        deps.onInternalError?.(pathname, error);
        send(res, 500, { error: 'internal' });
      }
    })
    .catch(() => send(res, 400, { error: 'invalid request body' }));
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** CLI 子命令用的薄客户端（127.0.0.1 直连）。 */
export interface AdminClient {
  pair(): Promise<PairingOffer>;
  status(): Promise<{ remote: RemoteStatusOutput; pendingPairing: PendingPairingRequest[] }>;
  confirmPairing(requestId: string, accept: boolean): Promise<{ status: string }>;
  devices(): Promise<{ devices: PairedDevice[] }>;
  revoke(deviceId: string): Promise<PairedDevice>;
  pluginsInspect(source: unknown): Promise<unknown>;
  pluginsInstall(input: unknown): Promise<unknown>;
}

export function createAdminClient(port: number, token: string): AdminClient {
  const call = <T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = ADMIN_CALL_TIMEOUT_MS,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = requestAdmin(method, path, port, token, payload, (data, code) => {
        if (code !== 200) {
          reject(new Error(`admin ${path} 失败（HTTP ${code}）：${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (error) {
          reject(error);
        }
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          new Error(`admin ${path} 超时（${Math.round(timeoutMs / 1000)} 秒内服务没有响应）`),
        );
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  return {
    pair: () => call('POST', '/admin/pair'),
    status: () => call('GET', '/admin/status'),
    confirmPairing: (requestId, accept) =>
      call('POST', '/admin/pairing/confirm', { requestId, accept }),
    devices: () => call('GET', '/admin/devices'),
    revoke: (deviceId) => call('POST', '/admin/devices/revoke', { deviceId }),
    pluginsInspect: (source) =>
      call('POST', '/admin/plugins/inspect', source, PLUGIN_CALL_TIMEOUT_MS),
    pluginsInstall: (input) =>
      call('POST', '/admin/plugins/install', input, PLUGIN_CALL_TIMEOUT_MS),
  };
}

function requestAdmin(
  method: string,
  path: string,
  port: number,
  token: string,
  payload: string | null,
  onDone: (data: string, code: number) => void,
): ClientRequest {
  return request(
    { host: '127.0.0.1', port, method, path, headers: buildHeaders(token, payload) },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => onDone(Buffer.concat(chunks).toString('utf8'), res.statusCode ?? 0));
    },
  );
}

function buildHeaders(token: string, payload: string | null): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return headers;
}
