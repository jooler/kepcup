import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AppError } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import { encodeBert, loadBertVocab } from './bert-tokenizer.js';

/**
 * Vector service (docs/dev/phases/P07-memory.md 任务 2): one interface, two
 * implementations. Vendor sources go through the media gateway
 * (`GatewayEmbedder`)，由各厂商适配器路由端点（百炼多模态/早期向量模型走
 * 原生端点），配置来自 settings.capabilityModels.embedding。本地来源
 * （`LocalEmbedder`）经环境管理器安装 ONNX 运行库 + bge-small-zh-v1.5 到
 * 私有 toolchains 后加载推理（DEV-007 已落实）；任一来源未就绪时检索
 * 退化为全文搜索。
 */
export interface Embedder {
  /** Stable id recorded in memory.db meta (model changes trigger rebuilds). */
  id: string;
  /** Vector dimension; null until the first successful embed (vendor). */
  dim: number | null;
  ready(): boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * 国内厂商向量来源：embed 经媒体网关注入的回调按厂商适配器路由（百炼
 * 多模态/早期向量模型走原生端点，其余厂商 OpenAI 兼容），ready 委托给
 * 网关的条目检查。dim 语义与 VendorEmbedder 一致：优先取持久化维度，
 * 首帧 embed 后更新。
 */
export interface GatewayEmbedderDeps {
  provider: string;
  model: string;
  ready(): boolean;
  embed(texts: string[]): Promise<number[][]>;
  getPersistedDim?: () => number | null;
}

export class GatewayEmbedder implements Embedder {
  readonly #deps: GatewayEmbedderDeps;
  #dim: number | null;

  constructor(deps: GatewayEmbedderDeps) {
    this.#deps = deps;
    this.#dim = deps.getPersistedDim?.() ?? null;
  }

  get id(): string {
    return `provider:${this.#deps.provider}/${this.#deps.model}`;
  }

  get dim(): number | null {
    return this.#dim;
  }

  ready(): boolean {
    return this.#deps.ready();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const vectors = await this.#deps.embed(texts);
    if (this.#dim === null && vectors.length > 0) this.#dim = vectors[0]!.length;
    return vectors.map((vector) => normalize(Float32Array.from(vector)));
  }
}

/**
 * 本地模型（env 条目 `embedding-model` + 前置 `onnxruntime`，经环境管理器
 * 安装到 toolchains）。bge-small-zh-v1.5 ONNX 导出：BERT 4 层 / 512 维 /
 * 中文词表，CLS 池化 + 单位归一（与本文件 normalize 对齐，余弦即点积）。
 * 运行库经 createRequire 从 toolchains 的 onnxruntime-node 包加载（不经
 * esbuild 打包、不进应用安装包）；执行单元按平台选型（env/gpu.ts），首选
 * EP 创建会话失败时回退 CPU。会话/词表按安装目录做模块级缓存——
 * MemoryService 每次检索都新建 Embedder 实例，缓存必须在实例之外。
 */

/** 与 catalog 条目一致的模型标识（进入 embedder id，变更触发向量重建）。 */
export const EMBEDDING_MODEL_ID = 'bge-small-zh-v1.5';
/** bge-small-zh-v1.5 的序列上限（= config.max_position_embeddings）。 */
const MAX_SEQUENCE_LENGTH = 512;
/** config.json 读取失败时的兜底维度（该模型 hidden_size=512）。 */
const FALLBACK_DIM = 512;

/** onnxruntime-node 的最小类型面（不引入编译期依赖）。 */
export interface OrtTensorLike {
  data: Float32Array | BigInt64Array;
  dims: number[];
}
export interface OrtSessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}
export interface OrtNamespaceLike {
  Tensor: new (
    type: 'int64' | 'float32',
    data: BigInt64Array | Float32Array,
    dims: number[],
  ) => OrtTensorLike;
  InferenceSession: {
    create(path: string, options?: { executionProviders?: string[] }): Promise<OrtSessionLike>;
  };
}
export type OrtLoader = (runtimeDir: string) => OrtNamespaceLike | Promise<OrtNamespaceLike>;

export interface LocalEmbedderOptions {
  /** toolchains/embedding-model/{version}；null = 未安装。 */
  modelDir: string | null;
  /** toolchains/onnxruntime/{version}；null = 未安装。 */
  runtimeDir: string | null;
  /** 安装的模型条目版本（进入 embedder id）。 */
  modelVersion: string;
  /** 有序执行单元（env/gpu.ts executionProvidersFor）。 */
  accelerators: readonly string[];
  logger: Pick<CoreLogger, 'warn' | 'info'>;
  /** 测试注入；默认 createRequire 从 runtimeDir 解析 onnxruntime-node。 */
  loadOrt?: OrtLoader;
}

interface SharedSession {
  ort: OrtNamespaceLike;
  session: OrtSessionLike;
  vocab: ReturnType<typeof loadBertVocab>;
}

// key = `${modelDir}\u0000${runtimeDir}`；失败的创建同样缓存（拒绝），避免
// 每条检索都重试损坏的安装；重装/换版本会改变 key 自然失效。
const sharedSessions = new Map<string, Promise<SharedSession>>();

export class LocalEmbedder implements Embedder {
  readonly #options: LocalEmbedderOptions;

  constructor(options: LocalEmbedderOptions) {
    this.#options = options;
  }

  get id(): string {
    return `local:${EMBEDDING_MODEL_ID}@${this.#options.modelVersion}`;
  }

