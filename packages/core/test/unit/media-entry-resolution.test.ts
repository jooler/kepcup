import { describe, expect, it } from 'vitest';
import { settingsSchema, type Settings } from '@kepcup/shared';
import {
  MediaService,
  type MediaEntrySource,
  type ResolvedEntry,
} from '../../src/media/service.js';
import type { SettingsService } from '../../src/domain/settings.js';
import type { SecretsService } from '../../src/domain/secrets.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const SETTINGS: Settings = settingsSchema.parse({
  modelProviders: [
    {
      id: 'volcengine',
      vendor: 'volcengine',
      name: '火山方舟',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      enabled: true,
      models: [],
    },
  ],
  capabilityModels: {
    embedding: null,
    rerank: null,
    multimodal: null,
    asr: null,
    tts: null,
    // 全局槽位配置了 image（回退分支用）；video 未配置（未配置分支用）。
    image: { provider: 'volcengine', model: 'global-image-model' },
    video: null,
  },
});

const KEYS: Record<string, string> = { 'provider:volcengine': 'sk-ark' };

/** 百炼多模态生成的最小成功响应（一张图）。 */
const okDashscopeImage = (async () =>
  new Response(
    JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://out.example/i.png' }] } }] },
    }),
  )) as unknown as typeof fetch;

/** 方舟图像同步响应（一张图）。 */
const okArkImage = (async () =>
  new Response(
    JSON.stringify({ data: [{ url: 'https://out.example/ark.png' }] }),
  )) as unknown as typeof fetch;

function fakeSecrets(values: Record<string, string | null>): SecretsService {
  return {
    getValue: (name: string) => values[name] ?? null,
    hasValue: (name: string) => values[name] !== undefined && values[name] !== null,
    names: () => Object.keys(values),
    registerRedactValue: () => {},
  } as unknown as SecretsService;
}

function makeService(
  fetchImpl: typeof fetch,
  source: MediaEntrySource | null,
  secretValues: Record<string, string | null> = {},
): MediaService {
  const service = new MediaService({
    settings: { get: () => SETTINGS } as unknown as SettingsService,
    secrets: fakeSecrets({ ...KEYS, ...secretValues }),
    logger: LOGGER,
    fetchImpl,
  });
  if (source !== null) service.attachEntrySource(source);
  return service;
}

/** 两个条目（dashscope 引擎；第二个多实例未指定实例）。 */
const ENTRIES: ResolvedEntry[] = [
  {
    pluginId: 'io.kepcup/dashscope',
    entryId: 'qwen-image',
    model: 'qwen-image-2.0',
    displayName: 'Qwen-Image 图片生成',
    engine: 'dashscope',
    source: 'engine',
    instanceId: 'pli_a',
    instances: ['pli_a'],
  },
  {
    pluginId: 'io.kepcup/dashscope',
    entryId: 'wan-image',
    model: 'wan2.7-t2v-plus',
    displayName: '万相文生图',
    engine: 'dashscope',
    source: 'engine',
    instanceId: 'pli_a',
    instances: ['pli_a'],
  },
];

function fakeSource(
  entries: ResolvedEntry[],
  overrides: Partial<MediaEntrySource> = {},
): MediaEntrySource {
  return {
    entriesFor: async (botId, capability) => {
      if (botId === undefined || botId === '') return [];
      return capability === 'image' ? entries : [];
    },
    entryOf: async () => null,
    instancesOf: () => ['pli_a', 'pli_b'],
    instanceCredential: (_pluginId, instanceId, _key, keyOverride) => {
      if (keyOverride !== undefined) return keyOverride;
      return instanceId === 'pli_nocred' ? null : 'sk-plugin';
    },
    instanceConfig: () => ({}),
    capabilityInstanceOf: async () => ({
      pluginId: 'io.kepcup/dashscope',
      engine: 'dashscope',
      source: 'engine',
      entryId: 'qwen-image',
      model: 'qwen-image-2.0',
    }),
    ...overrides,
  } as MediaEntrySource;
}

