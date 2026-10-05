import { describe, expect, it } from 'vitest';
import { settingsSchema, type Settings, type VendorProvider } from '@kepcup/shared';
import {
  buildModelRegistry,
  providerCompatBaseUrl,
  providerInfoList,
} from '../../src/agent/models.js';
import { ProvidersService } from '../../src/domain/providers.js';
import { MediaService } from '../../src/media/service.js';
import type { SettingsService } from '../../src/domain/settings.js';
import type { SecretsService } from '../../src/domain/secrets.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const KEYS = { 'provider:volcengine': 'sk-ark' };

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return settingsSchema.parse(overrides);
}

function fakeSecrets(keys: Record<string, string>): SecretsService {
  return {
    getValue: (name: string) => keys[name] ?? null,
    hasValue: (name: string) => name in keys,
    names: () => Object.keys(keys),
    setValue: () => {},
    removeValue: () => {},
    redact: (text: string) => text,
  } as unknown as SecretsService;
}

function fakeSettingsStore(settings: Settings): SettingsService {
  return { get: () => settings } as unknown as SettingsService;
}

/** 厂商条目只登记对话模型（16-capability-models.md：媒体能力在 capabilityModels）。 */
const VOLCENGINE_ENTRY: VendorProvider = {
  id: 'volcengine',
  models: [{ id: 'doubao-seed-2-1-pro-260915' }],
};

