import { describe, expect, it } from 'vitest';
import { settingsSchema, type Settings } from '@kepcup/shared';
import { MediaService, type MediaEntrySource } from '../../src/media/service.js';
import type { SettingsService } from '../../src/domain/settings.js';
import type { SecretsService } from '../../src/domain/secrets.js';
import type { UsageRecordInput, UsageService } from '../../src/domain/usage.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const SETTINGS: Settings = settingsSchema.parse({
  modelProviders: [
    {
      id: 'dashscope',
      vendor: 'dashscope',
      name: '阿里云百炼',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      enabled: true,
      models: [],
    },
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
    rerank: { provider: 'dashscope', model: 'gte-rerank-v2' },
    multimodal: null,
    asr: null,
    // DEV-133：image / video 槽位已删；全局路径记账用例改走 tts。
    tts: { provider: 'dashscope', model: 'cosyvoice-v2' },
  },
});
const KEYS: Record<string, string> = { 'provider:volcengine': 'sk-ark', 'provider:dashscope': 'k' };

const CTX = { runId: 'run_1', botId: 'bot_1', conversationId: 'conv_1', loopType: 'turn' } as const;

function setup(fetchImpl: typeof fetch, usage?: Pick<UsageService, 'record'>) {
  const rows: UsageRecordInput[] = [];
  const recorder = usage ?? {
    record: (input: UsageRecordInput) => {
      rows.push(input);
    },
  };
  const service = new MediaService({
    settings: { get: () => SETTINGS } as unknown as SettingsService,
    secrets: {
      getValue: (name: string) => KEYS[name] ?? null,
      hasValue: (name: string) => name in KEYS,
      names: () => Object.keys(KEYS),
      registerRedactValue: () => {},
    } as unknown as SecretsService,
    logger: LOGGER,
    usage: recorder as UsageService,
    fetchImpl,
  });
  return { service, rows };
}

/** 百炼 SpeechSynthesizer 的最小成功响应（output.audio.data）。 */
const okTts = (async () =>
  new Response(
    JSON.stringify({ output: { audio: { data: Buffer.from('mp3').toString('base64') } } }),
  )) as unknown as typeof fetch;

