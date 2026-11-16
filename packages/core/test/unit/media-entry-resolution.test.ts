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
    // 全局槽位仍服务 multimodal / tts / asr / embedding / rerank（回退分支用
    // understandImage 验证）。
    multimodal: { provider: 'volcengine', model: 'doubao-seed-2-1-pro-260915' },
    asr: null,
    tts: null,
  },
});

const KEYS: Record<string, string> = { 'provider:volcengine': 'sk-ark' };

/** 方舟图片理解（OpenAI 兼容 chat/completions）的最小成功响应。 */
const okArkVision = (async () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: '一张图' } }] }),
  )) as unknown as typeof fetch;

/** 任意二进制成功响应（openai-compatible 语音合成的 audio/speech 用）。 */
const okAudioBytes = (async () => new Response(Buffer.from('fake-mp3-bytes'))) as unknown as typeof fetch;

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

/**
 * 两个数据型条目（DEV-133：图像 / 视频生成不再有引擎条目——语音走
 * openai-compatible 引擎的标准端点；第二个条目用于 model 匹配与多实例用例）。
 */
const ENTRIES: ResolvedEntry[] = [
  {
    pluginId: 'io.kepcup/compatible',
    entryId: 'kimi-tts',
    model: 'kimi-audio-tts',
    displayName: 'Kimi 语音合成',
    engine: 'openai-compatible',
    source: 'engine',
    instanceId: 'pli_a',
    instances: ['pli_a'],
  },
  {
    pluginId: 'io.kepcup/compatible',
    entryId: 'minimax-tts',
    model: 'minimax-speech-02',
    displayName: 'MiniMax 语音',
    engine: 'openai-compatible',
    source: 'engine',
    instanceId: 'pli_a',
    instances: ['pli_a'],
  },
];