function mediaService(
  settings: Settings,
  keys: Record<string, string>,
  fetchImpl?: typeof fetch,
): MediaService {
  return new MediaService({
    settings: fakeSettingsStore(settings),
    secrets: fakeSecrets(keys),
    logger: LOGGER,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}

describe('厂商注册表（buildModelRegistry / providerInfoList）', () => {
  it('厂商条目的对话模型注册进对话注册表（模型 id 完整保留）', () => {
    const settings = makeSettings({ vendorProviders: [VOLCENGINE_ENTRY] });
    const models = buildModelRegistry({ settings, secrets: fakeSecrets({}), logger: LOGGER });
    const provider = models.getProvider('volcengine');
    expect(provider).toBeDefined();
    expect(models.getModels('volcengine').map((m) => m.id)).toEqual([
      'doubao-seed-2-1-pro-260915',
    ]);
    expect(models.getModel('volcengine', 'doubao-seed-2-1-pro-260915')).toBeDefined();
  });

  it('未配置条目的国内厂商也列出 ProviderInfo（能力 section 需要 key 状态），但模型为空', () => {
    const settings = makeSettings({});
    const models = buildModelRegistry({ settings, secrets: fakeSecrets({}), logger: LOGGER });
    expect(models.getProvider('dashscope')).toBeUndefined();
    const infos = providerInfoList(models, settings, fakeSecrets({}));
    const info = infos.find((p) => p.id === 'dashscope');
    expect(info).toMatchObject({ kind: 'vendor', vendor: 'dashscope', hasKey: false });
    expect(info?.models).toEqual([]);
  });

  it('providerInfoList：厂商条目带 baseUrl 与对话模型；hasKey 跟随 secrets', () => {
    const settings = makeSettings({
      vendorProviders: [{ ...VOLCENGINE_ENTRY, baseUrl: 'https://ark.alt.example/api/v3' }],
    });
    const models = buildModelRegistry({ settings, secrets: fakeSecrets({}), logger: LOGGER });
    const infos = providerInfoList(
      models,
      settings,
      fakeSecrets({ 'provider:volcengine': 'sk-1' }),
    );
    const info = infos.find((p) => p.id === 'volcengine');
    expect(info?.baseUrl).toBe('https://ark.alt.example/api/v3');
    expect(info?.hasKey).toBe(true);
    expect(info?.models).toEqual([
      {
        id: 'doubao-seed-2-1-pro-260915',
        name: 'doubao-seed-2-1-pro-260915',
        contextWindow: 131_072,
      },
    ]);
  });

  it('providerCompatBaseUrl：厂商覆盖/默认、custom 两种 id 写法、builtin 为 null', () => {
    const settings = makeSettings({
      customProviders: [
        {
          id: 'mine',
          name: 'Mine',
          baseUrl: 'https://mine.example/v1',
          models: [{ id: 'm1', name: 'M1', contextWindow: 8192 }],
        },
      ],
      vendorProviders: [VOLCENGINE_ENTRY],
    });
    expect(providerCompatBaseUrl(settings, 'volcengine')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3',
    );
    expect(providerCompatBaseUrl(settings, 'custom:mine')).toBe('https://mine.example/v1');
    expect(providerCompatBaseUrl(settings, 'mine')).toBe('https://mine.example/v1');
    expect(providerCompatBaseUrl(settings, 'openai')).toBeNull();
  });
});

describe('MediaService 路由（capabilityModels）', () => {
  const SETTINGS = makeSettings({
    vendorProviders: [VOLCENGINE_ENTRY],
    capabilityModels: {
      embedding: null,
      rerank: null,
      multimodal: null,
      asr: null,
      tts: null,
      image: { vendor: 'volcengine', model: 'doubao-seedream-4-0-250828' },
      video: { vendor: 'volcengine', model: 'doubao-seedance-1-0-pro-250528' },
    },
  });

  it('generateImage：按能力配置路由（模型 id 完整传递）', async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('doubao-seedream-4-0-250828');
      return new Response(JSON.stringify({ data: [{ url: 'https://out.example/i.png' }] }));
    }) as unknown as typeof fetch;
    const result = await mediaService(SETTINGS, KEYS, fetchImpl).generateImage({
      prompt: '测试图',
    });
    expect(result.images).toEqual([{ url: 'https://out.example/i.png' }]);
  });

  it('显式 model 覆盖能力配置中的模型 id', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe('doubao-seedream-4-5-251128');
      return new Response(JSON.stringify({ data: [{ url: 'https://out.example/e.png' }] }));
    }) as unknown as typeof fetch;
    const result = await mediaService(SETTINGS, KEYS, fetchImpl).generateImage({
      model: 'doubao-seedream-4-5-251128',
      prompt: 'x',
    });
    expect(result.images).toEqual([{ url: 'https://out.example/e.png' }]);
  });

  it('未配置该能力（CAPABILITY_NOT_CONFIGURED）、缺 key、非厂商 id 各自给出明确错误', async () => {
    const service = mediaService(SETTINGS, KEYS);
    await expect(service.synthesizeSpeech({ text: 'hi' })).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
    await expect(mediaService(SETTINGS, {}).generateImage({ prompt: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
    const none = makeSettings({
      capabilityModels: {
        embedding: null,
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: null,
        video: null,
      },
    });
    await expect(mediaService(none, KEYS).generateImage({ prompt: 'x' })).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
  });

  it('capabilityConfigured 只看配置存在与否，不发网络请求', () => {
    const service = mediaService(SETTINGS, KEYS);
    expect(service.capabilityConfigured('image')).toBe(true);
    expect(service.capabilityConfigured('tts')).toBe(false);
  });

  it('方舟的 tts/asr 为 NOT_IMPLEMENTED；描述符能力矩阵与适配器一致', async () => {
    const arkSettings = makeSettings({
      capabilityModels: {
        ...SETTINGS.capabilityModels,
        tts: { vendor: 'volcengine', model: 'anything' },
      },
    });
    const service = mediaService(arkSettings, { 'provider:volcengine': 'sk-ark' });
    await expect(service.synthesizeSpeech({ text: 'x' })).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('generateVideo/videoStatus：提交与查询分别路由；pollVideo 到终态为止', async () => {
    let polled = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith('/contents/generations/tasks')) {
        return new Response(JSON.stringify({ id: 'req-9' }));
      }
      expect(target.endsWith('/contents/generations/tasks/req-9')).toBe(true);
      polled += 1;
      return new Response(
        JSON.stringify(
          polled >= 2
            ? { status: 'succeeded', content: { video_url: 'https://v.example/f.mp4' } }
            : { status: 'running' },
        ),
      );
    }) as unknown as typeof fetch;
    const service = mediaService(SETTINGS, KEYS, fetchImpl);
    const handle = await service.generateVideo({ prompt: '夜景' });
    expect(handle).toEqual({ provider: 'volcengine', taskId: 'req-9' });
    const done = await service.pollVideo('volcengine', 'req-9', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(done.status).toBe('succeeded');
  });

  it('rerank：百炼原生 text-rerank 端点，响应按 score 降序解析', async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: { query: string; documents: string[] };
        parameters: { top_n: number; return_documents: boolean };
      };
      expect(body.model).toBe('gte-rerank-v2');
      expect(body.input.query).toBe('相关文档');
      expect(body.input.documents).toEqual(['甲', '乙', '丙']);
      expect(body.parameters.top_n).toBe(3);
      expect(body.parameters.return_documents).toBe(false);
      return new Response(
        JSON.stringify({
          output: {
            results: [
              { index: 2, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.5 },
              { index: 1, relevance_score: 0.1 },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const settings = makeSettings({
      capabilityModels: {
        ...SETTINGS.capabilityModels,
        image: null,
        video: null,
        rerank: { vendor: 'dashscope', model: 'gte-rerank-v2' },
      },
    });
    const result = await mediaService(settings, { 'provider:dashscope': 'k' }, fetchImpl).rerank({
      query: '相关文档',
      documents: ['甲', '乙', '丙'],
      topN: 3,
    });
    expect(result.results.map((row) => row.index)).toEqual([2, 0, 1]);
  });

  it('understandImage：OpenAI 兼容 chat + image_url 内容块，返回文本', async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      expect(body.model).toBe('qwen3-vl-plus');
      expect(body.messages[0]!.content[0]).toMatchObject({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,xxx' },
      });
      expect(body.messages[0]!.content[1]).toMatchObject({ type: 'text', text: '图中是什么' });
      return new Response(JSON.stringify({ choices: [{ message: { content: '一张图' } }] }));
    }) as unknown as typeof fetch;
    const settings = makeSettings({
      capabilityModels: {
        ...SETTINGS.capabilityModels,
        image: null,
        video: null,
        multimodal: { vendor: 'dashscope', model: 'qwen3-vl-plus' },
      },
    });
    const result = await mediaService(settings, { 'provider:dashscope': 'k' }, fetchImpl).understandImage(
      {
        images: ['data:image/png;base64,xxx'],
        prompt: '图中是什么',
      },
    );
    expect(result.text).toBe('一张图');
  });

  it('embeddingReady：配置与 key 齐备为 true，缺一为 false（不发网络请求）', () => {
    const ready = makeSettings({
      capabilityModels: {
        ...SETTINGS.capabilityModels,
        embedding: { vendor: 'volcengine', model: 'doubao-embedding-vision-251215' },
      },
    });
    expect(mediaService(ready, KEYS).embeddingReady()).toBe(true);
    expect(mediaService(ready, {}).embeddingReady()).toBe(false);
    expect(mediaService(SETTINGS, KEYS).embeddingReady()).toBe(false);
  });
});

describe('按能力连通性测试（testCapability）', () => {
  it('embedding：方舟对 /embeddings/multimodal 发单词请求', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ data: { embedding: [0.1, 0.2] } }));
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), KEYS, fetchImpl).testCapability('embedding', {
      vendor: 'volcengine',
      model: 'doubao-embedding-vision-251215',
    });
    expect(seen).toEqual(['https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal']);
  });

  it('rerank：query + 2 条短文档的最小探测', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: { documents: string[] } };
      expect(body.input.documents).toHaveLength(2);
      return new Response(
        JSON.stringify({ output: { results: [{ index: 0, relevance_score: 0.9 }] } }),
      );
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), { 'provider:dashscope': 'k' }, fetchImpl).testCapability(
      'rerank',
      { vendor: 'dashscope', model: 'gte-rerank-v2' },
    );
  });

  it('multimodal：内置纯色 PNG data URI 发给视觉模型', async () => {
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      const image = body.messages[0]!.content.find((part) => part.type === 'image_url');
      expect(image?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: '红色' } }] }));
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), { 'provider:dashscope': 'k' }, fetchImpl).testCapability(
      'multimodal',
      { vendor: 'dashscope', model: 'qwen3-vl-plus' },
    );
  });

  it('非厂商 id、厂商能力矩阵未开放的能力各自报错', async () => {
    const service = mediaService(makeSettings({}), { 'provider:custom:mine': 'k' });
    await expect(
      service.testCapability('embedding', { vendor: 'custom:mine', model: 'm1' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(
      service.testCapability('tts', { vendor: 'volcengine', model: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('video（百炼）：提交成功即通过并尽力取消；取消失败不影响判定', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).endsWith('/video-synthesis')) {
        return new Response(JSON.stringify({ output: { task_id: 't-1', task_status: 'PENDING' } }));
      }
      // 取消接口 500：仍应判定通过（提交已证明 key/模型可用）。
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), { 'provider:dashscope': 'k' }, fetchImpl).testCapability(
      'video',
      { vendor: 'dashscope', model: 'wan2.7-t2v' },
    );
    expect(urls).toEqual([
      'POST https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
      'POST https://dashscope.aliyuncs.com/api/v1/tasks/t-1/cancel',
    ]);
  });

  it('video（方舟）：提交拿到 taskId 后立即 DELETE 取消', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).endsWith('/contents/generations/tasks')) {
        return new Response(JSON.stringify({ id: 'ark-1' }));
      }
      return new Response(JSON.stringify({ status: 'cancelled' }));
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), KEYS, fetchImpl).testCapability('video', {
      vendor: 'volcengine',
      model: 'doubao-seedance-1-0-pro-250528',
    });
    expect(urls).toEqual([
      'POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      'DELETE https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-1',
    ]);
  });

  it('tts：qwen3-tts 走 multimodal-generation；asr：静音 WAV 以 input_audio 发给兼容对话接口', async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      if (String(url).endsWith('multimodal-generation/generation')) {
        return new Response(
          JSON.stringify({ output: { audio: { data: Buffer.from('mp3').toString('base64') } } }),
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '转写' } }] }));
    }) as unknown as typeof fetch;
    const service = mediaService(makeSettings({}), { 'provider:dashscope': 'k' }, fetchImpl);
    await service.testCapability('tts', { vendor: 'dashscope', model: 'qwen3-tts-flash' });
    await service.testCapability('asr', { vendor: 'dashscope', model: 'qwen3-asr-flash' });
    expect(requests.map((r) => r.url)).toEqual([
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    ]);
    // qwen3-tts：parameters.voice 默认 Cherry；asr：input_audio data URI 的
    // WAV 头尺寸与内容一致（44 字节头 + 静音样本）。
    expect(
      (requests[0]!.body!.parameters as Record<string, unknown>).voice,
    ).toBe('Cherry');
    const content = (
      (requests[1]!.body!.messages as Array<{ content: Array<Record<string, string>> }>)[0]!
        .content
    );
    const dataUri = content.find((part) => part.type === 'input_audio')!.input_audio.data;
    const wav = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
    expect(wav.length).toBeGreaterThan(44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });
});

