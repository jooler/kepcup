import {
  TASK_PLAN_MAX_STEPS,
  TASK_PLAN_STEP_MAX_CHARS,
  countLines,
  diffStatsOfEdits,
  type DiffStats,
  type Message,
  type RunStep,
  type SteerAttachment,
} from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 任务执行过程页（docs/design/42-task-run-view.md）的纯展示逻辑：
 * run_steps → Agent 消息时间线（助手文本、工具调用 + 结果、进度、追加指令），
 * 以及工具调用的摘要 / 状态。不依赖 Svelte，便于单测。
 */

export interface TaskRunToolResult {
  ok: boolean;
  content: string;
  errorCode?: string;
  /** File change line counts (external agents' ACP diff content). */
  diffStats?: DiffStats;
}

export type TaskRunEntry =
  | { kind: 'assistant'; id: string; text: string; thinking: string; error: string | null }
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
  | {
      kind: 'steer';
      id: string;
      text: string;
      /** D115 附件直注：注入直带的附件元数据（steer payload），气泡渲染 chip。 */
      attachments: SteerAttachment[];
    }
  /** D123: a message from a sibling task (steered as `<peer_task_message>`). */
  | { kind: 'peer'; id: string; fromTaskId: string; fromTitle: string | null; text: string }
  | { kind: 'system'; id: string; text: string };

/** 时间线上的渲染分组：连续的 tool 条目收进一张工具卡（与编程 Agent 的对话一致）。 */
export type TaskRunRenderEntry =
  | Exclude<TaskRunEntry, { kind: 'tool' }>
  | {
      kind: 'toolGroup';
      id: string;
      tools: Array<Extract<TaskRunEntry, { kind: 'tool' }>>;
    };

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

