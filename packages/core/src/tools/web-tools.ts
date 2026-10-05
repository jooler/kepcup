import { Type } from '@earendil-works/pi-ai';
import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import { TOOL_SETUP_REQUIRED } from './image-tools.js';
import type { ToolDefinition } from '../agent/types.js';

/**
 * 联网检索工具（docs/design/21-web-search.md，D62）：web_search 走用户配置
 * 的检索供应商（未配置 → SETUP_REQUIRED，orchestrator 引导设置后自动续跑）；
 * web_fetch 抓取网页文本（SSRF 防护内建）。两者都是只读公网操作，与浏览器
 * 工具同级，不需要审批。
 */

/** The slice of SearchService the web tools consume. */
export interface SearchToolFacade {
  search(
    query: string,
    maxResults?: number,
    signal?: AbortSignal,
  ): Promise<Array<{ title: string; url: string; snippet: string }>>;
  fetchPage(url: string, signal?: AbortSignal): Promise<string>;
}

export function buildWebTools(input: { search: SearchToolFacade }): ToolDefinition[] {
  const { search } = input;

  const webSearch: ToolDefinition<{ query: string; max_results?: number }> = {
    name: 'web_search',
    description:
      '联网搜索：按关键词检索公网资料，返回标题、链接与摘要列表。回答时效性问题、查证事实或寻找资料来源时使用；需要页面全文时对结果里的链接调用 web_fetch。应用未配置检索供应商时本工具不可用。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词（可用空格组合多个词）' }),
      max_results: Type.Optional(Type.Number({ description: '结果条数上限，默认 6，最多 8' })),
    }),
    execute: async (params, ctx) => {
      let hits;
      try {
        hits = await search.search(params.query, params.max_results, ctx.signal);
      } catch (error) {
        if (error instanceof AppError) {
          if (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED') {
            return {
              ok: false,
              content:
                '联网检索未配置：请告知用户需要先在应用中完成「联网检索」设置（选择供应商并填写 API key）；设置完成后本次请求会自动继续。',
              errorCode: TOOL_SETUP_REQUIRED,
            };
          }
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `检索失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'PROVIDER_UNAVAILABLE',
        };
      }
      if (hits.length === 0) return { ok: true, content: '没有找到相关结果。' };
      const lines = hits.map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet.slice(0, TOOL_OUTPUT_MAX_CHARS / 10)}`,
      );
      return {
        ok: true,
        content: `<untrusted>\n${lines.join('\n')}\n</untrusted>`,
      };
    },
  };

  const webFetch: ToolDefinition<{ url: string }> = {
    name: 'web_fetch',
    description:
      '抓取网页正文（文本化返回，html 剥标签，50k 字符截断）。用于阅读 web_search 结果里的具体页面；PDF/图片等二进制文件不支持（请用浏览器工具或技能下载处理）。',
    parameters: Type.Object({
      url: Type.String({ description: '要抓取的 http/https 地址' }),
    }),
    execute: async (params, ctx) => {
      try {
        const text = await search.fetchPage(params.url, ctx.signal);
        const truncated = truncateToBudget(text, TOOL_OUTPUT_MAX_CHARS);
        return {
          ok: true,
          content: `<untrusted>${truncated.text}${truncated.truncated ? '\n[输出已截断]' : ''}</untrusted>`,
        };
      } catch (error) {
        if (error instanceof AppError) {
          return { ok: false, content: error.message, errorCode: error.code };
        }
        return {
          ok: false,
          content: `抓取失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'PROVIDER_UNAVAILABLE',
        };
      }
    },
  };

  return [webSearch, webFetch];
}
