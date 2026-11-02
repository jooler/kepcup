import {
  AppError,
  VENDOR_DESCRIPTORS,
  newId,
  type CapabilityModelKey,
  type LoopType,
  type ModelCapability,
  type Settings,
  type VendorId,
} from '@kepcup/shared';
import { findProviderInstance, providerSecretName } from '../agent/models.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import { dashscopeAdapter } from './adapters/dashscope.js';
import { volcengineAdapter } from './adapters/volcengine.js';
import { openAICompatibleAdapter } from './adapters/openai-compatible.js';
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
 * （供应商实例 + 模型，见 docs/design/16-capability-models.md）解析出实例后
 * 路由到适配器：内置厂商实例走各家原生适配器，自定义实例（vendor = null）
 * 走 OpenAI 兼容通用适配器（目前只有向量有跨厂商的事实标准）。调用方
 * （RPC media.*、memory 检索、Bot 工具）只面对厂商无关的参数。
 *
 * API key 按实例共享（provider:{实例id}，与对话配置同一条）；baseUrl 取实例
 * 上的值。media.* 入参的 model 是裸模型 id，省略时用该能力的配置。
 */

const ADAPTERS: Record<VendorId, VendorAdapter> = {
  dashscope: dashscopeAdapter,
  volcengine: volcengineAdapter,
};

/**
 * 媒体调用的用量归属（task 2：每次成功调用在 usage_ledger 记一行）。省略或
 * 传 null = 不记账（设置页连通性测试等）；没有所属 run 的调用（记忆向量、语音
 * 输入）不给 runId，账本行自动取一个 media_ 前缀的合成 id。
 */
export interface MediaUsageContext {
  runId?: string | null | undefined;
  botId?: string | null | undefined;
  conversationId?: string | null | undefined;
  loopType: LoopType;
}

/** 除 chat 外的全部模型能力（settings.capabilityModels 的 key）。 */
type MediaCapability = Exclude<keyof Settings['capabilityModels'], number>;

interface ResolvedProvider {
  /** 适配器路由键：厂商 id，自定义实例为 'custom'。 */
  vendor: VendorId | 'custom';
  /** 实例 id（用量记账与 videoStatus 往返的 provider 值）。 */
  instanceId: string;
  modelId: string;
  context: VendorCallContext;
  adapter: VendorAdapter;
}

