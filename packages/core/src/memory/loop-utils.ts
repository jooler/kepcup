import type { LoopType } from '@kepcup/shared';
import type { UsageService } from '../domain/usage.js';

export interface LoopUsageDeps {
  usage: UsageService;
}

/**
 * Records one structured call's usage against the loop's own run row.
 * `botId`: the bot the row is charged to (daily background budget) — set for
 * external-agent rows whose owning bot is known (审查 C5); built-in rows keep
 * the pre-P6 bot-less attribution.
 */
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
  botId: string | null = null,
): void {
  if (!usage) return;
  const index = modelRef.indexOf('/');
  deps.usage.record({
    runId,
    botId,
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
