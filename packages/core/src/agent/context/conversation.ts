import {
  RECENT_MESSAGES_MAX,
  RECENT_MESSAGES_TOKEN_BUDGET,
  type Message,
} from '@kepcup/shared';
import { estimateTokens } from '../tokens.js';

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

/** Renders one message line: [msg_... | time | sender] body. */
export function renderMessageLine(message: Message, options: RenderMessageOptions): string {
  const time = formatTime(message.createdAt, options.timeZone);
  if (message.kind === 'card') {
    const rendered = options.renderCard?.(message) ?? null;
    const body = rendered ?? '（卡片消息）';
    return `[${message.id} | ${time} | 系统] ${body}`;
  }
  let sender: string;
  switch (message.senderType) {
    case 'user':
      sender = '用户';
      break;
    case 'system':
      sender = '系统';
      break;
    case 'bot': {
      const botId = message.senderBotId ?? '';
      const isSelf = options.selfBotId !== null && botId === options.selfBotId;
      sender = `${options.botNames.get(botId) ?? botId}${isSelf ? '（你）' : ''}`;
      break;
    }
  }
  const content = message.content;
  const body = content && 'text' in content ? content.text : '';
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
    const line = renderMessageLine(message, input.options);
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

export interface TriggerSegmentInput {
  reason: 'direct' | 'mention' | 'broadcast' | 'reply' | 'chain' | 'scheduled' | 'event';
  messages: Message[];
  options: RenderMessageOptions;
  extraAttributes?: Record<string, string | number>;
}

/** The <trigger> segment with the triggering batch. */
export function buildTriggerSegment(input: TriggerSegmentInput): string {
  const attrs = Object.entries(input.extraAttributes ?? {})
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('');
  const lines = input.messages
    .filter((m) => m.status !== 'recalled')
    .map((m) => renderMessageLine(m, input.options));
  return `<trigger reason="${input.reason}"${attrs}>\n${lines.join('\n')}\n</trigger>`;
}

/** The injection (steer) message for a batch delivered mid-run. */
export function buildNewMessagesInjection(
  messages: Message[],
  options: RenderMessageOptions,
): string {
  const lines = messages
    .filter((m) => m.status !== 'recalled')
    .map((m) => renderMessageLine(m, options));
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