export class MediaService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #logger: CoreLogger;
  readonly #usage: UsageService | undefined;
  /** Test seam: injected fetch for adapter unit tests. */
  readonly #fetchImpl?: typeof fetch;

  constructor(deps: {
    settings: SettingsService;
    secrets: SecretsService;
    logger: CoreLogger;
    /** 缺省不记账（单测与无账本的装配）。 */
    usage?: UsageService;
    fetchImpl?: typeof fetch;
  }) {
    this.#settings = deps.settings;
    this.#secrets = deps.secrets;
    this.#logger = deps.logger;
    this.#usage = deps.usage;
    this.#fetchImpl = deps.fetchImpl;
  }

  // --- 统一调用入口（media.* RPC 背后的方法） ------------------------------

  async generateImage(
    input: ImageGenerationParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<ImageGenerationResult> {
    const resolved = this.#resolve('image', input.model);
    const fn = resolved.adapter.generateImage;
    if (fn === undefined) throw this.#unsupported(resolved, 'image');
    const result = await fn(resolved.context, resolved.modelId, {
      prompt: input.prompt,
      images: input.images,
      n: input.n,
      size: input.size,
      negativePrompt: input.negativePrompt,
      seed: input.seed,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return result;
  }

  async synthesizeSpeech(
    input: SpeechParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<SpeechResult> {
    const resolved = this.#resolve('tts', input.model);
    const fn = resolved.adapter.synthesizeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved, 'tts');
    const result = await fn(resolved.context, resolved.modelId, {
      text: input.text,
      voice: input.voice,
      format: input.format,
      speed: input.speed,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return result;
  }

  async transcribeSpeech(
    input: TranscriptionParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<TranscriptionResult> {
    const resolved = this.#resolve('asr', input.model);
    const fn = resolved.adapter.transcribeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved, 'asr');
    const result = await fn(resolved.context, resolved.modelId, {
      audioBase64: input.audioBase64,
      audioMime: input.audioMime,
      language: input.language,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return result;
  }

  async generateVideo(
    input: VideoGenerationParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<{ provider: string; taskId: string }> {
    const resolved = this.#resolve('video', input.model);
    const fn = resolved.adapter.submitVideo;
    if (fn === undefined) throw this.#unsupported(resolved, 'video');
    const handle = await fn(resolved.context, resolved.modelId, {
      prompt: input.prompt,
      images: input.images,
      resolution: input.resolution,
      ratio: input.ratio,
      size: input.size,
      duration: input.duration,
    });
    // 记在提交成功处：一次任务一行，轮询状态不计。
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return { provider: resolved.instanceId, taskId: handle.taskId };
  }

  async videoStatus(provider: string, taskId: string): Promise<VideoTaskStatus> {
    const resolved = this.#resolveProvider(provider);
    const fn = resolved.adapter.videoStatus;
    if (fn === undefined) throw this.#unsupported(resolved, 'video');
    return fn(resolved.context, taskId);
  }

  async rerank(
    input: RerankParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<RerankResult> {
    const resolved = this.#resolve('rerank', input.model);
    const fn = resolved.adapter.rerank;
    if (fn === undefined) throw this.#unsupported(resolved, 'rerank');
    const result = await fn(resolved.context, resolved.modelId, {
      query: input.query,
      documents: input.documents,
      topN: input.topN,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return result;
  }

  async understandImage(
    input: UnderstandImageParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<{ text: string }> {
    const resolved = this.#resolve('multimodal', input.model);
    const fn = resolved.adapter.understandImage;
    if (fn === undefined) throw this.#unsupported(resolved, 'multimodal');
    const result = await fn(resolved.context, resolved.modelId, {
      images: input.images,
      prompt: input.prompt,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage);
    return result;
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

  /** 供应商实例向量调用：适配器按实例路由（内置厂商原生端点 / 自定义兼容端点）。 */
  async embedTexts(
    provider: string,
    model: string,
    texts: string[],
    usage?: MediaUsageContext | null,
  ): Promise<number[][]> {
    const resolved = this.#resolveProvider(provider);
    const vectors = await resolved.adapter.embed(resolved.context, model, texts);
    this.#recordUsage(resolved.instanceId, model, usage);
    return vectors;
  }

  /** 向量来源是否可用（capabilityModels.embedding + key 齐备，不发网络请求）。 */
  embeddingReady(): boolean {
    const config = this.#settings.get().capabilityModels.embedding;
    if (config === null) return false;
    try {
      this.#resolveProvider(config.provider);
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
    target: { provider: string; model: string },
    options: { keyOverride?: string } = {},
  ): Promise<void> {
    const resolved = this.#resolveProvider(target.provider, options.keyOverride);
    resolved.modelId = target.model;
    // 内置厂商实例还要过描述符能力矩阵（方舟没有 Rerank / TTS / ASR）；
    // 自定义实例的能力边界就是适配器实现的方法。
    if (
      resolved.vendor !== 'custom' &&
      !VENDOR_DESCRIPTORS[resolved.vendor].capabilities.includes(capability)
    ) {
      throw this.#unsupported(resolved, capability);
    }
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
        if (fn === undefined) throw this.#unsupported(resolved, 'rerank');
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
        if (fn === undefined) throw this.#unsupported(resolved, 'multimodal');
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
        const fn = resolved.adapter.generateImage;
        if (fn === undefined) throw this.#unsupported(resolved, 'image');
        const isEditModel = /edit/i.test(target.model);
        const result = await fn(ctx, target.model, {
          prompt: isEditModel ? '把这张图里的圆形改成蓝色' : '一个纯红色圆形，纯白背景，极简测试图',
          ...(isEditModel ? { images: [buildSolidPngDataUri()] } : {}),
          n: 1,
        });
        if (result.images.length === 0) throw new AppError('PROVIDER_UNAVAILABLE', '未返回图片');
        return;
      }
      case 'tts': {
        const fn = resolved.adapter.synthesizeSpeech;
        if (fn === undefined) throw this.#unsupported(resolved, 'tts');
        const result = await fn(ctx, target.model, { text: '你好' });
        if (result.audioBase64.length === 0)
          throw new AppError('PROVIDER_UNAVAILABLE', '未返回音频');
        return;
      }
      case 'asr': {
        const fn = resolved.adapter.transcribeSpeech;
        if (fn === undefined) throw this.#unsupported(resolved, 'asr');
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

  async #testVideo(resolved: ResolvedProvider, modelId: string): Promise<void> {
    const { instanceId, context, adapter } = resolved;
    const submit = adapter.submitVideo;
    if (submit === undefined) throw this.#unsupported(resolved, 'video');
    // 提交即校验 key、模型与参数；拿到 taskId 后立刻取消（零成片计费）。
    const handle = await submit(context, modelId, { prompt: '连通性测试' });
    try {
      await adapter.cancelVideo?.(context, handle.taskId);
    } catch (error) {
      // 取消失败不影响判定（提交成功已证明可用），只记日志。
      this.#logger.warn(
        { provider: instanceId, taskId: handle.taskId, error: String(error) },
        'video test cancel failed',
      );
    }
  }

  // --- 用量 ----------------------------------------------------------------

  /**
   * 一次成功调用 = 账本一行（次数按行统计，不新增列）。适配器目前不上报
   * token，故 token 记 0、费用留空；失败的调用不记；记账失败只打日志，绝不
   * 影响调用结果。provider 记实例 id（与对话侧 pi 注册表的 provider 一致）。
   */
  #recordUsage(
    provider: string,
    modelId: string,
    usage: MediaUsageContext | null | undefined,
  ): void {
    if (this.#usage === undefined || usage === undefined || usage === null) return;
    try {
      this.#usage.record({
        runId: usage.runId ?? `media_${newId('use')}`,
        botId: usage.botId ?? null,
        conversationId: usage.conversationId ?? null,
        loopType: usage.loopType,
        provider,
        model: modelId,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
      });
    } catch (error) {
      this.#logger.warn(
        { provider, error: error instanceof Error ? error.message : String(error) },
        'media usage record failed',
      );
    }
  }

  // --- 解析 ----------------------------------------------------------------

  /**
   * 能力 → 配置（capabilityModels）+ 实例 + 适配器 + 调用上下文。model
   * 显式传入时覆盖配置里的模型 id。
   */
  #resolve(capability: MediaCapability, modelId?: string): ResolvedProvider {
    const config = this.#settings.get().capabilityModels[capability];
    if (config === null) {
      // 专用错误码（而非 INVALID_INPUT）：调用方（Bot 工具、inline setup）
      // 据此判定"缺的是用户配置"并给出设置引导（docs/design/18-inline-setup.md）。
      throw new AppError(
        'CAPABILITY_NOT_CONFIGURED',
        `未配置「${capability}」模型，请在设置-模型中选择并配置`,
      );
    }
    const resolved = this.#resolveProvider(config.provider);
    // Anthropic 协议端点没有 OpenAI 兼容的媒体接口（通用适配器无从调用）；
    // UI 的能力候选已排除，这里兜底。
    const instance = findProviderInstance(this.#settings.get(), config.provider);
    if (
      resolved.vendor === 'custom' &&
      instance !== undefined &&
      instance.api === 'anthropic-messages'
    ) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `${instance.name} 使用 Anthropic 协议端点，不提供「${capability}」媒体能力`,
      );
    }
    resolved.modelId = modelId ?? config.model;
    this.#requireAdapterCapability(resolved, capability);
    return resolved;
  }

  /**
   * 实例 id → key/baseUrl 解析与适配器。不校验能力方法（调用方负责）。
   * keyOverride：未保存先测（providers.test）用入参 key，不读密钥表。
   */
  #resolveProvider(instanceId: string, keyOverride?: string): ResolvedProvider {
    const instance = findProviderInstance(this.#settings.get(), instanceId);
    if (instance === undefined) {
      throw new AppError('NOT_FOUND', `供应商实例 "${instanceId}" 不存在`);
    }
    const apiKey = keyOverride ?? this.#secrets.getValue(providerSecretName(instance.id));
    if (apiKey === null) {
      throw new AppError('PROVIDER_AUTH_FAILED', `供应商 ${instance.name} 未配置 API Key`);
    }
    return {
      vendor: instance.vendor ?? 'custom',
      instanceId: instance.id,
      modelId: '',
      context: {
        vendor: instance.vendor ?? 'custom',
        baseUrl: instance.baseUrl ?? '',
        apiKey,
        logger: this.#logger,
        ...(this.#fetchImpl !== undefined ? { fetchImpl: this.#fetchImpl } : {}),
      },
      adapter: instance.vendor === null ? openAICompatibleAdapter : ADAPTERS[instance.vendor],
    };
  }

  /** 适配器未实现该能力（应与描述符能力矩阵一致）时的明确提示。 */
  #requireAdapterCapability(resolved: ResolvedProvider, capability: MediaCapability): void {
    const adapter = resolved.adapter;
    const supported =
      (capability === 'embedding' && adapter.embed !== undefined) ||
      (capability === 'image' && adapter.generateImage !== undefined) ||
      (capability === 'video' &&
        adapter.submitVideo !== undefined &&
        adapter.videoStatus !== undefined) ||
      (capability === 'rerank' && adapter.rerank !== undefined) ||
      (capability === 'multimodal' && adapter.understandImage !== undefined) ||
      (capability === 'tts' && adapter.synthesizeSpeech !== undefined) ||
      (capability === 'asr' && adapter.transcribeSpeech !== undefined);
    if (!supported) throw this.#unsupported(resolved, capability);
  }

  /** 实例不提供该能力时的明确提示（自定义实例用实例 id 显示）。 */
  #unsupported(resolved: ResolvedProvider, capability: ModelCapability): AppError {
    const name =
      resolved.vendor === 'custom' ? resolved.instanceId : VENDOR_DESCRIPTORS[resolved.vendor].name;
    return new AppError('NOT_IMPLEMENTED', `${name} 不提供「${capability}」能力`);
  }
}
