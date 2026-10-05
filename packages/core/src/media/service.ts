import {
  AppError,
  isVendorId,
  VENDOR_DESCRIPTORS,
  type CapabilityModelKey,
  type ModelCapability,
  type Settings,
  type VendorId,
} from '@kepcup/shared';
import { providerCompatBaseUrl, providerSecretName } from '../agent/models.js';
import type { SettingsService } from '../domain/settings.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import { dashscopeAdapter } from './adapters/dashscope.js';
import { volcengineAdapter } from './adapters/volcengine.js';
import { buildSilentWavBase64, buildSolidPngDataUri, PROBE_AUDIO_MIME } from './test-probe.js';
import type {
  ImageGenerationParams,
  ImageGenerationResult,
  RerankParams,
  RerankResult,
  SpeechParams,
  SpeechResult,
  TranscriptionParams,
  TranscriptionResult,
  UnderstandImageParams,
  VendorAdapter,
  VendorCallContext,
  VideoGenerationParams,
  VideoTaskStatus,
} from './types.js';

/**
 * 媒体网关：统一调用入口，按能力取 settings.capabilityModels 的配置
 * （厂商 + 模型，见 docs/design/16-capability-models.md）解析出厂商后
 * 路由到各自适配器。调用方（RPC media.*、memory 检索、未来的 Bot 工具）
 * 只面对厂商无关的参数；新增厂商 = shared 描述符 + core 适配器 + 在
 * ADAPTERS 表里登记一行。
 *
 * API key 按厂商共享（provider:{厂商id}，与对话配置同一条）；baseUrl 取
 * 厂商条目的覆盖值或描述符默认根。media.* 入参的 model 是裸模型 id，
 * 省略时用该能力的配置。
 */

const ADAPTERS: Record<VendorId, VendorAdapter> = {
  dashscope: dashscopeAdapter,
  volcengine: volcengineAdapter,
};

/** 除 chat 外的全部模型能力（settings.capabilityModels 的 key）。 */
type MediaCapability = Exclude<keyof Settings['capabilityModels'], number>;

interface ResolvedVendor {
  vendor: VendorId;
  modelId: string;
  context: VendorCallContext;
  adapter: VendorAdapter;
}

