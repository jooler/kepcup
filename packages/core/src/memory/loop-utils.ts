import { AppError } from '@kepcup/shared';
import type { LoopType } from '@kepcup/shared';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';

/** Default main model ref (画像整理 uses the main model, docs 04 loop 表). */
export function mainModelRef(settings: SettingsService): string {
  const ref = settings.get().defaultMainModel;
  if (ref.length === 0) throw new AppError('PROVIDER_UNAVAILABLE', '未配置默认主模型');
  return ref;
}

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
