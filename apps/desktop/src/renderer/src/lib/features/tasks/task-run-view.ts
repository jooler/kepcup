import {
  TASK_PLAN_MAX_STEPS,
  TASK_PLAN_STEP_MAX_CHARS,
  type RunStep,
} from '@kepcup/shared';

/**
 * 任务执行过程页（docs/design/42-task-run-view.md）的纯展示逻辑：
 * run_steps → Agent 消息时间线（助手文本、工具调用 + 结果、进度、追加指令），
 * 以及工具调用的摘要 / 状态。不依赖 Svelte，便于单测。
 */

export interface TaskRunToolResult {
  ok: boolean;
  content: string;
  errorCode?: string;
}

export type TaskRunEntry =
  | { kind: 'assistant'; id: string; text: string; error: string | null }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      name: string;
      title: string | null;
      args: unknown;
      result: TaskRunToolResult | null;
    }
  | { kind: 'progress'; id: string; text: string }
  | { kind: 'steer'; id: string; text: string }
  | { kind: 'system'; id: string; text: string };

interface PayloadRecord {
  [key: string]: unknown;
}

function recordOf(value: unknown): PayloadRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PayloadRecord)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Builds the visible transcript. `request` steps are internal model payloads and
 * are not part of the timeline; `tool_result` is attached to its `tool_call` so
 * one card shows both sides of the call.
 */
export function buildTaskRunTimeline(steps: readonly RunStep[]): TaskRunEntry[] {
  const entries: TaskRunEntry[] = [];
  const tools = new Map<string, Extract<TaskRunEntry, { kind: 'tool' }>>();
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);

  for (const step of ordered) {
    const payload = recordOf(step.payload);
    switch (step.type) {
      case 'assistant': {
        const text = textOf(payload.text).trim();
        const error = textOf(payload.errorMessage).trim();
        if (text.length === 0 && error.length === 0) break;
        entries.push({
          kind: 'assistant',
          id: step.id,
          text,
          error: error.length > 0 ? error : null,
        });
        break;
      }
      case 'tool_call': {
        const toolCallId = textOf(payload.toolCallId);
        const title = textOf(payload.title).trim();
        const entry: Extract<TaskRunEntry, { kind: 'tool' }> = {
          kind: 'tool',
          id: step.id,
          toolCallId,
          name: textOf(payload.toolName) || 'tool',
          title: title.length > 0 ? title : null,
          args: payload.args,
          result: null,
        };
        entries.push(entry);
        if (toolCallId.length > 0) tools.set(toolCallId, entry);
        break;
      }
      case 'tool_result': {
        const toolCallId = textOf(payload.toolCallId);
        const result: TaskRunToolResult = {
          ok: payload.ok === true,
          content: textOf(payload.content),
          ...(textOf(payload.errorCode).length > 0 ? { errorCode: textOf(payload.errorCode) } : {}),
        };
        const target = tools.get(toolCallId);
        if (target !== undefined) {
          target.result = result;
          tools.delete(toolCallId);
          break;
        }
        entries.push({
          kind: 'tool',
          id: step.id,
          toolCallId,
          name: textOf(payload.toolName) || 'tool',
          title: null,
          args: null,
          result,
        });
        break;
      }
      case 'progress': {
        const text = textOf(payload.text).trim();
        if (text.length > 0) entries.push({ kind: 'progress', id: step.id, text });
        break;
      }
      case 'steer': {
        const text = textOf(payload.text).trim();
        if (text.length > 0) entries.push({ kind: 'steer', id: step.id, text });
        break;
      }
      case 'system': {
        const text = textOf(payload.text).trim();
        if (text.length > 0) entries.push({ kind: 'system', id: step.id, text });
        break;
      }
      default:
        break;
    }
  }
  return entries;
}

export type TaskPlanStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskPlanEntry {
  step: string;
  status: TaskPlanStatus;
}

export interface TaskPlan {
  explanation: string;
  plan: TaskPlanEntry[];
  updatedAt: number;
}

const PLAN_STATUSES: readonly TaskPlanStatus[] = ['pending', 'in_progress', 'completed'];

/** 校验一条 update_plan 调用的 args.plan；非法返回 null。 */
function parsePlanArgs(args: unknown): TaskPlanEntry[] | null {
  const record = recordOf(args);
  const raw = record['plan'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > TASK_PLAN_MAX_STEPS) return null;
  const plan: TaskPlanEntry[] = [];
  for (const entry of raw) {
    const item = recordOf(entry);
    const step = textOf(item['step']).trim();
    const status = item['status'];
    if (
      step.length === 0 ||
      step.length > TASK_PLAN_STEP_MAX_CHARS ||
      !PLAN_STATUSES.includes(status as TaskPlanStatus)
    ) {
      return null;
    }
    plan.push({ step, status: status as TaskPlanStatus });
  }
  return plan;
}

/**
 * 执行过程页的结构化计划（D93 §6.2）：取最后一个合法的 `update_plan`
 * 调用，不新增 RPC 或数据库字段。非法调用跳过，往前找上一个合法计划。
 */
export function latestPlan(steps: readonly RunStep[]): TaskPlan | null {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const step = ordered[index]!;
    if (step.type !== 'tool_call') continue;
    const payload = recordOf(step.payload);
    if (textOf(payload['toolName']) !== 'update_plan') continue;
    const plan = parsePlanArgs(payload['args']);
    if (plan === null) continue;
    const explanation = textOf(recordOf(payload['args'])['explanation']).trim();
    return { explanation, plan, updatedAt: step.createdAt };
  }
  return null;
}

const SUMMARY_MAX = 160;

/** One-line summary of a call (external agents' title wins). */
export function toolCallSummary(
  entry: Pick<Extract<TaskRunEntry, { kind: 'tool' }>, 'name' | 'title' | 'args'>,
): string {
  if (entry.title !== null && entry.title.trim().length > 0) return clip(entry.title);
  const args = recordOf(entry.args);
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return '';
  };
  let summary = '';
  if (entry.name === 'bash' || entry.name === 'powershell') {
    summary = first('command', 'cmd');
  } else if (entry.name === 'read' || entry.name === 'write' || entry.name === 'edit') {
    summary = first('path', 'file_path', 'filePath');
  } else if (entry.name === 'ls' || entry.name === 'find' || entry.name === 'grep') {
    summary = first('path', 'pattern', 'query');
  } else if (entry.name.startsWith('browser_')) {
    summary = first('url', 'selector', 'ref', 'text', 'key');
  } else if (entry.name === 'ask_user' || entry.name === 'ask_question') {
    summary = first('question', 'text');
  } else if (entry.name === 'send_message') {
    summary = first('text', 'message');
  } else if (entry.name === 'capability_call') {
    summary = first('name', 'tool', 'toolName');
  }
  if (summary.length === 0) {
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        summary = value.trim();
        break;
      }
    }
  }
  return clip(summary);
}

/** Pretty JSON for the expanded call args; strings are shown as-is. */
export function formatToolArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2) ?? '';
  } catch {
    return String(args);
  }
}

/** First line of a tool result, for a collapsed row; '' when there is no output. */
export function resultPreview(content: string): string {
  const line = content
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line === undefined ? '' : clip(line);
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Elapsed task time: ended − started (created before it starts). */
export function taskElapsedMs(
  task: { createdAt: number; startedAt: number | null; endedAt: number | null },
  now: number,
): number {
  const started = task.startedAt ?? task.createdAt;
  return Math.max(0, (task.endedAt ?? now) - started);
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}
