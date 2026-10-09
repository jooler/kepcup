import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORTS } from '@kepcup/shared';
import {
  renderResultPage,
  startCallbackServer,
  type CallbackServer,
} from '../../src/apps/auth/callback-server.js';

/**
 * 本机 OAuth 回调服务（D73 §4.6 callback-server）：127.0.0.1、固定端口优先再随机、仅
 * GET /callback、Host 校验、state 匹配、一次性、超时、无脚本结果页。
 */

const STATE = 'state-0123456789abcdef';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(options: Parameters<typeof startCallbackServer>[0]): Promise<CallbackServer> {
  const server = await startCallbackServer(options);
  closers.push(() => server.close());
  return server;
}

/** 空闲端口（先绑 0 取号再释放；避开并行用例对固定端口的争用）。 */
async function freePorts(count: number): Promise<number[]> {
  const holders: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holders.push(server);
    ports.push((server.address() as AddressInfo).port);
  }
  await Promise.all(holders.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

async function occupy(ports: number[]): Promise<void> {
  for (const port of ports) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
  }
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 原始请求（可伪造 Host / 方法）。 */
function raw(
  port: number,
  options: { path: string; method?: string; host?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${port}`, connection: 'close' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const callbackPath = (query: string): string => `${OAUTH_CALLBACK_PATH}?${query}`;

describe('端口选择', () => {
  it('监听 127.0.0.1，按序取第一个空闲的固定端口', async () => {
    const [a, b, c] = await freePorts(3);
    await occupy([a as number]);
    const server = await start({ state: STATE, ports: [a as number, b as number, c as number] });
    expect(server.port).toBe(b);
    expect(server.usedFallbackPort).toBe(false);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${b}${OAUTH_CALLBACK_PATH}`);
  });

  it('固定端口全部被占用 → 回落随机端口', async () => {
    const ports = await freePorts(3);
    await occupy(ports);
    const server = await start({ state: STATE, ports });
    expect(ports).not.toContain(server.port);
    expect(server.usedFallbackPort).toBe(true);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}${OAUTH_CALLBACK_PATH}`);
  });

  it('缺省候选端口是共享常量 OAUTH_CALLBACK_PORTS', async () => {
    const server = await start({ state: STATE });
    // 并行用例可能占着固定端口：要么用上了某个固定端口，要么回落到随机端口。
    expect(
      (OAUTH_CALLBACK_PORTS as readonly number[]).includes(server.port) !== server.usedFallbackPort,
    ).toBe(true);
  });
});

describe('请求校验', () => {
  it('Host 头不是 127.0.0.1:{port} 一律 400，且不消耗这次流程', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    for (const host of ['evil.example.com', `localhost:${port}`, `127.0.0.1:${(port as number) + 1}`, '127.0.0.1']) {
      const reply = await raw(server.port, {
        path: callbackPath(`code=abc&state=${STATE}`),
        host,
      });
      expect(reply.status, host).toBe(400);
      expect(reply.body).not.toContain('abc');
    }
    // 之后合法回调仍可到达。
    const ok = raw(server.port, { path: callbackPath(`code=abc&state=${STATE}&iss=https%3A%2F%2Fas.example`) });
    const delivery = await wait;
    expect(delivery.params).toEqual({ code: 'abc', iss: 'https://as.example' });
    delivery.respond({ ok: true });
    expect((await ok).status).toBe(200);
  });

  it('只接受 GET 与 /callback', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    void server.waitForCallback().catch(() => undefined);
    expect((await raw(server.port, { path: callbackPath(`state=${STATE}&code=x`), method: 'POST' })).status).toBe(405);
    expect((await raw(server.port, { path: `/other?state=${STATE}&code=x` })).status).toBe(404);
    expect((await raw(server.port, { path: '/' })).status).toBe(404);
  });

  it('state 缺失或不匹配 → 400，等待者不受影响', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    let settled = false;
    const wait = server.waitForCallback().then((d) => {
      settled = true;
      return d;
    });
    expect((await raw(server.port, { path: callbackPath('code=x') })).status).toBe(400);
    expect((await raw(server.port, { path: callbackPath('code=x&state=wrong') })).status).toBe(400);
    expect((await raw(server.port, { path: callbackPath(`code=x&state=${STATE}x`) })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    void raw(server.port, { path: callbackPath(`code=real&state=${STATE}`) });
    const delivery = await wait;
    expect(delivery.params.code).toBe('real');
    delivery.respond({ ok: true });
  });

  it('授权服务器的错误回调（access_denied）也带出 error / error_description', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    void raw(server.port, {
      path: callbackPath(`error=access_denied&error_description=user%20said%20no&state=${STATE}`),
    });
    const delivery = await wait;
    expect(delivery.params).toEqual({ error: 'access_denied', errorDescription: 'user said no' });
    delivery.respond({ ok: false, reason: '你拒绝了授权' });
  });
});

describe('一次性、超时、关闭', () => {
  it('第一个合法回调结算后服务关闭（之后连接被拒）', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    const first = raw(server.port, { path: callbackPath(`code=one&state=${STATE}`) });
    const delivery = await wait;
    delivery.respond({ ok: true });
    expect((await first).status).toBe(200);
    await expect(raw(server.port, { path: callbackPath(`code=two&state=${STATE}`) })).rejects.toBeDefined();
  });

  it('回调在 respond() 之前不返回：结果页由流程在换令牌后决定', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    let answered = false;
    const reply = raw(server.port, { path: callbackPath(`code=c&state=${STATE}`) }).then((r) => {
      answered = true;
      return r;
    });
    const delivery = await wait;
    await new Promise((r) => setTimeout(r, 40));
    expect(answered).toBe(false);
    delivery.respond({ ok: false, reason: '令牌端点拒绝' });
    delivery.respond({ ok: true }); // 第二次无效
    const page = await reply;
    expect(page.status).toBe(200);
    expect(page.body).toContain('连接失败');
    expect(page.body).toContain('令牌端点拒绝');
    expect(page.body).not.toContain('已连接，可回到 KepCup');
  });

  it('超时 → OAUTH_FLOW_TIMEOUT，端口释放', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    await expect(server.waitForCallback({ timeoutMs: 40 })).rejects.toMatchObject({
      code: 'OAUTH_FLOW_TIMEOUT',
    });
    await expect(raw(server.port, { path: callbackPath(`code=x&state=${STATE}`) })).rejects.toBeDefined();
  });

  it('close() 让等待者以 OAUTH_FLOW_CANCELLED 失败；幂等', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    await server.close();
    await expect(wait).rejects.toMatchObject({ code: 'OAUTH_FLOW_CANCELLED' });
    await server.close();
    await expect(server.waitForCallback()).rejects.toMatchObject({ code: 'OAUTH_FLOW_CANCELLED' });
  });
});

describe('结果页', () => {
  it('无脚本：不含 <script>、事件属性与外链，带严格 CSP', async () => {
    const [port] = await freePorts(1);
    const server = await start({ state: STATE, ports: [port as number] });
    const wait = server.waitForCallback();
    const reply = raw(server.port, { path: callbackPath(`code=c&state=${STATE}`) });
    (await wait).respond({ ok: true });
    const page = await reply;
    expect(page.body).toContain('已连接，可回到 KepCup');
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page.body).not.toMatch(/https?:\/\//);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('失败原因被转义，不能注入标签', () => {
    const html = renderResultPage({ ok: false, reason: '<script>alert(1)</script>"&' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
