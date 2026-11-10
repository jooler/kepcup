import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { estimateTokens, truncateToBudget } from './tokens.js';

/**
 * 内置任务的任务 Loop 按工具上下文消耗估算（D93 排查辅助）：
 *
 * - `callTokens` = 工具调用参数（模型输出侧，通常很小）；
 * - `resultTokens` = 工具返回内容进入上下文的估算 token（输入侧）。
 *
 * 这里只估算「一次性进入上下文的大小」，不是计费 token，也不按后续请求
 * 重发次数放大。结果内容与 `toolResultBlocks` 同口径截断
 * （`truncateToBudget(content, TOOL_OUTPUT_MAX_CHARS)`），图片按固定成本计。
 * 外部 Agent 任务不采样（其工具内容只是宿主侧渲染，会系统性低估）。
 * 记账失败永不影响任务。
 */

export interface ToolUsageEntry {
  toolName: string;
  callTokens: number;
  resultTokens: number;
}

export interface ToolUsageTrackerOptions {
  /** 一次工具调用的估算结果（同步写入账本）。 */
  record: (entry: ToolUsageEntry) => void;
  /** 还没等到 tool_result 的调用上限；缺省 256。 */
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 256;
/** 图片的固定估算成本，与上下文压缩的 `estimateMessageTokens` 一致。 */
export const TOOL_IMAGE_TOKENS = 1_000;

export class ToolUsageTracker {
  readonly #record: (entry: ToolUsageEntry) => void;
  readonly #maxPending: number;
  /** toolCallId → 调用参数估算；tool_result 到达时配对并清理。 */
  readonly #pending = new Map<string, number>();

  constructor(options: ToolUsageTrackerOptions) {
    this.#record = options.record;
    this.#maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
  }

  call(input: { toolCallId: string; toolName: string; args: unknown }): void {
    const id = input.toolCallId;
    if (id.length === 0) return;
    // 缺失 tool_result 的调用不能无限占内存：丢掉最老的一条（只影响调用参数
    // 的归因，返回内容仍会在 result 时记录）。
    if (!this.#pending.has(id) && this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(id, estimateTokens(safeJson(input.args)));
  }

  result(input: {
    toolCallId: string;
    toolName: string;
    content: string;
    /** 模型实际收到的图片数量（不接受图片的模型为 0）。 */
    imageCount?: number;
  }): void {
    const callTokens = this.#pending.get(input.toolCallId) ?? 0;
    this.#pending.delete(input.toolCallId);
    const content = truncateToBudget(String(input.content ?? ''), TOOL_OUTPUT_MAX_CHARS).text;
    const resultTokens =
      estimateTokens(content) + Math.max(0, Math.round(input.imageCount ?? 0)) * TOOL_IMAGE_TOKENS;
    try {
      this.#record({ toolName: input.toolName, callTokens, resultTokens });
    } catch {
      // 用量账本失败不能影响任务；调用方（orchestrator）也会兜底。
    }
  }

  /** run 结束：丢弃没有结果的调用。 */
  clear(): void {
    this.#pending.clear();
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
