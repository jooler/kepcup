import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import {
  createSafeFetch,
  isLoopbackAllowed,
  loopbackHostOf,
} from '../../src/apps/auth/safe-fetch.js';
import {
  assertNoPrivateAddress,
  connectRejectionText,
  isPrivateAddress,
} from '../../src/infra/safe-dispatcher.js';

/**
 * OAuth 发现 / 令牌请求用的 SSRF 防护 fetch（D73 §4.6 safe-fetch）：只许 https、连接守卫拒绝
 * 私网（含 IP 字面量）、回环白名单是唯一例外、响应体上限、不跟随跨源重定向。
 * 全部用本机假服务器，不访问真实网络。
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((r) => server.close(() => r()))),
  );
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : `non-AppError: ${String(error)}`;
  }
}

describe('infra/safe-dispatcher（从 search/service 抽出）', () => {
  it('isPrivateAddress / assertNoPrivateAddress 行为不变，拒绝信息带固定前缀', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(() =>
      assertNoPrivateAddress([{ address: '8.8.8.8' }, { address: '127.0.0.1' }]),
    ).toThrow(/^拒绝访问内网\/保留地址/);
  });

  it('IP 字面量经 WHATWG URL 规范化后仍判为私网（IPv4 映射 / NAT64 / 6to4 / Teredo / 站点本地等）', () => {
    const viaUrl = (host: string): string =>
      new URL(`https://${host}/`).hostname.replace(/^\[|\]$/g, '');
    for (const host of [
      '[::ffff:127.0.0.1]', // 规范化为 ::ffff:7f00:1
      '[::ffff:10.0.0.1]',
      '[::ffff:169.254.169.254]',
      '[::ffff:c0a8:1]',
      '[::127.0.0.1]', // IPv4 兼容
      '[64:ff9b::7f00:1]', // NAT64 内嵌环回
      '[64:ff9b::a9fe:a9fe]', // NAT64 内嵌元数据地址
      '[64:ff9b:1::1]',
      '[2002:7f00:1::]', // 6to4 内嵌环回
      '[2002:a00:1::1]',
      '[2001:0:4136:e378:8000:63bf:3fff:fdd2]', // Teredo
      '[fec0::1]',
      '[fe81::1]',
      '[febf::1]',
      '[fc00::1]',
      '[ff02::1]',
      '[2001:db8::1]',
      '[::1]',
      '[::]',
      '198.18.0.1',
      '198.19.255.1',
      '192.0.0.1',
      '192.0.2.5',
      '198.51.100.7',
      '203.0.113.9',
      '0x7f.1', // 规范化为 127.0.0.1
    ]) {
      expect(isPrivateAddress(viaUrl(host)), host).toBe(true);
    }
    for (const host of [
      '[::ffff:8.8.8.8]',
      '[64:ff9b::808:808]', // NAT64 内嵌公网
      '[2002:808:808::1]',
      '[2606:4700::1111]',
      '[2a00:1450::1]',
      '198.20.0.1',
      '8.8.8.8',
    ]) {
      expect(isPrivateAddress(viaUrl(host)), host).toBe(false);
    }
  });

  it('connectRejectionText 沿 cause 链还原拒绝原因', () => {
    const inner = new Error('拒绝访问内网/保留地址：127.0.0.1');
    const wrapped = new TypeError('fetch failed', { cause: inner });
    expect(connectRejectionText(wrapped)).toBe(inner.message);
    expect(connectRejectionText(new Error('其他'))).toBeNull();
  });
});

describe('createSafeFetch：协议与地址', () => {
  it('非 https 且不在回环白名单 → OAUTH_INSECURE_ENDPOINT（不发起任何连接）', async () => {
    const safe = createSafeFetch();
    expect(await code(safe('http://example.com/.well-known/oauth-protected-resource'))).toBe(
      'OAUTH_INSECURE_ENDPOINT',
    );
    expect(await code(safe('ftp://example.com/x'))).toBe('OAUTH_INSECURE_ENDPOINT');
    expect(await code(safe('file:///etc/passwd'))).toBe('OAUTH_INSECURE_ENDPOINT');
  });

  it('IP 字面量的私网 / 回环 / 元数据地址在连接前被拒绝', async () => {
    const safe = createSafeFetch();
    for (const url of [
      'https://10.0.0.5/mcp',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1:9/',
      'https://[::1]/',
    ]) {
      expect(await code(safe(url)), url).toBe('OAUTH_INSECURE_ENDPOINT');
    }
  });

  it('解析到回环的主机名由连接守卫拒绝（无白名单时 localhost 也不行）', async () => {
    const safe = createSafeFetch();
    const error = await safe('https://localhost:8443/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('OAUTH_INSECURE_ENDPOINT');
    expect((error as AppError).message).toMatch(/^拒绝访问内网\/保留地址/);
  });

  it('回环白名单是唯一例外：hostname 条目放行任意端口，host:port 条目只放行该端口', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const byHost = createSafeFetch({ loopbackHosts: ['127.0.0.1'] });
    const response = await byHost(`${server.url}/x`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const byHostPort = createSafeFetch({ loopbackHosts: [`127.0.0.1:${server.port}`] });
    expect((await byHostPort(`${server.url}/x`)).status).toBe(200);

    const wrongPort = createSafeFetch({ loopbackHosts: [`127.0.0.1:${server.port + 1}`] });
    expect(await code(wrongPort(`${server.url}/x`))).toBe('OAUTH_INSECURE_ENDPOINT');

    // 函数形式的白名单在每次请求时求值。
    const hosts = new Set<string>();
    const dynamic = createSafeFetch({ loopbackHosts: () => hosts });
    expect(await code(dynamic(`${server.url}/x`))).toBe('OAUTH_INSECURE_ENDPOINT');
    hosts.add('127.0.0.1');
    expect((await dynamic(`${server.url}/x`)).status).toBe(200);
  });

  it('loopbackHostOf / isLoopbackAllowed', () => {
    expect(loopbackHostOf('http://127.0.0.1:8123/mcp')).toBe('127.0.0.1');
    expect(loopbackHostOf('http://localhost:3000/mcp')).toBe('localhost');
    expect(loopbackHostOf('http://[::1]:3000/mcp')).toBe('[::1]');
    expect(loopbackHostOf('https://mcp.example.com/mcp')).toBeNull();
    expect(loopbackHostOf('https://10.0.0.5/mcp')).toBeNull();
    expect(loopbackHostOf('not a url')).toBeNull();
    expect(isLoopbackAllowed(new URL('http://127.0.0.1:1/x'), ['127.0.0.1'])).toBe(true);
    expect(isLoopbackAllowed(new URL('http://127.0.0.1:1/x'), ['127.0.0.1:2'])).toBe(false);
  });
});

describe('createSafeFetch：响应体与重定向', () => {
  it('响应体超过上限即中止（content-length 声明与分块两种）', async () => {
    const big = 'x'.repeat(4096);
    const declared = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': String(big.length) });
      res.end(big);
    });
    const chunked = await listen((_req, res) => {
      res.writeHead(200);
      res.write(big.slice(0, 2048));
      setTimeout(() => res.end(big.slice(2048)), 10);
    });
    const safe = createSafeFetch({ loopbackHosts: ['127.0.0.1'], maxBytes: 1024 });
    expect(await code(safe(declared.url))).toBe('OAUTH_FLOW_FAILED');
    expect(await code(safe(chunked.url))).toBe('OAUTH_FLOW_FAILED');
    // 上限内的响应不受影响。
    const small = await listen((_req, res) => res.end('small'));
    expect(await (await safe(small.url)).text()).toBe('small');
  });

  it('同源重定向被跟随，跨源重定向被拒绝', async () => {
    const server = await listen((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' });
        res.end();
      } else if (req.url === '/cross') {
        res.writeHead(302, { location: `http://localhost:${req.socket.localPort as number}/b` });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else {
        res.end(`path=${req.url}`);
      }
    });
    const safe = createSafeFetch({ loopbackHosts: ['127.0.0.1', 'localhost'] });
    expect(await (await safe(`${server.url}/a`)).text()).toBe('path=/b');
    expect(await code(safe(`${server.url}/cross`))).toBe('OAUTH_INSECURE_ENDPOINT');
    expect(await code(safe(`${server.url}/loop`))).toBe('OAUTH_INSECURE_ENDPOINT');
  });

  it('POST 表单（令牌请求形态）原样发出，状态码与响应头保留', async () => {
    let seen = '';
    const server = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen = `${req.method} ${req.headers['content-type']} ${body}`;
        res.writeHead(400, { 'content-type': 'application/json', 'x-extra': '1' });
        res.end('{"error":"invalid_grant"}');
      });
    });
    const safe = createSafeFetch({ loopbackHosts: ['127.0.0.1'] });
    const response = await safe(`${server.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-extra')).toBe('1');
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(seen).toContain('POST application/x-www-form-urlencoded');
    expect(seen).toContain('grant_type=authorization_code&code=abc');
  });

  it('调用方的 AbortSignal 中止请求', async () => {
    const server = await listen(() => {
      /* never answers */
    });
    const safe = createSafeFetch({ loopbackHosts: ['127.0.0.1'] });
    const controller = new AbortController();
    const pending = safe(server.url, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeDefined();
  });
});
