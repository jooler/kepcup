import type { CoreLogger } from '../infra/logger.js';
import type { VendorId } from '@kepcup/shared';

/**
 * 厂商媒体适配器的厂商无关契约。每个国内厂商实现一份（adapters/），
 * 网关（service.ts）按模型引用解析出厂商后路由；未实现的能力直接
 * 不挂方法——网关给出带厂商名的 NOT_IMPLEMENTED 提示。
 *
 * 请求 / 响应里图片一律用 URL 或 data URI 字符串，音频用 base64。
 */

export interface VendorCallContext {
  vendor: VendorId;
  /** OpenAI 兼容根（settings 覆盖值或厂商默认，无尾斜杠）。 */
  baseUrl: string;
  apiKey: string;
  logger: CoreLogger;
  fetchImpl?: typeof fetch;
}

export interface ImageGenerationParams {
  prompt: string;
  /** 参考图（URL / data URI）：提供即编辑或图生图。 */
  images?: string[];
  n?: number;
  /** "宽x高"，如 1024x1024。 */
  size?: string;
  negativePrompt?: string;
  seed?: number;
}

export interface GeneratedImage {
  url?: string;
  b64?: string;
  mimeType?: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
}

export interface SpeechParams {
  text: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus';
  speed?: number;
}

export interface SpeechResult {
  audioBase64: string;
  mimeType: string;
}

/**
 * SpeechParams.format → 标准 MIME（mp3 的标准 MIME 是 audio/mpeg，
 * opus 载体是 ogg）。各适配器返回 SpeechResult 时统一取用。
 */
const SPEECH_MIME: Record<NonNullable<SpeechParams['format']>, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
};

export function speechMimeType(format: SpeechParams['format']): string {
  return SPEECH_MIME[format ?? 'mp3'];
}

export interface TranscriptionParams {
  audioBase64: string;
  audioMime: string;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
}

export interface VideoGenerationParams {
  prompt: string;
  /** 首帧参考图（图生视频）。 */
  images?: string[];
  resolution?: string;
  ratio?: string;
  size?: string;
  duration?: number;
}

export type VideoTaskPhase = 'queued' | 'running' | 'succeeded' | 'failed';

export interface VideoTaskStatus {
  status: VideoTaskPhase;
  videoUrl?: string;
  error?: string;
}

export interface VideoGenerationHandle {
  taskId: string;
}

/** 重排输入：query + 候选文档；结果按相关性降序，index 为输入下标。 */
export interface RerankParams {
  query: string;
  documents: string[];
  /** 只返回前 N 条；缺省全部返回。 */
  topN?: number;
}

export interface RerankResult {
  results: Array<{ index: number; score: number }>;
}

/** 图片理解（视觉问答）：images 为 URL / data URI。 */
export interface UnderstandImageParams {
  images: string[];
  prompt: string;
}

export interface VendorAdapter {
  /** 文本向量（memory 检索与 embedding 能力探测共用）。 */
  embed(ctx: VendorCallContext, model: string, texts: string[]): Promise<number[][]>;
  /** 相关性重排（memory 检索精排用）。 */
  rerank?(ctx: VendorCallContext, model: string, params: RerankParams): Promise<RerankResult>;
  /** 图片理解（多模态视觉问答）。 */
  understandImage?(
    ctx: VendorCallContext,
    model: string,
    params: UnderstandImageParams,
  ): Promise<{ text: string }>;
  /** 文生图 / 图片编辑（编辑 = 带 images 参考图的同一端点）。 */
  generateImage(
    ctx: VendorCallContext,
    model: string,
    params: ImageGenerationParams,
  ): Promise<ImageGenerationResult>;
  /** 语音合成（TTS）。 */
  synthesizeSpeech?(
    ctx: VendorCallContext,
    model: string,
    params: SpeechParams,
  ): Promise<SpeechResult>;
  /** 语音识别（ASR）。 */
  transcribeSpeech?(
    ctx: VendorCallContext,
    model: string,
    params: TranscriptionParams,
  ): Promise<TranscriptionResult>;
  /** 视频生成为异步任务：提交返回 taskId，状态用 videoStatus 轮询。 */
  submitVideo(
    ctx: VendorCallContext,
    model: string,
    params: VideoGenerationParams,
  ): Promise<VideoGenerationHandle>;
  videoStatus(ctx: VendorCallContext, taskId: string): Promise<VideoTaskStatus>;
  /** 尽力取消任务（连通性测试提交后立即取消，避免无谓计费）。 */
  cancelVideo?(ctx: VendorCallContext, taskId: string): Promise<void>;
}
