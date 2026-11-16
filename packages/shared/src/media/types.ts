/**
 * 媒体能力契约的类型事实源（D125 P1，docs/design/61-plugin-runtime-platform.md §5）。
 *
 * v1 唯一契约 `media` 的方法面 = core `media/types.ts` 里 `VendorAdapter` 的七个可选
 * 方法（generateImage / synthesizeSpeech / transcribeSpeech / understandImage /
 * submitVideo / videoStatus / cancelVideo）；params / output 形态与本文件逐字段一致
 * （从 core 侧 re-derive，**不是第二套语义**）。`VendorCallContext`（vendor / baseUrl /
 * apiKey / logger / fetchImpl）是宿主侧执行上下文，不过协议线——插件侧签名见
 * `@kepcup/plugin-sdk` 的 `MediaCallContext`（host 命名空间 + credentials + signal）。
 *
 * 边界（61 §5）：`embed` 不开放（60 §10 Q4 维持），`rerank` 不在 v1 方法面。
 * P2 会把 core `media/types.ts` re-point 到本文件（本阶段 core 不动，重复是临时的）。
 */

/** 文生图 / 图片编辑参数（编辑 = 带 images 参考图的同一端点）。 */
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

export interface TranscriptionParams {
  audioBase64: string;
  audioMime: string;
  language?: string;
}

export interface TranscriptionResult {
  text: string;
}

/** 图片理解（视觉问答）：images 为 URL / data URI。 */
export interface UnderstandImageParams {
  images: string[];
  prompt: string;
}

/** 图片理解结果（core `VendorAdapter.understandImage` 返回的内联 `{ text }` 具名化）。 */
export interface UnderstandImageResult {
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

/**
 * media 契约 v1 方法面（61 §5）：`VendorAdapter` 的七个可选方法名。视频异步三方法
 * 的 wire params 统一为对象（videoStatus / cancelVideo 用 {@link VideoGenerationHandle}
 * 包装 taskId），协议层 invoke.params 因此恒为一个 JSON 对象。
 */
export const MEDIA_CONTRACT_METHODS = [
  'generateImage',
  'synthesizeSpeech',
  'transcribeSpeech',
  'understandImage',
  'submitVideo',
  'videoStatus',
  'cancelVideo',
] as const;

export type MediaContractMethod = (typeof MEDIA_CONTRACT_METHODS)[number];
