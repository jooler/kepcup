import { z } from 'zod';
import type {
  GeneratedImage,
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
  MediaContractMethod,
} from './types.js';

/**
 * media 能力契约的 wire schema（D125 P1，docs/design/61-plugin-runtime-platform.md
 * 决策 6「边界即契约：调用输入、事件、输出全部 zod 校验，schema 定义在 shared，两侧共用」）。
 *
 * 形状逐字段对齐 `media/types.ts`（类型事实源）——文件底部有双向赋值断言，schema 与
 * 接口漂移会在 shared typecheck 直接失败。能力桥的宿主侧消费在 P2（core
 * `plugins/runtime/contracts.ts` 的 `CAPABILITY_CONTRACTS` 从这里拿 schema）；插件侧
 * 消费在 `@kepcup/plugin-sdk`（invoke 输入校验 + result 输出自检）。
 *
 * 与 core `VendorAdapter` 签名的两处差异（都是 wire 形状，不是语义分叉）：
 * - `videoStatus` / `cancelVideo` 的 wire params 是 `{ taskId }` 对象
 *   （{@link VideoGenerationHandle}）——协议 invoke.params 恒为一个 JSON 对象；
 * - `cancelVideo` 的 wire output 是 `null`（方法返回 void，帧 output 必须有值）。
 *
 * 大产物（images / audioBase64 / videoUrl）按引用或 base64 走，单值上限 30 MB
 * （≈ 61 §3.2 的 20 MB 产物上限 base64 后的安全余量）。
 */

const STRING_30MB = 30_000_000;

/** 文生图 / 图片编辑 wire params。 */
export const imageGenerationParamsSchema = z.strictObject({
  prompt: z.string().min(1).max(20_000),
  /** 参考图（URL / data URI）：提供即编辑或图生图。 */
  images: z.array(z.string().min(1).max(STRING_30MB)).max(16).optional(),
  n: z.number().int().min(1).max(64).optional(),
  /** "宽x高"，如 1024x1024。 */
  size: z.string().min(1).max(64).optional(),
  negativePrompt: z.string().min(1).max(20_000).optional(),
  seed: z.number().int().optional(),
});

export const generatedImageSchema = z.strictObject({
  url: z.string().min(1).max(STRING_30MB).optional(),
  b64: z.string().min(1).max(STRING_30MB).optional(),
  mimeType: z.string().min(1).max(255).optional(),
});

export const imageGenerationResultSchema = z.strictObject({
  images: z.array(generatedImageSchema).min(1).max(64),
});

/** 语音合成（TTS）wire params。 */
export const speechParamsSchema = z.strictObject({
  text: z.string().min(1).max(20_000),
  voice: z.string().min(1).max(255).optional(),
  format: z.enum(['mp3', 'wav', 'opus']).optional(),
  speed: z.number().min(0).max(10).optional(),
});

export const speechResultSchema = z.strictObject({
  audioBase64: z.string().min(1).max(STRING_30MB),
  mimeType: z.string().min(1).max(255),
});

/** 语音识别（ASR）wire params。 */
export const transcriptionParamsSchema = z.strictObject({
  audioBase64: z.string().min(1).max(STRING_30MB),
  audioMime: z.string().min(1).max(255),
  language: z.string().min(1).max(64).optional(),
});

export const transcriptionResultSchema = z.strictObject({
  text: z.string().max(1_000_000),
});

/** 图片理解（视觉问答）wire params。 */
export const understandImageParamsSchema = z.strictObject({
  images: z.array(z.string().min(1).max(STRING_30MB)).min(1).max(16),
  prompt: z.string().min(1).max(20_000),
});

export const understandImageResultSchema = z.strictObject({
  text: z.string().max(1_000_000),
});

/** 视频生成提交 wire params。 */
export const videoGenerationParamsSchema = z.strictObject({
  prompt: z.string().min(1).max(20_000),
  /** 首帧参考图（图生视频）。 */
  images: z.array(z.string().min(1).max(STRING_30MB)).max(16).optional(),
  resolution: z.string().min(1).max(64).optional(),
  ratio: z.string().min(1).max(64).optional(),
  size: z.string().min(1).max(64).optional(),
  duration: z.number().min(0).max(3600).optional(),
});

/** 视频异步任务的 wire 句柄：`{ taskId }`（submitVideo 的 output、videoStatus /
 * cancelVideo 的 params 同形）。 */
