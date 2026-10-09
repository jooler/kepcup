import { redactStepPayload, stripImageBlocks } from '../infra/redact.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { RunHandle } from './types.js';

/**
 * The sensitive flag as the model may send it: pi coerces `"true"` / `1` to
 * a boolean for the tool (TypeBox Value.Convert) while the raw args the
 * tool_call step sees keep the original — both must count as sensitive.
 */
function truthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

/**
 * W1 按工具的参数脱敏表（todo/borrowings-from-personal-agents.md W1 设计 4）：
 * 命中的参数在落盘的 tool_call 步骤里替换为 `«redacted:N chars»`，参数值登记
 * 为本 run 的敏感值，此后落盘的步骤（下一次 request 里模型自己的 tool call
 * 参数与 pi 的参数校验报错回显、工具结果、助手文本）都会抹掉它，已写入的本 run
 * 最近一条助手步骤与此前的 tool_call 步骤也会被改写。只改落盘副本——工具执行
 * 拿到的 params 对象不动。执行时才发现的敏感参数（密码框、被 pi 强转的
 * sensitive）由 tool_result 的 `sensitiveParams` 补报。
 */
const PARAM_REDACTIONS: Record<
  string,
  ReadonlyArray<{ param: string; when: (args: Record<string, unknown>) => boolean }>
> = {
  browser_type: [{ param: 'text', when: (args) => truthyFlag(args['sensitive']) }],
};

/**
 * Registered sensitive values shorter than this are not substring-scrubbed
 * (a 1–3 character value would mangle unrelated text); they are still
 * removed structurally wherever they appear as the sensitive param itself
 * (`"text": "123"` in args objects, JSON argument strings, validation echoes).
 */
export const SENSITIVE_SCRUB_MIN_CHARS = 4;

const MASK = '«redacted»';

/** One registered sensitive param value. */
export interface SensitiveEntry {
  param: string;
  value: string;
}

/**
 * Redacts the sensitive params of one tool call's args (table rules plus
 * `extraParams` reported at execution time). Returns a copy, the redacted
 * string values and their param names; non-object args come back unchanged.
 */
export function redactToolArgs(
  toolName: string,
  args: unknown,
  extraParams: readonly string[] = [],
): { args: unknown; values: string[]; entries: SensitiveEntry[] } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { args, values: [], entries: [] };
  }
  const record = args as Record<string, unknown>;
  const params = new Set(extraParams);
  for (const rule of PARAM_REDACTIONS[toolName] ?? []) {
    if (rule.when(record)) params.add(rule.param);
  }
  const entries: SensitiveEntry[] = [];
  let copy: Record<string, unknown> | null = null;
  for (const param of params) {
    const value = record[param];
    if (typeof value !== 'string') continue;
    copy ??= { ...record };
    copy[param] = `«redacted:${value.length} chars»`;
    if (value.length > 0) entries.push({ param, value });
  }
  return { args: copy ?? args, values: entries.map((e) => e.value), entries };
}