function diffStatsOfPayload(value: unknown): DiffStats | null {
  const record = recordOf(value);
  const added = record['added'];
  const removed = record['removed'];
  if (typeof added !== 'number' || typeof removed !== 'number') return null;
  if (!Number.isFinite(added) || !Number.isFinite(removed)) return null;
  return { added: Math.max(0, Math.trunc(added)), removed: Math.max(0, Math.trunc(removed)) };
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
        // 思考内容与正文分开保存；只有思考的轮次也要出现在时间线上。
        const thinking = textOf(payload.thinking).trim();
        const error = textOf(payload.errorMessage).trim();
        if (text.length === 0 && thinking.length === 0 && error.length === 0) break;
        entries.push({
          kind: 'assistant',
          id: step.id,
          text,
          thinking,
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
        const diffStats = diffStatsOfPayload(payload.diffStats);
        const result: TaskRunToolResult = {
          ok: payload.ok === true,
          content: textOf(payload.content),
          ...(textOf(payload.errorCode).length > 0 ? { errorCode: textOf(payload.errorCode) } : {}),
          ...(diffStats !== null ? { diffStats } : {}),
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
        // 工具执行状态（「正在执行命令 …」）是自动提示，只该出现在状态行；
        // 新 run 不再落步骤，这里再兜住旧数据，避免它打断工具分组。
        if (text.length > 0 && !isToolProgressText(text)) {
          entries.push({ kind: 'progress', id: step.id, text });
        }
        break;
      }
      case 'steer': {
        const raw = textOf(payload.text);
        const peer = peerMessageOf(raw);
        if (peer !== null) {
          entries.push({ kind: 'peer', id: step.id, ...peer });
          break;
        }
        const stripped = steerDisplayText(raw);
        const meta = steerAttachmentsOf(payload.attachments);
        const attachments =
          meta.length > 0
            ? meta
            : // 外部 Agent 引擎的 steer 事件不带元数据（opts 被忽略，附件靠
              // 文本里的物化提示到达）：从正文行解析出降级元数据，chip 照出。
              injectAttachmentLinesOf(stripped);
        // 附件行是给模型的（物化提示）：气泡正文剥掉，chip 另行渲染。
        const text = stripInjectAttachmentLines(stripped, attachments);
        if (text.length > 0 || attachments.length > 0) {
          entries.push({ kind: 'steer', id: step.id, text, attachments });
        }
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

/**
 * 工具执行时的自动状态提示（ToolContext.progress，如「正在执行命令 …」/
 * 「正在编辑 …」）。它们只服务状态行，不是模型消息；旧 run 曾把它们写成
 * progress 步骤，时间线读取时隐藏。计划（「计划 x/y：…」）、压缩、子任务
 * 等有意义的进度不以「正在」开头，照常显示。
 */
export function isToolProgressText(text: string): boolean {
  return text.startsWith('正在');
}

/**
 * D115 附件直注：剥离 steer 文本里的附件行（`att_… name [mime] 大小KB`，给
 * 模型的物化提示）。气泡下方已按 payload.attachments 渲染 chip，正文里再显示
 * 这几行就是重复；按注入附件的 id 精确匹配行首，用户手打的相似文本不受影响。
 */
export function stripInjectAttachmentLines(
  text: string,
  attachments: readonly SteerAttachment[],
): string {
  if (attachments.length === 0) return text;
  const ids = new Set(attachments.map((attachment) => attachment.id));
  const kept = text
    .split('\n')
    .filter((line) => {
      const head = line.trimStart().split(/\s/, 1)[0] ?? '';
      return !ids.has(head);
    });
  return kept.join('\n').trim();
}

/**
 * D115 附件直注：从 steer 正文解析注入附件行（外部 Agent 引擎的 steer 事件
 * 不带 payload.attachments，附件靠 buildTaskInjection 的文本行到达）：
 * `att_… name [mime] NKB`。size 是行里的 KB 取整值（显示足够）；形状不符的行
 * 不采信——用户手打的相似文本不会误判成附件。
 */
export function injectAttachmentLinesOf(text: string): SteerAttachment[] {
  return text.split('\n').flatMap((line) => {
    const match = /^(\S+) (.+) \[([^\]]+)\] (\d+)KB$/.exec(line.trim());
    if (match === null || !match[1]!.startsWith('att_')) return [];
    return [
      {
        id: match[1]!,
        fileName: match[2]!,
        mime: match[3]!,
        size: Number(match[4]) * 1024,
      },
    ];
  });
}

/**
 * D115 附件直注：steer payload 里注入直带的附件元数据。旧数据 / 形状不符的
 * 条目逐个丢弃（payload 是 z.unknown()，渲染端自校验），全部无效 = 空。
 */
export function steerAttachmentsOf(value: unknown): SteerAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const record = recordOf(candidate);
    const id = record['id'];
    const fileName = record['fileName'];
    const mime = record['mime'];
    const size = record['size'];
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof fileName !== 'string' ||
      typeof mime !== 'string' ||
      typeof size !== 'number' ||
      !Number.isFinite(size)
    ) {
      return [];
    }
    return [{ id, fileName, mime, size }];
  });
}

/**
 * D115 附件直注：steer 附件元数据 → 消息附件视图形状（MessageAttachments 复用；
 * 字节按 id 经 attachments.get 取回，存储侧字段是占位——渲染只读 id / mime /
 * 文件名 / 大小）。
 */
export function steerAttachmentViewOf(attachments: readonly SteerAttachment[]): Message['attachments'] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    conversationId: '',
    messageId: null,
    fileName: attachment.fileName,
    mime: attachment.mime,
    size: attachment.size,
    sha256: '',
    relPath: '',
    createdAt: 0,
  }));
}

/**
 * D123: a steered `<peer_task_message from_task="…" title="…">` (a sibling
 * task's message) as a timeline entry; null for ordinary steers.
 */
export function peerMessageOf(
  text: string,
): { fromTaskId: string; fromTitle: string | null; text: string } | null {
  // Only a steer that *is* a peer message: a user instruction that merely
  // quotes the tag (an example pasted into the inject dock) stays an inject.
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<peer_task_message')) return null;
  const message = /<peer_task_message\b([^>]*)>([\s\S]*?)<\/peer_task_message>/.exec(trimmed);
  if (message === null) return null;
  const attributes = message[1] ?? '';
  const fromTaskId = /from_task="([^"]*)"/.exec(attributes)?.[1] ?? '';
  if (fromTaskId.length === 0) return null;
  const fromTitle = /title="([^"]*)"/.exec(attributes)?.[1] ?? null;
  const untrusted = /<untrusted>([\s\S]*?)<\/untrusted>/.exec(message[2] ?? '');
  return { fromTaskId, fromTitle, text: (untrusted?.[1] ?? message[2] ?? '').trim() };
}