describe('MediaService 条目解析链（D124：条目 > 全局槽位 > 未配置）', () => {
  it('① Bot 有条目时走条目：引擎适配器 + 插件实例凭据 + 条目 baseUrl 覆盖', async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        key: new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null,
      });
      return new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ image: 'https://out.example/i.png' }] } }] },
        }),
      );
    }) as unknown as typeof fetch;
    const service = makeService(
      fetchImpl,
      fakeSource(ENTRIES, {
        // dashscope 适配器的 apiRoot 语义：baseUrl 以 /compatible-mode/v1 结尾时取其
        // 前缀作原生根（与全局槽位路径同款），其他值回落内置 apiRoot。
        instanceConfig: () => ({ baseUrl: 'https://plugin.example/compatible-mode/v1' }),
      }),
    );
    const result = await service.generateImage(
      { prompt: '图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.images).toHaveLength(1);
    // dashscope 引擎适配器的原生多模态生成端点；实例 config 的 baseUrl 覆盖生效。
    expect(calls[0]?.url).toBe(
      'https://plugin.example/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(calls[0]?.key).toBe('sk-plugin');
  });

  it('① 显式 model 依次命中条目 model / displayName / entryId；未命中回首个（声明序）', async () => {
    const probe = async (model?: string): Promise<string> => {
      let usedModel = '';
      const tracing = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        usedModel = (JSON.parse(String(init?.body)) as { model?: string }).model ?? '';
        return new Response(
          JSON.stringify({
            output: { choices: [{ message: { content: [{ image: 'https://x.example/a.png' }] } }] },
          }),
        );
      }) as unknown as typeof fetch;
      const service = makeService(tracing, fakeSource(ENTRIES));
      await service.generateImage(
        { prompt: '图' },
        { loopType: 'task' },
        { botId: 'bot_1', ...(model !== undefined ? { model } : {}) },
      );
      return usedModel;
    };
    expect(await probe('qwen-image-2.0')).toBe('qwen-image-2.0'); // model 精确命中
    expect(await probe('万相文生图')).toBe('wan2.7-t2v-plus'); // displayName 命中
    expect(await probe('wan-image')).toBe('wan2.7-t2v-plus'); // entryId 命中
    expect(await probe('不存在的模型')).toBe('qwen-image-2.0'); // 未命中回首个
    expect(await probe(undefined)).toBe('qwen-image-2.0'); // 缺省 = 首个条目
  });

  it('① 多实例未指定 → INSTANCE_AMBIGUOUS（payload 带插件 / 条目 / 实例全集）', async () => {
    const service = makeService(
      okDashscopeImage,
      fakeSource([{ ...ENTRIES[1]!, instanceId: undefined, instances: ['pli_a', 'pli_b'] }]),
    );
    await expect(
      service.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'INSTANCE_AMBIGUOUS',
      details: {
        pluginId: 'io.kepcup/dashscope',
        entryId: 'wan-image',
        instances: ['pli_a', 'pli_b'],
      },
    });
  });

  it('① 实例缺凭据 → CAPABILITY_NOT_CONFIGURED（details 定位插件 / 条目 / 实例）', async () => {
    const service = makeService(
      okDashscopeImage,
      fakeSource([{ ...ENTRIES[0]!, instanceId: 'pli_nocred', instances: ['pli_nocred'] }]),
    );
    await expect(
      service.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      details: { pluginId: 'io.kepcup/dashscope', instanceId: 'pli_nocred' },
    });
  });

  it('① 零实例 → CAPABILITY_NOT_CONFIGURED（details 带条目定位，无 instanceId）', async () => {
    const service = makeService(
      okDashscopeImage,
      fakeSource([{ ...ENTRIES[0]!, instanceId: undefined, instances: [] }]),
    );
    await expect(
      service.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      details: { pluginId: 'io.kepcup/dashscope', entryId: 'qwen-image' },
    });
  });

  it('testCapabilityEntry 数据型条目：未知引擎先于实例解析报 PLUGIN_ENGINE_UNKNOWN（D124 顺序不变）', async () => {
    const service = makeService(
      okArkImage,
      fakeSource([], {
        entryOf: async () => ({
          id: 'ghost-engine',
          capability: 'image',
          model: 'ghost-model',
          engine: 'missing-engine',
        }),
        instancesOf: () => [],
        hostedAdapterOf: async () => null,
      }),
    );
    await expect(service.testCapabilityEntry('io.test/x', 'ghost-engine')).rejects.toMatchObject({
      code: 'PLUGIN_ENGINE_UNKNOWN',
    });
  });

  it('② 条目仓库返回空 → 原全局槽位路径生效（settings 实例 + 全局模型）', async () => {    const service = makeService(okArkImage, fakeSource([]));
    const result = await service.generateImage(
      { prompt: '图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.url).toBe('https://out.example/ark.png');
  });

  it('② 未装任何插件（未注入条目仓库）→ 行为与从前一致（全局路径 / 未配置报错）', async () => {
    const service = makeService(okArkImage, null);
    const result = await service.generateImage(
      { prompt: '图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.images).toHaveLength(1);
    // video 全局未配置：现状语义 CAPABILITY_NOT_CONFIGURED。
    await expect(
      service.generateVideo(
        { prompt: 'v' },
        { loopType: 'task', botId: 'bot_1' },
        { botId: 'bot_1' },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' });
    // resolve 缺省（无 botId）也走全局路径。
    await expect(
      service.generateVideo({ prompt: 'v' }, { loopType: 'task' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
  });

  it('① video 条目路径：generateVideo 返回插件实例 id，videoStatus 按插件实例往返', async () => {
    const submitted: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/contents/generations/tasks')) {
        submitted.push(String(url));
        return new Response(JSON.stringify({ id: 'task-9' }));
      }
      return new Response(
        JSON.stringify({ status: 'succeeded', content: { video_url: 'https://v.example/f.mp4' } }),
      );
    }) as unknown as typeof fetch;
    const videoEntry: ResolvedEntry = {
      pluginId: 'io.kepcup/ark',
      entryId: 'seedance',
      model: 'doubao-seedance-2-0',
      engine: 'volcengine-ark',
      source: 'engine',
      instanceId: 'pli_s',
      instances: ['pli_s'],
    };
    const service = makeService(
      fetchImpl,
      fakeSource([], {
        entriesFor: async (_botId, capability) => (capability === 'video' ? [videoEntry] : []),
        instanceCredential: () => 'sk-plugin',
        instanceConfig: () => ({}), // 无覆盖 → 用引擎厂商内置根
        capabilityInstanceOf: async () => ({
          pluginId: 'io.kepcup/ark',
          engine: 'volcengine-ark',
          source: 'engine',
          entryId: 'seedance',
          model: 'doubao-seedance-2-0',
        }),
      }),
    );
    const handle = await service.generateVideo(
      { prompt: '夜景' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    // provider 是插件实例 id（pli_…），请求打到方舟内置根（无 config 覆盖时）。
    expect(handle.provider).toBe('pli_s');
    expect(submitted[0]).toContain(
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
    );
    const status = await service.videoStatus(handle.provider, handle.taskId);
    expect(status.status).toBe('succeeded');
  });
});

describe('D125 P2 执行型条目（source: plugin → HostedAdapter 分支）', () => {
  const HOSTED_PLUGIN = 'io.test/hosted';
  const HOSTED_ENTRY: ResolvedEntry = {
    pluginId: HOSTED_PLUGIN,
    entryId: 'hosted-image',
    model: 'hosted-model-1',
    engine: '',
    source: 'plugin',
    displayName: '托管图片',
    instanceId: 'pli_h',
    instances: ['pli_h'],
  };

  it('① 插件条目 → 托管适配器收到条目 / 实例 / locale 上下文，不碰引擎与 Key', async () => {
    const calls: Array<{
      ctx: {
        entryRef?: { pluginId: string; entryId: string };
        instanceId?: string;
        locale?: string;
      };
      model: string;
      params: { prompt: string };
    }> = [];
    const adapter = {
      embed: async () => [],
      generateImage: async (ctx: never, model: string, params: { prompt: string }) => {
        calls.push({ ctx, model, params });
        return { images: [{ url: 'https://hosted.example/out.png' }] };
      },
    };
    const service = makeService(
      okArkImage,
      fakeSource([HOSTED_ENTRY], {
        hostedAdapterOf: async () => adapter as never,
        capabilityInstanceOf: async () => ({
          pluginId: HOSTED_PLUGIN,
          engine: '',
          source: 'plugin' as const,
          entryId: 'hosted-image',
          model: 'hosted-model-1',
        }),
      }),
    );
    const result = await service.generateImage(
      { prompt: '托管图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.images[0]?.url).toBe('https://hosted.example/out.png');
    expect(calls[0]).toMatchObject({
      model: 'hosted-model-1',
      params: { prompt: '托管图' },
      ctx: {
        entryRef: { pluginId: HOSTED_PLUGIN, entryId: 'hosted-image' },
        instanceId: 'pli_h',
        locale: 'zh-CN',
      },
    });
  });

  it('① 插件条目多实例未指定 → INSTANCE_AMBIGUOUS；零实例 → CAPABILITY_NOT_CONFIGURED', async () => {
    const ambiguous = makeService(
      okArkImage,
      fakeSource([{ ...HOSTED_ENTRY, instanceId: undefined, instances: ['pli_a', 'pli_b'] }], {
        hostedAdapterOf: async () => ({ embed: async () => [] }) as never,
      }),
    );
    await expect(
      ambiguous.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({ code: 'INSTANCE_AMBIGUOUS' });

    const zero = makeService(
      okArkImage,
      fakeSource([{ ...HOSTED_ENTRY, instanceId: undefined, instances: [] }], {
        hostedAdapterOf: async () => ({ embed: async () => [] }) as never,
      }),
    );
    await expect(
      zero.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      details: { pluginId: HOSTED_PLUGIN, entryId: 'hosted-image' },
    });
  });

  it('① 托管运行时未装配（hostedAdapterOf = null）→ NOT_IMPLEMENTED', async () => {
    const service = makeService(
      okArkImage,
      fakeSource([HOSTED_ENTRY], { hostedAdapterOf: async () => null }),
    );
    await expect(
      service.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('testCapabilityEntry：执行型条目经托管适配器同一 invoke 路径（探针生成）', async () => {
    const calls: Array<{ model: string; prompt: string }> = [];
    const adapter = {
      embed: async () => [],
      generateImage: async (_ctx: never, model: string, params: { prompt: string }) => {
        calls.push({ model, prompt: params.prompt });
        return { images: [{ url: 'https://hosted.example/probe.png' }] };
      },
    };
    const entry = { id: 'hosted-image', capability: 'image' as const, model: 'hosted-model-1' };
    const source = fakeSource([], {
      entryOf: async () => entry,
      instancesOf: () => ['pli_h'],
      hostedAdapterOf: async () => adapter as never,
    });
    const service = makeService(okArkImage, source);
    await service.testCapabilityEntry(HOSTED_PLUGIN, 'hosted-image');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('hosted-model-1');
    expect(calls[0]?.prompt.length).toBeGreaterThan(0);
  });

  it('testCapabilityEntry：执行型条目 + 运行时未装配 → NOT_IMPLEMENTED（不再是 NOT_FOUND）', async () => {
    const source = fakeSource([], {
      entryOf: async () => ({
        id: 'hosted-image',
        capability: 'image',
        model: 'hosted-model-1',
      }),
      instancesOf: () => ['pli_h'],
      hostedAdapterOf: async () => null,
    });
    const service = makeService(okArkImage, source);
    await expect(service.testCapabilityEntry(HOSTED_PLUGIN, 'hosted-image')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('videoStatus：插件实例往返走托管适配器（source: plugin）', async () => {
    const seen: string[] = [];
    const adapter = {
      embed: async () => [],
      videoStatus: async (_ctx: never, taskId: string) => {
        seen.push(taskId);
        return { status: 'running' as const };
      },
    };
    const service = makeService(
      okArkImage,
      fakeSource([], {
        hostedAdapterOf: async () => adapter as never,
        capabilityInstanceOf: async () => ({
          pluginId: HOSTED_PLUGIN,
          engine: '',
          source: 'plugin' as const,
          entryId: 'hosted-video',
          model: 'hosted-video-1',
        }),
      }),
    );
    const status = await service.videoStatus('pli_h', 'task-42');
    expect(status.status).toBe('running');
    expect(seen).toEqual(['task-42']);
  });

  // --- D125 P3：取消 / 进度只进托管路径的 VendorCallContext ----------------------

  it('D125 P3：resolve.signal / onProgress 进托管适配器上下文（generateVideo / videoStatus）', async () => {
    const controller = new AbortController();
    const onProgress = (): void => {};
    const contexts: Array<{ signal?: AbortSignal; onProgress?: unknown }> = [];
    const adapter = {
      embed: async () => [],
      submitVideo: async (ctx: { signal?: AbortSignal; onProgress?: unknown }) => {
        contexts.push({ signal: ctx.signal, onProgress: ctx.onProgress });
        return { taskId: 'hosted-task-1' };
      },
      videoStatus: async (ctx: { signal?: AbortSignal; onProgress?: unknown }, taskId: string) => {
        contexts.push({ signal: ctx.signal, onProgress: ctx.onProgress });
        return { status: 'running' as const, taskId };
      },
    };
    const hostedVideoEntry: ResolvedEntry = {
      pluginId: HOSTED_PLUGIN,
      entryId: 'hosted-video',
      model: 'hosted-video-1',
      engine: '',
      source: 'plugin',
      instanceId: 'pli_h',
      instances: ['pli_h'],
    };
    const service = makeService(
      okArkImage,
      fakeSource([hostedVideoEntry], {
        entriesFor: async (_botId, capability) =>
          capability === 'video' ? [hostedVideoEntry] : [],
        hostedAdapterOf: async () => adapter as never,
        capabilityInstanceOf: async () => ({
          pluginId: HOSTED_PLUGIN,
          engine: '',
          source: 'plugin' as const,
          entryId: 'hosted-video',
          model: 'hosted-video-1',
        }),
      }),
    );
    const handle = await service.generateVideo(
      { prompt: '托管视频' },
      { loopType: 'task' },
      { botId: 'bot_1', signal: controller.signal, onProgress },
    );
    expect(handle).toMatchObject({ provider: 'pli_h', taskId: 'hosted-task-1' });
    await service.videoStatus(handle.provider, handle.taskId, {
      signal: controller.signal,
      onProgress,
    });
    expect(contexts).toHaveLength(2);
    for (const ctx of contexts) {
      expect(ctx.signal).toBe(controller.signal);
      expect(ctx.onProgress).toBe(onProgress);
    }
  });

  it('D125 P3：数据型路径（内置引擎）不携带 signal / onProgress（行为零变化）', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ image: 'https://out.example/i.png' }] } }] },
        }),
      );
    }) as unknown as typeof fetch;
    const service = makeService(fetchImpl, fakeSource(ENTRIES));
    const controller = new AbortController();
    await service.generateImage(
      { prompt: '图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', signal: controller.signal, onProgress: () => {} },
    );
    // 内置引擎适配器只挂自己的超时信号；工具 / run 的取消信号不进引擎路径。
    expect(seen?.signal).not.toBe(controller.signal);
  });
});
