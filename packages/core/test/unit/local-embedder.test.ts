import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalEmbedder,
  type OrtNamespaceLike,
  type OrtTensorLike,
} from '../../src/memory/embedder.js';

const TMP_ROOT = path.join(tmpdir(), 'kepcup-local-embedder-test');

function makeDirs(): { modelDir: string; runtimeDir: string } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const modelDir = mkdtempSync(path.join(TMP_ROOT, 'model-'));
  const runtimeDir = mkdtempSync(path.join(TMP_ROOT, 'ort-'));
  writeFileSync(path.join(modelDir, 'model.onnx'), 'fake-model-bytes');
  writeFileSync(
    path.join(modelDir, 'vocab.txt'),
    ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '今', '天', '好'].join('\n'),
  );
  writeFileSync(path.join(modelDir, 'config.json'), JSON.stringify({ hidden_size: 8 }));
  mkdirSync(path.join(runtimeDir, 'dist'), { recursive: true });
  writeFileSync(path.join(runtimeDir, 'dist', 'index.js'), '// fake ort entry');
  return { modelDir, runtimeDir };
}

const noopLogger = { warn: () => {}, info: () => {} };

/**
 * Fake ORT：last_hidden_state[CLS] 由词 id 求和确定性生成（dim 8）；
 * `failFirstEp` 为真时首选 EP 创建会话抛错，模拟 GPU EP 不可用回退。
 */
function fakeOrt(failFirstEp = false): OrtNamespaceLike {
  const createdWith: string[][] = [];
  return {
    Tensor: (function (type: string, data: BigInt64Array | Float32Array, dims: number[]) {
      return { type, data, dims };
    }) as never,
    InferenceSession: {
      create: async (_modelPath: string, options?: { executionProviders?: string[] }) => {
        const providers = options?.executionProviders ?? ['cpu'];
        createdWith.push(providers);
        if (failFirstEp && providers[0] !== 'cpu') throw new Error(`EP ${providers[0]} unavailable`);
        return {
          inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
          run: async (feeds: Record<string, OrtTensorLike>) => {
            const ids = feeds['input_ids']!.data as BigInt64Array;
            const dim = 8;
            const data = new Float32Array(ids.length * dim);
            let sum = 0;
            for (const value of ids) sum += Number(value);
            for (let d = 0; d < dim; d++) data[d] = Math.sin(sum + d) * 2;
            return { last_hidden_state: { data, dims: [1, ids.length, dim] } };
          },
        };
      },
    },
  } satisfies OrtNamespaceLike;
}

describe('LocalEmbedder (P07 本地向量模型)', () => {
  afterEach(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it('reports not-ready until model and runtime directories exist', () => {
    const embedder = new LocalEmbedder({
      modelDir: null,
      runtimeDir: null,
      modelVersion: '1.5',
      accelerators: ['coreml', 'cpu'],
      logger: noopLogger,
    });
    expect(embedder.ready()).toBe(false);
    const dirs = makeDirs();
    const installed = new LocalEmbedder({
      ...dirs,
      modelVersion: '1.5',
      accelerators: ['coreml', 'cpu'],
      logger: noopLogger,
    });
    expect(installed.ready()).toBe(true);
    expect(installed.id).toBe('local:bge-small-zh-v1.5@1.5');
    expect(installed.dim).toBe(8); // config.json hidden_size
    rmSync(dirs.modelDir, { recursive: true, force: true });
    rmSync(dirs.runtimeDir, { recursive: true, force: true });
  });

  it('embeds via the injected ORT and returns normalized vectors', async () => {
    const dirs = makeDirs();
    const embedder = new LocalEmbedder({
      ...dirs,
      modelVersion: '1.5',
      accelerators: ['cpu'],
      logger: noopLogger,
      loadOrt: () => fakeOrt(false),
    });
    const [a] = await embedder.embed(['今天好']);
    const [b] = await embedder.embed(['今天好']);
    expect(a).toBeInstanceOf(Float32Array);
    expect(a!.length).toBe(8);
    let norm = 0;
    for (const value of a!) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    expect([...a!]).toEqual([...b!]); // 确定性
    rmSync(dirs.modelDir, { recursive: true, force: true });
    rmSync(dirs.runtimeDir, { recursive: true, force: true });
  });

  it('falls back to CPU when the preferred GPU EP fails at session creation', async () => {
    const dirs = makeDirs();
    const ort = fakeOrt(true);
    const warns: string[] = [];
    const embedder = new LocalEmbedder({
      ...dirs,
      modelVersion: '1.5',
      accelerators: ['coreml', 'cpu'],
      logger: { info: () => {}, warn: (row) => warns.push(JSON.stringify(row)) },
      loadOrt: () => ort,
    });
    const [vector] = await embedder.embed(['好']);
    expect(vector!.length).toBe(8);
    expect(warns.join('\n')).toContain('coreml');
    rmSync(dirs.modelDir, { recursive: true, force: true });
    rmSync(dirs.runtimeDir, { recursive: true, force: true });
  });

  it('rejects embed before installation', async () => {
    const embedder = new LocalEmbedder({
      modelDir: null,
      runtimeDir: null,
      modelVersion: '1.5',
      accelerators: ['cpu'],
      logger: noopLogger,
    });
    await expect(embedder.embed(['今天'])).rejects.toThrow('未安装');
  });
});
