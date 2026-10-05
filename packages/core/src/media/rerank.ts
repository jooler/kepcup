import type { RerankResult } from './types.js';

/**
 * 重排响应的共享解析：`results[].{index, relevance_score}` 结构
 * （百炼原生 text-rerank 端点即此形态），按 relevance_score 降序输出。
 */
export function parseRerankResults(payload: unknown): RerankResult['results'] {
  const rows =
    (payload as { results?: Array<{ index?: number; relevance_score?: number }> }).results ?? [];
  return rows
    .filter(
      (row): row is { index: number; relevance_score: number } =>
        typeof row.index === 'number' && typeof row.relevance_score === 'number',
    )
    .map((row) => ({ index: row.index, score: row.relevance_score }))
    .sort((a, b) => b.score - a.score);
}
