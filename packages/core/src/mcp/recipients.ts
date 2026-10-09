import { normalizeToolName } from './risk.js';

/**
 * W4 精确卡片（todo/borrowings-from-personal-agents.md W4 设计 5）：写入 /
 * 破坏性 MCP 工具的审批卡把参数里的「收件方」类字段**完整**列出，不随
 * argsSummary 的 400 字截断丢掉——发给谁是用户批准「发送」时最要看清的部分。
 *
 * 键名归一化（camelCase / kebab → snake）后与下表比对；嵌套对象里的同名键
 * 也算（键路径写成 `message.to`）；值只取字符串 / 数字及其数组（数组整体列为
 * 一项，逗号分隔），对象值不列、继续向里找。值经调用方给的 `redact` 脱敏。
 */

/** Recipient-like argument keys (normalized). */
const RECIPIENT_KEYS: ReadonlySet<string> = new Set([
  'to',
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'channel',
  'channels',
  'channel_id',
  'email',
  'emails',
  'phone',
  'phone_number',
  'user',
  'users',
  'user_id',
  'chat_id',
]);

/** Nesting depth searched below the top-level args object. */
const MAX_DEPTH = 3;
/** Safety bound per value (a value this long is not a recipient list anyone reads). */
export const RECIPIENT_VALUE_MAX_CHARS = 10_000;
/** At most this many recipient fields on one card. */
const MAX_FIELDS = 20;

export interface RecipientField {
  /** Argument path, e.g. `to` or `message.cc`. */
  key: string;
  value: string;
}

export function isRecipientKey(key: string): boolean {
  return RECIPIENT_KEYS.has(normalizeToolName(key));
}

/**
 * A recipient value as text: strings, finite numbers (numeric chat / user
 * ids) and arrays of those (W4 复查: nested objects are not recipient values —
 * the walk looks inside them instead). Anything else → null.
 */
function valueText(value: unknown): string | null {
  const scalar = (item: unknown): string | null =>
    typeof item === 'string'
      ? item
      : typeof item === 'number' && Number.isFinite(item)
        ? String(item)
        : null;
  if (Array.isArray(value)) {
    const parts = value.map(scalar);
    return parts.every((part): part is string => part !== null) ? parts.join(', ') : null;
  }
  return scalar(value);
}

/**
 * The recipient-like fields of a tool call's args, in key order, each value
 * passed through `redact` (stored secrets) and bounded by
 * RECIPIENT_VALUE_MAX_CHARS. Empty when there are none.
 */
export function recipientFields(
  args: Record<string, unknown>,
  redact: (text: string) => string,
): RecipientField[] {
  const out: RecipientField[] = [];
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (out.length >= MAX_FIELDS) return;
      const path = prefix.length > 0 ? `${prefix}.${key}` : key;
      if (isRecipientKey(key)) {
        const text = valueText(child);
        if (text !== null && text.length > 0) {
          const redacted = redact(text);
          out.push({
            key: path,
            value:
              redacted.length > RECIPIENT_VALUE_MAX_CHARS
                ? `${redacted.slice(0, RECIPIENT_VALUE_MAX_CHARS)}…（共 ${redacted.length} 字，已截断）`
                : redacted,
          });
          continue;
        }
      }
      if (depth < MAX_DEPTH) visit(child, path, depth + 1);
    }
  };
  visit(args, '', 0);
  return out;
}