function fakeSource(
  entries: ResolvedEntry[],
  overrides: Partial<MediaEntrySource> = {},
  /** entriesFor 对哪些能力返回条目（entrySummaries 的 image 分组用例可覆盖）。 */
  capabilities: readonly string[] = ['tts', 'image'],
): MediaEntrySource {
  return {
    entriesFor: async (botId, capability) => {
      if (botId === undefined || botId === '') return [];
      return capabilities.includes(capability) ? entries : [];
    },
    entryOf: async () => null,
    instancesOf: () => ['pli_a', 'pli_b'],
    instanceCredential: (_pluginId, instanceId, _key, keyOverride) => {
      if (keyOverride !== undefined) return keyOverride;
      return instanceId === 'pli_nocred' ? null : 'sk-plugin';
    },
    // openai-compatible 引擎的 baseUrl 是必填实例字段；缺省给一个兼容根。
    instanceConfig: () => ({ baseUrl: 'https://plugin.example/v1' }),
    capabilityInstanceOf: async () => ({
      pluginId: 'io.kepcup/compatible',
      engine: 'openai-compatible',
      source: 'engine',
      entryId: 'kimi-tts',
      model: 'kimi-audio-tts',
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
      return new Response(Buffer.from('fake-mp3-bytes'));
    }) as unknown as typeof fetch;
    const service = makeService(
      fetchImpl,
      fakeSource(ENTRIES, {
        instanceConfig: () => ({ baseUrl: 'https://plugin.example/v1' }),
      }),
    );
    const result = await service.synthesizeSpeech(
      { text: '你好' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.audioBase64.length).toBeGreaterThan(0);
    // openai-compatible 引擎的标准 TTS 端点；实例 config 的 baseUrl 覆盖生效。
    expect(calls[0]?.url).toBe('https://plugin.example/v1/audio/speech');
    expect(calls[0]?.key).toBe('sk-plugin');
  });

  it('① 显式 model 依次命中条目 model / displayName / entryId；未命中回首个（声明序）', async () => {
    const probe = async (model?: string): Promise<string> => {
      let usedModel = '';
      const tracing = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        usedModel = (JSON.parse(String(init?.body)) as { model?: string }).model ?? '';
        return new Response(Buffer.from('mp3'));
      }) as unknown as typeof fetch;
      const service = makeService(tracing, fakeSource(ENTRIES));
      await service.synthesizeSpeech(
        { text: '你好' },
        { loopType: 'task' },
        { botId: 'bot_1', ...(model !== undefined ? { model } : {}) },
      );
      return usedModel;
    };
    expect(await probe('kimi-audio-tts')).toBe('kimi-audio-tts'); // model 精确命中
    expect(await probe('MiniMax 语音')).toBe('minimax-speech-02'); // displayName 命中
    expect(await probe('minimax-tts')).toBe('minimax-speech-02'); // entryId 命中
    expect(await probe('不存在的模型')).toBe('kimi-audio-tts'); // 未命中回首个
    expect(await probe(undefined)).toBe('kimi-audio-tts'); // 缺省 = 首个条目
  });

  it('① 多实例未指定 → INSTANCE_AMBIGUOUS（payload 带插件 / 条目 / 实例全集）', async () => {
    const service = makeService(
      okAudioBytes,
      fakeSource([{ ...ENTRIES[1]!, instanceId: undefined, instances: ['pli_a', 'pli_b'] }]),
    );
    await expect(
      service.synthesizeSpeech({ text: '你好' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'INSTANCE_AMBIGUOUS',
      details: {
        pluginId: 'io.kepcup/compatible',
        entryId: 'minimax-tts',
        instances: ['pli_a', 'pli_b'],
      },
    });
  });

  it('① 实例缺凭据 → CAPABILITY_NOT_CONFIGURED（details 定位插件 / 条目 / 实例）', async () => {
    const service = makeService(
      okAudioBytes,
      fakeSource([{ ...ENTRIES[0]!, instanceId: 'pli_nocred', instances: ['pli_nocred'] }]),
    );
    await expect(
      service.synthesizeSpeech({ text: '你好' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      details: { pluginId: 'io.kepcup/compatible', instanceId: 'pli_nocred' },
    });
  });

  it('① 零实例 → CAPABILITY_NOT_CONFIGURED（details 带条目定位，无 instanceId）', async () => {
    const service = makeService(
      okAudioBytes,
      fakeSource([{ ...ENTRIES[0]!, instanceId: undefined, instances: [] }]),
    );
    await expect(
      service.synthesizeSpeech({ text: '你好' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      details: { pluginId: 'io.kepcup/compatible', entryId: 'kimi-tts' },
    });
  });

  it('testCapabilityEntry 数据型条目：未知引擎先于实例解析报 PLUGIN_ENGINE_UNKNOWN（D124 顺序不变）', async () => {
    const service = makeService(
      okArkVision,
      fakeSource([], {
        entryOf: async () => ({
          id: 'ghost-engine',
          capability: 'tts',
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

  it('① DEV-133：image / video 无全局槽位——条目为空时抛插件导向的 CAPABILITY_NOT_CONFIGURED', async () => {
    const service = makeService(okArkVision, fakeSource([]));
    await expect(
      service.generateImage({ prompt: '图' }, { loopType: 'task', botId: 'bot_1' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      message: expect.stringContaining('插件条目'),
    });
    await expect(
      service.generateVideo({ prompt: 'v' }, { loopType: 'task', botId: 'bot_1' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
      message: expect.stringContaining('插件条目'),
    });
    // resolve 缺省（无 botId）同样没有全局路径可回退。
    await expect(service.generateImage({ prompt: '图' }, { loopType: 'task' })).rejects.toMatchObject(
      { code: 'CAPABILITY_NOT_CONFIGURED' },
    );
  });

  it('② 条目仓库返回空 → 原全局槽位路径生效（settings 实例 + 全局模型；保留键）', async () => {
    const service = makeService(okArkVision, fakeSource([]));
    const result = await service.understandImage(
      { images: ['data:image/png;base64,xxx'], prompt: '图中是什么' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.text).toBe('一张图');
  });

  it('② 未装任何插件（未注入条目仓库）→ 保留键走全局路径，image / video 直接未配置', async () => {
    const service = makeService(okArkVision, null);
    const result = await service.understandImage(
      { images: ['data:image/png;base64,xxx'], prompt: '图中是什么' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1' },
    );
    expect(result.text).toBe('一张图');
    await expect(
      service.generateVideo({ prompt: 'v' }, { loopType: 'task' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' });
  });

  it('① DEV-133：旧清单的 video 引擎条目（绑内置引擎）运行时明确 NOT_IMPLEMENTED', async () => {
    // 安装期已拒绝新装（PLUGIN_INVALID）；已装的旧清单解析到引擎路径时由
    // 适配器能力检查给出可读错误，而不是静默失败。
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
      okArkVision,
      fakeSource([], {
        entriesFor: async (_botId, capability) => (capability === 'video' ? [videoEntry] : []),
        instanceCredential: () => 'sk-plugin',
        instanceConfig: () => ({}),
      }),
    );
    await expect(
      service.generateVideo(
        { prompt: '夜景' },
        { loopType: 'task', botId: 'bot_1' },
        { botId: 'bot_1' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
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
      okArkVision,
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
      okArkVision,
      fakeSource([{ ...HOSTED_ENTRY, instanceId: undefined, instances: ['pli_a', 'pli_b'] }], {
        hostedAdapterOf: async () => ({ embed: async () => [] }) as never,
      }),
    );
    await expect(
      ambiguous.generateImage({ prompt: '图' }, { loopType: 'task' }, { botId: 'bot_1' }),
    ).rejects.toMatchObject({ code: 'INSTANCE_AMBIGUOUS' });

    const zero = makeService(
      okArkVision,
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
      okArkVision,
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
    const service = makeService(okArkVision, source);
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
    const service = makeService(okArkVision, source);
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
      okArkVision,
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

  it('DEV-133：数据型引擎实例的 videoStatus 往返仍解析到引擎适配器（旧清单收敛为 NOT_IMPLEMENTED）', async () => {
    // 已装的旧清单（数据型 video 条目绑内置引擎）：generateVideo 返回的
    // provider 恒为插件实例 id（pli_…），videoStatus 经 capabilityInstanceOf
    // 走引擎分支（#resolvePluginInstance）——适配器不再挂 videoStatus，给出
    // 可读的 NOT_IMPLEMENTED 而不是 NOT_FOUND（解析链仍然走通）。
    const service = makeService(
      okArkVision,
      fakeSource([], {
        capabilityInstanceOf: async () => ({
          pluginId: 'io.kepcup/ark',
          engine: 'volcengine-ark',
          source: 'engine' as const,
          entryId: 'seedance',
          model: 'doubao-seedance-2-0',
        }),
        instanceCredential: () => 'sk-plugin',
        instanceConfig: () => ({}),
      }),
    );
    await expect(service.videoStatus('pli_s', 'task-9')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('videoStatus：provider 查不到（实例已卸载 / 非插件实例）→ NOT_FOUND', async () => {
    const service = makeService(
      okArkVision,
      fakeSource([], { capabilityInstanceOf: async () => null }),
    );
    await expect(service.videoStatus('pli_gone', 'task-9')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('视频任务实例'),
    });
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
      okArkVision,
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
      return new Response(Buffer.from('fake-mp3-bytes'));
    }) as unknown as typeof fetch;
    const service = makeService(fetchImpl, fakeSource(ENTRIES));
    const controller = new AbortController();
    await service.synthesizeSpeech(
      { text: '你好' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', signal: controller.signal, onProgress: () => {} },
    );
    // 内置引擎适配器只挂自己的超时信号；工具 / run 的取消信号不进引擎路径。
    expect(seen?.signal).not.toBe(controller.signal);
  });
});

/**
 * D125 补丁：`onResolved` 来源回调——只有执行型插件条目带 pluginId；数据型条目 /
 * 全局槽位恒为 `{}`（工具据此决定产物默认落点，不能把数据型条目误判成插件产物）。
 */
describe('onResolved 来源回调（D125 补丁）', () => {
  const hostedEntry: ResolvedEntry = {
    pluginId: 'io.test/hosted-cb',
    entryId: 'hosted-image-cb',
    model: 'hosted-model-cb',
    engine: '',
    source: 'plugin',
    instanceId: 'pli_h',
    instances: ['pli_h'],
  };

  it('执行型插件条目 → { pluginId }', async () => {
    const origins: Array<{ pluginId?: string }> = [];
    const adapter = {
      embed: async () => [],
      generateImage: async () => ({ images: [{ url: 'https://hosted.example/out.png' }] }),
    };
    const service = makeService(
      okArkVision,
      fakeSource([hostedEntry], { hostedAdapterOf: async () => adapter as never }),
    );
    await service.generateImage(
      { prompt: '托管图' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', onResolved: (origin) => origins.push(origin) },
    );
    expect(origins).toEqual([{ pluginId: hostedEntry.pluginId }]);
  });

  it('数据型条目（source=engine）→ {}（绝不带 pluginId）', async () => {
    const origins: Array<{ pluginId?: string }> = [];
    const service = makeService(okAudioBytes, fakeSource(ENTRIES));
    await service.synthesizeSpeech(
      { text: '你好' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', onResolved: (origin) => origins.push(origin) },
    );
    expect(origins).toEqual([{}]);
  });

  it('全局槽位（无条目 / 无条目仓库）→ {}', async () => {
    const fromEmptyEntries: Array<{ pluginId?: string }> = [];
    const viaEmpty = makeService(okArkVision, fakeSource([]));
    await viaEmpty.understandImage(
      { images: ['data:image/png;base64,xxx'], prompt: '图中是什么' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', onResolved: (origin) => fromEmptyEntries.push(origin) },
    );
    expect(fromEmptyEntries).toEqual([{}]);

    const fromGlobal: Array<{ pluginId?: string }> = [];
    const viaGlobal = makeService(okArkVision, null);
    await viaGlobal.understandImage(
      { images: ['data:image/png;base64,xxx'], prompt: '图中是什么' },
      { loopType: 'task', botId: 'bot_1' },
      { botId: 'bot_1', onResolved: (origin) => fromGlobal.push(origin) },
    );
    expect(fromGlobal).toEqual([{}]);
  });

  it('回调抛错被记录并忽略，不破坏媒体调用', async () => {
    const service = makeService(okArkVision, fakeSource([]));
    const result = await service.understandImage(
      { images: ['data:image/png;base64,xxx'], prompt: '图中是什么' },
      { loopType: 'task', botId: 'bot_1' },
      {
        botId: 'bot_1',
        onResolved: () => {
          throw new Error('callback boom');
        },
      },
    );
    expect(result.text).toBe('一张图');
  });
});

describe('entrySummariesFor（D124 P3 工具描述注入的数据面）', () => {
  it('按能力分组去重；清单文本经 sanitizeDisplayText（换行 / 双向控制 / 零宽不进系统提示词）', async () => {
    const entries: ResolvedEntry[] = [
      { ...ENTRIES[0]!, displayName: '水\n墨\u202e\u200b', model: 'ink' },
      // displayName 与 model 相同 → 只留 model（避免「ink（ink）」）。
      { ...ENTRIES[0]!, entryId: 'b', displayName: 'ink', model: 'ink' },
      { ...ENTRIES[0]!, entryId: 'c', displayName: undefined, model: 'plain' },
      // 重复名只留一份。
      { ...ENTRIES[0]!, entryId: 'd', displayName: undefined, model: 'plain' },
    ];
    const summaries = await makeService(
      okArkVision,
      fakeSource(entries, {}, ['image']),
    ).entrySummariesFor('bot_1');
    expect(summaries.image).toEqual(['水 墨（ink）', 'ink', 'plain']);
    expect(summaries.tts).toEqual([]);
    expect(summaries.video).toEqual([]);
  });

  it('条目仓库未装配 / botId 为空 → 三个能力恒空（工具描述与从前逐字节一致）', async () => {
    const detached = await makeService(okArkVision, null).entrySummariesFor('bot_1');
    expect(detached).toEqual({ image: [], tts: [], video: [] });
    const emptyBot = await makeService(okArkVision, fakeSource(ENTRIES)).entrySummariesFor(
      undefined,
    );
    expect(emptyBot).toEqual({ image: [], tts: [], video: [] });
  });
});
