/**
 * Worker 入口(handleRequest)的单元测试:healthz、sid / role / 升级校验、
 * viewer 的 Origin 同源要求(CSWSH)、per-IP 会话上限、ASSETS 兜底。DO namespace
 * 与 ASSETS 用 mock fetcher——路由逻辑全在 worker.ts,DO 内部由 relay-session
 * 的纯类测试覆盖。
 */

import { describe, expect, it } from 'vitest';
import { MAX_SESSIONS_PER_IP } from '../src/ip-limiter';
import { handleRequest, type Env } from '../src/worker';

const SID = '01J8Z3V7K2QW5R8TN9XYC4M6AH';
const ORIGIN = 'https://remote.kepcup.com';

/** 记录进入 DO 的请求;ASSETS 返回可识别的标记响应。 */
function makeEnv(): { env: Env; doFetches: string[] } {
  const doFetches: string[] = [];
  const env: Env = {
    RELAY_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          doFetches.push(req.url);
          return new Response('do-ok');
        },
      }),
    } as unknown as Env['RELAY_SESSION'],
    ASSETS: {
      fetch: async (req: Request) => new Response(`asset:${new URL(req.url).pathname}`),
    } as unknown as Fetcher,
  };
  return { env, doFetches };
}

function wsRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7', ...headers },
  });
}

describe('worker 入口(审查补测)', () => {
  it('/healthz 返回 200 ok', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(new Request(`${ORIGIN}/healthz`), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('sid 不满足 ULID 形状 → 400;缺 role / role 非法 → 400;非 websocket 升级 → 426', async () => {
    const { env } = makeEnv();
    expect((await handleRequest(wsRequest('/ws/not-a-ulid?role=viewer'), env)).status).toBe(400);
    expect((await handleRequest(wsRequest(`/ws/${SID}`), env)).status).toBe(400);
    expect((await handleRequest(wsRequest(`/ws/${SID}?role=root`), env)).status).toBe(400);
    const noUpgrade = new Request(`${ORIGIN}/ws/${SID}?role=viewer`, {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    });
    expect((await handleRequest(noUpgrade, env)).status).toBe(426);
  });

  it('viewer 带跨源 Origin → 403(CSWSH);同源或缺省放行进 DO', async () => {
    const { env, doFetches } = makeEnv();
    const cross = await handleRequest(
      wsRequest(`/ws/${SID}?role=viewer`, { origin: 'https://evil.example' }),
      env,
    );
    expect(cross.status).toBe(403);
    expect(doFetches).toHaveLength(0);

    const malformed = await handleRequest(
      wsRequest(`/ws/${SID}?role=viewer`, { origin: '::not a url::' }),
      env,
    );
    expect(malformed.status).toBe(403);

    const same = await handleRequest(wsRequest(`/ws/${SID}?role=viewer`, { origin: ORIGIN }), env);
    expect(same.status).toBe(200);
    const absent = await handleRequest(wsRequest(`/ws/${SID}?role=viewer`), env);
    expect(absent.status).toBe(200);
    // anchor(Node 外连)本就不带 Origin,不限制
    const anchor = await handleRequest(wsRequest(`/ws/${SID}?role=anchor`), env);
    expect(anchor.status).toBe(200);
    expect(doFetches).toHaveLength(3);
  });

  it('per-IP 会话上限:同 IP 第 N+1 个会话 429,不同 IP 不受影响', async () => {
    const { env } = makeEnv();
    // 独立 IP:limiter 是模块级单例,前面的用例已占用默认 IP 的名额。
    const base24 = '01J8Z3V7K2QW5R8TN9XYC4M6';
    const sidOf = (i: number) => `${base24}${String(i).padStart(2, '0')}`;
    const at = (ip: string, sid: string) =>
      new Request(`${ORIGIN}/ws/${sid}?role=viewer`, {
        headers: { upgrade: 'websocket', 'cf-connecting-ip': ip },
      });
    for (let i = 0; i < MAX_SESSIONS_PER_IP; i += 1) {
      const res = await handleRequest(at('198.51.100.77', sidOf(i)), env);
      expect(res.status, `session ${i}`).toBe(200);
    }
    expect((await handleRequest(at('198.51.100.77', sidOf(99)), env)).status).toBe(429);
    // 另一个 IP 仍有名额
    expect((await handleRequest(at('198.51.100.78', sidOf(98)), env)).status).toBe(200);
  });

  it('非 /ws、/healthz 的路径兜底交给 ASSETS', async () => {
    const { env } = makeEnv();
    const res = await handleRequest(new Request(`${ORIGIN}/some/deep/link`), env);
    expect(await res.text()).toBe('asset:/some/deep/link');
  });
});