export class MediaService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #logger: CoreLogger;
  /** Test seam: injected fetch for adapter unit tests. */
  readonly #fetchImpl?: typeof fetch;

  constructor(deps: {
    settings: SettingsService;
    secrets: SecretsService;
    logger: CoreLogger;
    fetchImpl?: typeof fetch;
  }) {
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#logger = deps.logger;
    this.#fetchImpl = deps.fetchImpl;
  }

  // --- 统一调用入口（media.* RPC 背后的方法） ------------------------------

  async generateImage(
    input: ImageGenerationParams & { model?: string },
  ): Promise<ImageGenerationResult> {
    const resolved = this.#resolve('image', input.model);
    return resolved.adapter.generateImage(resolved.context, resolved.modelId, {
      prompt: input.prompt,
      images: input.images,
      n: input.n,
      size: input.size,
      negativePrompt: input.negativePrompt,
      seed: input.seed,
    });
  }

  async synthesizeSpeech(input: SpeechParams & { model?: string }): Promise<SpeechResult> {
    const resolved = this.#resolve('tts', input.model);
    const fn = resolved.adapter.synthesizeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved.vendor, 'tts');
    return fn(resolved.context, resolved.modelId, {
      text: input.text,
      voice: input.voice,
      format: input.format,
      speed: input.speed,
    });
  }

  async transcribeSpeech(
    input: TranscriptionParams & { model?: string },
  ): Promise<TranscriptionResult> {
    const resolved = this.#resolve('asr', input.model);
    const fn = resolved.adapter.transcribeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved.vendor, 'asr');
    return fn(resolved.context, resolved.modelId, {
      audioBase64: input.audioBase64,
      audioMime: input.audioMime,
      language: input.language,
    });
  }

  async generateVideo(
    input: VideoGenerationParams & { model?: string },
  ): Promise<{ provider: string; taskId: string }> {
    const resolved = this.#resolve('video', input.model);
    const handle = await resolved.adapter.submitVideo(resolved.context, resolved.modelId, {
      prompt: input.prompt,
      images: input.images,
      resolution: input.resolution,
      ratio: input.ratio,
      size: input.size,
      duration: input.duration,
    });
    return { provider: resolved.vendor, taskId: handle.taskId };
  }

  async videoStatus(provider: string, taskId: string): Promise<VideoTaskStatus> {
    const resolved = this.#resolveVendor(provider);
    return resolved.adapter.videoStatus(resolved.context, taskId);
  }

  async rerank(input: RerankParams & { model?: string }): Promise<RerankResult> {
    const resolved = this.#resolve('rerank', input.model);
    const fn = resolved.adapter.rerank;
    if (fn === undefined) throw this.#unsupported(resolved.vendor, 'rerank');
    return fn(resolved.context, resolved.modelId, {
      query: input.query,
      documents: input.documents,
      topN: input.topN,
    });
  }

  async understandImage(
    input: UnderstandImageParams & { model?: string },
  ): Promise<{ text: string }> {
    const resolved = this.#resolve('multimodal', input.model);
    const fn = resolved.adapter.understandImage;
    if (fn === undefined) throw this.#unsupported(resolved.vendor, 'multimodal');
    return fn(resolved.context, resolved.modelId, {
      images: input.images,
      prompt: input.prompt,
    });
  }

  /**
   * 轮询直至任务终态（供未来的语音/视频生成工具使用；RPC 层只暴露单次
   * 查询，长等待由调用方决定）。
   */
  async pollVideo(
    provider: string,
    taskId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<VideoTaskStatus> {
    const intervalMs = opts.intervalMs ?? 10_000;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const status = await this.videoStatus(provider, taskId);
      if (status.status === 'succeeded' || status.status === 'failed') return status;
      if (Date.now() + intervalMs > deadline) {
        throw new AppError('TIMEOUT', `视频任务 ${taskId} 超时未完成`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // --- 向量（memory 的 GatewayEmbedder 与 embedding 探测共用） --------------

  /** 能力是否已有配置（不发网络请求；Key 是否有效另说）。 */
  capabilityConfigured(capability: CapabilityModelKey): boolean {
    return this.#settings.get().capabilityModels[capability] !== null;
  }

  /** 厂商向量调用：适配器按模型家族路由（百炼多模态/早期模型走原生端点）。 */
  async embedTexts(provider: string, model: string, texts: string[]): Promise<number[][]> {
    const resolved = this.#resolveVendor(provider);
    return resolved.adapter.embed(resolved.context, model, texts);
  }

  /** 向量来源是否可用（capabilityModels.embedding + key 齐备，不发网络请求）。 */
  embeddingReady(): boolean {
    const config = this.#settings.get().capabilityModels.embedding;
    if (config === null) return false;
    try {
      this.#resolveVendor(config.vendor);
      return true;
    } catch {
      return false;
    }
  }

  // --- 按能力的连通性测试（providers.test capability != 'chat'） ------------

  /**
   * 各能力用最小真实请求探测（对话能力在 ProvidersService 走 pi 注册表）：
   * - embedding：一次单词 embed
   * - rerank：query + 2 条短文档
   * - multimodal：内置 1×1 PNG + 提问
   * - image / tts / asr：一次最小生成（asr 用内置静音 WAV）
   * - video：提交任务后立即取消（零成片计费）
   */
  async testCapability(
    capability: Exclude<ModelCapability, 'chat'>,
    target: { vendor: string; model: string },
  ): Promise<void> {
    if (!isVendorId(target.vendor)) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `媒体能力仅支持内置国内厂商（百炼/火山方舟），不支持 ${target.vendor}`,
      );
    }
    const vendor = target.vendor;
    if (!VENDOR_DESCRIPTORS[vendor].capabilities.includes(capability)) {
      throw this.#unsupported(vendor, capability);
    }
    const resolved = this.#resolveVendor(vendor);
    resolved.modelId = target.model;
    const ctx = resolved.context;
    switch (capability) {
      case 'embedding': {
        const vectors = await resolved.adapter.embed(ctx, target.model, ['ping']);
        if (vectors.length === 0 || vectors[0]!.length === 0) {
          throw new AppError('PROVIDER_UNAVAILABLE', '未返回向量');
        }
        return;
      }
      case 'rerank': {
        const fn = resolved.adapter.rerank;
        if (fn === undefined) throw this.#unsupported(vendor, 'rerank');
        const result = await fn(ctx, target.model, {
          query: '连通性测试',
          documents: ['这是一条用于连通性测试的候选文档。', '今天天气不错。'],
          topN: 2,
        });
        if (result.results.length === 0) {
          throw new AppError('PROVIDER_UNAVAILABLE', '重排接口未返回结果');
        }
        return;
      }
      case 'multimodal': {
        const fn = resolved.adapter.understandImage;
        if (fn === undefined) throw this.#unsupported(vendor, 'multimodal');
        const result = await fn(ctx, target.model, {
          images: [buildSolidPngDataUri()],
          prompt: '请用不超过五个字回答：这张图是什么？',
        });
        if (result.text.length === 0) {
          throw new AppError('PROVIDER_UNAVAILABLE', '图片理解接口未返回文本');
        }
        return;
      }
      case 'image': {
        // 编辑专用模型（id 含 edit）必须带参考图：附带探针 PNG 走编辑路径。
        const isEditModel = /edit/i.test(target.model);
        const result = await resolved.adapter.generateImage(ctx, target.model, {
          prompt: isEditModel ? '把这张图里的圆形改成蓝色' : '一个纯红色圆形，纯白背景，极简测试图',
          ...(isEditModel ? { images: [buildSolidPngDataUri()] } : {}),
          n: 1,
        });
        if (result.images.length === 0) throw new AppError('PROVIDER_UNAVAILABLE', '未返回图片');
        return;
      }
      case 'tts': {
        const fn = resolved.adapter.synthesizeSpeech;
        if (fn === undefined) throw this.#unsupported(vendor, 'tts');
        const result = await fn(ctx, target.model, { text: '你好' });
        if (result.audioBase64.length === 0)
          throw new AppError('PROVIDER_UNAVAILABLE', '未返回音频');
        return;
      }
      case 'asr': {
        const fn = resolved.adapter.transcribeSpeech;
        if (fn === undefined) throw this.#unsupported(vendor, 'asr');
        await fn(ctx, target.model, {
          audioBase64: buildSilentWavBase64(),
          audioMime: PROBE_AUDIO_MIME,
        });
        return;
      }
      case 'video':
        return this.#testVideo(resolved, target.model);
    }
  }

  async #testVideo(resolved: ResolvedVendor, modelId: string): Promise<void> {
    const { vendor, context, adapter } = resolved;
    // 提交即校验 key、模型与参数；拿到 taskId 后立刻取消（零成片计费）。
    const handle = await adapter.submitVideo(context, modelId, { prompt: '连通性测试' });
    try {
      await adapter.cancelVideo?.(context, handle.taskId);
    } catch (error) {
      // 取消失败不影响判定（提交成功已证明可用），只记日志。
      this.#logger.warn(
        { vendor, taskId: handle.taskId, error: String(error) },
        'video test cancel failed',
      );
    }
  }

  // --- 解析 ----------------------------------------------------------------

  /**
   * 能力 → 厂商条目（capabilityModels）+ 适配器 + 调用上下文。model
   * 显式传入时覆盖配置里的模型 id。
   */
  #resolve(capability: MediaCapability, modelId?: string): ResolvedVendor {
    const config = this.#settings.get().capabilityModels[capability];
    if (config === null) {
      // 专用错误码（而非 INVALID_INPUT）：调用方（Bot 工具、inline setup）
      // 据此判定"缺的是用户配置"并给出设置引导（docs/design/18-inline-setup.md）。
      throw new AppError(
        'CAPABILITY_NOT_CONFIGURED',
        `未配置「${capability}」模型，请在设置-模型中选择厂商并配置`,
      );
    }
    const resolved = this.#resolveVendor(config.vendor);
    resolved.modelId = modelId ?? config.model;
    this.#requireAdapterCapability(resolved, capability);
    return resolved;
  }

  /** 厂商 id → key/baseUrl 解析与适配器。不校验能力方法（调用方负责）。 */
  #resolveVendor(provider: string): ResolvedVendor {
    if (!isVendorId(provider)) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `媒体能力仅支持内置国内厂商（百炼/火山方舟），不支持 ${provider}`,
      );
    }
    const apiKey = this.#secrets.getValue(providerSecretName(provider));
    if (apiKey === null) {
      throw new AppError(
        'PROVIDER_AUTH_FAILED',
        `厂商 ${VENDOR_DESCRIPTORS[provider].name} 未配置 API Key`,
      );
    }
    const baseUrl = providerCompatBaseUrl(this.#settings.get(), provider);
    if (baseUrl === null) {
      throw new AppError('PROVIDER_UNAVAILABLE', `厂商 ${provider} 缺少 baseUrl`);
    }
    return {
      vendor: provider,
      modelId: '',
      context: {
        vendor: provider,
        baseUrl,
        apiKey,
        logger: this.#logger,
        ...(this.#fetchImpl !== undefined ? { fetchImpl: this.#fetchImpl } : {}),
      },
      adapter: ADAPTERS[provider],
    };
  }

  /** 适配器未实现该能力（应与描述符能力矩阵一致）时的明确提示。 */
  #requireAdapterCapability(resolved: ResolvedVendor, capability: MediaCapability): void {
    const adapter = resolved.adapter;
    const supported =
      capability === 'embedding' ||
      capability === 'image' ||
      capability === 'video' ||
      (capability === 'rerank' && adapter.rerank !== undefined) ||
      (capability === 'multimodal' && adapter.understandImage !== undefined) ||
      (capability === 'tts' && adapter.synthesizeSpeech !== undefined) ||
      (capability === 'asr' && adapter.transcribeSpeech !== undefined);
    if (!supported) throw this.#unsupported(resolved.vendor, capability);
  }

  /** 厂商不提供该能力时的明确提示。 */
  #unsupported(vendor: VendorId, capability: ModelCapability): AppError {
    return new AppError(
      'NOT_IMPLEMENTED',
      `${VENDOR_DESCRIPTORS[vendor].name} 不提供「${capability}」能力`,
    );
  }
}