/**
 * D123: the task-detail meta chips' display values. `null` means the chip is
 * absent (an undeclared domain / no claims); the caller applies the i18n
 * label. Kept pure so the visibility contract is testable without a DOM.
 */
export function taskMetaChips(
  task: {
    writeDomains: string[] | null;
    claims: ReadonlyArray<{ paths: string[] }>;
  },
  separator: string,
): { writeDomains: string | null; claims: string | null } {
  const domains = task.writeDomains;
  const claimed = task.claims.flatMap((claim) => claim.paths);
  return {
    writeDomains: domains === null ? null : domains.join(separator),
    claims: claimed.length > 0 ? claimed.join(separator) : null,
  };
}

/**
 * 追加指令（steer）在时间线上的显示文本。发给引擎的 steer 原文由
 * `buildTaskInjection` 包成 `<task_inject>指令（含 source_messages）</task_inject>`
 * 加尾部说明（「对话中的你追加了新的指令：…」）——那是给 LLM 的完整语义，
 * 用户只需看到标签内的指令本身，气泡标题已有「追加指令」。没有包裹的
 * 旧数据 / 纯文本 steer 原样显示。
 */
export function steerDisplayText(text: string): string {
  const trimmed = text.trimStart();
  // A malformed / partially parsed peer wrapper must not show raw tags.
  if (trimmed.startsWith('<peer_task_message')) {
    return trimmed
      .replace(/^<peer_task_message\b[^>]*>/, '')
      .replace(/<\/peer_task_message>[\s\S]*$/, '')
      .replace(/<\/?untrusted>/g, '')
      .trim();
  }
  const match = /<task_inject>\n?([\s\S]*?)\n?<\/task_inject>/.exec(text);
  if (match === null) return text.trim();
  return match[1]?.trim() ?? '';
}

/**
 * 连续的工具调用合并成一组：助手说明、追加指令、进度等会打断分组，组内条目
 * 保持调用顺序。组 id 取首个步骤的 id，刷新时保持稳定（不会整组重建）。
 */
export function groupTaskRunEntries(entries: readonly TaskRunEntry[]): TaskRunRenderEntry[] {
  const grouped: TaskRunRenderEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'tool') {
      grouped.push(entry);
      continue;
    }
    const last = grouped[grouped.length - 1];
    if (last !== undefined && last.kind === 'toolGroup') last.tools.push(entry);
    else grouped.push({ kind: 'toolGroup', id: `group-${entry.id}`, tools: [entry] });
  }
  return grouped;
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

/** One tool row in the task timeline: verb (dim), target (bright), diff line counts. */
export interface TaskRunToolRow {
  /** i18n key for the verb; null = render `verb` verbatim (external agent title). */
  actionKey: MessageKey | null;
  verb: string;
  target: string;
  /** Shell commands keep monospace; files / titles stay sans. */
  mono: boolean;
  added: number | null;
  removed: number | null;
}

const BROWSER_ACTIONS: Record<string, MessageKey> = {
  open: 'task.run.action.open',
  navigate: 'task.run.action.open',
  click: 'task.run.action.click',
  type: 'task.run.action.type',
  press_key: 'task.run.action.press',
  key: 'task.run.action.press',
  scroll: 'task.run.action.scroll',
  screenshot: 'task.run.action.screenshot',
  back: 'task.run.action.back',
  close: 'task.run.action.close',
  read_page: 'task.run.action.readPage',
  snapshot: 'task.run.action.readPage',
};

