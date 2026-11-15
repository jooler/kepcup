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
import { findProviderInstance, nextProviderApiKey } from '../agent/models.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import { MEDIA_ENGINES } from './engines.js';
import type { MediaEngine } from './engines.js';
import type { MediaEntrySummaries } from '../tools/media-entry-hints.js';
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
import type { CapabilityModelEntry } from '@kepcup/shared';

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

/**
 * 条目仓库（D124，60 号文档 §4）：media 侧只依赖本接口，实现住 plugins/ 侧
 * （media → plugins 的反向依赖经注入断开，start.ts 在插件装配后接上）。
 * entriesFor 返回该 Bot 在该能力下可用的条目（botRuntime.capability_entries ∩
 * effectivePluginIds ∩ 插件已装启用；输出序 = 插件级 Bot 勾选序 + 插件内条目
 * 声明序，见 DEV-099）；实例维度：
 * - `instanceId` 仅在「条目显式指定且存在」或「插件恰好一个实例」时填；
 * - 多实例未指定留空并带上 `instances` 全集（MediaService 据此判 INSTANCE_AMBIGUOUS）；
 * - 零实例留空（MediaService 报 CAPABILITY_NOT_CONFIGURED，payload 带条目定位）。
 */
export interface MediaEntrySource {
  entriesFor(botId: string | undefined, capability: MediaCapability): Promise<ResolvedEntry[]>;
  /** 单个条目定义（清单投影；null = 插件 / 条目不存在）。 */
  entryOf(pluginId: string, entryId: string): Promise<CapabilityModelEntry | null>;
  /** 插件当前的 capability-model 实例 id 全集（条目测试的实例解析用）。 */
  instancesOf(pluginId: string): string[];
  /** 实例敏感凭据（secrets；keyOverride 支持未保存先测）。null = 缺失。 */
  instanceCredential(
    pluginId: string,
    instanceId: string,
    key: string,
    keyOverride?: string,
  ): string | null;
  /** 实例非敏感配置（config_json；无行 = null）。 */
  instanceConfig(pluginId: string, instanceId: string): Record<string, unknown> | null;
  /**
   * 实例 → 所属插件与执行体来源（generateVideo → videoStatus 的 provider 往返；
   * null = 非插件实例）。D125：`source` 区分第一方引擎与执行型插件（托管适配器）。
   */
  capabilityInstanceOf(instanceId: string): Promise<{
    pluginId: string;
    engine: string;
    source: 'engine' | 'plugin';
    entryId: string;
    model: string;
  } | null>;
  /**
   * D125：插件 → 托管适配器（所属插件含 `runtime` 段时非 null；数据型插件 = null）。
   * 可选（单测夹具不装配运行时）：条目 `source: 'plugin'` 时缺失 = 运行时未装配。
   */
  hostedAdapterOf?(pluginId: string): Promise<VendorAdapter | null>;
}

/** 解析出的一个可用条目（60 号 §4 的 ① 分支）。 */
export interface ResolvedEntry {
  pluginId: string;
  entryId: string;
  model: string;
  /** 数据型条目的引擎 id；执行型条目为 ''（`source:'plugin'`，无第一方引擎）。 */
  engine: string;
  /**
   * D125：执行体来源——'engine' = 第一方引擎注册表；'plugin' = 所属插件含 `runtime`
   * 段，经 HostedAdapter 在插件子进程执行（61 §5）。
   */
  source: 'engine' | 'plugin';
  /** 条目展示名（displayName 缺省时实现侧回填 model，工具 model 参数匹配用）。 */
  displayName?: string;
  /** 条目级引擎参数覆盖（原样透传到 VendorCallContext.entryParams）。 */
  params?: Record<string, unknown>;
  /** 唯一实例 / 条目显式指定且存在时填；多实例未指定或零实例留空。 */
  instanceId?: string;
  /** 该插件当前全部实例 id（INSTANCE_AMBIGUOUS 判定与文案用）。 */
  instances?: readonly string[];
}

