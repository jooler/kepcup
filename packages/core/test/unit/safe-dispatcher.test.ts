import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as UndiciModule from 'undici';

/**
 * 产物 URL 下载的 SSRF 加固（D125 P4，P2 审查遗留）：执行型插件返回的任意 URL 不得
 * 把宿主带进内网。IP 字面量在 fetch 之前拒绝；主机名走连接期 lookup 校验
 * （`sharedSafeDispatcher`，与 web_fetch / 搜索共用同一防线）。
 *
 * `undici.fetch` 被打桩（不发起真实网络）；连接期校验的真实集成见
 * `safe-dispatcher-connect.test.ts`。
 */

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof UndiciModule>();
  return { ...actual, fetch: fetchMock };
});

const { connectRejectionText, readBodyCapped, safeFetch, sharedSafeDispatcher } =
  await import('../../src/infra/safe-dispatcher.js');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchMock.mockReset();
});

describe('safeFetch（产物下载 SSRF 守卫）', () => {
  it('私网 / 环回 / 云元数据 IP 字面量（含 IPv6 映射与数字混淆）：拒绝且不发起请求', async () => {
    for (const url of [
      'http://127.0.0.1:8080/x.png',
      'http://10.0.0.5/x.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x.png',
      'http://[::ffff:127.0.0.1]/x.png',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://[fd00::1]/x.png',
      'http://[fe80::1]/x.png',
      'http://[64:ff9b::a9fe:a9fe]/latest/meta-data',
      // WHATWG URL normalises these to 127.0.0.1 before fetch sees them.
      'http://2130706433/x.png',
      'http://0x7f000001/x.png',
    ]) {
      await expect(safeFetch(url), url).rejects.toThrow(/内网|保留/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('公网主机：用 undici.fetch（与 Agent 同版本）并挂共享 safe dispatcher，其余 init 原样透传', async () => {
    let captured: { url: string; init: Record<string, unknown> | undefined } | null = null;
    fetchMock.mockImplementation(async (url: string, init?: Record<string, unknown>) => {
      captured = { url, init };
      return new Response('ok');
    });
    const controller = new AbortController();
    const response = await safeFetch('https://dashscope.aliyuncs.com/api/v1/tasks/x', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    expect(await response.text()).toBe('ok');
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/x');
    expect(captured!.init?.signal).toBe(controller.signal);
    expect(captured!.init?.headers).toEqual({ accept: 'application/json' });
    expect(captured!.init?.dispatcher).toBe(sharedSafeDispatcher());
  });

  it('data: 等非网络协议不挂 dispatcher（无内网面），仍走全局 fetch', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response('x');
    }) as typeof fetch;
    await safeFetch('data:image/png;base64,AAAA');
    expect((captured as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非法 URL 直接拒绝', async () => {
    await expect(safeFetch('not a url')).rejects.toThrow(/无效/);
  });

  it('连接期拒绝信息可从 cause 链还原（供工具给出人话错误）', () => {
    const inner = new Error('拒绝访问内网/保留地址：127.0.0.1');
    expect(connectRejectionText(new TypeError('fetch failed', { cause: inner }))).toBe(
      inner.message,
    );
    expect(connectRejectionText(new Error('其他'))).toBeNull();
  });
});

describe('readBodyCapped（不可信产物 URL 的字节上限）', () => {
  it('content-length 超过上限 → 取消响应体并返回 null', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-length': '10' },
    });
    expect(await readBodyCapped(response, 4)).toBeNull();
  });

  it('未声明 content-length：按流累计，超过上限即取消并返回 null', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        },
      }),
      { status: 200 },
    );
    expect(await readBodyCapped(response, 4)).toBeNull();
  });

  it('上限内完整读出（等于上限也允许）', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    const bytes = await readBodyCapped(response, 4);
    expect(bytes).not.toBeNull();
    expect([...bytes!]).toEqual([1, 2, 3, 4]);
  });

  it('无响应体 → 空 Buffer', async () => {
    expect((await readBodyCapped(new Response(null, { status: 204 }), 4))?.length).toBe(0);
  });
});