/** Keys that carry identifiers (call/result pairing): never rewritten. */
const IDENTIFIER_KEYS = new Set([
  'id',
  'call_id',
  'tool_call_id',
  'tool_use_id',
  'toolCallId',
  'toolName',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes registered sensitive values from a payload:
 * - structurally, at any length: an object field named like the param that
 *   holds the value, and `"param": "value"` inside JSON text (provider
 *   tool-call `arguments` strings, pi's "Received arguments:" validation echo),
 *   also one escaping level deeper;
 * - as a substring (raw and JSON-escaped) for values of 4+ characters.
 * Identifier fields (call ids, tool names) are left alone.
 */
export function scrubSensitiveValues(
  payload: unknown,
  entries: Iterable<SensitiveEntry | string>,
): unknown {
  const fields = new Map<string, Set<string>>();
  const patterns: Array<{ re: RegExp; replacement: string }> = [];
  const needles = new Set<string>();
  for (const raw of entries) {
    const entry = typeof raw === 'string' ? { param: '', value: raw } : raw;
    if (entry.value.length === 0) continue;
    if (entry.param.length > 0) {
      let values = fields.get(entry.param);
      if (values === undefined) fields.set(entry.param, (values = new Set()));
      values.add(entry.value);
      const quoted = JSON.stringify(entry.value);
      const key = JSON.stringify(entry.param);
      patterns.push({
        re: new RegExp(`${escapeRegExp(key)}\\s*:\\s*${escapeRegExp(quoted)}`, 'g'),
        replacement: `${key}: "${MASK}"`,
      });
      const quotedEsc = JSON.stringify(quoted).slice(1, -1);
      const keyEsc = JSON.stringify(key).slice(1, -1);
      patterns.push({
        re: new RegExp(`${escapeRegExp(keyEsc)}\\s*:\\s*${escapeRegExp(quotedEsc)}`, 'g'),
        replacement: `${keyEsc}: \\"${MASK}\\"`,
      });
    }
    if (entry.value.length >= SENSITIVE_SCRUB_MIN_CHARS) {
      needles.add(entry.value);
      const escaped = JSON.stringify(entry.value).slice(1, -1);
      if (escaped !== entry.value) needles.add(escaped);
    }
  }
  if (fields.size === 0 && needles.size === 0) return payload;
  // Longest first: an escaped form may contain the raw one.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  const scrubText = (node: string): string => {
    let text = node;
    for (const { re, replacement } of patterns) text = text.replace(re, replacement);
    for (const needle of ordered) {
      if (text.includes(needle)) text = text.split(needle).join(MASK);
    }
    return text;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubText(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (IDENTIFIER_KEYS.has(key)) out[key] = value;
        else if (typeof value === 'string' && fields.get(key)?.has(value) === true) out[key] = MASK;
        else out[key] = walk(value);
      }
      return out;
    }
    return node;
  };
  return walk(payload);
}

/** tool_call steps kept in memory for re-scrubbing (bounded). */
const RESCRUB_STEPS_MAX = 50;
const RESCRUB_PAYLOAD_MAX_CHARS = 64 * 1024;

/**
 * 引擎事件 → run_steps 落库（「模型看到的一切都在日志里」，
 * docs/dev/03-data-model.md）。response loop（orchestrator）与 subagent 子
 * run（D66）共用同一条路径；差别只在是否把进度转发给 UI。
 */
export function persistEngineSteps(input: {
  runs: RunsService;
  secrets: SecretsService;
  runId: string;
  handle: RunHandle;
  /** Progress forwarding (run.progress events); omitted for quiet sub runs. */
  onProgress?: (progress: { toolName?: string; text?: string }) => void;
}): () => void {
  const { runs, secrets, runId, handle, onProgress } = input;
  // W1: this run's sensitive values, the tool_call steps still waiting for
  // their result (late redaction), and recently written steps that a newly
  // registered value must be scrubbed from (the assistant message that issued
  // the call is written before the call itself).
  const sensitive = new Map<string, SensitiveEntry>();
  const pendingCalls = new Map<string, { stepId: string; event: Record<string, unknown> }>();
  const rescrubbable = new Map<string, Record<string, unknown>>();
  let lastAssistant: { id: string; payload: unknown } | null = null;

  const scrub = <T>(payload: T): T =>
    sensitive.size === 0 ? payload : (scrubSensitiveValues(payload, sensitive.values()) as T);
  const redactText = (text: string): string => scrub(secrets.redact(text));
  const redactJson = <T>(payload: T): T =>
    redactStepPayload((text) => secrets.redact(text), payload) as T;
  /** tool_call payload: only args / title are scrubbed, never identifiers. */
  const scrubCall = (payload: Record<string, unknown>): Record<string, unknown> => ({
    ...payload,
    args: scrub(payload['args']),
    ...(typeof payload['title'] === 'string' ? { title: scrub(payload['title']) } : {}),
  });
  const keepCall = (stepId: string, payload: Record<string, unknown>): void => {
    if (JSON.stringify(payload).length > RESCRUB_PAYLOAD_MAX_CHARS) return;
    rescrubbable.set(stepId, payload);
    if (rescrubbable.size > RESCRUB_STEPS_MAX) {
      const oldest = rescrubbable.keys().next().value;
      if (oldest !== undefined) rescrubbable.delete(oldest);
    }
  };
  /** Registers values; when new ones arrive, rewrites already-written steps. */
  const register = (entries: readonly SensitiveEntry[]): void => {
    let added = false;
    for (const entry of entries) {
      const key = `${entry.param}\u0000${entry.value}`;
      if (sensitive.has(key)) continue;
      sensitive.set(key, entry);
      added = true;
    }
    if (!added) return;
    for (const [stepId, payload] of rescrubbable) {
      const next = scrubCall(payload);
      if (JSON.stringify(next) === JSON.stringify(payload)) continue;
      runs.replaceStepPayload(stepId, next);
      rescrubbable.set(stepId, next);
    }
    if (lastAssistant !== null) {
      const next = scrub(lastAssistant.payload);
      if (JSON.stringify(next) !== JSON.stringify(lastAssistant.payload)) {
        runs.replaceStepPayload(lastAssistant.id, next);
        lastAssistant = { id: lastAssistant.id, payload: next };
      }
    }
  };

  return handle.onEvent((event) => {
    switch (event.type) {
      case 'request':
        runs.appendStep({
          runId,
          type: 'request',
          payload: scrub(redactJson(stripImageBlocks(event.payload))),
        });
        return;
      case 'assistant': {
        const payload = scrub(event.payload);
        const step = runs.appendStep({ runId, type: 'assistant', payload });
        lastAssistant = { id: step.id, payload };
        return;
      }
      case 'tool_call': {
        const redacted = redactToolArgs(event.payload.toolName, event.payload.args);
        register(redacted.entries);
        const payload = scrubCall(
          redactJson({ ...event.payload, args: redacted.args }) as Record<string, unknown>,
        );
        const step = runs.appendStep({ runId, type: 'tool_call', payload });
        keepCall(step.id, payload);
        pendingCalls.set(event.payload.toolCallId, {
          stepId: step.id,
          event: event.payload as unknown as Record<string, unknown>,
        });
        if (onProgress !== undefined && event.payload.toolName.length > 0) {
          // External agents' human-readable title wins on the status line (D72 P5).
          // Agent titles are free text (often the command itself): redacted
          // like the persisted payload (P5 审查 #8).
          const title = event.payload.title;
          onProgress({
            toolName: event.payload.toolName,
            ...(title !== undefined && title.length > 0 ? { text: redactText(title) } : {}),
          });
        }
        return;
      }
      case 'tool_result': {
        const call = pendingCalls.get(event.payload.toolCallId);
        pendingCalls.delete(event.payload.toolCallId);
        const late = event.payload.sensitiveParams ?? [];
        if (call !== undefined && late.length > 0) {
          // Found sensitive only while executing (browser_type into a password
          // field, or a coerced flag): rewrite the already-persisted tool_call.
          const redacted = redactToolArgs(event.payload.toolName, call.event['args'], late);
          register(redacted.entries);
          const payload = scrubCall(
            redactJson({ ...call.event, args: redacted.args }) as Record<string, unknown>,
          );
          runs.replaceStepPayload(call.stepId, payload);
          if (rescrubbable.has(call.stepId)) rescrubbable.set(call.stepId, payload);
        }
        runs.appendStep({
          runId,
          type: 'tool_result',
          payload: {
            ...event.payload,
            content: redactText(String(event.payload.content)),
          },
        });
        return;
      }
      case 'progress': {
        // Progress text can quote agent titles / tool output: redacted (审查 #8).
        const text = redactText(String(event.payload.text));
        runs.appendStep({ runId, type: 'progress', payload: { ...event.payload, text } });
        if (onProgress !== undefined && text.length > 0) onProgress({ text });
        return;
      }
      case 'steer':
        runs.appendStep({ runId, type: 'steer', payload: event.payload });
        return;
    }
  });
}
