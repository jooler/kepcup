import { AppError, VENDOR_DESCRIPTORS } from '@kepcup/shared';
import { fetchBinaryBase64, trimTrailingSlash, vendorFetch } from '../http.js';
import { openAICompatibleEmbed } from '../embeddings.js';
import { parseRerankResults } from '../rerank.js';
import { openAICompatibleUnderstandImage } from '../vision.js';
import {
  speechMimeType,
  type GeneratedImage,
  type ImageGenerationParams,
  type ImageGenerationResult,
  type RerankParams,
  type RerankResult,
  type SpeechParams,
  type SpeechResult,
  type TranscriptionParams,
  type TranscriptionResult,
  type UnderstandImageParams,
  type VendorAdapter,
  type VendorCallContext,
  type VideoGenerationHandle,
  type VideoGenerationParams,
  type VideoTaskPhase,
  type VideoTaskStatus,
} from '../types.js';

/**
 * 阿里云百炼（DashScope）。对话走 OpenAI 兼容根（…/compatible-mode/v1，
 * 由 pi 注册表处理）；本适配器负责其余能力：
 * - 向量：text-embedding-v3/v4 走兼容根 /embeddings；早期 v1/v2 与
 *   多模态向量（tongyi-embedding-vision / multimodal-embedding 系列）
 *   兼容模式不支持，分别走 `{apiRoot}/api/v1/services/embeddings/`
 *   下的 text-embedding 与 multimodal-embedding 原生端点
 * - 重排：`{apiRoot}/api/v1/services/rerank/text-rerank/text-rerank`
 *   （gte-rerank-v2 / qwen3.7-text-rerank；qwen3-rerank 的独立兼容端点不适配）
 * - 图片理解：兼容根 chat/completions + image_url 内容块（vision.ts）
 * - 图片生成 / 编辑：`{apiRoot}/api/v1/services/aigc/multimodal-generation/generation`
 *   （qwen-image 家族统一端点，编辑 = content 里带 image 参考图）
 * - TTS：`{apiRoot}/api/v1/services/audio/tts/SpeechSynthesizer`（CosyVoice）
 * - ASR：兼容根 chat/completions + input_audio（qwen3-asr-flash）
 * - 视频：`{apiRoot}/api/v1/services/aigc/video-generation/video-synthesis`
 *   异步任务（X-DashScope-Async）+ `GET {apiRoot}/api/v1/tasks/{id}` 轮询
 */

const COMPAT_SUFFIX = '/compatible-mode/v1';

/** 原生 API 根：兼容根去掉 /compatible-mode/v1；覆盖了非默认根时回退厂商默认。 */
function apiRoot(baseUrl: string): string {
  if (baseUrl.endsWith(COMPAT_SUFFIX)) return baseUrl.slice(0, -COMPAT_SUFFIX.length);
  return VENDOR_DESCRIPTORS.dashscope.apiRoot;
}

interface MultimodalContentItem {
  text?: string;
  image?: string;
}

interface MultimodalResponse {
  output?: {
    choices?: Array<{
      message?: { content?: MultimodalContentItem[] };
    }>;
  };
}

/**
 * DashScope 原生向量端点按模型家族选择：多模态向量（contents 传参）与
 * 早期文本向量（texts 传参）只有原生接口；批量上限分别为 10 / 25。
 */
function nativeEmbeddingRoute(model: string): {
  path: string;
  body: (batch: string[]) => Record<string, unknown>;
  batchSize: number;
} | null {
  if (/vision|multimodal/i.test(model)) {
    return {
      path: 'multimodal-embedding/multimodal-embedding',
      body: (batch) => ({ input: { contents: batch.map((text) => ({ text })) } }),
      batchSize: 10,
    };
  }
  if (/^text-embedding-v[12](-|$)/.test(model)) {
    return {
      path: 'text-embedding/text-embedding',
      body: (batch) => ({ input: { texts: batch } }),
      batchSize: 25,
    };
  }
  return null;
}

