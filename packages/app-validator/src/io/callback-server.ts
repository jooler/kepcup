import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORTS } from '@kepcup/shared';

/**
 * Loopback OAuth callback server for `--auth` (RFC 8252). Same rules as KepCup's own engine
 * (packages/core/src/apps/auth/callback-server.ts), which this mirrors without importing core
 * (core pulls in Electron-side native modules):
 *
 * - listens on 127.0.0.1 only, trying KepCup's fixed ports (they are the redirect URIs listed in
 *   the CIMD document) and falling back to a random port;
 * - `GET /callback` only, with `Host` exactly `127.0.0.1:{port}` (DNS rebinding guard);
 * - requests with a wrong `state` get a 400 and do not consume the flow;
 * - one shot: the first matching callback settles the flow and the server closes.
 */

export interface CallbackParams {
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackDelivery {
  params: CallbackParams;
  respond(result: { ok: true } | { ok: false; reason: string }): void;
}

export interface CallbackServer {
  readonly port: number;
  readonly redirectUri: string;
  readonly usedFallbackPort: boolean;
  waitForCallback(timeoutMs: number): Promise<CallbackDelivery>;
  close(): Promise<void>;
}

export class CallbackTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the browser authorization.');
    this.name = 'CallbackTimeoutError';
  }
}

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
    .replace(/"/g, '&quot;');
}

function page(result: { ok: true } | { ok: false; reason: string }): string {
  const title = result.ok ? 'Authorized' : 'Authorization failed';
  const body = result.ok
    ? 'kepcup-app received the authorization. You can close this tab.'
    : `Authorization did not complete: ${escapeHtml(result.reason)}.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>kepcup-app - ${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  connection: 'close',
} as const;

function send(
  res: ServerResponse,
  status: number,
  result: { ok: true } | { ok: false; reason: string },
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, HEADERS);
  res.end(page(result));
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

export async function startCallbackServer(options: {
  state: string;
  ports?: readonly number[];
}): Promise<CallbackServer> {
  const candidates = [...(options.ports ?? OAUTH_CALLBACK_PORTS), 0];
  let port = 0;
  let usedFallbackPort = false;
  let server: Server | null = null;
  let waiter: {
    resolve: (delivery: CallbackDelivery) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  let early: CallbackDelivery | null = null;
  let settled = false;
  let closed = false;
  const pending = new Set<ServerResponse>();

  const closeServer = (force: boolean): Promise<void> => {
    const current = server;
    if (current === null) return Promise.resolve();
    server = null;
    return new Promise((resolve) => {
      current.close(() => resolve());
      if (force) current.closeAllConnections();
      else current.closeIdleConnections();
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (settled || closed) {
      res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
      res.end();
      return;
    }
    if (req.headers.host !== `127.0.0.1:${port}`) {
      send(res, 400, {
        ok: false,
        reason: 'the request Host is not the loopback callback address',
      });
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
      send(res, 400, { ok: false, reason: 'unparsable request' });
      return;
    }
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'cache-control': 'no-store', connection: 'close' });
      res.end();
      return;
    }
    const state = url.searchParams.get('state');
    if (state === null || !safeEqual(state, options.state)) {
      send(res, 400, { ok: false, reason: 'state does not match' });
      return;
    }
    settled = true;
    pending.add(res);
    let answered = false;
    const grace = setTimeout(() => {
      answered = true;
      pending.delete(res);
      send(res, 200, { ok: false, reason: 'timed out' });
    }, 30_000);
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
        send(res, 200, result);
        void closeServer(false);
      },
    };
    if (waiter !== null) {
      const current = waiter;
      waiter = null;
      clearTimeout(current.timer);
      current.resolve(delivery);
    } else {
      early = delivery;
    }
  };

  for (const candidate of candidates) {
    const attempt = createServer(handle);
    try {
      await listenOn(attempt, candidate);
    } catch (error) {
      attempt.close();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && candidate !== 0) continue;
      throw new Error(
        `Cannot listen for the OAuth callback on loopback: ${(error as Error).message}`,
        { cause: error },
      );
    }
    server = attempt;
    port = (attempt.address() as AddressInfo).port;
    usedFallbackPort = candidate === 0;
    break;
  }
  if (server === null) throw new Error('Cannot listen for the OAuth callback on loopback.');

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`,
    usedFallbackPort,
    waitForCallback(timeoutMs) {
      if (closed) return Promise.reject(new Error('Callback server is closed.'));
      if (early !== null) return Promise.resolve(early);
      return new Promise<CallbackDelivery>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new CallbackTimeoutError());
          void closeServer(true);
        }, timeoutMs);
        timer.unref();
        waiter = { resolve, reject, timer };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (waiter !== null) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Authorization cancelled.'));
        waiter = null;
      }
      for (const res of pending) res.destroy();
      pending.clear();
      await closeServer(true);
    },
  };
}
