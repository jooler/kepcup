/**
 * Hand-written payload validation (todo/ai-content-reporting.md §7.4 step 5).
 *
 * No schema library and nothing executes: shape / enum / length / control-character
 * checks only, returning short English issues that never echo the offending value.
 * The numeric limits are kept in sync with packages/shared/src/domain/report.ts
 * (REPORT_* constants, §5.3); core truncates before sending, so a violation here
 * means a broken or hostile client. Worker never imports @kepcup/shared (independent
 * deployment unit) — contract tests with the shared fixture pin the two together.
 */

// --- 与 packages/shared/src/domain/report.ts 同步的上限数值 --------------------

const MESSAGE_TEXT_MAX_BYTES = 32 * 1024; // REPORT_MESSAGE_TEXT_MAX_BYTES
const MESSAGE_CONTENT_MAX_BYTES = 16 * 1024; // REPORT_MESSAGE_CONTENT_MAX_BYTES
const REPLY_TO_TEXT_MAX_BYTES = 2 * 1024; // REPORT_REPLY_TO_TEXT_MAX_BYTES
const CONTEXT_ITEM_MAX_BYTES = 2 * 1024; // REPORT_CONTEXT_ITEM_MAX_BYTES
const CONTEXT_MAX_ITEMS = 4; // REPORT_CONTEXT_MAX_ITEMS
const BOT_PROFILE_MAX_BYTES = 8 * 1024; // REPORT_BOT_PROFILE_MAX_BYTES
const ATTACHMENTS_MAX = 20; // REPORT_ATTACHMENTS_MAX
/** usage / tools / providers 数组上限（§7.4 第 5 步）。 */
const USAGE_MAX_ITEMS = 16;
const TOOLS_MAX_ITEMS = 32;
const PROVIDERS_MAX_ITEMS = 16;

// --- 枚举（与 shared 的 zod enum 同步） ---------------------------------------

const REASONS = ['inappropriate'] as const;
const MESSAGE_KINDS = ['text', 'card'] as const;
const MESSAGE_STATUSES = ['normal', 'recalled', 'edited'] as const;
const CONVERSATION_TYPES = ['direct', 'project', 'card', 'bot_direct', 'dm'] as const;
const SENDER_TYPES = ['user', 'bot'] as const;
const SOURCE_KINDS = ['local', 'team'] as const;

const REPORT_ID_PATTERN = /^rep_/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
/** C0 control characters except \n (0x0A) and \t (0x09), plus DEL (0x7F) — the exact rule of core's stripControlChars (§5.3). */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Hard cap on object nesting; real payloads are a handful of levels deep.
 * Same threshold as dedupe.ts canonicalJson — a payload beyond it would throw
 * RangeError in the hash pass, so it is rejected here with a 400 instead. */
