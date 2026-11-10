import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderApi } from '@kepcup/shared';
import {
  buildModelsHeaders,
  buildModelsUrl,
  fetchProviderModels,
  parseModelsResponse,
} from '../../src/domain/provider-model-fetch.js';
import { ProvidersService } from '../../src/domain/providers.js';
import type { SecretsService } from '../../src/domain/secrets.js';

function jsonResponse(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** 只实现 Key 存取助手用到的方法（同 provider-keys.test.ts 的取向）。 */
function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    hasValue: (name: string): boolean => store.has(name),
    getValue: (name: string): string | null => store.get(name) ?? null,
    names: (): string[] => [...store.keys()].sort(),
    setValue: (name: string, value: string): void => {
      store.set(name, value);
    },
    removeValue: (name: string): void => {
      store.delete(name);
    },
    // readProviderEntries 读出条目时会补登记脱敏（漏掉会在 try 里抛错、被
    // 单条失败的 catch 静默吞掉，Key 解析表现为空）。
    registerRedactValue: (): void => {},
  } as unknown as SecretsService;
}

describe('provider model fetch', () => {
  describe('buildModelsUrl', () => {
    it('OpenAI 风格：根去尾斜杠后拼 /models（兼容根已含 /v1）', () => {
      expect(buildModelsUrl('https://api.example.com/v1/', 'openai-completions')).toBe(
        'https://api.example.com/v1/models',
      );
      expect(buildModelsUrl('https://ark.cn-beijing.volces.com/api/v3', 'openai-responses')).toBe(
        'https://ark.cn-beijing.volces.com/api/v3/models',
      );
    });

    it('Anthropic 风格：SDK 在根后追加 /v1/messages，列表同理拼 /v1/models', () => {
      expect(buildModelsUrl('https://api.z.ai/api/anthropic', 'anthropic-messages')).toBe(
        'https://api.z.ai/api/anthropic/v1/models',
      );
    });
  });

  describe('buildModelsHeaders', () => {
    it('OpenAI 风格用 Bearer；无 Key 匿名（本地服务）', () => {
      expect(buildModelsHeaders('openai-completions', 'sk-test-1234')).toEqual({
        Authorization: 'Bearer sk-test-1234',
      });
      expect(buildModelsHeaders('openai-completions', null)).toEqual({});
    });

    it('Anthropic 风格用 x-api-key + 版本头；无 Key 保留版本头', () => {
      expect(buildModelsHeaders('anthropic-messages', 'sk-ant-1234')).toEqual({
        'x-api-key': 'sk-ant-1234',
        'anthropic-version': '2023-06-01',
      });
      expect(buildModelsHeaders('anthropic-messages', null)).toEqual({
        'anthropic-version': '2023-06-01',
      });
    });
  });

  describe('parseModelsResponse', () => {
    it('解析 OpenAI 形状 { data: [...] } 与裸数组', () => {
      const wrapped = parseModelsResponse({
        data: [{ id: 'gpt-a' }, { id: 'gpt-b', owned_by: 'org' }],
      });
      expect(wrapped.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
      expect(parseModelsResponse([{ id: 'bare-a' }, { id: 'bare-b' }]).map((m) => m.id)).toEqual([
        'bare-a',
        'bare-b',
      ]);
    });

    it('Anthropic 形状取 display_name 作为展示名', () => {
      expect(
        parseModelsResponse({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }),
      ).toEqual([{ id: 'claude-a', name: 'Claude A' }]);
    });

    it('display_name 优先于 name', () => {
      expect(
        parseModelsResponse({
          data: [{ id: 'a', display_name: 'Shown', name: 'Fallback' }],
        }),
      ).toEqual([{ id: 'a', name: 'Shown' }]);
    });

    it('超长 id 跳过、超长 name 截断（单条坏条目不拖垮整个拉取）', () => {
      const models = parseModelsResponse({
        data: [
          { id: 'x'.repeat(201) },
          { id: 'ok-1', name: 'n'.repeat(201) },
          { id: 'ok-2' },
        ],
      });
      expect(models).toEqual([
        { id: 'ok-1', name: 'n'.repeat(200) },
        { id: 'ok-2' },
      ]);
    });

    it('条目数截断到上限（500）', () => {
      const rows = Array.from({ length: 510 }, (_, i) => ({ id: `m-${i}` }));
      expect(parseModelsResponse({ data: rows })).toHaveLength(500);
    });

    it('上下文提示字段取第一个正数并夹到上限', () => {
      expect(parseModelsResponse({ data: [{ id: 'a', context_length: 65536 }] })).toEqual([
        { id: 'a', contextWindow: 65536 },
      ]);
      expect(parseModelsResponse({ data: [{ id: 'b', max_context_length: 8192 }] })).toEqual([
        { id: 'b', contextWindow: 8192 },
      ]);
      expect(parseModelsResponse({ data: [{ id: 'c', context_window: 1_000_000_000 }] })).toEqual([
        { id: 'c', contextWindow: 10_000_000 },
      ]);
    });

    it('缺 id 跳过、按 id 去重', () => {
      expect(
        parseModelsResponse({ data: [{ id: 'a' }, { name: 'no-id' }, { id: 'a' }, { id: '' }] }),
      ).toEqual([{ id: 'a' }]);
    });

    it('非列表形状抛错（提示检查 baseUrl 与数据风格）', () => {
      expect(() => parseModelsResponse({ models: 'not-a-list' })).toThrow(/数据风格/);
      expect(() => parseModelsResponse('string-body')).toThrow(/数据风格/);
    });
  });

  describe('fetchProviderModels', () => {
    const base = { baseUrl: 'https://api.example.com/v1', key: 'sk-test-1234' };

    it('请求正确的 URL 与认证头，解析 OpenAI 形状响应', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const models = await fetchProviderModels({
        ...base,
        api: 'openai-completions',
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedInit = init;
          return jsonResponse(200, JSON.stringify({ data: [{ id: 'm-1' }, { id: 'm-2' }] }));
        }) as typeof fetch,
      });
      expect(capturedUrl).toBe('https://api.example.com/v1/models');
      expect(capturedInit?.method).toBe('GET');
      expect(capturedInit?.headers).toEqual({ Authorization: 'Bearer sk-test-1234' });
      expect(models.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    });

    it('Anthropic 风格请求 /v1/models + x-api-key', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      await fetchProviderModels({
        baseUrl: 'https://api.z.ai/api/anthropic',
        api: 'anthropic-messages',
        key: 'sk-ant-1234',
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          capturedUrl = String(url);
          capturedInit = init;
          return jsonResponse(200, JSON.stringify({ data: [{ id: 'claude-x' }] }));
        }) as typeof fetch,
      });
      expect(capturedUrl).toBe('https://api.z.ai/api/anthropic/v1/models');
      expect(capturedInit?.headers).toEqual({
        'x-api-key': 'sk-ant-1234',
        'anthropic-version': '2023-06-01',
      });
    });

    it('401 归类为认证失败', async () => {
      await expect(
        fetchProviderModels({
          ...base,
          api: 'openai-completions',
          fetchImpl: (async () => jsonResponse(401, '{"error":"bad key"}')) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    });

    it('404 / 网络错误归类为不可达', async () => {
      await expect(
        fetchProviderModels({
          ...base,
          api: 'openai-completions',
          fetchImpl: (async () => jsonResponse(404, '<html>not found</html>', 'text/html')) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
      await expect(
        fetchProviderModels({
          ...base,
          api: 'openai-completions',
          fetchImpl: (async () => {
            throw new Error('fetch failed');
          }) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    });

    it('429 归类为限流', async () => {
      await expect(
        fetchProviderModels({
          ...base,
          api: 'openai-completions',
          fetchImpl: (async () => jsonResponse(429, '{"error":"rate limited"}')) as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    });

    it('200 但非 JSON（例如打到了网页）给出风格检查提示', async () => {
      await expect(
        fetchProviderModels({
          ...base,
          api: 'openai-completions',
          fetchImpl: (async () => jsonResponse(200, '<html></html>', 'text/html')) as typeof fetch,
        }),
      ).rejects.toThrow(/数据风格/);
    });

    it('空列表返回空数组', async () => {
      const models = await fetchProviderModels({
        ...base,
        api: 'openai-completions',
        fetchImpl: (async () => jsonResponse(200, '{"data":[]}')) as typeof fetch,
      });
      expect(models).toEqual([]);
    });
  });

  it('api 字段覆盖三种线协议（类型面回归）', () => {
    const apis: ProviderApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages'];
    expect(apis.map((api) => buildModelsUrl('https://x.example.com', api))).toEqual([
      'https://x.example.com/models',
      'https://x.example.com/models',
      'https://x.example.com/v1/models',
    ]);
  });
});

describe('ProvidersService.fetchModels key resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeService(secrets: Record<string, string>): ProvidersService {
    return new ProvidersService({
      settings: {} as never,
      secrets: fakeSecrets(secrets),
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
  }

  /** stub 全局 fetch，记录收到的 Authorization 头（fetchModels 不透传 fetchImpl）。 */
  function stubFetch(status = 200, body = '{"data":[{"id":"m-1"}]}'): { auths: string[] } {
    const auths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        auths.push(headers.Authorization ?? '');
        return jsonResponse(status, body);
      }),
    );
    return { auths };
  }

  it('keyOverride 优先于已存 Key（新增表单未保存先拉）', async () => {
    const { auths } = stubFetch();
    const service = makeService({ 'provider:p1': 'sk-saved-1111' });
    const models = await service.fetchModels({
      provider: 'p1',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      keyOverride: 'sk-override-2222',
    });
    expect(models.map((m) => m.id)).toEqual(['m-1']);
    expect(auths).toEqual(['Bearer sk-override-2222']);
  });

  it('provider 从 secrets 解析已存 Key；未知 provider / 双缺省匿名探测', async () => {
    const { auths } = stubFetch();
    const service = makeService({ 'provider:p1': 'sk-saved-1111' });
    await service.fetchModels({
      provider: 'p1',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
    });
    await service.fetchModels({
      provider: 'p-missing',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
    });
    await service.fetchModels({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
    });
    expect(auths).toEqual(['Bearer sk-saved-1111', '', '']);
  });
});
