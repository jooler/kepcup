import { describe, expect, it } from 'vitest';
import { settingsSchema, type Settings } from '@kepcup/shared';
import { MediaService } from '../../src/media/service.js';
import type { SettingsService } from '../../src/domain/settings.js';
import type { SecretsService } from '../../src/domain/secrets.js';
import type { UsageRecordInput, UsageService } from '../../src/domain/usage.js';

const LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const SETTINGS: Settings = settingsSchema.parse({
  capabilityModels: {
    embedding: null,
    rerank: { vendor: 'dashscope', model: 'gte-rerank-v2' },
    multimodal: null,
    asr: null,
    tts: null,
    image: { vendor: 'volcengine', model: 'doubao-seedream-4-0-250828' },
    video: { vendor: 'volcengine', model: 'doubao-seedance-1-0-pro-250528' },
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
    secrets: { getValue: (name: string) => KEYS[name] ?? null } as unknown as SecretsService,
    logger: LOGGER,
    usage: recorder as UsageService,
    fetchImpl,
  });
  return { service, rows };
}

const okImage = (async () =>
  new Response(JSON.stringify({ data: [{ url: 'https://out.example/i.png' }] }))) as unknown as typeof fetch;

describe('媒体调用记入 usage_ledger', () => {
  it('成功调用写一行：厂商 / 模型 / 归属取自上下文，token 为 0、费用为空', async () => {
    const { service, rows } = setup(okImage);
    await service.generateImage({ prompt: '图' }, CTX);
    expect(rows).toEqual([
      {
        runId: 'run_1',
        botId: 'bot_1',
        conversationId: 'conv_1',
        loopType: 'turn',
        provider: 'volcengine',
        model: 'doubao-seedream-4-0-250828',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    ]);
  });

  it('显式 model 覆盖时按实际调用的模型记账', async () => {
    const { service, rows } = setup(okImage);
    await service.generateImage({ prompt: '图', model: 'doubao-seedream-4-5-251128' }, CTX);
    expect(rows[0]?.model).toBe('doubao-seedream-4-5-251128');
  });

  it('省略上下文或传 null 不记账', async () => {
    const { service, rows } = setup(okImage);
    await service.generateImage({ prompt: '图' });
    await service.generateImage({ prompt: '图' }, null);
    expect(rows).toHaveLength(0);
  });

  it('失败的调用不记账', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const { service, rows } = setup(failing);
    await expect(service.generateImage({ prompt: '图' }, CTX)).rejects.toBeDefined();
    await expect(service.embedTexts('dashscope', 'text-embedding-v4', ['a'], CTX)).rejects.toBeDefined();
    expect(rows).toHaveLength(0);
  });

  it('未配置能力（解析阶段就失败）不记账', async () => {
    const { service, rows } = setup(okImage);
    await expect(service.synthesizeSpeech({ text: 'hi' }, CTX)).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_CONFIGURED',
    });
    expect(rows).toHaveLength(0);
  });

  it('无 run 的调用（记忆 / 语音输入）账本行取 media_ 前缀的合成 runId，botId 为空', async () => {
    const { service, rows } = setup(okImage);
    await service.generateImage({ prompt: '图' }, { loopType: 'voice_input' });
    expect(rows[0]?.runId).toMatch(/^media_/);
    expect(rows[0]).toMatchObject({ botId: null, conversationId: null, loopType: 'voice_input' });
  });

  it('向量与重排：embedTexts 一次调用一行（内部分批不多记），rerank 一行', async () => {
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('rerank')) {
        return new Response(JSON.stringify({ output: { results: [{ index: 0, relevance_score: 1 }] } }));
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

  it('视频：提交成功记一行，轮询状态不记', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) =>
      String(url).endsWith('/contents/generations/tasks')
        ? new Response(JSON.stringify({ id: 'req-9' }))
        : new Response(
            JSON.stringify({ status: 'succeeded', content: { video_url: 'https://v.example/f.mp4' } }),
          )) as unknown as typeof fetch;
    const { service, rows } = setup(fetchImpl);
    const handle = await service.generateVideo({ prompt: '夜景' }, CTX);
    await service.videoStatus(handle.provider, handle.taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'volcengine', model: 'doubao-seedance-1-0-pro-250528' });
  });

  it('记账本身出错只影响日志，不影响调用结果', async () => {
    const { service } = setup(okImage, {
      record: () => {
        throw new Error('db locked');
      },
    });
    const result = await service.generateImage({ prompt: '图' }, CTX);
    expect(result.images).toHaveLength(1);
  });
});