const MAX_DEPTH = 64;

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function jsonBytes(value: unknown): number {
  // undefined can only appear on hand-built (non JSON.parse) objects; treat as missing.
  if (value === undefined) return 0;
  return utf8Length(JSON.stringify(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the whole payload; returns short English issues (empty = valid). */
export function validateReportPayload(value: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(value)) {
    return ['payload: must be a JSON object'];
  }
  if (scanControlChars(value, 0)) {
    issues.push('payload: contains forbidden control characters (only \\n and \\t are allowed)');
  }
  if (hasExcessiveDepth(value, 0)) {
    issues.push(`payload: nesting deeper than ${MAX_DEPTH} levels`);
  }

  if (value.schemaVersion !== 1 || typeof value.schemaVersion !== 'number') {
    issues.push('schemaVersion: must be 1');
  }
  const reportId = value.reportId;
  if (typeof reportId !== 'string' || !REPORT_ID_PATTERN.test(reportId) || reportId.length > 64) {
    issues.push('reportId: must start with "rep_" and be at most 64 characters');
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0) {
    issues.push('createdAt: must be a positive number (epoch milliseconds)');
  }
  if (typeof value.reason !== 'string' || !(REASONS as readonly string[]).includes(value.reason)) {
    issues.push(`reason: must be one of ${REASONS.map((r) => `"${r}"`).join(', ')}`);
  }

  checkClient(value.client, issues);
  checkSource(value.source, issues);
  checkConversation(value.conversation, issues);
  checkBot(value.bot, issues);
  checkMessage(value.message, issues);
  checkReplyTo(value.replyTo, issues);
  checkArray(value.context, 'context', CONTEXT_MAX_ITEMS, issues, (item) => {
    if (!isPlainObject(item)) return issues.push('context[]: each item must be an object');
    checkString(item, 'context[].messageId', { min: 1, max: 128 }, issues);
    if (
      typeof item.senderType !== 'string' ||
      !(SENDER_TYPES as readonly string[]).includes(item.senderType)
    ) {
      issues.push('context[].senderType: must be "user" or "bot"');
    }
    checkString(item, 'context[].kind', { max: 64 }, issues);
    checkBytes(item, 'context[].text', { max: CONTEXT_ITEM_MAX_BYTES }, issues);
    checkNumber(item, 'context[].createdAt', { finite: true }, issues);
  });
  checkArray(value.usage, 'usage', USAGE_MAX_ITEMS, issues, (item) => {
    if (!isPlainObject(item)) return issues.push('usage[]: each item must be an object');
    checkString(item, 'usage[].provider', { min: 1, max: 128 }, issues);
    checkString(item, 'usage[].model', { max: 256 }, issues);
    checkString(item, 'usage[].loopType', { max: 64 }, issues);
    checkNumber(item, 'usage[].calls', { min: 0 }, issues);
    checkNumber(item, 'usage[].inputTokens', { min: 0 }, issues);
    checkNumber(item, 'usage[].outputTokens', { min: 0 }, issues);
  });
  checkArray(value.tools, 'tools', TOOLS_MAX_ITEMS, issues, (item) => {
    if (!isPlainObject(item)) return issues.push('tools[]: each item must be an object');
    checkString(item, 'tools[].name', { min: 1, max: 256 }, issues);
    checkNumber(item, 'tools[].calls', { min: 0 }, issues);
  });
  checkArray(value.providers, 'providers', PROVIDERS_MAX_ITEMS, issues, (item) => {
    if (!isPlainObject(item)) return issues.push('providers[]: each item must be an object');
    checkString(item, 'providers[].id', { min: 1, max: 128 }, issues);
    checkString(item, 'providers[].name', { max: 128 }, issues);
    checkString(item, 'providers[].vendor', { max: 128 }, issues);
    checkString(item, 'providers[].api', { max: 128 }, issues);
  });

  const hashes = value.hashes;
  if (!isPlainObject(hashes)) {
    issues.push('hashes: must be an object with "content" and "payload"');
  } else {
    if (typeof hashes.content !== 'string' || !HASH_PATTERN.test(hashes.content)) {
      issues.push('hashes.content: must be 64 lowercase hex characters');
    }
    if (typeof hashes.payload !== 'string' || !HASH_PATTERN.test(hashes.payload)) {
      issues.push('hashes.payload: must be 64 lowercase hex characters');
    }
  }
  return issues;
}

// ------------------------------------------------------------------ sections

function checkClient(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push('client: required object');
    return;
  }
  checkString(value, 'client.id', { min: 1, max: 128 }, issues);
  checkString(value, 'client.surface', { min: 1, max: 32 }, issues);
  checkString(value, 'client.appVersion', { max: 64 }, issues);
  checkString(value, 'client.platform', { max: 64 }, issues);
  checkString(value, 'client.arch', { max: 32 }, issues);
  checkString(value, 'client.osVersion', { max: 128 }, issues);
  checkString(value, 'client.locale', { max: 32 }, issues);
}

function checkSource(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push('source: required object');
    return;
  }
  if (typeof value.kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(value.kind)) {
    issues.push('source.kind: must be "local" or "team"');
    return;
  }
  if (value.kind === 'team') checkString(value, 'source.serverHash', { min: 1, max: 128 }, issues);
}

