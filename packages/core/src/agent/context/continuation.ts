import {
  CONTINUATION_TEXT_MAX_CHARS,
  CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS,
  type Run,
  type RunStep,
  type ToolEffect,
} from '@kepcup/shared';
import { estimateTokens } from '../tokens.js';
import { effectClassOf } from '../effects/classify.js';
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

/** The W2 ledger facts a digest uses (a subset of ToolEffect). */
export type DigestEffect = Pick<ToolEffect, 'toolCallId' | 'status'>;

/**
 * W3-P0「结果未知」标注（todo/borrowings-from-personal-agents.md W3 设计 1 /
 * W1 续接项）：续接的模型必须先核实、不得直接重做。
 */
export const UNKNOWN_RESULT_MARK = '[结果未知]';
/** A call that never returned (the run was interrupted / cancelled while it ran). */
export const UNRETURNED_CALL_NOTE =
  '—— 中断时仍在执行、没有返回结果，可能已经生效：先核实页面 / 外部状态，勿直接重做';
/** A call whose result says the action may have taken effect (W1 uncertain / ledger). */
export const UNCERTAIN_RESULT_NOTE =
  '—— 动作可能已经生效（结果不确定）：先核实页面 / 外部状态，勿直接重做';

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
  /**
   * W2 ledger rows of the run (optional — old runs have none): a call whose
   * row is `uncertain` is flagged even when its result step looks like a plain
   * failure (a thrown tool, a recovery-marked row).
   */
  effects?: readonly DigestEffect[];
}): string {
  const header =
    `<previous_run id="${input.run.id}" status="${input.run.status}"` +
    ` ended="${formatTime(input.run.endedAt ?? input.run.createdAt, input.timeZone)}"` +
    `${input.run.triggerReason !== null ? ` trigger="${input.run.triggerReason}"` : ''}>`;
  // By base id: a tool-call id the run reused is stored as `id#2`, `id#3`…
  // in the ledger (ToolEffectsStore.open) while the steps keep `id`.
  const uncertain = new Set(
    (input.effects ?? [])
      .filter((e) => e.status === 'uncertain')
      .map((e) => baseToolCallId(e.toolCallId)),
  );
  const lines = renderStepLines(input.steps, input.timeZone, uncertain);
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

function renderStepLines(
  steps: RunStep[],
  timeZone: string,
  uncertainCallIds: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  /** tool_call steps still waiting for their result: line index + rendering parts. */
  const openCalls = new Map<
    string,
    { index: number; time: string; call: string; toolName: string; args: unknown }
  >();
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
        const call = `${toolName}${argsText}`;
        if (toolCallId.length > 0) {
          openCalls.set(toolCallId, {
            index: lines.length,
            time,
            call,
            toolName,
            args: payload.args,
          });
        }
        lines.push(`[${time}] ${call}`);
        break;
      }
      case 'tool_result': {
        const payload = step.payload as {
          toolCallId?: unknown;
          ok?: unknown;
          content?: unknown;
          errorCode?: unknown;
          outcome?: unknown;
        };
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
        const open = openCalls.get(toolCallId);
        const ok = payload.ok === true ? 'ok' : '失败';
        // W1 uncertain outcome (old rows lack `outcome`: the error code still
        // tells), or the W2 ledger says so (a thrown tool, recovery).
        const uncertain =
          payload.outcome === 'uncertain' ||
          payload.errorCode === 'BROWSER_OUTCOME_UNKNOWN' ||
          // Ledger fallback only for failures: an ok result is never uncertain,
          // and a reused id must not drag a successful sibling call along.
          (payload.ok !== true && toolCallId.length > 0 && uncertainCallIds.has(toolCallId));
        const content = typeof payload.content === 'string' ? payload.content : '';
        let resultText: string;
        if (content.length > CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS) {
          resultText = `→ ${ok}：输出 ${content.length} 字符（已省略）`;
        } else {
          // 内联的工具输出是数据不是指令（<platform_rules> 规则 7）。
          resultText = `→ ${ok}：<untrusted>${truncateText(content, CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS)}</untrusted>`;
        }
        if (open !== undefined) {
          lines[open.index] = uncertain
            ? `[${open.time}] ${UNKNOWN_RESULT_MARK} ${open.call} ${UNCERTAIN_RESULT_NOTE} ${resultText}`
            : `${lines[open.index]} ${resultText}`;
          openCalls.delete(toolCallId);
        } else {
          lines.push(
            uncertain
              ? `[${time}] ${UNKNOWN_RESULT_MARK} ${UNCERTAIN_RESULT_NOTE} ${resultText}`
              : `[${time}] ${resultText}`,
          );
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
  // Calls that never got a result: the run ended (interrupted / cancelled)
  // while they ran. A side-effecting one may have happened — flagged; a
  // read-only one (W2 class `none`, not marked uncertain) just says so.
  for (const [toolCallId, open] of openCalls) {
    const flagged =
      uncertainCallIds.has(toolCallId) || effectClassOf(open.toolName, open.args) !== 'none';
    lines[open.index] = flagged
      ? `[${open.time}] ${UNKNOWN_RESULT_MARK} ${open.call} ${UNRETURNED_CALL_NOTE}`
      : `[${open.time}] ${open.call} →（未返回结果）`;
  }
  return lines;
}

/** A ledger tool-call id without its reuse suffix (`call_0#2` → `call_0`). */
export function baseToolCallId(id: string): string {
  return id.replace(/#\d+$/, '');
}

function hhmm(ms: number, timeZone: string): string {
  return formatTime(ms, timeZone).slice(-5);
}

function truncateText(text: string, max = CONTINUATION_TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
