import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from './tokens.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

/**
 * 工具执行与结果文本化的共用部分：内置 pi 引擎的工具包装层与外部智能体的
 * 宿主 MCP 桥（docs/design/28-external-agents-acp.md §4.4）走同一套规则——
 * 执行失败不打断 loop（作为工具输出返回）、输出按 TOOL_OUTPUT_MAX_CHARS
 * 截断、图片只给接受图像输入的模型（否则一行提示）。
 */

/** Runs a tool; a thrown error becomes a failed result (never breaks the loop). */
export async function executeToolSafely(
  tool: ToolDefinition,
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool.execute(params as never, ctx);
  } catch (error) {
    return {
      ok: false,
      content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
      errorCode: 'INTERNAL',
    };
  }
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