function checkConversation(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push('conversation: required object');
    return;
  }
  checkString(value, 'conversation.id', { min: 1, max: 128 }, issues);
  if (
    typeof value.type !== 'string' ||
    !(CONVERSATION_TYPES as readonly string[]).includes(value.type)
  ) {
    issues.push('conversation.type: must be one of "direct", "project", "card", "bot_direct", "dm"');
  }
}

function checkBot(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push('bot: required object');
    return;
  }
  checkString(value, 'bot.id', { min: 1, max: 128 }, issues);
  checkString(value, 'bot.name', { max: 256 }, issues);
  if (value.systemRole !== null && typeof value.systemRole !== 'string') {
    issues.push('bot.systemRole: must be a string or null');
  } else if (typeof value.systemRole === 'string' && utf8Length(value.systemRole) > 2048) {
    issues.push('bot.systemRole: exceeds 2048 UTF-8 bytes');
  }
  if (!isPlainObject(value.runtime)) {
    issues.push('bot.runtime: required object');
    return;
  }
  const runtime = value.runtime;
  checkString(runtime, 'bot.runtime.model', { max: 256 }, issues);
  checkString(runtime, 'bot.runtime.lightModel', { max: 256 }, issues);
  checkString(runtime, 'bot.runtime.backgroundModel', { max: 256 }, issues);
  if (!isPlainObject(runtime.agent)) {
    issues.push('bot.runtime.agent: required object');
    return;
  }
  checkString(runtime.agent, 'bot.runtime.agent.id', { max: 128 }, issues);
  checkString(runtime.agent, 'bot.runtime.agent.model', { max: 256 }, issues);
  checkString(runtime.agent, 'bot.runtime.agent.effort', { max: 64 }, issues);
  // profile 是 core 裁剪后的任意 JSON（z.unknown()）；只检查尺寸（8KB，§5.3）。
  if (value.profile !== undefined && jsonBytes(value.profile) > BOT_PROFILE_MAX_BYTES) {
    issues.push(`bot.profile: exceeds ${BOT_PROFILE_MAX_BYTES} UTF-8 bytes as JSON`);
  }
}

function checkMessage(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push('message: required object');
    return;
  }
  checkString(value, 'message.id', { min: 1, max: 128 }, issues);
  if (value.seq !== null && typeof value.seq !== 'number') {
    issues.push('message.seq: must be a number or null');
  }
  if (typeof value.kind !== 'string' || !(MESSAGE_KINDS as readonly string[]).includes(value.kind)) {
    issues.push('message.kind: must be "text" or "card"');
  }
  if (
    typeof value.status !== 'string' ||
    !(MESSAGE_STATUSES as readonly string[]).includes(value.status)
  ) {
    issues.push('message.status: must be one of "normal", "recalled", "edited"');
  }
  checkNumber(value, 'message.createdAt', { finite: true, min: 0 }, issues);
  if (value.editedAt !== null && typeof value.editedAt !== 'number') {
    issues.push('message.editedAt: must be a number or null');
  }
  if (value.runId !== null && typeof value.runId !== 'string') {
    issues.push('message.runId: must be a string or null');
  } else if (typeof value.runId === 'string' && value.runId.length > 128) {
    issues.push('message.runId: must be at most 128 characters');
  }
  checkBytes(value, 'message.text', { max: MESSAGE_TEXT_MAX_BYTES }, issues);
  // content 是卡片原样 JSON（text 消息为 null）；只查尺寸（16KB，§5.3）。
  if (value.content !== null && value.content !== undefined) {
    if (jsonBytes(value.content) > MESSAGE_CONTENT_MAX_BYTES) {
      issues.push(`message.content: exceeds ${MESSAGE_CONTENT_MAX_BYTES} UTF-8 bytes as JSON`);
    }
  }
  if (typeof value.truncated !== 'boolean') {
    issues.push('message.truncated: must be a boolean');
  }
  const hasText = typeof value.text === 'string' && value.text.length > 0;
  const content = value.content;
  const hasContent =
    content !== null && content !== undefined && (typeof content !== 'string' || content.length > 0);
  if (!hasText && !hasContent) {
    issues.push('message: at least one of text or content must be non-empty');
  }
  checkArray(value.attachments, 'attachments', ATTACHMENTS_MAX, issues, (item) => {
    if (!isPlainObject(item)) return issues.push('message.attachments[]: each item must be an object');
    checkString(item, 'message.attachments[].fileName', { min: 1, max: 255 }, issues);
    checkString(item, 'message.attachments[].mime', { min: 1, max: 128 }, issues);
    checkNumber(item, 'message.attachments[].size', { min: 0, integer: false }, issues);
  });
}