function argText(args: PayloadRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

/**
 * External agents send a human-readable title ("Edited types.ts", "Read a.ts");
 * the first word is the action, the rest the target. Titles without a space
 * stay whole.
 */
function splitAgentTitle(title: string): { verb: string; target: string } {
  const trimmed = title.trim();
  const space = trimmed.indexOf(' ');
  if (space <= 0) return { verb: trimmed, target: '' };
  return { verb: trimmed.slice(0, space), target: trimmed.slice(space + 1).trim() };
}

/** `path` + the read window (`offset` is 1-indexed), as in "Read a.ts (50-99)". */
function readTarget(path: string, args: PayloadRecord): string {
  const offset =
    typeof args['offset'] === 'number' && args['offset'] > 0 ? Math.trunc(args['offset']) : null;
  const limit =
    typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.trunc(args['limit']) : null;
  if (offset === null && limit === null) return path;
  const start = offset ?? 1;
  return limit === null ? `${path} (from ${start})` : `${path} (${start}-${start + limit - 1})`;
}

/**
 * 任务详情页一行工具调用的展示模型：动词 + 操作目标（文件名 / 命令）+
 * 新增 / 删除行数。外部智能体用自带的 title；内置 pi 工具按参数归一化，
 * edit / write 的行数在这里从参数直接算。
 */
export function toolRowDisplay(entry: Extract<TaskRunEntry, { kind: 'tool' }>): TaskRunToolRow {
  const args = recordOf(entry.args);
  // A failed call did not change anything: no diff stats on the row.
  const mayShowStats = entry.result === null || entry.result.ok;
  const resultStats = mayShowStats ? (entry.result?.diffStats ?? null) : null;

  if (entry.title !== null && entry.title.trim().length > 0) {
    const { verb, target } = splitAgentTitle(entry.title);
    return {
      actionKey: null,
      verb,
      target,
      mono: false,
      added: resultStats?.added ?? null,
      removed: resultStats?.removed ?? null,
    };
  }

  const name = entry.name.toLowerCase();
  const path = argText(args, 'path', 'file_path', 'filePath');
  const row = (
    actionKey: MessageKey,
    target: string,
    mono = false,
    stats: DiffStats | null = null,
  ): TaskRunToolRow => ({
    actionKey,
    verb: '',
    target,
    mono,
    added: resultStats?.added ?? stats?.added ?? null,
    removed: resultStats?.removed ?? stats?.removed ?? null,
  });

  switch (name) {
    case 'read':
      return row('task.run.action.read', readTarget(path, args));
    case 'write': {
      const content = args['content'];
      const stats =
        mayShowStats && typeof content === 'string'
          ? { added: countLines(content), removed: 0 }
          : null;
      return row('task.run.action.write', path, false, stats);
    }
    case 'edit':
      return row(
        'task.run.action.edit',
        path,
        false,
        mayShowStats ? diffStatsOfEdits(args['edits']) : null,
      );
    case 'ls':
      return row('task.run.action.ls', path.length > 0 ? path : '.');
    case 'find':
      return row('task.run.action.find', argText(args, 'pattern', 'query') || path);
    case 'grep':
      return row('task.run.action.grep', argText(args, 'pattern', 'query') || path);
    case 'bash':
    case 'powershell':
      return row('task.run.action.run', argText(args, 'command', 'cmd'), true);
    case 'ask_user':
    case 'ask_question':
      return row('task.run.action.ask', argText(args, 'question', 'text'));
    case 'send_message':
      return row('task.run.action.send', argText(args, 'text', 'message'));
    case 'update_plan':
      return row('task.run.action.plan', argText(args, 'explanation'));
    case 'capability_call':
      return row('task.run.action.call', argText(args, 'name', 'tool', 'toolName'));
    default:
      break;
  }

  if (name.startsWith('browser_')) {
    const actionKey = BROWSER_ACTIONS[name.slice('browser_'.length)] ?? 'task.run.action.open';
    return row(actionKey, toolCallSummary(entry));
  }

  return {
    actionKey: null,
    verb: entry.name,
    target: toolCallSummary(entry) || entry.name,
    mono: false,
    added: resultStats?.added ?? null,
    removed: resultStats?.removed ?? null,
  };
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

/**
 * 展开工具卡时要展示的「原始命令」：shell 工具取完整 command，其余工具回退为
 * 格式化后的参数。不截断——折叠行已经给了摘要。
 */
export function toolCommandText(
  entry: Pick<Extract<TaskRunEntry, { kind: 'tool' }>, 'name' | 'args'>,
): string {
  const args = recordOf(entry.args);
  if (entry.name === 'bash' || entry.name === 'powershell') {
    const command = args['command'] ?? args['cmd'];
    if (typeof command === 'string' && command.trim().length > 0) return command.trim();
  }
  return formatToolArgs(entry.args);
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

/**
 * 任务详情页 metadata 行的「上下文用量」（`tasks.usage`）：大数压成 12.3K / 1.2M。
 * 不依赖 Svelte，便于单测。
 */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  const value = Math.round(tokens);
  if (value < 1_000) return String(value);
  const scaledThousands = value / 1_000;
  if (value < 999_950) {
    return scaledThousands < 100
      ? `${trimTrailingZero(scaledThousands.toFixed(1))}K`
      : `${Math.round(scaledThousands)}K`;
  }
  const scaledMillions = value / 1_000_000;
  return scaledMillions < 100
    ? `${trimTrailingZero(scaledMillions.toFixed(1))}M`
    : `${Math.round(scaledMillions)}M`;
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export interface TaskRunUsageParts {
  /** 当前上下文占用的紧凑 token 数（12.3K）。 */
  tokens: string;
  /** 模型上下文窗口的紧凑数（200K）；未知为 null。 */
  window: string | null;
  /** 上下文占比整数百分比；窗口未知为 null。 */
  percent: number | null;
  /** 加权缓存命中的整数百分比；缺数据为 null。 */
  cacheHitPercent: number | null;
}

/**
 * 任务详情页「上下文用量」的展示数据：没有上下文 token 时整块隐藏（null）。
 * 窗口未知只显示 token 数，没有命中率就不显示命中率——不猜默认窗口。
 */
export function taskRunUsageParts(
  usage:
    | { contextTokens: number | null; contextWindow: number | null; cacheHitRate: number | null }
    | null
    | undefined,
): TaskRunUsageParts | null {
  if (usage === null || usage === undefined) return null;
  if (usage.contextTokens === null || usage.contextTokens === undefined) return null;
  const contextTokens = usage.contextTokens;
  const window =
    usage.contextWindow !== null && usage.contextWindow !== undefined && usage.contextWindow > 0
      ? usage.contextWindow
      : null;
  const rate =
    usage.cacheHitRate !== null && usage.cacheHitRate !== undefined && usage.cacheHitRate >= 0
      ? usage.cacheHitRate
      : null;
  return {
    tokens: formatCompactTokens(contextTokens),
    window: window !== null ? formatCompactTokens(window) : null,
    percent: window !== null ? Math.max(0, Math.round((contextTokens / window) * 100)) : null,
    cacheHitPercent: rate !== null ? Math.max(0, Math.round(rate * 100)) : null,
  };
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

/**
 * 详情页审批条（权限请求）归属的会话：任务的卡片归属会话（§3.7 执行归属
 * 映射——委派任务的审批卡落发起方 A 的私聊，core 在 TaskView.userConversationId
 * 给出；旧数据 / 未接线时回落任务自己的会话）；任务视图还没读到时回退当前
 * 会话——详情页只在本会话内打开（切会话即关闭），两者在打开期间一致。
 */
export function approvalConversationIdOf(
  task:
    | { conversationId: string | null; userConversationId?: string | null }
    | null,
  currentConversationId: string | null | undefined,
): string | null {
  return task?.userConversationId ?? task?.conversationId ?? currentConversationId ?? null;
}

/**
 * 详情页问题条（D75 §2.4.6）：该任务绑定、还没回答的 task_question 提问卡。
 * 提问卡是会话消息（不在 run_steps 里），详情页打开期间对话被 display:none
 * 隐藏，按审批条同一思路把未答的卡固定在时间线下方。core 保证一个任务同时
 * 最多一个未答问题（上一个没答时 ask 直接拒绝），取最新一条即可；已答 /
 * 作废 / 超时的卡带 `content.answer`，不再算待回答。
 */
export function pendingTaskQuestionOf(
  messages: readonly Message[],
  taskId: string,
): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.taskId !== taskId || message.kind !== 'system_event') continue;
    const content = message.content;
    if (!('event' in content) || content.event !== 'task_question') continue;
    if (typeof content.answer === 'string') continue;
    return message;
  }
  return null;
}
