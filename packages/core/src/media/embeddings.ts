import type { VendorCallContext } from './types.js';
import { trimTrailingSlash, vendorFetch } from './http.js';

/**
 * OpenAI 兼容 `/embeddings` 调用（百炼 text-embedding 系的向量接口形态）。
 * 批量上限各厂商不一（10～32），这里统一按 10 一批串行发送并按请求顺序
 * 拼接，同时按响应里的 index 归位，保证输出顺序与输入一致。方舟的向量
 * 走多模态端点（见 volcengine 适配器），不经这里。
 */
export async function openAICompatibleEmbed(
  ctx: VendorCallContext,
  model: string,
  texts: string[],
  opts: { batchSize?: number } = {},
): Promise<number[][]> {
  const batchSize = opts.batchSize ?? 10;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const response = await vendorFetch(
      `${trimTrailingSlash(ctx.baseUrl)}/embeddings`,
      ctx.apiKey,
      { json: { model, input: texts.slice(i, i + batchSize) }, timeoutMs: 60_000 },
      ctx.fetchImpl,
    );
    vectors.push(...parseOpenAIEmbeddings(response.json()));
  }
  return vectors;
}

/** 解析 OpenAI 兼容向量响应，按 index 归位为与输入同序的向量数组。 */
export function parseOpenAIEmbeddings(payload: unknown): number[][] {
  const data = (payload as { data?: Array<{ index?: number; embedding?: unknown }> }).data ?? [];
  const rows = data
    .filter((row): row is { index?: number; embedding: number[] } => Array.isArray(row.embedding))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((row) => row.embedding);
}
