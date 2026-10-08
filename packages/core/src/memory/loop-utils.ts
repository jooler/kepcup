import type { LoopType } from '@kepcup/shared';
import type { UsageService } from '../domain/usage.js';

export interface LoopUsageDeps {
  usage: UsageService;
}

/** Records one structured call's usage against the loop's own run row. */
export function recordLoopUsage(
  deps: LoopUsageDeps,
  runId: string,
  loopType: LoopType,
  modelRef: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number | null;
  } | null,
): void {
  if (!usage) return;
  const index = modelRef.indexOf('/');
  deps.usage.record({
    runId,
    botId: null,
    conversationId: null,
    loopType,
    provider: index > 0 ? modelRef.slice(0, index) : 'unknown',
    model: index > 0 ? modelRef.slice(index + 1) : modelRef,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.costUsd,
  });
}