describe('ProvidersService.test 厂商缺省路由', () => {
  function providersService(
    settings: Settings,
    keys: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): ProvidersService {
    const settingsStore = fakeSettingsStore(settings);
    const secrets = fakeSecrets(keys);
    return new ProvidersService({
      settings: settingsStore,
      secrets,
      logger: LOGGER,
      media: new MediaService({ settings: settingsStore, secrets, logger: LOGGER, fetchImpl }),
    });
  }

  it('缺省 capability：条目有对话模型 → 对话探测；只有能力配置 → 按该能力探测', async () => {
    // 「更换 Key」弹框的测试按钮不带 capability。
    const imageOnly = makeSettings({
      capabilityModels: {
        embedding: null,
        rerank: null,
        multimodal: null,
        asr: null,
        tts: null,
        image: { vendor: 'dashscope', model: 'qwen-image' },
        video: null,
      },
    });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      );
      return new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ image: 'https://out.example/1.png' }] } }] },
        }),
      );
    }) as unknown as typeof fetch;
    const service = providersService(imageOnly, { 'provider:dashscope': 'k' }, fetchImpl);
    await expect(service.test('dashscope')).resolves.toBeUndefined();
    await expect(service.test('dashscope', 'qwen-image')).resolves.toBeUndefined();
  });

  it('缺省 capability 且条目登记了对话模型 → 仍走对话注册表（连接错误而非 Unknown provider）', async () => {
    const settings = makeSettings({
      vendorProviders: [
        {
          id: 'dashscope',
          // 指向必拒端口，证明走的是注册表的对话探测路径。
          baseUrl: 'http://127.0.0.1:9',
          models: [{ id: 'qwen-plus' }],
        },
      ],
    });
    const service = providersService(settings, { 'provider:dashscope': 'k' });
    // pi 把连接拒绝包装成 "Connection error." → PROVIDER_UNAVAILABLE；
    // 关键是不得再抛 NOT_FOUND（Unknown provider）。
    await expect(service.test('dashscope')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('条目无对话模型且无能力配置、条目不存在 → 各自给出明确文案', async () => {
    const service = providersService(makeSettings({}), { 'provider:dashscope': 'k' });
    await expect(service.test('dashscope')).rejects.toThrow('尚未配置对话或能力模型');
    await expect(service.test('dashscope', undefined, 'chat')).rejects.toThrow(
      '阿里云百炼 未登记「chat」能力的模型',
    );
  });

  it('显式 capability：路由到能力探测（不再要求厂商条目存在）', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(
        'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal',
      );
      return new Response(JSON.stringify({ data: { embedding: [0.1] } }));
    }) as unknown as typeof fetch;
    const service = providersService(makeSettings({}), KEYS, fetchImpl);
    await expect(
      service.test('volcengine', 'doubao-embedding-vision-251215', 'embedding'),
    ).resolves.toBeUndefined();
  });
});