/** 媒体方法的条目解析透传（缺省 = 现行为：走全局槽位）。 */
export interface MediaResolveOptions {
  /** Bot 上下文；null / 缺省 = 不走条目路径。 */
  botId?: string | null | undefined;
  /** 工具显式 model 参数：匹配条目 model / displayName，未命中回首个条目。 */
  model?: string | undefined;
}

interface ResolvedProvider {
  /** 适配器路由键：厂商 id，自定义实例为 'custom'。 */
  vendor: VendorId | 'custom';
  /** 实例 id（用量记账与 videoStatus 往返的 provider 值）；条目路径为插件实例 id。 */
  instanceId: string;
  modelId: string;
  context: VendorCallContext;
  adapter: VendorAdapter;
  /** 条目命中时携带（用量记账写 capability / model_entry_id，provider 记插件 id）。 */
  entry?: { pluginId: string; entryId: string; capability: MediaCapability } | undefined;
}

export class MediaService {
  readonly #settings: SettingsService;
  readonly #secrets: SecretsService;
  readonly #logger: CoreLogger;
  readonly #usage: UsageService | undefined;
  /** Test seam: injected fetch for adapter unit tests. */
  readonly #fetchImpl?: typeof fetch;
  /**
   * 条目仓库（D124）：start.ts 在插件装配后注入。未注入（单测 / 未装配）=
   * 恒走全局槽位路径——未装任何能力模型插件的环境行为与从前逐字节一致。
   */
  #entrySource: MediaEntrySource | undefined;

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

  /** D124：接入条目仓库（插件装配后调用一次；全局槽位路径不受影响）。 */
  attachEntrySource(source: MediaEntrySource): void {
    this.#entrySource = source;
  }

  // --- 统一调用入口（media.* RPC 背后的方法） ------------------------------

