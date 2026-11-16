import { AppError } from '@kepcup/shared';
import { trimTrailingSlash, vendorFetch } from '../http.js';
import { openAICompatibleUnderstandImage } from '../vision.js';
import type { UnderstandImageParams, VendorAdapter, VendorCallContext } from '../types.js';

/**
 * 火山方舟（Ark）。数据面全部挂 OpenAI 风格的 `{baseUrl}`（默认
 * https://ark.cn-beijing.volces.com/api/v3）：
 * - 向量：POST /embeddings/multimodal（doubao-embedding-vision；文本向量
 *   模型与纯文本 /embeddings 端点均已下线，多模态端点整个 input 融合为
 *   **单个**向量，批量时逐条请求再按输入顺序拼接）
 * - 图片理解：POST /chat/completions + image_url 内容块（vision.ts）
 * - 重排 / TTS / ASR：方舟数据面均不提供（重排在 VikingDB、语音在独立
 *   语音产品线），适配器不挂对应方法，网关层会给出明确提示。
 *
 * DEV-133：图片生成 / 编辑（seedream，/images/generations）与视频生成
 * （seedance，/contents/generations/tasks 异步任务）的内置实现已移除
 * （generateImage / submitVideo / videoStatus / cancelVideo）——图像 /
 * 视频生成统一由能力模型插件条目提供，本适配器不再承载。
 */

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
};