describe('媒体调用记入 usage_ledger', () => {
  it('成功调用写一行：厂商 / 模型 / 归属取自上下文，token 为 0、费用为空', async () => {
    const { service, rows } = setup(okTts);
    await service.synthesizeSpeech({ text: '你好' }, CTX);
    expect(rows).toEqual([
      {
        runId: 'run_1',
        botId: 'bot_1',
        conversationId: 'conv_1',
        loopType: 'turn',
        provider: 'dashscope',
        model: 'cosyvoice-v2',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    ]);
  });

  it('显式 model 覆盖时按实际调用的模型记账', async () => {
    const { service, rows } = setup(okTts);
    await service.synthesizeSpeech({ text: '你好', model: 'qwen3-tts-flash' }, CTX);
    expect(rows[0]?.model).toBe('qwen3-tts-flash');
  });

  it('省略上下文或传 null 不记账', async () => {
    const { service, rows } = setup(okTts);
    await service.synthesizeSpeech({ text: '你好' });
    await service.synthesizeSpeech({ text: '你好' }, null);
    expect(rows).toHaveLength(0);
  });

  it('失败的调用不记账', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const { service, rows } = setup(failing);
    await expect(service.synthesizeSpeech({ text: '你好' }, CTX)).rejects.toBeDefined();
    await expect(
      service.embedTexts('dashscope', 'text-embedding-v4', ['a'], CTX),
    ).rejects.toBeDefined();
    expect(rows).toHaveLength(0);
  });

  it('未配置能力（解析阶段就失败）不记账', async () => {
    const { service, rows } = setup(okTts);
    await expect(service.understandImage({ images: ['x'], prompt: 'q' }, CTX)).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
    expect(rows).toHaveLength(0);
  });

  it('无 run 的调用（记忆 / 语音输入）账本行取 media_ 前缀的合成 runId，botId 为空', async () => {
    const { service, rows } = setup(okTts);
    await service.synthesizeSpeech({ text: '你好' }, { loopType: 'voice_input' });
    expect(rows[0]?.runId).toMatch(/^media_/);
    expect(rows[0]).toMatchObject({ botId: null, conversationId: null, loopType: 'voice_input' });
  });

  it('向量与重排：embedTexts 一次调用一行（内部分批不多记），rerank 一行', async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('rerank')) {
        return new Response(
          JSON.stringify({ output: { results: [{ index: 0, relevance_score: 1 }] } }),
        );
      }
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [1, i] })) }),
      );
    }) as unknown as typeof fetch;
    const { service, rows } = setup(fetchImpl);
    await service.embedTexts(
      'dashscope',
      'text-embedding-v4',
      Array.from({ length: 16 }, (_, i) => `t${i}`),
      { loopType: 'memory' },
    );
    await service.rerank({ query: 'q', documents: ['a'], topN: 1 }, { loopType: 'memory' });
    expect(rows.map((r) => [r.loopType, r.provider, r.model])).toEqual([
      ['memory', 'dashscope', 'text-embedding-v4'],
      ['memory', 'dashscope', 'gte-rerank-v2'],
    ]);
  });

  it('DEV-133 条目路径：执行型插件条目提交成功记一行（provider 记插件 id），轮询不记', async () => {
    const { service, rows } = setup((async () => new Response('x')) as unknown as typeof fetch);
    const hostedVideoEntry = {
      pluginId: 'io.test/hosted',
      entryId: 'hosted-video',
      model: 'hosted-video-1',
      engine: '',
      source: 'plugin' as const,
      instanceId: 'pli_h',
      instances: ['pli_h'],
    };
    const source: MediaEntrySource = {
      entriesFor: async (_botId, capability) => (capability === 'video' ? [hostedVideoEntry] : []),
      entryOf: async () => null,
      instancesOf: () => ['pli_h'],
      instanceCredential: () => 'sk-plugin',
      instanceConfig: () => ({}),
      capabilityInstanceOf: async () => ({
        pluginId: 'io.test/hosted',
        engine: '',
        source: 'plugin',
        entryId: 'hosted-video',
        model: 'hosted-video-1',
      }),
      hostedAdapterOf: async () =>
        ({
          embed: async () => [],
          submitVideo: async () => ({ taskId: 'task-9' }),
          videoStatus: async () => ({ status: 'succeeded' as const }),
        }) as never,
    };
    service.attachEntrySource(source);
    const handle = await service.generateVideo(
      { prompt: '夜景' },
      CTX,
      { botId: 'bot_1' },
    );
    await service.videoStatus(handle.provider, handle.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'io.test/hosted',
      model: 'hosted-video-1',
      capability: 'video',
      modelEntryId: 'io.test/hosted/hosted-video',
    });
  });

  it('记账本身出错只影响日志，不影响调用结果', async () => {
    const { service } = setup(okTts, {
      record: () => {
        throw new Error('db locked');
      },
    });
    const result = await service.synthesizeSpeech({ text: '你好' }, CTX);
    expect(result.audioBase64.length).toBeGreaterThan(0);
  });

  it('D124 条目命中：provider 记插件 id，capability / model_entry_id 两列写入', async () => {
    // DEV-133：图像生成只有插件条目路径——执行型条目（source: plugin）经托管
    // 适配器生成，provider 记插件 id。
    const { service, rows } = setup((async () => new Response('x')) as unknown as typeof fetch);
    const source: MediaEntrySource = {
      entriesFor: async (_botId, capability) =>
        capability === 'image'
          ? [
              {
                pluginId: 'io.kepcup/dashscope',
                entryId: 'qwen-image',
                model: 'qwen-image-2.0',
                engine: '',
                source: 'plugin',
                instanceId: 'pli_a',
                instances: ['pli_a'],
              },
            ]
          : [],
      entryOf: async () => null,
      instancesOf: () => ['pli_a'],
      instanceCredential: () => 'sk-plugin',
      instanceConfig: () => ({}),
      capabilityInstanceOf: async () => null,
      hostedAdapterOf: async () =>
        ({
          embed: async () => [],
          generateImage: async () => ({ images: [{ url: 'https://out.example/i.png' }] }),
        }) as never,
    };
    service.attachEntrySource(source);
    await service.generateImage({ prompt: '图' }, CTX, { botId: 'bot_1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'io.kepcup/dashscope',
      model: 'qwen-image-2.0',
      capability: 'image',
      modelEntryId: 'io.kepcup/dashscope/qwen-image',
    });
  });

  it('DEV-133 全局槽位路径：capability / model_entry_id 两列为 NULL（undefined）', async () => {
    const { service, rows } = setup(okTts);
    await service.synthesizeSpeech({ text: '你好' }, CTX, { botId: 'bot_1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('dashscope');
    expect(rows[0]?.capability).toBeUndefined();
    expect(rows[0]?.modelEntryId).toBeUndefined();
  });
});