  async generateImage(
    input: ImageGenerationParams & { model?: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
  ): Promise<ImageGenerationResult> {
    const resolved = await this.#resolve('image', input.model, resolve);
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
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
    return result;
  }

  async synthesizeSpeech(
    input: SpeechParams & { model?: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
  ): Promise<SpeechResult> {
    const resolved = await this.#resolve('tts', input.model, resolve);
    const fn = resolved.adapter.synthesizeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved, 'tts');
    const result = await fn(resolved.context, resolved.modelId, {
      text: input.text,
      voice: input.voice,
      format: input.format,
      speed: input.speed,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
    return result;
  }

  async transcribeSpeech(
    input: TranscriptionParams & { model?: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
  ): Promise<TranscriptionResult> {
    const resolved = await this.#resolve('asr', input.model, resolve);
    const fn = resolved.adapter.transcribeSpeech;
    if (fn === undefined) throw this.#unsupported(resolved, 'asr');
    const result = await fn(resolved.context, resolved.modelId, {
      audioBase64: input.audioBase64,
      audioMime: input.audioMime,
      language: input.language,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
    return result;
  }

  async generateVideo(
    input: VideoGenerationParams & { model?: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
  ): Promise<{ provider: string; taskId: string }> {
    const resolved = await this.#resolve('video', input.model, resolve);
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
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
    // provider 返回给调用方做 videoStatus 往返：条目路径是插件实例 id（pli_…），
    // videoStatus 经条目仓库解析回插件凭据（全局路径仍是供应商实例 id，不变）。
    return { provider: resolved.instanceId, taskId: handle.taskId };
  }

  async videoStatus(provider: string, taskId: string): Promise<VideoTaskStatus> {
    const resolved = await this.#resolveVideoProvider(provider);
    const fn = resolved.adapter.videoStatus;
    if (fn === undefined) throw this.#unsupported(resolved, 'video');
    return fn(resolved.context, taskId);
  }

  /**
   * rerank / embedTexts 不走条目路径（60 号 §10 Q4：embedding / rerank 条目本期
   * 不消费——记忆管线绑定全局槽位），保持原签名与语义。
   */
  async rerank(
    input: RerankParams & { model?: string },
    usage?: MediaUsageContext | null,
  ): Promise<RerankResult> {
    const resolved = await this.#resolve('rerank', input.model);
    const fn = resolved.adapter.rerank;
    if (fn === undefined) throw this.#unsupported(resolved, 'rerank');
    const result = await fn(resolved.context, resolved.modelId, {
      query: input.query,
      documents: input.documents,
      topN: input.topN,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
    return result;
  }

  async understandImage(
    input: UnderstandImageParams & { model?: string },
    usage?: MediaUsageContext | null,
    resolve?: MediaResolveOptions,
  ): Promise<{ text: string }> {
    const resolved = await this.#resolve('multimodal', input.model, resolve);
    const fn = resolved.adapter.understandImage;
    if (fn === undefined) throw this.#unsupported(resolved, 'multimodal');
    const result = await fn(resolved.context, resolved.modelId, {
      images: input.images,
      prompt: input.prompt,
    });
    this.#recordUsage(resolved.instanceId, resolved.modelId, usage, resolved.entry);
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
    this.#recordUsage(resolved.instanceId, model, usage, resolved.entry);
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
    return this.#runProbe(capability, resolved);
  }

  /**
   * Bot 已勾选条目的摘要（D124 P3：三个生成工具描述注入的数据面）。按能力返回
   * `displayName(model)` 名单（displayName 与 model 相同时只留 model，避免重复）；
   * 条目仓库未装配 / botId 为空 = 各能力恒空数组（工具描述保持逐字节不变）。
   * 只查三个生成能力——understand_image / transcribe_audio 无条目注入（无 model 参数）。
   */
  async entrySummariesFor(botId: string | null | undefined): Promise<MediaEntrySummaries> {
    const summaries = { image: [] as string[], tts: [] as string[], video: [] as string[] };
    if (this.#entrySource === undefined || botId === null || botId === undefined || botId === '') {
      return summaries;
    }
    const push = (capability: 'image' | 'tts' | 'video', entries: ResolvedEntry[]): void => {
      for (const entry of entries) {
        const name =
          entry.displayName !== undefined && entry.displayName !== entry.model
            ? `${entry.displayName}（${entry.model}）`
            : entry.model;
        if (!summaries[capability].includes(name)) summaries[capability].push(name);
      }
    };
    push('image', await this.#entrySource.entriesFor(botId, 'image'));
    push('tts', await this.#entrySource.entriesFor(botId, 'tts'));
    push('video', await this.#entrySource.entriesFor(botId, 'video'));
    return summaries;
  }

  /**
   * 条目级连通性测试（D124，`plugins.testCapabilityEntry`）：按条目能力走
   * testCapability 同款探针（1×1 PNG / 静音 WAV / 「你好」/ video 提交即取消），
   * 凭据取插件实例（keyOverride 支持未保存先测）。实例解析：入参 > 条目
   * `instance` > 唯一实例；多实例未指定拒绝（INSTANCE_AMBIGUOUS）。
   */
  async testCapabilityEntry(
    pluginId: string,
    entryId: string,
    options: { instanceId?: string; keyOverride?: string } = {},
  ): Promise<void> {
    const source = this.#requireEntrySource();
    const entry = await source.entryOf(pluginId, entryId);
    if (entry === null) {
      throw new AppError('NOT_FOUND', `插件 ${pluginId} 没有条目「${entryId}」`);
    }
    // 实例解析（入参 > 条目 instance > 唯一实例；多实例未指定拒绝）。
    const resolveInstanceId = (): string => {
      const explicit = options.instanceId ?? entry.instance;
      if (explicit !== undefined) return explicit;
      const rows = source.instancesOf(pluginId);
      if (rows.length === 1) return rows[0]!;
      if (rows.length > 1) {
        throw new AppError(
          'INSTANCE_AMBIGUOUS',
          `插件有 ${rows.length} 个厂商账号实例，请指定要测试的实例`,
          { pluginId, entryId, instances: rows },
        );
      }
      throw this.#entryNotConfigured('该条目还没有可用的厂商账号实例，请先添加并填写凭据', {
        pluginId,
        entryId,
      });
    };
    // D125：执行型条目（所属插件含 runtime 段）走托管适配器的同一 invoke 路径（探针
    // 与真实调用同一入口，超时用契约默认）；数据型条目保持 D124 的引擎路径。
    const hosted = (await source.hostedAdapterOf?.(pluginId)) ?? null;
    if (hosted !== null) {
      const instanceId = resolveInstanceId();
      const resolved = this.#hostedProvider(pluginId, entryId, instanceId, entry.model, hosted);
      resolved.entry = { pluginId, entryId, capability: entry.capability };
      if (entry.params !== undefined) resolved.context.entryParams = entry.params;
      return this.#runProbe(entry.capability, resolved);
    }
    // 数据型条目：先引擎、后实例——错误判定顺序与 D124 逐字节一致。
    if (entry.engine === undefined) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `插件 ${pluginId} 的托管运行时未装配，无法探测执行型条目「${entryId}」`,
      );
    }
    const engine = MEDIA_ENGINES[entry.engine];
    if (engine === undefined) {
      throw new AppError(
        'PLUGIN_ENGINE_UNKNOWN',
        `条目「${entryId}」绑定的引擎「${entry.engine}」未注册`,
      );
    }
    const instanceId = resolveInstanceId();
    const resolved = this.#resolvePluginInstance(pluginId, instanceId, engine, options.keyOverride);
    resolved.modelId = entry.model;
    // 引擎能力矩阵（安装期已保证引擎注册；这里防御引擎不支持条目声明的能力）。
    if (!engine.capabilities.includes(entry.capability)) {
      throw this.#unsupported(resolved, entry.capability);
    }
    return this.#runProbe(entry.capability, resolved);
  }

  /** 各能力探针开关（testCapability / testCapabilityEntry 共用；modelId 已在 resolved 上）。 */
  async #runProbe(
    capability: Exclude<ModelCapability, 'chat'>,
    resolved: ResolvedProvider,
  ): Promise<void> {
    const ctx = resolved.context;
    const modelId = resolved.modelId;
    switch (capability) {
      case 'embedding': {
        const vectors = await resolved.adapter.embed(ctx, modelId, ['ping']);
        if (vectors.length === 0 || vectors[0]!.length === 0) {
          throw new AppError('PROVIDER_UNAVAILABLE', '未返回向量');
        }
        return;
      }
      case 'rerank': {
        const fn = resolved.adapter.rerank;
        if (fn === undefined) throw this.#unsupported(resolved, 'rerank');
        const result = await fn(ctx, modelId, {
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
        const result = await fn(ctx, modelId, {
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
        const isEditModel = /edit/i.test(modelId);
        const result = await fn(ctx, modelId, {
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
        const result = await fn(ctx, modelId, { text: '你好' });
        if (result.audioBase64.length === 0)
          throw new AppError('PROVIDER_UNAVAILABLE', '未返回音频');
        return;
      }
      case 'asr': {
        const fn = resolved.adapter.transcribeSpeech;
        if (fn === undefined) throw this.#unsupported(resolved, 'asr');
        await fn(ctx, modelId, {
          audioBase64: buildSilentWavBase64(),
          audioMime: PROBE_AUDIO_MIME,
        });
        return;
      }
      case 'video':
        return this.#testVideo(resolved, modelId);
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
   * 影响调用结果。provider 记实例 id（与对话侧 pi 注册表的 provider 一致）；
   * D124 条目命中时改记插件 id，并写 capability / model_entry_id 两列
   * （'{pluginId}/{entryId}'）——全局槽位路径两列为 NULL（迁移 0075）。
   */
  #recordUsage(
    provider: string,
    modelId: string,
    usage: MediaUsageContext | null | undefined,
    entry?: ResolvedProvider['entry'],
  ): void {
    if (this.#usage === undefined || usage === undefined || usage === null) return;
    try {
      this.#usage.record({
        runId: usage.runId ?? `media_${newId('use')}`,
        botId: usage.botId ?? null,
        conversationId: usage.conversationId ?? null,
        loopType: usage.loopType,
        ...(entry !== undefined
          ? { provider: entry.pluginId, capability: entry.capability, modelEntryId: `${entry.pluginId}/${entry.entryId}` }
          : { provider }),
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
   * 能力 → 调用面（D124 解析顺序，60 号文档 §4）：① Bot 绑定条目（`resolve.botId`
   * 且条目仓库返回非空时——显式 model 匹配条目 model/displayName，未命中回首个）
   * → ② 全局槽位（`#resolveGlobal`，现状路径逐字节保留）→ ③ 未配置
   * （CAPABILITY_NOT_CONFIGURED，现状语义）。`modelId` 是全局路径的裸模型覆盖。
   */
  async #resolve(
    capability: MediaCapability,
    modelId?: string,
    resolve?: MediaResolveOptions,
  ): Promise<ResolvedProvider> {
    if (resolve?.botId != null && resolve.botId !== '' && this.#entrySource !== undefined) {
      const entries = await this.#entrySource.entriesFor(resolve.botId, capability);
      if (entries.length > 0) {
        return await this.#resolveEntry(capability, this.#selectEntry(entries, resolve.model));
      }
    }
    return this.#resolveGlobal(capability, modelId);
  }

  /** 条目挑选：显式 model 依次命中条目 model / displayName / entryId 才生效，否则用首个（声明序）。 */
  #selectEntry(entries: readonly ResolvedEntry[], modelHint?: string): ResolvedEntry {
    if (modelHint !== undefined && modelHint !== '') {
      const hit = entries.find(
        (entry) =>
          entry.model === modelHint ||
          entry.displayName === modelHint ||
          entry.entryId === modelHint,
      );
      if (hit !== undefined) return hit;
    }
    return entries[0]!;
  }

  /**
   * 条目 → 执行体 + 插件实例凭据（D125：按 `source` 选第一方引擎或托管适配器）。
   * 失败语义（60 号 §4）：多实例未指定 → INSTANCE_AMBIGUOUS；缺实例 / 缺凭据 →
   * CAPABILITY_NOT_CONFIGURED（details 带 {pluginId, entryId, instanceId?} 定位，
   * orchestrator 据此出插件凭据卡）。数据型条目（`source:'engine'`）路径与 D124
   * 逐字节一致。
   */
  async #resolveEntry(
    capability: MediaCapability,
    entry: ResolvedEntry,
  ): Promise<ResolvedProvider> {
    if (entry.source === 'plugin') {
      const instanceId = this.#entryInstanceOf(entry);
      const adapter = await this.#hostedAdapterOf(entry.pluginId);
      const resolved = this.#hostedProvider(
        entry.pluginId,
        entry.entryId,
        instanceId,
        entry.model,
        adapter,
      );
      resolved.entry = { pluginId: entry.pluginId, entryId: entry.entryId, capability };
      if (entry.params !== undefined) resolved.context.entryParams = entry.params;
      this.#requireAdapterCapability(resolved, capability);
      return resolved;
    }
    // 数据型条目：错误判定顺序与 D124 逐字节一致（先引擎，再实例）。
    const engine = MEDIA_ENGINES[entry.engine];
    if (engine === undefined) {
      // 安装期已校验；这里兜底降级 / 数据异常（60 §7：引擎永远在第一方）。
      throw new AppError(
        'PLUGIN_ENGINE_UNKNOWN',
        `条目 ${entry.entryId} 绑定的引擎「${entry.engine}」未注册`,
      );
    }
    const instanceId = this.#entryInstanceOf(entry);
    const resolved = this.#resolvePluginInstance(entry.pluginId, instanceId, engine);
    resolved.modelId = entry.model;
    this.#requireAdapterCapability(resolved, capability);
    // 条目级参数覆盖：原样进调用上下文（适配器本期不读；引擎逐键白名单消费，60 §7）。
    if (entry.params !== undefined) resolved.context.entryParams = entry.params;
    resolved.entry = { pluginId: entry.pluginId, entryId: entry.entryId, capability };
    return resolved;
  }

  /** 条目实例解析（引擎 / 执行型共用，错误与文案保持 D124 语义）。 */
  #entryInstanceOf(entry: ResolvedEntry): string {
    if (entry.instanceId !== undefined) return entry.instanceId;
    const candidates = entry.instances ?? [];
    if (candidates.length > 1) {
      throw new AppError(
        'INSTANCE_AMBIGUOUS',
        `插件有 ${candidates.length} 个厂商账号实例，条目「${entry.entryId}」未指定使用哪个；请在插件详情里指定实例`,
        { pluginId: entry.pluginId, entryId: entry.entryId, instances: [...candidates] },
      );
    }
    throw this.#entryNotConfigured(
      `条目「${entry.entryId}」还没有可用的厂商账号实例，请先在插件详情里添加并填写凭据`,
      { pluginId: entry.pluginId, entryId: entry.entryId },
    );
  }

  /**
   * 执行型条目的解析结果：托管适配器不需要厂商根 / Key（凭据在宿主侧按实例注入），
   * 上下文只带条目与实例定位 + locale（46 号 §4 的 invoke.context）。
   */
  #hostedProvider(
    pluginId: string,
    entryId: string,
    instanceId: string,
    modelId: string,
    adapter: VendorAdapter,
  ): ResolvedProvider {
    return {
      vendor: 'custom',
      instanceId,
      modelId,
      context: {
        vendor: 'custom',
        baseUrl: '',
        apiKey: '',
        logger: this.#logger,
        entryRef: { pluginId, entryId },
        instanceId,
        locale: this.#settings.get().appLanguage,
        ...(this.#fetchImpl !== undefined ? { fetchImpl: this.#fetchImpl } : {}),
      },
      adapter,
    };
  }

  /** 托管适配器（条目 `source:'plugin'`）：运行时未装配 = 明确 NOT_IMPLEMENTED。 */
  async #hostedAdapterOf(pluginId: string): Promise<VendorAdapter> {
    const source = this.#requireEntrySource();
    const adapter = (await source.hostedAdapterOf?.(pluginId)) ?? null;
    if (adapter === null) {
      throw new AppError('NOT_IMPLEMENTED', `插件 ${pluginId} 的托管运行时未装配，无法执行该条目`);
    }
    return adapter;
  }

  /** 条目路径的 CAPABILITY_NOT_CONFIGURED：payload 携带插件 / 条目 / 实例定位。 */
  #entryNotConfigured(
    message: string,
    details: { pluginId: string; entryId?: string; instanceId?: string },
  ): AppError {
    return new AppError('CAPABILITY_NOT_CONFIGURED', message, details);
  }

  /**
   * 插件实例（pli_…）→ 引擎 + 凭据。必填凭据缺一不可：sensitive 字段读
   * secrets，非敏感字段读 config_json；缺 required → CAPABILITY_NOT_CONFIGURED
   * （details 带插件与实例定位）。
   */
  #resolvePluginInstance(
    pluginId: string,
    instanceId: string,
    engine: MediaEngine,
    keyOverride?: string,
  ): ResolvedProvider {
    const source = this.#requireEntrySource();
    const config = source.instanceConfig(pluginId, instanceId) ?? {};
    let apiKey: string | null = null;
    for (const field of engine.credentialFields) {
      const raw = field.sensitive
        ? source.instanceCredential(pluginId, instanceId, field.key, keyOverride)
        : (config[field.key] ?? null);
      if (field.required && (raw === null || raw === '')) {
        throw this.#entryNotConfigured(
          `条目凭据未配齐：请在插件详情的账号实例里填写「${field.title}」`,
          { pluginId, instanceId },
        );
      }
      if (field.sensitive && typeof raw === 'string' && apiKey === null) {
        apiKey = raw;
      }
    }
    if (apiKey === null) {
      throw this.#entryNotConfigured('条目凭据未配齐：缺少 API Key', { pluginId, instanceId });
    }
    // baseUrl：实例 config 覆盖优先；缺省用引擎厂商的内置根（通用兼容引擎无内置根）。
    const configBaseUrl = typeof config['baseUrl'] === 'string' ? config['baseUrl'] : undefined;
    const baseUrl =
      configBaseUrl !== undefined && configBaseUrl !== ''
        ? configBaseUrl
        : engine.vendor !== 'custom'
          ? VENDOR_DESCRIPTORS[engine.vendor].baseUrl
          : '';
    return {
      vendor: engine.vendor,
      instanceId,
      modelId: '',
      context: {
        vendor: engine.vendor,
        baseUrl,
        apiKey,
        logger: this.#logger,
        ...(this.#fetchImpl !== undefined ? { fetchImpl: this.#fetchImpl } : {}),
      },
      adapter: engine.adapter,
    };
  }

  /** 全局槽位路径（D124 前的原 #resolve，逐字节保留）。 */
  #resolveGlobal(capability: MediaCapability, modelId?: string): ResolvedProvider {
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

  #requireEntrySource(): MediaEntrySource {
    if (this.#entrySource === undefined) {
      throw new AppError('NOT_IMPLEMENTED', '条目仓库未装配，无法解析插件模型条目');
    }
    return this.#entrySource;
  }

  /**
   * 实例 id → key/baseUrl 解析与适配器。不校验能力方法（调用方负责）。
   * keyOverride：未保存先测（providers.test）用入参 key，不读密钥表。
   * 保持同步：embeddingReady 等同步判定面依赖它按现状抛错。
   */
  #resolveProvider(instanceId: string, keyOverride?: string): ResolvedProvider {
    const instance = findProviderInstance(this.#settings.get(), instanceId);
    if (instance === undefined) {
      throw new AppError('NOT_FOUND', `供应商实例 "${instanceId}" 不存在`);
    }
    const apiKey = keyOverride ?? nextProviderApiKey(this.#secrets, instance.id);
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

  /**
   * videoStatus / cancelVideo 的 provider 解析：settings 实例优先（现状逐字节），
   * NOT_FOUND 时回落插件实例（D124 条目路径的 generateVideo 返回 pli_…，凭据
   * 经条目仓库读回）；都查不到维持原 NOT_FOUND。
   */
  async #resolveVideoProvider(provider: string): Promise<ResolvedProvider> {
    try {
      return this.#resolveProvider(provider);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === 'NOT_FOUND' &&
        this.#entrySource !== undefined
      ) {
        const pluginInstance = await this.#entrySource.capabilityInstanceOf(provider);
        if (pluginInstance !== null && pluginInstance.source === 'plugin') {
          // D125 执行型条目：轮询 / 取消走托管适配器（凭据由宿主按实例注入）。
          const adapter =
            (await this.#entrySource.hostedAdapterOf?.(pluginInstance.pluginId)) ?? null;
          if (adapter !== null) {
            const resolved = this.#hostedProvider(
              pluginInstance.pluginId,
              pluginInstance.entryId,
              provider,
              pluginInstance.model,
              adapter,
            );
            resolved.entry = {
              pluginId: pluginInstance.pluginId,
              entryId: pluginInstance.entryId,
              capability: 'video',
            };
            return resolved;
          }
        }
        const engine = pluginInstance === null ? undefined : MEDIA_ENGINES[pluginInstance.engine];
        if (pluginInstance !== null && engine !== undefined) {
          return this.#resolvePluginInstance(pluginInstance.pluginId, provider, engine);
        }
      }
      throw error;
    }
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
