import { AppError } from '@kepcup/shared';
import { trimTrailingSlash, vendorFetch } from '../http.js';
import { openAICompatibleUnderstandImage } from '../vision.js';
import type {
  GeneratedImage,
  ImageGenerationParams,
  ImageGenerationResult,
  UnderstandImageParams,
  VendorAdapter,
  VendorCallContext,
  VideoGenerationHandle,
  VideoGenerationParams,
  VideoTaskPhase,
  VideoTaskStatus,
} from '../types.js';

/**
 * 火山方舟（Ark）。数据面全部挂 OpenAI 风格的 `{baseUrl}`（默认
 * https://ark.cn-beijing.volces.com/api/v3）：
 * - 向量：POST /embeddings/multimodal（doubao-embedding-vision；文本向量
 *   模型与纯文本 /embeddings 端点均已下线，多模态端点整个 input 融合为
 *   **单个**向量，批量时逐条请求再按输入顺序拼接）
 * - 图片理解：POST /chat/completions + image_url 内容块（vision.ts）
 * - 图片生成 / 编辑：POST /images/generations（编辑 = image 参考图 +
 *   编辑指令；方舟没有 /images/edits 端点，seedream 系列同端点编辑）
 * - 视频：POST /contents/generations/tasks 提交异步任务，
 *   GET /tasks/{id} 轮询（status: queued/running/succeeded/failed/cancelled）
 * - 重排 / TTS / ASR：方舟数据面均不提供（重排在 VikingDB、语音在独立
 *   语音产品线），适配器不挂对应方法，网关层会给出明确提示。
 */

interface ArkImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}

interface ArkTaskResponse {
  id?: string;
  status?: string;
  content?: { video_url?: string };
  error?: { message?: string; code?: string };
}

function mapTaskStatus(data: ArkTaskResponse): VideoTaskStatus {
  const raw = data.status ?? 'queued';
  let status: VideoTaskPhase;
  if (raw === 'succeeded') status = 'succeeded';
  else if (raw === 'queued' || raw === 'running') status = raw === 'queued' ? 'queued' : 'running';
  else status = 'failed';
  return {
    status,
    ...(status === 'succeeded' && data.content?.video_url
      ? { videoUrl: data.content.video_url }
      : {}),
    ...(status === 'failed'
      ? { error: data.error?.message ?? data.error?.code ?? `任务状态 ${raw}` }
      : {}),
  };
}

export const volcengineAdapter: VendorAdapter = {
  async embed(ctx: VendorCallContext, model: string, texts: string[]): Promise<number[][]> {
    // 多模态向量端点把整个 input 数组融合成一个向量，批量语义（一条文本
    // 一个向量）必须逐条请求；并发发出后按输入顺序归位。
    const vectors = await Promise.all(
      texts.map(async (text) => {
        const response = await vendorFetch(
          `${trimTrailingSlash(ctx.baseUrl)}/embeddings/multimodal`,
          ctx.apiKey,
          {
            json: { model, encoding_format: 'float', input: [{ type: 'text', text }] },
            timeoutMs: 60_000,
          },
          ctx.fetchImpl,
        );
        const data = response.json() as { data?: { embedding?: number[] } };
        if (!Array.isArray(data.data?.embedding) || data.data.embedding.length === 0) {
          throw new AppError('PROVIDER_UNAVAILABLE', '方舟向量接口未返回向量', {
            body: response.bodyText.slice(0, 300),
          });
        }
        return data.data.embedding;
      }),
    );
    return vectors;
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
    const images = params.images ?? [];
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/images/generations`,
      ctx.apiKey,
      {
        json: {
          model,
          prompt: params.prompt,
          // 编辑 / 多参考图：image 接受字符串或数组。
          ...(images.length > 0 ? { image: images.length === 1 ? images[0] : images } : {}),
          ...(params.size ? { size: params.size } : {}),
          ...(params.n && params.n > 1
            ? {
                sequential_image_generation: 'auto',
                sequential_image_generation_options: { max_images: params.n },
              }
            : {}),
          ...(params.seed !== undefined ? { seed: params.seed } : {}),
        },
        timeoutMs: 120_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as ArkImageResponse;
    const results: GeneratedImage[] = [];
    for (const item of data.data ?? []) {
      if (item.url) results.push({ url: item.url });
      else if (item.b64_json) results.push({ b64: item.b64_json, mimeType: 'image/png' });
    }
    if (results.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '方舟图片接口未返回图片', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { images: results };
  },

  async submitVideo(
    ctx: VendorCallContext,
    model: string,
    params: VideoGenerationParams,
  ): Promise<VideoGenerationHandle> {
    const images = params.images ?? [];
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/contents/generations/tasks`,
      ctx.apiKey,
      {
        json: {
          model,
          content: [
            { type: 'text', text: params.prompt },
            ...(images.length > 0
              ? [{ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' }]
              : []),
          ],
          resolution: params.resolution,
          ratio: params.ratio,
          duration: params.duration,
          // 文本生成视频默认关水印。
          watermark: false,
        },
        timeoutMs: 60_000,
      },
      ctx.fetchImpl,
    );
    const data = response.json() as ArkTaskResponse;
    if (!data.id) {
      throw new AppError('PROVIDER_UNAVAILABLE', '方舟视频任务提交失败', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return { taskId: data.id };
  },

  async videoStatus(ctx: VendorCallContext, taskId: string): Promise<VideoTaskStatus> {
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      ctx.apiKey,
      { timeoutMs: 30_000 },
      ctx.fetchImpl,
    );
    return mapTaskStatus(response.json() as ArkTaskResponse);
  },

  async cancelVideo(ctx: VendorCallContext, taskId: string): Promise<void> {
    await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      ctx.apiKey,
      { method: 'DELETE', timeoutMs: 30_000 },
      ctx.fetchImpl,
    );
  },
};
