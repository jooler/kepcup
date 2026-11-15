import { AppError } from '@kepcup/shared';
import type {
  ImageGenerationParams,
  ImageGenerationResult,
  SpeechParams,
  SpeechResult,
  TranscriptionParams,
  TranscriptionResult,
  UnderstandImageParams,
  VendorAdapter,
  VendorCallContext,
  VideoGenerationHandle,
  VideoGenerationParams,
  VideoTaskStatus,
} from '../../media/types.js';
import type { PluginHost } from './host.js';

/**
 * 托管适配器（D125 P2，61 §5）：core 侧 `VendorAdapter` 的代理对象——把七个方法逐一
 * 转发给插件进程（PluginHost 排队 / 超时 / 取消 / 事件转发），并把运行时故障归一进
 * `media/http.ts` 的错误族。
 *
 * 错误映射（不破坏既有语义）：
 * - `PROVIDER_*` 族（AUTH_FAILED / QUOTA / RATE_LIMITED / UNREACHABLE / UNAVAILABLE）
 *   与 `NOT_IMPLEMENTED` 原样透传——插件可显式声明认证 / 配额分家（c0bf9168），
 *   网关与工具的错误引导不变；
 * - `PLUGIN_CRASHED` / `PLUGIN_TIMEOUT` / `PLUGIN_CONTRACT_VIOLATION` /
 *   `PLUGIN_NETWORK_DENIED` 等运行时错误 → `PROVIDER_UNAVAILABLE`（人话文案，
 *   原始错误码留在 details，供插件活动 / 诊断）；
 * - 其余未知错误码 → `PROVIDER_UNAVAILABLE`。
 *
 * 七方法全部挂在对象上（不是按插件声明裁剪）：条目声明了哪个能力由清单负责，插件
 * 未实现的方法由 SDK 回 `NOT_IMPLEMENTED`（原样透传），与内置引擎的能力矩阵判定
 * 在用户侧同层呈现。
 */
export class HostedAdapter implements VendorAdapter {
  readonly #host: PluginHost;
  readonly #pluginId: string;

  constructor(host: PluginHost, pluginId: string) {
    this.#host = host;
    this.#pluginId = pluginId;
  }

  /**
   * `VendorAdapter` 的必选方法，但 media 契约 v1 **不开放** embedding（60 §10 Q4：
   * 记忆管线绑定全局槽位）——显式 NOT_IMPLEMENTED，不假装支持。
   */
  // 七个方法一律用箭头属性：MediaService 以 `const fn = adapter.generateImage` 的形式
  // 取出方法再裸调用（不绑定 this），普通方法会丢 this（内置适配器是无状态对象字面量，
  // 宿主代理必须自带绑定）。
  embed = (): Promise<number[][]> => {
    throw new AppError('NOT_IMPLEMENTED', 'media 契约不开放向量能力');
  };

  generateImage = (
    ctx: VendorCallContext,
    model: string,
    params: ImageGenerationParams,
  ): Promise<ImageGenerationResult> =>
    this.#invoke<ImageGenerationResult>(ctx, model, 'generateImage', params);

  synthesizeSpeech = (
    ctx: VendorCallContext,
    model: string,
    params: SpeechParams,
  ): Promise<SpeechResult> => this.#invoke<SpeechResult>(ctx, model, 'synthesizeSpeech', params);

  transcribeSpeech = (
    ctx: VendorCallContext,
    model: string,
    params: TranscriptionParams,
  ): Promise<TranscriptionResult> =>
    this.#invoke<TranscriptionResult>(ctx, model, 'transcribeSpeech', params);

  understandImage = (
    ctx: VendorCallContext,
    model: string,
    params: UnderstandImageParams,
  ): Promise<{ text: string }> =>
    this.#invoke<{ text: string }>(ctx, model, 'understandImage', params);

  submitVideo = (
    ctx: VendorCallContext,
    model: string,
    params: VideoGenerationParams,
  ): Promise<VideoGenerationHandle> =>
    this.#invoke<VideoGenerationHandle>(ctx, model, 'submitVideo', params);

  videoStatus = (ctx: VendorCallContext, taskId: string): Promise<VideoTaskStatus> =>
    this.#invoke<VideoTaskStatus>(ctx, '', 'videoStatus', { taskId });

  cancelVideo = async (ctx: VendorCallContext, taskId: string): Promise<void> => {
    await this.#invoke<null>(ctx, '', 'cancelVideo', { taskId });
  };

  async #invoke<T>(
    ctx: VendorCallContext,
    model: string,
    method: string,
    params: unknown,
  ): Promise<T> {
    const ref = ctx.entryRef;
    if (ref === undefined || ref.pluginId !== this.#pluginId) {
      throw new AppError('INTERNAL', '托管适配器调用缺少条目上下文');
    }
    try {
      const output = await this.#host.call(this.#pluginId, 'media', method, params, {
        entryId: ref.entryId,
        model,
        ...(ctx.locale !== undefined ? { locale: ctx.locale } : {}),
        ...(ctx.entryParams !== undefined ? { params: ctx.entryParams } : {}),
        instanceId: ctx.instanceId ?? '',
        // D125 P3（DEV-118）：工具的 AbortSignal → Host cancel 帧；插件 progress
        // 帧 → 工具的 ctx.progress（对话内状态行 / 任务详情页）。
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
      });
      return output as T;
    } catch (error) {
      throw mapPluginError(error, this.#pluginId);
    }
  }
}

/** 插件错误 → `media/http.ts` 错误族（透传白名单 + 运行时故障归一）。 */
export function mapPluginError(error: unknown, pluginId: string): unknown {
  if (!(error instanceof AppError)) return error;
  switch (error.code) {
    case 'PROVIDER_AUTH_FAILED':
    case 'PROVIDER_QUOTA':
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_UNREACHABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'NOT_IMPLEMENTED':
      return error;
    case 'PLUGIN_CRASHED':
      return new AppError('PROVIDER_UNAVAILABLE', '插件进程异常退出，请稍后重试或查看插件活动', {
        pluginId,
        code: error.code,
      });
    case 'PLUGIN_TIMEOUT':
      return new AppError('PROVIDER_UNAVAILABLE', '插件无响应，本次调用已终止', {
        pluginId,
        code: error.code,
      });
    case 'PLUGIN_CONTRACT_VIOLATION':
      return new AppError('PROVIDER_UNAVAILABLE', '插件返回了不符合契约的结果，已安全丢弃', {
        pluginId,
        code: error.code,
      });
    case 'PLUGIN_NETWORK_DENIED':
      return new AppError('PROVIDER_UNAVAILABLE', '插件访问了未授权的网络地址，已拒绝', {
        pluginId,
        code: error.code,
      });
    case 'PLUGIN_UPGRADE_REQUIRED':
      return new AppError('PROVIDER_UNAVAILABLE', '插件版本与当前应用不兼容，请升级插件或应用', {
        pluginId,
        code: error.code,
      });
    default:
      return new AppError('PROVIDER_UNAVAILABLE', `插件调用失败：${error.message}`, {
        pluginId,
        code: error.code,
      });
  }
}
