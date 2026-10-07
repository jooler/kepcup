import { describe, expect, it } from 'vitest';

import { GatewayEmbedder, LocalEmbedder, normalize } from '../../src/memory/embedder.js';

describe('GatewayEmbedder（厂商向量经媒体网关路由）', () => {
  it('无持久化维度时首帧 embed 记录 dim 并做归一化', async () => {
    const embedder = new GatewayEmbedder({
      provider: 'dashscope',
      model: 'text-embedding-v4',
      ready: () => true,
      embed: async (texts) => texts.map(() => [3, 4]),
    });
    expect(embedder.id).toBe('provider:dashscope/text-embedding-v4');
    expect(embedder.ready()).toBe(true);
    expect(embedder.dim).toBeNull();

    const [vector] = await embedder.embed(['检索文本']);
    expect(vector).toHaveLength(2);
    // [3, 4] 归一化后 ≈ [0.6, 0.8]。
    expect(vector![0]).toBeCloseTo(0.6, 5);
    expect(vector![1]).toBeCloseTo(0.8, 5);
    expect(embedder.dim).toBe(2);
  });

  it('持久化维度存在时直接起步（settings.embedding.dim，BR-P07-001）', () => {
    const embedder = new GatewayEmbedder({
      provider: 'dashscope',
      model: 'text-embedding-v4',
      ready: () => true,
      embed: async (texts) => texts.map(() => [1]),
      getPersistedDim: () => 8,
    });
    expect(embedder.dim).toBe(8);
  });

  it('ready 委托网关检查（未配置 / 缺 key 返回 false）', () => {
    const embedder = new GatewayEmbedder({
      provider: 'dashscope',
      model: 'text-embedding-v4',
      ready: () => false,
      embed: async () => [],
    });
    expect(embedder.ready()).toBe(false);
  });

  it('normalize：零向量原样返回，非零向量单位化', () => {
    const zero = new Float32Array([0, 0]);
    expect(normalize(zero)).toEqual(zero);
    const unit = normalize(Float32Array.from([0, 2]));
    expect(unit[0]).toBe(0);
    expect(unit[1]).toBe(1);
  });
});

describe('LocalEmbedder（未安装时）', () => {
  // DEV-007 已落实后的未安装路径：ready=false、embed 拒绝，检索退化为全文。
  // 安装后的推理行为见 local-embedder.test.ts（注入 fake ORT）。
  it('未安装时 ready 为 false，embed 报 PROVIDER_UNAVAILABLE', async () => {
    const noop = { warn: () => {}, info: () => {} };
    const embedder = new LocalEmbedder({
      modelDir: null,
      runtimeDir: null,
      modelVersion: '2.0.0',
      accelerators: ['cpu'],
      logger: noop,
    });
    expect(embedder.id).toBe('local:jina-embeddings-v2-base-zh@2.0.0');
    expect(embedder.ready()).toBe(false);
    expect(embedder.dim).toBeNull();
    await expect(embedder.embed(['x'])).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
