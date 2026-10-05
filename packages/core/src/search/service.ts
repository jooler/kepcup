import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '@kepcup/shared';
import type { SettingsService } from '../domain/settings.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import type { WebSearchProviderId } from '@kepcup/shared';
import { WEB_SEARCH_ADAPTERS, type SearchHit } from './adapters.js';

/**
 * 联网检索网关（docs/design/21-web-search.md，D62）：web_search 按用户配置的
 * 供应商路由（settings.webSearch + 密钥 `websearch:{provider}`）；web_fetch
 * 独立可用并自带 SSRF 防护（先行 URL 校验 + 连接时逐跳校验解析地址，私网/
 * 元数据拒绝；重定向逐跳复检；体量与超时上限）。未配置/缺 key 抛
 * CAPABILITY_NOT_CONFIGURED / PROVIDER_AUTH_FAILED——orchestrator 的 facade
 * 借此记结构化 setup 需求（内联设置引导）。
 */

const FETCH_MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_TEXT_MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;

/** fetchPage 的请求形态（global fetch 与注入的测试实现都满足）。 */
type FetchPageImpl = (
  url: string,
  init: { signal?: AbortSignal; redirect: 'manual'; headers: Record<string, string> },
) => Promise<Response>;

export class SearchService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #logger: CoreLogger;

  constructor(deps: {
    settings: SettingsService;
    secrets: SecretsService;
    logger: CoreLogger;
    fetchImpl?: typeof fetch;
  }) {
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#logger = deps.logger;
    if (deps.fetchImpl !== undefined) this.#fetchImpl = deps.fetchImpl;
  }

  #fetchImpl?: typeof fetch;

  /**
   * 连接时校验解析地址：fetch 内部对同一 hostname 的（再次）解析也走本
   * lookup，私网地址在 TCP 连接前即被拒绝。#validateUrl 的先行解析只做
   * 快速失败，真正的权威检查在这里——否则存在 DNS rebinding 窗口（校验时
   * 解析公网、连接时切换私网）。
   */
  readonly #connectGuard = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        dns
          .lookup(hostname, {
            all: true,
            ...(options.family === 4 || options.family === 6 ? { family: options.family } : {}),
          })
          .then((addresses) => {
            try {
              assertNoPrivateAddress(addresses);
              callback(null, addresses);
            } catch (error) {
              callback(error as Error, []);
            }
          })
          .catch((error: Error) => callback(error, []));
      },
    },
  });

  /** 默认通道：undici fetch 挂连接校验 dispatcher（fetchImpl 注入时不走）。 */
  #guardedFetch: FetchPageImpl = (url, init) =>
    undiciFetch(url, { ...init, dispatcher: this.#connectGuard }) as unknown as Promise<Response>;

  #provider(): WebSearchProviderId {
    const provider = this.#settings.get().webSearch.provider;
    if (provider === null) {
      throw new AppError('CAPABILITY_NOT_CONFIGURED', '未配置联网检索供应商');
    }
    return provider;
  }

  #apiKey(provider: WebSearchProviderId): string {
    const key = this.#secrets.getValue(`websearch:${provider}`);
    if (key === null || key.length === 0) {
      throw new AppError('PROVIDER_AUTH_FAILED', `未配置 ${provider} 的 API key`);
    }
    return key;
  }

  /** 检索供应商是否已选择（key 是否有效由调用/测试判断）。 */
  isConfigured(): boolean {
    return this.#settings.get().webSearch.provider !== null;
  }

  /** 保存/清除检索供应商的 API key（密钥表 `websearch:{provider}`）。 */
  setKey(provider: WebSearchProviderId, key: string): void {
    this.#secrets.setValue(`websearch:${provider}`, key);
  }

  removeKey(provider: WebSearchProviderId): void {
    this.#secrets.removeValue(`websearch:${provider}`);
  }

  async search(query: string, maxResults = 6, signal?: AbortSignal): Promise<SearchHit[]> {
    const provider = this.#provider();
    const adapter = WEB_SEARCH_ADAPTERS[provider];
    const hits = await adapter.search(
      { apiKey: this.#apiKey(provider), logger: this.#logger, fetchImpl: this.#fetchImpl },
      query,
      Math.max(1, Math.min(8, maxResults)),
      signal,
    );
    this.#logger.info({ provider, query: query.slice(0, 100), hits: hits.length }, 'web search');
    return hits;
  }

  /**
   * 抓取 URL 并文本化：text/* 与 JSON 原文截断，text/html 剥标签取正文；
   * 二进制一律拒绝（引导走浏览器工具或技能下载）。
   */
  async fetchPage(rawUrl: string, signal?: AbortSignal): Promise<string> {
    let url = await this.#validateUrl(rawUrl);
    // 超时覆盖整次抓取（含重定向各跳与 body 读取）；调用方的取消信号（如工具
    // 的 ctx.signal）与之合并——此前 signal 存在时 20s 上限不生效，慢速服务
    // 器可把工具挂到用户手动取消为止。
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const fetchSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const fetchImpl: FetchPageImpl = this.#fetchImpl ?? this.#guardedFetch;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          signal: fetchSignal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Kepcup/1.0; +https://kepcup.app)',
            Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
          },
        });
      } catch (error) {
        const rejection = connectRejectionText(error);
        if (rejection !== null) throw new AppError('INVALID_INPUT', rejection);
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new AppError('INVALID_INPUT', `抓取超时（${FETCH_TIMEOUT_MS / 1000}s 上限）`);
        }
        throw error;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null)
          throw new AppError('INVALID_INPUT', `重定向缺少目标（HTTP ${response.status}）`);
        url = await this.#validateUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        throw new AppError('INVALID_INPUT', `抓取失败（HTTP ${response.status}）`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (
        !/^(text\/|application\/(json|xml|javascript|x-yaml))/i.test(
          contentType.split(';')[0] ?? '',
        )
      ) {
        throw new AppError(
          'INVALID_INPUT',
          `不支持的内容类型（${contentType || '未知'}）：二进制文件请用浏览器工具或技能下载后处理`,
        );
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > FETCH_MAX_BYTES) {
        throw new AppError('INVALID_INPUT', '页面超过 3MB 体积上限');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > FETCH_MAX_BYTES) {
        throw new AppError('INVALID_INPUT', '页面超过 3MB 体积上限');
      }
      const text = buffer.toString('utf8');
      const isHtml = /text\/html/i.test(contentType);
      const body = isHtml ? htmlToText(text) : text;
      return body.length > FETCH_TEXT_MAX_CHARS
        ? `${body.slice(0, FETCH_TEXT_MAX_CHARS)}\n[内容已截断]`
        : body;
    }
    throw new AppError('INVALID_INPUT', `重定向超过 ${MAX_REDIRECTS} 跳`);
  }

  /**
   * SSRF 防护：仅 http/https；DNS 解析后拒绝私网/环回/链路本地/元数据地址；
   * 重定向由调用方逐跳重新走本检查。
   */
  async #validateUrl(rawUrl: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AppError('INVALID_INPUT', `URL 无法解析：${rawUrl.slice(0, 200)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('INVALID_INPUT', '只支持 http/https 地址');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    if (net.isIP(hostname) !== 0) {
      addresses = [hostname];
    } else {
      try {
        addresses = (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
      } catch {
        throw new AppError('INVALID_INPUT', `域名无法解析：${hostname}`);
      }
    }
    try {
      assertNoPrivateAddress(addresses.map((address) => ({ address })));
    } catch (error) {
      throw new AppError('INVALID_INPUT', (error as Error).message);
    }
    return url.toString();
  }

  /** 连通性测试（设置页与设置卡共用）：一次最小真实查询。 */
  async test(
    provider: WebSearchProviderId,
    keyOverride?: string,
  ): Promise<{ ok: boolean; resultCount?: number; elapsedMs: number; error: string | null }> {
    const started = Date.now();
    try {
      const key = keyOverride ?? this.#secrets.getValue(`websearch:${provider}`);
      if (key === null || key.length === 0) {
        return { ok: false, elapsedMs: Date.now() - started, error: '未配置 API key' };
      }
      const hits = await WEB_SEARCH_ADAPTERS[provider].search(
        { apiKey: key, logger: this.#logger, fetchImpl: this.#fetchImpl },
        'test',
        1,
      );
      return { ok: true, resultCount: hits.length, elapsedMs: Date.now() - started, error: null };
    } catch (error) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      };
    }
  }
}

/**
 * undici 会把连接阶段失败（含连接校验的私网拒绝，见 #connectGuard）包成
 * `TypeError: fetch failed`——沿 cause 链找回原文，保证拒绝原因可达用户。
 */
function connectRejectionText(error: unknown): string | null {
  let current = error instanceof Error ? error : undefined;
  while (current !== undefined) {
    if (current.message.startsWith('拒绝访问内网/保留地址')) return current.message;
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return null;
}

/**
 * 解析结果里出现私网/保留地址即抛错（错误信息以「拒绝访问内网/保留地址」
 * 开头——fetchPage 依赖该前缀从 undici 的 cause 链里还原拒绝原因）。先行
 * URL 校验与连接时校验（#connectGuard）共用同一判定。
 */
export function assertNoPrivateAddress(addresses: Array<{ address: string }>): void {
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`拒绝访问内网/保留地址：${entry.address}`);
    }
  }
}

/** IPv4/IPv6 私网、环回、链路本地、保留段与云元数据地址。 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 链路本地 + AWS/GCP 元数据 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::' || lower === '::ffff:127.0.0.1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return false;
}

/** HTML → 正文文本：去 script/style、块级标签换行、剥标签、解常见实体。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