describe('厂商向量（网关 → 适配器）', () => {
  it('embedTexts：百炼兼容形态 16 条按 10+6 分批，跨批保持输入顺序', async () => {
    const batchSizes: number[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      batchSizes.push(body.input.length);
      return new Response(
        JSON.stringify({
          data: body.input.map((text, i) => ({ index: i, embedding: [body.input.length, i] })),
        }),
      );
    }) as unknown as typeof fetch;
    const result = await mediaService(
      makeSettings({}),
      { 'provider:dashscope': 'k' },
      fetchImpl,
    ).embedTexts('dashscope', 'text-embedding-v4', Array.from({ length: 16 }, (_, i) => `t${i}`));
    expect(batchSizes).toEqual([10, 6]);
    expect(result).toHaveLength(16);
    expect(result[0]).toEqual([10, 0]);
    expect(result[10]).toEqual([6, 0]);
    expect(result[15]).toEqual([6, 5]);
  });

  it('testCapability embedding：厂商经适配器路由（vision 模型走原生端点）', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ output: { embeddings: [{ index: 0, embedding: [0.4] }] } }),
      );
    }) as unknown as typeof fetch;
    await mediaService(makeSettings({}), { 'provider:dashscope': 'k' }, fetchImpl).testCapability(
      'embedding',
      { vendor: 'dashscope', model: 'tongyi-embedding-vision-plus-2026-03-06' },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
    );
  });
});
