import type {
  ImageGenerationParams,
  ImageGenerationResult,
  SpeechParams,
  SpeechResult,
  TranscriptionParams,
  TranscriptionResult,
  UnderstandImageParams,
  UnderstandImageResult,
  VideoGenerationHandle,
  VideoGenerationParams,
  VideoTaskStatus,
} from '@kepcup/shared';
import type { PluginHostApi } from './host.js';

/**
 * 插件声明面（D125 P1，docs/design/61-plugin-runtime-platform.md §5 / todo P1 步骤 2）：
 * `definePlugin({ contracts: { media?: MediaContractImpl }, ready?(ctx) })`。
 *
 * `MediaContractImpl` 方法面 = core `VendorAdapter` 七方法的插件侧签名：方法名与
 * params / output 类型从 shared media 类型 re-derive（`@kepcup/shared` 单一事实源，
 * 不复刻第二份）；与宿主侧 `VendorCallContext` 的差异是刻意的——插件拿到的是
 * {@link MediaCallContext}（host 能力命名空间 + credentials + signal），不是裸
 * fetch / apiKey。`videoStatus / cancelVideo` 收 {@link VideoGenerationHandle} 对象
 * （wire 形状见 shared `media/schema.ts`），不是裸 taskId。
 *
 * 七个方法全部可选（同 `VendorAdapter`）：插件只实现自己支持的；未实现的方法被调用
 * 时 SDK 客户端回 `NOT_IMPLEMENTED` error 帧。
 */

export interface MediaCallContext {
  /** 宿主 API 命名空间（与模块级 `host` 同一对象；显式携带便于传递给辅助函数）。 */
  host: PluginHostApi;
  /** 条目 id（manifest `contributions.capabilityModels[].id`）。 */
  entryId: string;
  /** 厂商模型 id（条目 model）。 */
  model: string;
  /**
   * 本次调用所属实例 id（D125 P4 / DEV-114）；无实例的调用为空串。多实例插件据此
   * 把 `credentials` 与实例的非敏感配置对齐（`host.secrets.get` 也按实例前缀裁决）。
   */
  instanceId: string;
  /** 调用方 locale（如 'zh-CN'）。 */
  locale: string;
  /**
   * 条目 params 合并（manifest `contributions.capabilityModels[].params`，宿主原样
   * 注入；插件自行决定消费哪些键，61 §3.2）。
   */
  params: Record<string, unknown>;
  /** 该实例 sensitive 字段键值（宿主调用时注入；进程内存活，永不落盘、永不入日志）。 */
  credentials: Record<string, string>;
  /** 取消信号（宿主 cancel 帧 / 用户取消 / 超时的联动；abort 后应尽快返回）。 */
  signal: AbortSignal;
}

/** media 契约 v1 方法面（61 §5：`VendorAdapter` 七可选方法，`embed` / `rerank` 不开放）。 */
export interface MediaContractImpl {
  /** 文生图 / 图片编辑（编辑 = 带 images 参考图的同一端点）。 */
  generateImage?(
    ctx: MediaCallContext,
    params: ImageGenerationParams,
  ): Promise<ImageGenerationResult>;
  /** 语音合成（TTS）。 */
  synthesizeSpeech?(ctx: MediaCallContext, params: SpeechParams): Promise<SpeechResult>;
  /** 语音识别（ASR）。 */
  transcribeSpeech?(
    ctx: MediaCallContext,
    params: TranscriptionParams,
  ): Promise<TranscriptionResult>;
  /** 图片理解（多模态视觉问答）。 */
  understandImage?(
    ctx: MediaCallContext,
    params: UnderstandImageParams,
  ): Promise<UnderstandImageResult>;
  /** 视频生成为异步任务：提交返回 taskId 句柄，状态用 videoStatus 轮询。 */
  submitVideo?(
    ctx: MediaCallContext,
    params: VideoGenerationParams,
  ): Promise<VideoGenerationHandle>;
  videoStatus?(ctx: MediaCallContext, handle: VideoGenerationHandle): Promise<VideoTaskStatus>;
  /** 尽力取消任务（宿主连通性测试提交后会立即取消，避免无谓计费）。 */
  cancelVideo?(ctx: MediaCallContext, handle: VideoGenerationHandle): Promise<void>;
}

/** 握手 init 帧带给 `ready()` 的上下文（实例 fields 含敏感字段键值）。 */
export interface PluginReadyContext {
  hostApiVersion: number;
  manifestDigest: string;
  instances: Array<{ instanceId: string; fields: Record<string, string> }>;
}

export interface PluginSpec {
  /** 实现的能力契约；声明了哪个，`ready` 帧的 `contracts` 就报哪个。 */
  contracts?: { media?: MediaContractImpl };
  /** 握手时回调（在发 `ready` 帧之前）；抛错 = 握手失败，SDK 回 error 帧后退出。 */
  ready?(ctx: PluginReadyContext): void | Promise<void>;
}

/**
 * 插件入口 helper（固定契约名）。类型标注 + 原样返回；与 `runPluginRuntime` 配套：
 * `export const plugin = definePlugin({...})` + `runPluginRuntime(plugin)`。
 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  return spec;
}

/**
 * 插件方法内抛出的业务错误：`code` 进 error 帧（可用 `PROVIDER_*` 族显式声明
 * auth / quota 映射，61 §5），`details` 透传给宿主（诊断用，不进人话文案）。
 * 抛其它 Error 时 SDK 回退 `PROVIDER_UNAVAILABLE`。
 */
export class PluginInvokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PluginInvokeError';
  }
}
