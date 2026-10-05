import type { WebSearchProviderId } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 联网检索适配器（docs/design/21-web-search.md，D62）：每家供应商实现一份
 * 「发请求 → 归一结果」。结果统一为 SearchHit（标题/URL/摘要）；差异全部
 * 收敛在这里（鉴权头、参数命名、响应形状）。测试用 fetchImpl 注入。
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchCallContext {
  apiKey: string;
  logger: CoreLogger;
  fetchImpl?: typeof fetch;
}

export interface WebSearchAdapter {
  search(
    ctx: SearchCallContext,
    query: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<SearchHit[]>;
}

const HTTP_TIMEOUT_MS = 15_000;

async function fetchJson(
  ctx: SearchCallContext,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<unknown> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  // 超时与调用方取消信号（工具的 ctx.signal）合并：此前 signal 存在时 15s
  // 上限不生效，慢速供应商会把工具挂到用户手动取消为止。
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
  const response = await fetchImpl(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${body.length > 0 ? `：${body.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

/** tavily：POST https://api.tavily.com/search，AI 检索导向，带 content 摘要。 */
const tavily: WebSearchAdapter = {
  async search(ctx, query, maxResults, signal) {
    const payload = (await fetchJson(ctx, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal,
    })) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (payload.results ?? [])
      .filter((item) => typeof item.url === 'string' && item.url.length > 0)
      .map((item) => ({
        title: item.title ?? item.url ?? '',
        url: item.url ?? '',
        snippet: (item.content ?? '').slice(0, 500),
      }));
  },
};

/** brave：GET /res/v1/web/search（X-Subscription-Token），描述字段做摘要。 */
const brave: WebSearchAdapter = {
  async search(ctx, query, maxResults, signal) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(maxResults));
    const payload = (await fetchJson(ctx, url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': ctx.apiKey,
      },
      signal,
    })) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (payload.web?.results ?? [])
      .filter((item) => typeof item.url === 'string' && item.url.length > 0)
      .map((item) => ({
        title: item.title ?? item.url ?? '',
        url: item.url ?? '',
        snippet: (item.description ?? '').slice(0, 500),
      }));
  },
};

/** 博查（bocha）：POST api.bochaai.com/v1/web-search，国内直连友好的 AI 检索。 */
const bocha: WebSearchAdapter = {
  async search(ctx, query, maxResults, signal) {
    const payload = (await fetchJson(ctx, 'https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({ query, count: maxResults, summary: true }),
      signal,
    })) as {
      data?: {
        webPages?: {
          value?: Array<{ name?: string; url?: string; summary?: string; snippet?: string }>;
        };
      };
    };
    return (payload.data?.webPages?.value ?? [])
      .filter((item) => typeof item.url === 'string' && item.url.length > 0)
      .map((item) => ({
        title: item.name ?? item.url ?? '',
        url: item.url ?? '',
        snippet: (item.summary ?? item.snippet ?? '').slice(0, 500),
      }));
  },
};

export const WEB_SEARCH_ADAPTERS: Record<WebSearchProviderId, WebSearchAdapter> = {
  tavily,
  brave,
  bocha,
};
