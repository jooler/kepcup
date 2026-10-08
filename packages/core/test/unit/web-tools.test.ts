import { describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { WEB_SEARCH_ADAPTERS } from '../../src/search/adapters.js';
import {
  SearchService,
  assertNoPrivateAddress,
  htmlToText,
  isPrivateAddress,
} from '../../src/search/service.js';
import { buildWebTools } from '../../src/tools/web-tools.js';
import type { ToolContext } from '../../src/agent/types.js';
import type { CoreLogger } from '../../src/infra/logger.js';

/**
 * 联网检索（docs/design/21-web-search.md，D62）：三家适配器归一结果、
 * SearchService 的配置解析与 web_fetch 的 SSRF/文本化防护、web 工具的
 * SETUP_REQUIRED 语义。fetch 一律注入，不发真实网络请求。
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as CoreLogger;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('检索适配器归一', () => {
  it('tavily：Authorization 头 + results 归一', async () => {
    let seenInit: RequestInit | undefined;
    const hits = await WEB_SEARCH_ADAPTERS.tavily.search(
      {
        apiKey: 'k-tavily',
        logger,
        fetchImpl: async (url, init) => {
          seenInit = init;
          expect(String(url)).toContain('api.tavily.com/search');
          return jsonResponse({
            results: [
              { title: 'A', url: 'https://a.example', content: '正文A' },
              { url: 'https://b.example', content: '正文B' },
              { title: '无链接', url: '', content: '' },
            ],
          });
        },
      },
      'q',
      5,
    );
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer k-tavily');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: 'A', url: 'https://a.example', snippet: '正文A' });
    expect(hits[1]!.title).toBe('https://b.example');
  });

  it('brave：X-Subscription-Token 头 + web.results 归一', async () => {
    let seenInit: RequestInit | undefined;
    const hits = await WEB_SEARCH_ADAPTERS.brave.search(
      {
        apiKey: 'k-brave',
        logger,
        fetchImpl: async (_url, init) => {
          seenInit = init;
          return jsonResponse({
            web: { results: [{ title: 'B', url: 'https://b', description: 'd' }] },
          });
        },
      },
      'q',
      5,
    );
    expect((seenInit?.headers as Record<string, string>)['X-Subscription-Token']).toBe('k-brave');
    expect(hits[0]).toEqual({ title: 'B', url: 'https://b', snippet: 'd' });
  });

  it('bocha：Bearer 头 + data.webPages.value 归一（summary 优先）', async () => {
    const hits = await WEB_SEARCH_ADAPTERS.bocha.search(
      {
        apiKey: 'k-bocha',
        logger,
        fetchImpl: async () =>
          jsonResponse({
            data: {
              webPages: {
                value: [{ name: 'C', url: 'https://c', summary: '摘要', snippet: '片段' }],
              },
            },
          }),
      },
      'q',
      5,
    );
    expect(hits[0]).toEqual({ title: 'C', url: 'https://c', snippet: '摘要' });
  });
});

function makeService(options: {
  provider: 'tavily' | 'brave' | 'bocha' | null;
  key?: string | null;
  fetchImpl?: typeof fetch;
}): SearchService {
  return new SearchService({
    settings: { get: () => ({ webSearch: { provider: options.provider } }) } as never,
    secrets: {
      getValue: (name: string) => (name.startsWith('websearch:') ? (options.key ?? null) : null),
    } as never,
    logger,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

describe('SearchService', () => {
  it('未配置供应商 → CAPABILITY_NOT_CONFIGURED；缺 key → PROVIDER_AUTH_FAILED', async () => {
    await expect(makeService({ provider: null }).search('q')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
    await expect(makeService({ provider: 'tavily', key: null }).search('q')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
  });

  it('web_fetch：html 剥标签取正文并截断；json 原文', async () => {
    const service = makeService({
      provider: 'tavily',
      key: 'k',
      fetchImpl: (async (url: string) => {
        if (String(url).endsWith('.json')) return jsonResponse({ a: 1 });
        return new Response(
          '<html><head><style>x{}</style></head><body><script>evil()</script><h1>标题</h1><p>段落一</p><p>段落二</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }) as typeof fetch,
    });
    const html = await service.fetchPage('https://example.com/page');
    expect(html).toContain('标题');
    expect(html).toContain('段落一');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('<');
    const json = await service.fetchPage('https://example.com/page.json');
    expect(json).toContain('"a":1');
  });

  it('web_fetch：二进制内容拒绝；私网地址拒绝；重定向目标复检', async () => {
    const service = makeService({
      provider: 'tavily',
      key: 'k',
      fetchImpl: (async (url: string) => {
        if (String(url) === 'https://files.example/x.pdf') {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        if (String(url) === 'https://hop.example/x') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1:8080/' },
          });
        }
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
      }) as typeof fetch,
    });
    await expect(service.fetchPage('https://files.example/x.pdf')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.fetchPage('http://127.0.0.1:8080/')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.fetchPage('https://hop.example/x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.fetchPage('ftp://example.com/x')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('isPrivateAddress 覆盖 IPv4/IPv6 保留段与云元数据', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('assertNoPrivateAddress：私网拒绝且信息带固定前缀（fetchPage 靠它还原 cause），公网放行', () => {
    expect(() =>
      assertNoPrivateAddress([{ address: '8.8.8.8' }, { address: '2606:4700::1111' }]),
    ).not.toThrow();
    try {
      assertNoPrivateAddress([{ address: '8.8.8.8' }, { address: '169.254.169.254' }]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('拒绝访问内网/保留地址：169.254.169.254');
    }
  });

  it('test：成功返回条数与耗时；失败返回错误说明', async () => {
    const ok = makeService({
      provider: 'tavily',
      fetchImpl: (async () => jsonResponse({ results: [{ url: 'https://a' }] })) as typeof fetch,
    });
    expect(await ok.test('tavily', 'k')).toMatchObject({ ok: true, resultCount: 1 });
    const bad = makeService({
      provider: 'tavily',
      fetchImpl: (async () => jsonResponse({ error: 'nope' }, 401)) as typeof fetch,
    });
    const result = await bad.test('tavily', 'k');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });
});

describe('web 工具', () => {
  const ctx: ToolContext = {
    identity: { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' },
    signal: new AbortController().signal,
    terminate: () => {},
    progress: () => {},
  };

  it('web_search：未配置 → SETUP_REQUIRED（orchestrator 据此中断引导设置）', async () => {
    const tools = buildWebTools({
      identity: ctx.identity,
      search: {
        search: async () => {
          throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置联网检索供应商');
        },
        fetchPage: async () => '',
      },
    });
    const webSearch = tools.find((tool) => tool.name === 'web_search')!;
    const result = await webSearch.execute({ query: 'q' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SETUP_REQUIRED');
  });

  it('web_search：命中 → <untrusted> 编号结果列表', async () => {
    const tools = buildWebTools({
      identity: ctx.identity,
      search: {
        search: async () => [{ title: 'T', url: 'https://u', snippet: 'S' }],
        fetchPage: async () => '',
      },
    });
    const webSearch = tools.find((tool) => tool.name === 'web_search')!;
    const result = await webSearch.execute({ query: 'q' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('<untrusted>');
    expect(result.content).toContain('https://u');
  });

  it('htmlToText 折叠空白并解常见实体', () => {
    expect(htmlToText('<p>a&nbsp;&amp;&#39;b</p>')).toBe("a &'b");
  });
});
