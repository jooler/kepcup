import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { expect, it, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createMemoryKeystore } from '@kepcup/core';
import { createHeadlessServer, type HeadlessServer } from '../src/server.js';
import { SESSION_COOKIE } from '../src/auth.js';

/**
 * 账号密码模式全链路（D102 修订）：login → cookie → /rpc WS 会话 → bootstrap 事件
 * + system.ping + 断线重连；未登录升级拒绝、错误密码 401、whoami 探测。
 */

let server: HeadlessServer;
let dataDir: string;
let cookie: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kepcup-session-it-'));
  server = await createHeadlessServer(
    {
      command: 'run',
      host: '127.0.0.1',
      port: 0,
      dataDir,
      publicUrl: 'ws://127.0.0.1:0',
      publicUrlExplicit: false,
      relayUrl: null,
      auth: 'password',
      adminUser: 'tester',
      adminPassword: 'a-long-enough-passphrase',
      keystore: 'file',
      webDir: null,
      pairingManual: false,
      autoPair: false,
      acceptRequestId: null,
      revokeDeviceId: null,
      json: false,
    },
    { env: { ...process.env, NODE_ENV: 'test' }, keystore: createMemoryKeystore() },
  );
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<{ code: number; body: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: pathname,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            code: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookie: res.headers['set-cookie'] ?? [],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function get(pathname: string, headers: Record<string, string> = {}): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function rpcUrl(): string {
  return `ws://127.0.0.1:${server.port}/rpc`;
}

class RpcClient {
  readonly ws: WebSocket;
  readonly inbox: unknown[] = [];

  constructor(headers: Record<string, string>) {
    this.ws = new WebSocket(rpcUrl(), { headers });
    this.ws.on('message', (data) => {
      this.inbox.push(JSON.parse(String(data)));
    });
  }

  async open(): Promise<this> {
    await once(this.ws, 'open');
    return this;
  }

  async next(match: (message: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(match);
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`等待 RPC 消息超时：${this.inbox.length} 条积压`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  call(method: string, id: string): void {
    this.ws.send(JSON.stringify({ t: 'q', m: method, a: [], i: id }));
  }
}

it('密码模式：RemoteHub 保持关闭（配对端点不建）', () => {
  expect(server.sessionHub).not.toBeNull();
  expect(server.services.remote?.status().enabled).toBe(false);
  expect(server.directRelay).toBeNull();
});

it('login：正确凭据发 HttpOnly Cookie；错误凭据 401；whoami 状态机', async () => {
  const bad = await post('/api/auth/login', { username: 'tester', password: 'wrong-pass-xxx' });
  expect(bad.code).toBe(401);

  const anonymous = await get('/api/auth/whoami');
  expect(anonymous.code).toBe(401);
  expect((JSON.parse(anonymous.body) as { mode: string }).mode).toBe('password');

  const ok = await post('/api/auth/login', { username: 'tester', password: 'a-long-enough-passphrase' });
  expect(ok.code).toBe(200);
  const parsed = JSON.parse(ok.body) as { ok: boolean; username: string; token: string };
  expect(parsed.username).toBe('tester');
  expect(parsed.token).toMatch(/^v1\./);
  const setCookie = ok.setCookie.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  expect(setCookie).toBeDefined();
  expect(setCookie).toContain('HttpOnly');
  cookie = setCookie?.split(';')[0] ?? '';

  const whoami = await get('/api/auth/whoami', { cookie });
  expect(whoami.code).toBe(200);
  expect((JSON.parse(whoami.body) as { username: string }).username).toBe('tester');
});

it('/rpc 会话：未登录升级被拒；登录后 bootstrap + system.ping + 重连', async () => {
  // 未认证的 WS 升级被拒（拿到地址 ≠ 能用）。
  // 未认证的 WS 升级被拒（拿到地址 ≠ 能用）。运行时差异：纯 node 下 ws 触发
  // 'unexpected-response'（HTTP 401），Electron-as-Node 下只触发 error+close——
  // 两种结局都算拒绝，断言的核心是连接绝不可能 open。
  const unauth = new WebSocket(rpcUrl());
  const rejection = await new Promise<{ kind: 'response'; status: number } | { kind: 'closed' }>(
    (resolve) => {
      unauth.on('unexpected-response', (_req, res) =>
        resolve({ kind: 'response', status: res.statusCode ?? 0 }),
      );
      unauth.on('error', () => {
        // error 后必有 close；由 close 收口。
      });
      unauth.on('open', () => resolve({ kind: 'response', status: 0 }));
      unauth.on('close', () => resolve({ kind: 'closed' }));
    },
  );
  expect(rejection.kind === 'response' ? rejection.status : 401).toBe(401);
  unauth.terminate();

  // Bearer token 也能过（脚本路径）。
  const login = await post('/api/auth/login', { username: 'tester', password: 'a-long-enough-passphrase' });
  const token = (JSON.parse(login.body) as { token: string }).token;
  const bearer = await new RpcClient({ authorization: `Bearer ${token}` }).open();
  bearer.call('system.ping', 'bearer-1');
  await bearer.next((message) => (message as { i?: string })?.i === 'bearer-1');
  bearer.ws.close();

  // Cookie 路径：连接 → 首帧即 core.status 快照（birpc 事件推送）→ RPC 往返。
  const client = await new RpcClient({ cookie }).open();
  await client.next(
    (message) => (message as { m?: string })?.m === 'core.status',
  );
  client.call('system.ping', 'it-1');
  const response = await client.next((message) => (message as { i?: string })?.i === 'it-1');
  expect((response as { t?: string }).t).toBe('s');
  expect(server.sessionHub?.sessionCount()).toBeGreaterThan(0);

  // 断线重连：cookie 仍在，新连接重新 bootstrap。
  client.ws.close(1000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reconnected = await new RpcClient({ cookie }).open();
  await reconnected.next((message) => (message as { m?: string })?.m === 'core.status');
  reconnected.call('system.ping', 'it-2');
  await reconnected.next((message) => (message as { i?: string })?.i === 'it-2');
  reconnected.ws.close();
});

it('跨源 /rpc 升级被拒（CSWSH 纵深，即使带上有效 Cookie）', async () => {
  // 注意：改密码用例在本用例之后，此刻仍是初始密码。
  const login = await post('/api/auth/login', {
    username: 'tester',
    password: 'a-long-enough-passphrase',
  });
  expect(login.code).toBe(200);
  const freshCookie = (login.setCookie ?? []).find((value) =>
    value.startsWith('kepcup_session='),
  );
  expect(freshCookie).toBeDefined();
  const evil = new WebSocket(rpcUrl(), {
    headers: { cookie: freshCookie, origin: 'https://evil.example' },
  });
  const outcome = await new Promise<{ status: number | 'open' }>((resolve) => {
    evil.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    evil.on('error', () => {
      // error 后必有 close，由 close 兜底（Electron 运行时差异同前）。
    });
    evil.on('open', () => resolve({ status: 'open' }));
    evil.on('close', () => resolve({ status: 403 }));
  });
  expect(outcome.status).not.toBe('open');
  evil.terminate();
});

it('改密码后旧 cookie 失效', async () => {
  server.auth.changePassword('a-long-enough-passphrase', 'another-long-passphrase');
  const stale = await get('/api/auth/whoami', { cookie });
  expect(stale.code).toBe(401);
  // 新密码可登录。
  const fresh = await post('/api/auth/login', { username: 'tester', password: 'another-long-passphrase' });
  expect(fresh.code).toBe(200);
});
