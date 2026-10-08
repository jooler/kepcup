import {
  RECENT_MESSAGES_MAX,
  RECENT_MESSAGES_TOKEN_BUDGET,
  TASK_EVENT_CONTEXT_MAX_CHARS,
  TASK_TRIGGER_RESULT_MAX_CHARS,
  type Message,
  type RunStatus,
  type TaskEventContent,
  type TaskEventPhase,
} from '@kepcup/shared';
import { estimateTokens } from '../tokens.js';
import type { TriggerBatch } from '../../scheduler/mailbox.js';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Formats a UTC-ms timestamp in the given time zone: 2026-09-29 16:08. */
export function formatTime(ms: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${pad(Number(get('hour')))}:${get('minute')}`;
}

export interface RenderMessageOptions {
  /** The bot whose loop is being built; its own lines get "（你）". */
  selfBotId: string | null;
  timeZone: string;
  /** Bot names by id; deleted/unknown bots render as their id. */
  botNames: Map<string, string>;
  /**
   * Card messages (P03): renders the folded one-line record from the
   * approval state. Return null to fall back to a placeholder.
   */
  renderCard?: (message: Message) => string | null;
}

/**
 * How task-related lines (task_event rows, origin 'task' progress) are cut
 * (D75 design 30 §2.4.4); other lines are never cut:
 * - 'context': recent window, deltas, triage — TASK_EVENT_CONTEXT_MAX_CHARS,
 *   full text via get_messages_around;
 * - 'trigger': the entry that woke the turn — in full up to
 *   TASK_TRIGGER_RESULT_MAX_CHARS (a longer result points to
 *   forward_task_result);
 * - 'full': message tools (search_messages / get_messages_around).
 */
export type TaskLineMode = 'context' | 'trigger' | 'full';

const TASK_PHASE_LABELS: Record<TaskEventPhase, string> = {
  brief: '交代',
  inject: '追加',
  cancel: '取消',
  question: '提问',
  result: '结果',
  failure: '失败',
};

const TASK_OUTGOING_PHASES: ReadonlySet<TaskEventPhase> = new Set(['brief', 'inject', 'cancel']);

const TASK_STATUS_LABELS: Partial<Record<RunStatus, string>> = {
  failed: '失败',
  cancelled: '已取消',
  interrupted: '中断',
};

function taskEventBody(content: TaskEventContent): string {
  switch (content.phase) {
    case 'brief':
      return content.title !== undefined && content.title.length > 0
        ? `${content.title}：${content.text}`
        : content.text;
    case 'inject':
      // W4 / §8.2: an inject the task could not take is recorded as queued.
      return content.delivery === 'queued'
        ? `${content.text}（未送达：任务没能接收这条追加指令）`
        : content.text;
    case 'result':
      return content.text.length > 0 ? content.text : '（任务结束，没有结果内容）';
    case 'failure': {
      const status =
        content.status !== undefined
          ? (TASK_STATUS_LABELS[content.status] ?? content.status)
          : '失败';
      const head = `状态：${status}${content.error ? `；错误：${content.error}` : ''}`;
      return content.text.length > 0 ? `${head}。${content.text}` : head;
    }
    default:
      return content.text;
  }
}

function clipTaskBody(
  body: string,
  message: Message,
  mode: TaskLineMode,
  phase: TaskEventPhase | null,
): string {
  if (mode === 'full') return body;
  const max = mode === 'context' ? TASK_EVENT_CONTEXT_MAX_CHARS : TASK_TRIGGER_RESULT_MAX_CHARS;
  if (body.length <= max) return body;
  const hint =
    mode === 'trigger' && phase === 'result'
      ? `（结果过长，以上是前 ${max} 字，共 ${body.length} 字；要把原文发给用户请用 forward_task_result）`
      : `（已截断，共 ${body.length} 字；全文用 get_messages_around 查看 ${message.id}）`;
  return `${body.slice(0, max)}…${hint}`;
}

/** Renders one message line: [msg_... | time | sender] body. */
export function renderMessageLine(
  message: Message,
  options: RenderMessageOptions,
  taskLines: TaskLineMode = 'context',
): string {
  const time = formatTime(message.createdAt, options.timeZone);
  if (message.kind === 'task_event') {
    // D75 §2.4.4: the viewer's private round-trip with one of its tasks (only
    // the owner bot ever reads these rows).
    const content = message.content as TaskEventContent;
    const label = TASK_PHASE_LABELS[content.phase] ?? content.phase;
    const direction = TASK_OUTGOING_PHASES.has(content.phase)
      ? `你→任务 ${content.taskId}（${label}）`
      : `任务 ${content.taskId}→你（${label}）`;
    const body = clipTaskBody(taskEventBody(content), message, taskLines, content.phase);
    return `[${message.id} | ${time} | ${direction}] ${body}`;
  }
  if (message.kind === 'card') {
    const rendered = options.renderCard?.(message) ?? null;
    const body = rendered ?? '（卡片消息）';
    return `[${message.id} | ${time} | 系统] ${body}`;
  }
  let sender: string;
  switch (message.senderType) {
    case 'user': {
      // D71：委派代发消息——另一个 Bot 代用户转交的任务。
      const content = message.content as { origin?: string; delegatedBy?: string };
      if (content.origin === 'delegation') {
        const by = content.delegatedBy ?? '';
        sender = `用户（由 ${options.botNames.get(by) ?? (by || '其他 Bot')} 代为转交）`;
      } else {
        sender = '用户';
      }
      break;
    }
    case 'system':
      sender = '系统';
      break;
    case 'bot': {
      const botId = message.senderBotId ?? '';
      const isSelf = options.selfBotId !== null && botId === options.selfBotId;
      // D75 §2.4.4: a task's visible progress carries its task id.
      const content = message.content as { origin?: string; taskId?: string };
      if (content.origin === 'task') {
        const task = `（任务 ${content.taskId ?? ''}）`;
        sender = isSelf ? `你${task}` : `${options.botNames.get(botId) ?? botId}${task}`;
      } else {
        sender = `${options.botNames.get(botId) ?? botId}${isSelf ? '（你）' : ''}`;
      }
      break;
    }
  }
  const content = message.content;
  const rawBody = content && 'text' in content ? content.text : '';
  const body =
    (content as { origin?: string } | undefined)?.origin === 'task'
      ? clipTaskBody(rawBody, message, taskLines, null)
      : rawBody;
  const statusSuffix = message.status === 'edited' ? '（已编辑）' : '';
  const attachmentSuffix =
    message.attachments.length > 0
      ? `（附件：${message.attachments
          // mime 帮助模型匹配文件识别技能（docs/design/22-file-skill-routing.md）。
          .map(
            (a) => `${a.id} ${a.fileName} [${a.mime}] ${Math.max(1, Math.round(a.size / 1024))}KB`,
          )
          .join('、')}）`
      : '';
  // Other bots' words are data, not instructions (docs/dev/04-agent-runtime.md).
  const wrapped =
    message.senderType === 'bot' &&
    options.selfBotId !== null &&
    message.senderBotId !== options.selfBotId
      ? `<untrusted>${body}</untrusted>`
      : body;
  return `[${message.id} | ${time} | ${sender}]${statusSuffix} ${wrapped}${attachmentSuffix}`;
}

/**
 * The <conversation_context> segment: rolling summary plus the recent-message
 * window (newest-first selection, rendered oldest-first), excluding the
 * trigger batch and recalled messages.
 */
export function buildConversationContext(input: {
  summary: string | null;
  recent: Message[];
  options: RenderMessageOptions;
}): string {
  const parts: string[] = [];
  if (input.summary && input.summary.trim().length > 0) {
    parts.push(`<summary>\n${input.summary.trim()}\n</summary>`);
  }
  // Walk backwards from the newest message, respecting both limits.
  const selected: string[] = [];
  let tokens = 0;
  for (let i = input.recent.length - 1; i >= 0; i -= 1) {
    const message = input.recent[i];
    if (!message || message.status === 'recalled') continue;
    const line = renderMessageLine(message, input.options, 'context');
    const cost = estimateTokens(line);
    if (selected.length >= RECENT_MESSAGES_MAX || tokens + cost > RECENT_MESSAGES_TOKEN_BUDGET) {
      break;
    }
    selected.unshift(line);
    tokens += cost;
  }
  parts.push(`<recent_messages>\n${selected.join('\n')}\n</recent_messages>`);
  return `<conversation_context>\n${parts.join('\n')}\n</conversation_context>`;
}

/**
 * External-agent session reuse (D72 P5, design 28 §7): the messages of the
 * conversation the reused agent session has not seen (after its last run,
 * excluding its own replies and the trigger batch). Empty → ''.
 */
export function buildConversationDelta(messages: Message[], options: RenderMessageOptions): string {
  const lines = messages
    .filter((message) => message.status !== 'recalled')
    .map((message) => renderMessageLine(message, options, 'context'));
  if (lines.length === 0) return '';
  return `<conversation_delta>\n（你上次回复之后对话里的新消息）\n${lines.join('\n')}\n</conversation_delta>`;
}

export interface TriggerSegmentInput {
  reason: TriggerBatch['reason'];
  messages: Message[];
  options: RenderMessageOptions;
  extraAttributes?: Record<string, string | number>;
}

/** The <trigger> segment with the triggering batch. */
export function buildTriggerSegment(input: TriggerSegmentInput): string {
  const attrs = Object.entries(input.extraAttributes ?? {})
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('');
  // A triggering task result goes in full (up to the hard cap): the turn
  // relays it and must not work from a truncated copy (D75 §2.4.4).
  const lines = input.messages
    .filter((m) => m.status !== 'recalled')
    .map((m) => renderMessageLine(m, input.options, 'trigger'));
  return `<trigger reason="${input.reason}"${attrs}>\n${lines.join('\n')}\n</trigger>`;
}

/** The injection (steer) message for a batch delivered mid-run. */
export function buildNewMessagesInjection(
  messages: Message[],
  options: RenderMessageOptions,
): string {
  const lines = messages
    .filter((m) => m.status !== 'recalled')
    .map((m) => renderMessageLine(m, options, 'trigger'));
  return [
    '<new_messages>',
    ...lines,
    '</new_messages>',
    '你工作期间收到了新消息。判断是否需要调整当前的工作：需要就调整，不需要就继续。',
  ].join('\n');
}

/** Edit notifications injected into a running loop. */
export function buildMessageEventInjection(input: {
  type: 'edited';
  messageId: string;
  newText?: string | undefined;
}): string {
  return `<message_event type="edited" message_id="${input.messageId}"/>\n用户编辑了这条消息，新内容：${input.newText ?? ''}`;
}