async function dashscopeNativeEmbed(
  ctx: VendorCallContext,
  model: string,
  texts: string[],
  route: { path: string; body: (batch: string[]) => Record<string, unknown>; batchSize: number },
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += route.batchSize) {
    const response = await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/embeddings/${route.path}`,
      ctx.apiKey,
      { json: { model, ...route.body(texts.slice(i, i + route.batchSize)) }, timeoutMs: 60_000 },
      ctx.fetchImpl,
    );
    const data = response.json() as {
      output?: { embeddings?: Array<{ index?: number; embedding?: number[] }> };
    };
    const rows = (data.output?.embeddings ?? []).filter(
      (row): row is { index?: number; embedding: number[] } => Array.isArray(row.embedding),
    );
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    vectors.push(...rows.map((row) => row.embedding));
  }
  return vectors;
}

/**
 * 预置音色按模型代际带版本后缀（v2 → `_v2`，v3 系 → `_v3`）；
 * 未识别的模型沿用无后缀名（cosyvoice-v1 形态）。
 */
function defaultVoice(model: string): string {
  if (/v3/.test(model)) return 'longxiaochun_v3';
  if (/v2/.test(model)) return 'longxiaochun_v2';
  return 'longxiaochun';
}

/**
 * qwen3-tts / qwen-tts 系列（音色驱动的语音生成）：挂在 multimodal-
 * generation 端点（与图片生成同端点），voice 用 Qwen 音色（Cherry 等）。
 */
function isQwenTts(model: string): boolean {
  return /^qwen[\w.-]*tts/i.test(model);
}

/**
 * qwen-audio-tts 系列（音频生成，声音由参考音频驱动而非音色 id）：挂原生
 * SpeechSynthesizer 端点但请求体不同——文本放 `input.text_prompt`，不接
 * 受 voice/parameters（传了反而报错）。注意 flash 变体（如
 * qwen-audio-3.1-tts-flash）是实时（WebSocket）专用型号，HTTP 通道不可用；
 * HTTP 可用的是 next 等非实时型号（官方「音频生成 API 参考」）。
 */
function isQwenAudioTts(model: string): boolean {
  return /^qwen-audio-[\w.-]*tts/i.test(model);
}

/** 实时（WebSocket）专用的语音型号：HTTP 合成通道调不通，直接给出可操作的提示。 */
function realtimeOnlyTtsHint(model: string): string | null {
  if (/^qwen-audio-[\w.-]*tts[\w.-]*flash/i.test(model)) {
    return `${model} 是实时语音合成（WebSocket）专用型号，本应用的 HTTP 合成通道不支持；请改用 qwen-audio-3.1-tts-next（音频生成）或 qwen3-tts-flash（音色驱动）`;
  }
  if (/realtime$/i.test(model) || /-realtime-?\d/i.test(model)) {
    return `${model} 是实时（WebSocket）专用型号，本应用的 HTTP 合成通道不支持；请改用同系列的非实时型号`;
  }
  return null;
}

export const dashscopeAdapter: VendorAdapter = {
  async embed(ctx: VendorCallContext, model: string, texts: string[]): Promise<number[][]> {
    const route = nativeEmbeddingRoute(model);
    if (route !== null) return dashscopeNativeEmbed(ctx, model, texts, route);
    // text-embedding-v3/v4（与 Qwen3-Embedding 系列）走 OpenAI 兼容根。
    return openAICompatibleEmbed(ctx, model, texts);
  },

  async rerank(
    ctx: VendorCallContext,
    model: string,
    params: RerankParams,
  ): Promise<RerankResult> {
    // 原生 text-rerank 端点：query/documents 在 input 下，top_n 在 parameters 下。
    const response = await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/rerank/text-rerank/text-rerank`,
      ctx.apiKey,
      {
        json: {
          model,
          input: { query: params.query, documents: params.documents },
          parameters: {
            ...(params.topN !== undefined ? { top_n: params.topN } : {}),
            return_documents: false,
          },
        },
        timeoutMs: 60_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as {
      output?: { results?: Array<{ index?: number; relevance_score?: number }> };
    };
    const results = parseRerankResults(data.output ?? {});
    if (results.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '百炼重排接口未返回结果', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { results };
  },

  understandImage(
    ctx: VendorCallContext,
    model: string,
    params: UnderstandImageParams,
  ): Promise<{ text: string }> {
    return openAICompatibleUnderstandImage(ctx, model, params);
  },

  async generateImage(
    ctx: VendorCallContext,
    model: string,
    params: ImageGenerationParams,
  ): Promise<ImageGenerationResult> {
    const content: MultimodalContentItem[] = [
      ...(params.images ?? []).map((image) => ({ image })),
      { text: params.prompt },
    ];
    const response = await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/aigc/multimodal-generation/generation`,
      ctx.apiKey,
      {
        json: {
          model,
          input: { messages: [{ role: 'user', content }] },
          parameters: {
            n: params.n,
            // 原生接口尺寸分隔符是 "*"（兼容模式才是 "x"）。
            size: params.size?.replace(/x/g, '*'),
            negative_prompt: params.negativePrompt,
            seed: params.seed,
          },
        },
        timeoutMs: 120_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as MultimodalResponse;
    const items = data.output?.choices?.[0]?.message?.content ?? [];
    const images: GeneratedImage[] = items
      .map((item) => item.image)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      .map((url) => ({ url }));
    if (images.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '百炼图片接口未返回图片', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { images };
  },

  async synthesizeSpeech(
    ctx: VendorCallContext,
    model: string,
    params: SpeechParams,
  ): Promise<SpeechResult> {
    // 三路分流（响应结构一致：output.audio.data 或 24h 有效下载直链）：
    // qwen3-tts 音色系 → multimodal-generation + parameters.voice；
    // qwen-audio-tts 音频生成系 → SpeechSynthesizer + input.text_prompt（无 voice）；
    // cosyvoice → SpeechSynthesizer + parameters.voice（按代际默认音色）。
    const realtimeHint = realtimeOnlyTtsHint(model);
    if (realtimeHint !== null) throw new AppError('INVALID_INPUT', realtimeHint);
    const format = params.format ?? 'mp3';
    const isQwenAudio = isQwenAudioTts(model);
    // 音频生成系优先判定（isQwenTts 的模式同样能匹配 qwen-audio-*-tts-*）。
    const endpoint =
      !isQwenAudio && isQwenTts(model)
        ? `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/aigc/multimodal-generation/generation`
        : `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/audio/tts/SpeechSynthesizer`;
    const response = await vendorFetch(
      endpoint,
      ctx.apiKey,
      {
        json: {
          model,
          input: isQwenAudio
            ? { text_prompt: params.text, format }
            : { text: params.text },
          // 音色 / 格式 / 语速在 parameters 下（qwen-audio-tts 系不接收）。
          ...(isQwenAudio
            ? {}
            : {
                parameters: {
                  voice: params.voice ?? (isQwenTts(model) ? 'Cherry' : defaultVoice(model)),
                  format,
                  ...(params.speed !== undefined ? { rate: params.speed } : {}),
                },
              }),
        },
        timeoutMs: 120_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as {
      output?: { audio?: { url?: string; data?: string } };
    };
    const audio = data.output?.audio;
    if (audio?.data) {
      return { audioBase64: audio.data, mimeType: speechMimeType(params.format) };
    }
    if (audio?.url) {
      // 结果是 24h 有效的下载直链（带签名，不能再带鉴权头），立即取回字节。
      const audioBase64 = await fetchBinaryBase64(audio.url, { timeoutMs: 120_000 }, ctx.fetchImpl);
      return { audioBase64, mimeType: speechMimeType(params.format) };
    }
    throw new AppError('PROVIDER_UNAVAILABLE', '百炼语音合成未返回音频', {
      body: response.bodyText.slice(0, 300),
    });
  },

  async transcribeSpeech(
    ctx: VendorCallContext,
    model: string,
    params: TranscriptionParams,
  ): Promise<TranscriptionResult> {
    // qwen3-asr-flash 兼容模式：音频作为 input_audio 内容块发给对话接口，
    // 回复即转写文本。paraformer 等文件转写模型走异步任务 + 公网 URL，
    // 本地音频不适用，预置模型只列 qwen3-asr 系列。
    const dataUri = params.audioMime.startsWith('data:')
      ? params.audioMime
      : `data:${params.audioMime};base64,${params.audioBase64}`;
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/chat/completions`,
      ctx.apiKey,
      {
        json: {
          model,
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_audio', input_audio: { data: dataUri } }],
            },
          ],
          ...(params.language !== undefined ? { asr_options: { language: params.language } } : {}),
        },
        timeoutMs: 120_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : '';
    return { text };
  },

  async submitVideo(
    ctx: VendorCallContext,
    model: string,
    params: VideoGenerationParams,
  ): Promise<VideoGenerationHandle> {
    const response = await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/services/aigc/video-generation/video-synthesis`,
      ctx.apiKey,
      {
        headers: { 'X-DashScope-Async': 'enable' },
        json: {
          model,
          input: {
            prompt: params.prompt,
            ...(params.images && params.images.length > 0
              ? { media: [{ type: 'first_frame', url: params.images[0] }] }
              : {}),
          },
          parameters: {
            resolution: params.resolution,
            ratio: params.ratio,
            duration: params.duration,
          },
        },
        timeoutMs: 60_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as { output?: { task_id?: string; task_status?: string } };
    const taskId = data.output?.task_id;
    if (!taskId) {
      throw new AppError('PROVIDER_UNAVAILABLE', '百炼视频任务提交失败', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { taskId };
  },

  async videoStatus(ctx: VendorCallContext, taskId: string): Promise<VideoTaskStatus> {
    const response = await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      ctx.apiKey,
      { timeoutMs: 30_000 },
      ctx.fetchImpl,
    );
    const data = response.json() as {
      output?: { task_status?: string; video_url?: string; message?: string; code?: string };
    };
    const raw = data.output?.task_status ?? 'UNKNOWN';
    let status: VideoTaskPhase;
    if (raw === 'SUCCEEDED') status = 'succeeded';
    else if (raw === 'PENDING' || raw === 'RUNNING')
      status = raw === 'PENDING' ? 'queued' : 'running';
    else status = 'failed';
    return {
      status,
      ...(status === 'succeeded' && data.output?.video_url
        ? { videoUrl: data.output.video_url }
        : {}),
      ...(status === 'failed'
        ? { error: data.output?.message ?? data.output?.code ?? `任务状态 ${raw}` }
        : {}),
    };
  },

  async cancelVideo(ctx: VendorCallContext, taskId: string): Promise<void> {
    await vendorFetch(
      `${trimTrailingSlash(apiRoot(ctx.baseUrl))}/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
      ctx.apiKey,
      { method: 'POST', timeoutMs: 30_000 },
      ctx.fetchImpl,
    );
  },
};