export const videoGenerationHandleSchema = z.strictObject({
  taskId: z.string().min(1).max(256),
});

export const videoTaskStatusSchema = z.strictObject({
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  videoUrl: z.string().min(1).max(STRING_30MB).optional(),
  error: z.string().min(1).max(2000).optional(),
});

/** `cancelVideo` 的 wire output：方法返回 void，帧 output 恒 `null`。 */
export const videoCancelOutputSchema = z.null();

/**
 * 方法 → wire schema 注册表（61 §5「core 侧 `CAPABILITY_CONTRACTS`」的 schema 面）：
 * P2 core contracts.ts 与插件 SDK 客户端从这里按方法取 params / output schema，
 * 不各自再写第二份。
 */
export const MEDIA_CONTRACT_METHOD_WIRE = {
  generateImage: { params: imageGenerationParamsSchema, output: imageGenerationResultSchema },
  synthesizeSpeech: { params: speechParamsSchema, output: speechResultSchema },
  transcribeSpeech: { params: transcriptionParamsSchema, output: transcriptionResultSchema },
  understandImage: { params: understandImageParamsSchema, output: understandImageResultSchema },
  submitVideo: { params: videoGenerationParamsSchema, output: videoGenerationHandleSchema },
  videoStatus: { params: videoGenerationHandleSchema, output: videoTaskStatusSchema },
  cancelVideo: { params: videoGenerationHandleSchema, output: videoCancelOutputSchema },
} as const satisfies Record<MediaContractMethod, { params: z.ZodType; output: z.ZodType }>;

// --- schema ↔ 类型事实源双向断言（漂移即 typecheck 失败） -----------------------
// 每对 schema 与 types.ts 接口互相赋值一次；`_` 前缀变量仅为类型检查存在。

const _aImageParams: ImageGenerationParams = {} as z.infer<typeof imageGenerationParamsSchema>;
const _aImageParamsRev: z.infer<typeof imageGenerationParamsSchema> = {} as ImageGenerationParams;
const _aGeneratedImage: GeneratedImage = {} as z.infer<typeof generatedImageSchema>;
const _aGeneratedImageRev: z.infer<typeof generatedImageSchema> = {} as GeneratedImage;
const _aImageResult: ImageGenerationResult = {} as z.infer<typeof imageGenerationResultSchema>;
const _aImageResultRev: z.infer<typeof imageGenerationResultSchema> = {} as ImageGenerationResult;
const _aSpeechParams: SpeechParams = {} as z.infer<typeof speechParamsSchema>;
const _aSpeechParamsRev: z.infer<typeof speechParamsSchema> = {} as SpeechParams;
const _aSpeechResult: SpeechResult = {} as z.infer<typeof speechResultSchema>;
const _aSpeechResultRev: z.infer<typeof speechResultSchema> = {} as SpeechResult;
const _aTranscribeParams: TranscriptionParams = {} as z.infer<typeof transcriptionParamsSchema>;
const _aTranscribeParamsRev: z.infer<typeof transcriptionParamsSchema> = {} as TranscriptionParams;
const _aTranscribeResult: TranscriptionResult = {} as z.infer<typeof transcriptionResultSchema>;
const _aTranscribeResultRev: z.infer<typeof transcriptionResultSchema> = {} as TranscriptionResult;
const _aUnderstandParams: UnderstandImageParams = {} as z.infer<typeof understandImageParamsSchema>;
const _aUnderstandParamsRev: z.infer<typeof understandImageParamsSchema> =
  {} as UnderstandImageParams;
const _aUnderstandResult: UnderstandImageResult = {} as z.infer<typeof understandImageResultSchema>;
const _aUnderstandResultRev: z.infer<typeof understandImageResultSchema> =
  {} as UnderstandImageResult;
const _aVideoParams: VideoGenerationParams = {} as z.infer<typeof videoGenerationParamsSchema>;
const _aVideoParamsRev: z.infer<typeof videoGenerationParamsSchema> = {} as VideoGenerationParams;
const _aVideoHandle: VideoGenerationHandle = {} as z.infer<typeof videoGenerationHandleSchema>;
const _aVideoHandleRev: z.infer<typeof videoGenerationHandleSchema> = {} as VideoGenerationHandle;
const _aVideoStatus: VideoTaskStatus = {} as z.infer<typeof videoTaskStatusSchema>;
const _aVideoStatusRev: z.infer<typeof videoTaskStatusSchema> = {} as VideoTaskStatus;