  get dim(): number | null {
    return LocalEmbedder.modelDim(this.#options.modelDir);
  }

  /** config.json 的 hidden_size（读取失败回退 512；目录不存在返回 null）。 */
  static modelDim(modelDir: string | null): number | null {
    if (modelDir === null) return null;
    try {
      const config = JSON.parse(readFileSync(path.join(modelDir, 'config.json'), 'utf8')) as {
        hidden_size?: number;
      };
      return typeof config.hidden_size === 'number' && config.hidden_size > 0
        ? config.hidden_size
        : FALLBACK_DIM;
    } catch {
      return null;
    }
  }

  ready(): boolean {
    const { modelDir, runtimeDir } = this.#options;
    if (modelDir === null || runtimeDir === null) return false;
    try {
      return (
        existsSync(path.join(modelDir, 'model.onnx')) &&
        existsSync(path.join(modelDir, 'vocab.txt')) &&
        existsSync(path.join(runtimeDir, 'dist', 'index.js'))
      );
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.ready()) {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        '本地向量模型或 ONNX 运行库未安装（设置-向量来源可查看状态）',
      );
    }
    const shared = await this.#sharedSession();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      vectors.push(await this.#embedOne(shared, text));
    }
    return vectors;
  }

  async #embedOne(shared: SharedSession, text: string): Promise<Float32Array> {
    const ids = encodeBert(text, shared.vocab, MAX_SEQUENCE_LENGTH);
    const length = ids.length;
    const int64 = (values: number[]): OrtTensorLike =>
      new shared.ort.Tensor('int64', BigInt64Array.from(values.map((value) => BigInt(value))), [
        1,
        length,
      ]);
    const feeds: Record<string, OrtTensorLike> = {
      input_ids: int64(ids),
      attention_mask: int64(ids.map(() => 1)),
    };
    if (shared.session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = int64(ids.map(() => 0));
    }
    const output = await shared.session.run(feeds);
    // sentence_embedding（若导出带池化）优先；否则取首输出（bge 导出为
    // last_hidden_state [batch, seq, hidden]，CLS 池化取首个位置）。
    const name = 'sentence_embedding' in output ? 'sentence_embedding' : Object.keys(output)[0]!;
    const tensor = output[name];
    if (tensor === undefined || tensor.data.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '推理输出为空');
    }
    if (tensor.dims.length === 3) {
      // [batch, seq, hidden] → CLS（首个位置，BGE 约定）。
      const hidden = tensor.dims[2]!;
      return normalize(asFloat32(tensor.data).subarray(0, hidden).slice());
    }
    return normalize(asFloat32(tensor.data));
  }

  #sharedSession(): Promise<SharedSession> {
    const { modelDir, runtimeDir } = this.#options;
    if (modelDir === null || runtimeDir === null) {
      return Promise.reject(new AppError('PROVIDER_UNAVAILABLE', '本地向量模型未安装'));
    }
    const key = `${modelDir}\u0000${runtimeDir}`;
    const existing = sharedSessions.get(key);
    if (existing !== undefined) return existing;
    const creating = this.#createSession(modelDir, runtimeDir);
    sharedSessions.set(key, creating);
    creating.catch(() => {
      // 失败结果也保留在缓存里（上面的注释）；这里只吞掉未处理的拒绝告警。
    });
    return creating;
  }

  async #createSession(modelDir: string, runtimeDir: string): Promise<SharedSession> {
    const { accelerators, logger } = this.#options;
    const loader =
      this.#options.loadOrt ??
      ((dir: string): OrtNamespaceLike => {
        const require = createRequire(path.join(dir, 'dist', 'index.js'));
        return require(dir) as OrtNamespaceLike;
      });
    const ort = await loader(runtimeDir);
    const modelPath = path.join(modelDir, 'model.onnx');
    let session: OrtSessionLike | null = null;
    const tried: string[] = [];
    for (const providers of candidateProviderLists(accelerators)) {
      tried.push(providers.join(','));
      try {
        session = await ort.InferenceSession.create(modelPath, { executionProviders: providers });
        logger.info(
          { providers, modelDir },
          'local embedding session created (local:embedding-model)',
        );
        break;
      } catch (error) {
        logger.warn(
          { providers, error: error instanceof Error ? error.message : String(error) },
          'local embedding session creation failed on providers, falling back',
        );
      }
    }
    if (session === null) {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        `ONNX 会话创建失败（已尝试 ${tried.join(' | ')}）`,
      );
    }
    const vocab = loadBertVocab(readFileSync(path.join(modelDir, 'vocab.txt'), 'utf8'));
    return { ort, session, vocab };
  }
}

/**
 * 候选执行单元序列：先按 gpu.ts 的有序列表整体尝试（ORT 语义：EP 不可用的
 * 节点回落 CPU），失败再用纯 CPU 建一次会话（GPU 组件缺失/损坏的场景）。
 */
function candidateProviderLists(accelerators: readonly string[]): string[][] {
  const full = [...new Set(accelerators)];
  if (full.length <= 1 || full[full.length - 1] !== 'cpu') return [full];
  return [full, ['cpu']];
}

/** 推理输出张量 → float32 向量（int64 输出的导出按数值转换兜底）。 */
function asFloat32(data: Float32Array | BigInt64Array): Float32Array {
  if (data instanceof Float32Array) return data;
  return Float32Array.from(data, (value) => Number(value));
}

/** Unit-normalizes so cosine similarity ⇔ L2 distance relationships hold. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}
