import { AppError } from '@kepcup/shared';
import { trimTrailingSlash, vendorFetch } from '../http.js';
import type { VendorAdapter, VendorCallContext } from '../types.js';

/**
 * 自定义供应商（任意 OpenAI 兼容端点）的通用适配器：只实现有事实标准的
 * 能力——文本向量（POST `{baseUrl}/embeddings`，OpenAI 格式）。对话模型走
 * pi 注册表，不经这里；重排 / 图片 / 语音 / 视频没有跨厂商的事实标准，
 * 不实现，网关层给出明确提示（自定义供应商接这些能力请用内置厂商实例，
 * 走各家原生适配器）。
 */

interface OpenAIEmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export const openAICompatibleAdapter: VendorAdapter = {
  async embed(ctx: VendorCallContext, model: string, texts: string[]): Promise<number[][]> {
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/embeddings`,
      ctx.apiKey,
      { json: { model, encoding_format: 'float', input: texts }, timeoutMs: 60_000 },
      ctx.fetchImpl,
    );
    const data = response.json() as OpenAIEmbeddingsResponse;
    const rows = Array.isArray(data.data) ? data.data : [];
    const vectors: number[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new AppError('PROVIDER_UNAVAILABLE', '向量接口返回了无效向量', {
          body: response.bodyText.slice(0, 300),
        });
      }
      vectors.push(row.embedding);
    }
    if (vectors.length !== texts.length) {
      throw new AppError('PROVIDER_UNAVAILABLE', '向量接口未返回与输入等量的向量', {
        body: response.bodyText.slice(0, 300),
      });
    }
    return vectors;
  },
};