function checkReplyTo(value: unknown, issues: string[]): void {
  if (value === null || value === undefined) return;
  if (!isPlainObject(value)) {
    issues.push('replyTo: must be an object or null');
    return;
  }
  checkString(value, 'replyTo.messageId', { min: 1, max: 128 }, issues);
  checkBytes(value, 'replyTo.text', { max: REPLY_TO_TEXT_MAX_BYTES }, issues);
}

// ------------------------------------------------------------------ primitives

function checkString(
  holder: Record<string, unknown>,
  path: string,
  limits: { min?: number; max: number },
  issues: string[],
): void {
  const key = path.slice(path.lastIndexOf('.') + 1);
  const value = holder[key];
  if (typeof value !== 'string') {
    issues.push(`${path}: must be a string`);
    return;
  }
  if (limits.min !== undefined && value.length < limits.min) {
    issues.push(`${path}: must not be empty`);
  }
  if (value.length > limits.max) {
    issues.push(`${path}: must be at most ${limits.max} characters`);
  }
}

function checkBytes(
  holder: Record<string, unknown>,
  path: string,
  limits: { max: number },
  issues: string[],
): void {
  const key = path.slice(path.lastIndexOf('.') + 1);
  const value = holder[key];
  if (typeof value !== 'string') {
    issues.push(`${path}: must be a string`);
    return;
  }
  if (utf8Length(value) > limits.max) {
    issues.push(`${path}: exceeds ${limits.max} UTF-8 bytes`);
  }
}

function checkNumber(
  holder: Record<string, unknown>,
  path: string,
  limits: { min?: number; finite?: boolean; integer?: boolean },
  issues: string[],
): void {
  const key = path.slice(path.lastIndexOf('.') + 1);
  const value = holder[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    issues.push(`${path}: must be a number`);
    return;
  }
  if (limits.finite && !Number.isFinite(value)) issues.push(`${path}: must be finite`);
  if (limits.min !== undefined && value < limits.min) {
    issues.push(`${path}: must be >= ${limits.min}`);
  }
}

function checkArray(
  value: unknown,
  path: string,
  maxItems: number,
  issues: string[],
  checkItem: (item: unknown) => void,
): void {
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array`);
    return;
  }
  if (value.length > maxItems) issues.push(`${path}: must have at most ${maxItems} items`);
  for (const item of value) checkItem(item);
}

/** Recursive walk (depth-capped): true when any string carries a forbidden C0 char. */
function scanControlChars(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false; // nesting issues are reported by hasExcessiveDepth
  if (typeof value === 'string') return CONTROL_CHARS.test(value);
  if (Array.isArray(value)) return value.some((item) => scanControlChars(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => scanControlChars(item, depth + 1));
  }
  return false;
}

/**
 * True when any branch nests beyond MAX_DEPTH (the canonicalJson cap). Checking
 * here turns a hostile deep payload into a clean 400 instead of a RangeError
 * (500) during hash recomputation.
 */
function hasExcessiveDepth(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => hasExcessiveDepth(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => hasExcessiveDepth(item, depth + 1));
  }
  return false;
}
