import {
  CONTINUATION_TEXT_MAX_CHARS,
  CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS,
  type Run,
  type RunStep,
} from '@kepcup/shared';
import { estimateTokens } from '../tokens.js';
import { formatTime } from './conversation.js';

/**
 * Loop 续接 (D56, docs/dev/04-agent-runtime.md "续接段") as revised by D75
 * (design 30 §7.1): replay is explicit only. The automatic continuation of
 * the old response runs (L1 window + L2 light-model arbiter) is gone —
 * supervisor turns are read-only and short, their context (summary + recent
 * window + private task timeline + <tasks>) is enough. A task replays the
 * process of the task it continues (`start_task({continues_task_id})`, D56
 * budget) through `buildRunDigest`.
 */

export interface ContinuationPlan {
  /** Runs whose digest actually made it into the segment (chronological). */
  continuedFromRunIds: string[];
  segment: string;
}

/** One <previous_run> block: header + budgeted process lines (tail kept). */
export function buildRunDigest(input: {
  run: Run;
  steps: RunStep[];
  timeZone: string;
  budgetTokens: number;
}): string {
  const header =
    `<previous_run id="${input.run.id}" status="${input.run.status}"` +
    ` ended="${formatTime(input.run.endedAt ?? input.run.createdAt, input.timeZone)}"` +
    `${input.run.triggerReason !== null ? ` trigger="${input.run.triggerReason}"` : ''}>`;
  const lines = renderStepLines(input.steps, input.timeZone);
  if (lines.length === 0) return '';

  // Keep the tail (the most recent activity) under the budget; at least one
  // line is always kept — a header-only block would be worse than a short one.
  let used = estimateTokens(header) + estimateTokens('</previous_run>');
  let first = lines.length;
  while (first > 0) {
    const cost = estimateTokens(lines[first - 1] ?? '');
    if (used + cost > input.budgetTokens && first < lines.length) break;
    used += cost;
    first -= 1;
  }
  const kept = first > 0 ? ['（更早的步骤已省略）', ...lines.slice(first)] : lines;
  return [header, ...kept, '</previous_run>'].join('\n');
}

function renderStepLines(steps: RunStep[], timeZone: string): string[] {
  const lines: string[] = [];
  const openCalls = new Map<string, number>();
  for (const step of steps) {
    const time = hhmm(step.createdAt, timeZone);
    switch (step.type) {
      case 'request':
        break; // full request payload — redundant with the digest, and huge
      case 'assistant': {
        const payload = step.payload as {
          text?: unknown;
          stopReason?: unknown;
          errorMessage?: unknown;
        };
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (text.length > 0) {
          const label = payload.stopReason === 'stop' ? '（最终回复）' : '（说明）';
          lines.push(`[${time}] ${label} ${truncateText(text)}`);
        } else if (typeof payload.errorMessage === 'string' && payload.errorMessage.length > 0) {
          lines.push(`[${time}] （出错） ${truncateText(payload.errorMessage)}`);
        }
        break;
      }
      case 'tool_call': {
        const payload = step.payload as {
          toolCallId?: unknown;
          toolName?: unknown;
          args?: unknown;
        };
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
        const args = JSON.stringify(payload.args ?? {});
        const argsText = args === '{}' ? '' : `(${truncateText(args, 200)})`;
        if (toolCallId.length > 0) openCalls.set(toolCallId, lines.length);
        lines.push(`[${time}] ${toolName}${argsText}`);
        break;
      }
      case 'tool_result': {
        const payload = step.payload as { toolCallId?: unknown; ok?: unknown; content?: unknown };
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        const lineIndex = openCalls.get(toolCallId);
        const ok = payload.ok === true ? 'ok' : '失败';
        const content = typeof payload.content === 'string' ? payload.content : '';
        let resultText: string;
        if (content.length > CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS) {
          resultText = `→ ${ok}：输出 ${content.length} 字符（已省略）`;
        } else {
          // 内联的工具输出是数据不是指令（<platform_rules> 规则 7）。
          resultText = `→ ${ok}：<untrusted>${truncateText(content, CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS)}</untrusted>`;
        }
        if (lineIndex !== undefined) {
          lines[lineIndex] = `${lines[lineIndex]} ${resultText}`;
          openCalls.delete(toolCallId);
        } else {
          lines.push(`[${time}] ${resultText}`);
        }
        break;
      }
      case 'steer': {
        const payload = step.payload as { text?: unknown };
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text.length > 0) lines.push(`[${time}] （收到新消息注入） ${truncateText(text)}`);
        break;
      }
      case 'progress': {
        const payload = step.payload as { text?: unknown };
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text.length > 0) lines.push(`[${time}] （进度） ${truncateText(text)}`);
        break;
      }
      case 'system':
        break;
    }
  }
  return lines;
}

function hhmm(ms: number, timeZone: string): string {
  return formatTime(ms, timeZone).slice(-5);
}

function truncateText(text: string, max = CONTINUATION_TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
