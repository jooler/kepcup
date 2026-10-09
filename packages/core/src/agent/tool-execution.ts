import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { runInToolCall } from '../permissions/tool-call-scope.js';
import { truncateToBudget } from './tokens.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import type { EffectRecorder } from './effects/recorder.js';
import type { SettledEffectStatus } from './effects/store.js';

/**
 * 工具执行与结果文本化的共用部分：内置 pi 引擎的工具包装层与外部智能体的
 * 宿主 MCP 桥（docs/design/28-external-agents-acp.md §4.4）走同一套规则——
 * 执行失败不打断 loop（作为工具输出返回）、输出按 TOOL_OUTPUT_MAX_CHARS
 * 截断、图片只给接受图像输入的模型（否则一行提示）。
 */

/**
 * Runs a tool; a thrown error becomes a failed result (never breaks the loop).
 * The execution is one tool-call scope (D75：「仅这一次」授权随本次调用结束而
 * 失效，见 permissions/tool-call-scope.ts). A thrown AppError keeps its code
 * (e.g. RUN_READ_ONLY) so the model sees why; anything else is INTERNAL.
 *
 * W2: with an `effects` recorder, a call with an external side effect is
 * written to the ledger (runs.db tool_effects) as `executing` before it runs
 * and settled from its result (a throw settles as uncertain); the scope's
 * effect hooks let the gateway escalate a call that leaves the sandbox and
 * link its approval. The recorder never fails the call.
 *
 * W4: when the approval dedupe gate (ApprovalsService.request → the scope's
 * `approvalGate`) stopped the call — the same effect already completed / was
 * denied in the task chain — the model gets the gate's result
 * (DUPLICATE_EFFECT / 「用户已拒绝相同操作」) whatever the tool made of the
 * refused approval: tools keep their own denial texts, the gate stays out of
 * tool code.
 */
export async function executeToolSafely(
  tool: ToolDefinition,
  params: unknown,
  ctx: ToolContext,
  effects?: EffectRecorder,
): Promise<ToolResult> {
  const effect = effects?.begin({ tool, params, ctx }) ?? null;
  let result: ToolResult;
  try {
    result = await runInToolCall(
      () => tool.execute(params as never, ctx),
      effect !== null ? { effect } : {},
    );
  } catch (error) {
    const status = settleQuietly(() => effect?.settleThrown(error) ?? null);
    const deduped = dedupeQuietly(effect);
    if (deduped !== null) return deduped;
    return withLedgerOutcome(
      {
        ok: false,
        content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof AppError ? error.code : 'INTERNAL',
      },
      status,
    );
  }
  // Outside the try: a ledger failure can never replace the real result.
  const status = settleQuietly(() => effect?.settle(result) ?? null);
  return dedupeQuietly(effect) ?? withLedgerOutcome(result, status);
}

function dedupeQuietly(effect: { dedupeResult?(): ToolResult | null } | null): ToolResult | null {
  try {
    return effect?.dedupeResult?.() ?? null;
  } catch {
    return null;
  }
}

function settleQuietly(settle: () => SettledEffectStatus | null): SettledEffectStatus | null {
  try {
    return settle();
  } catch {
    return null; // the recorder logs its own failures; never the tool's problem
  }
}

/**
 * W2 → run_steps: a call the ledger settled as uncertain (thrown tool, MCP
 * transport failure, failure during an abort) carries `outcome:'uncertain'`
 * in its tool_result step too, so the continuation digest sees it even
 * without the ledger (or when tool-call ids repeat).
 */
function withLedgerOutcome(result: ToolResult, status: SettledEffectStatus | null): ToolResult {
  return status === 'uncertain' && result.outcome === undefined
    ? { ...result, outcome: 'uncertain' }
    : result;
}

export const SCREENSHOT_OMITTED_NOTE =
  '（截图已省略：当前模型不支持图像输入，请使用快照文本了解页面）';

export type ToolResultBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * The content blocks a tool result hands back to the model: the truncated
 * text first, then the images when the model accepts them (P11
 * browser_screenshot), else a one-line note. Same shape for pi tool results
 * and MCP `CallToolResult.content`.
 */
export function toolResultBlocks(result: ToolResult, acceptsImages: boolean): ToolResultBlock[] {
  const text = truncateToBudget(result.content, TOOL_OUTPUT_MAX_CHARS).text;
  const imageBlocks: ToolResultBlock[] =
    result.images !== undefined && result.images.length > 0
      ? acceptsImages
        ? result.images.map((image) => ({
            type: 'image' as const,
            data: image.base64,
            mimeType: image.mimeType,
          }))
        : [{ type: 'text' as const, text: SCREENSHOT_OMITTED_NOTE }]
      : [];
  return [{ type: 'text', text }, ...imageBlocks];
}
