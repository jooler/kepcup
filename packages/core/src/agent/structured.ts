import type { Tool } from '@earendil-works/pi-ai';
import type { ZodType } from 'zod';
import { parseAgentModelRef } from '@kepcup/shared';
import type { CompletionRequest, CompletionToolCall, EngineMessage, RunIdentity } from './types.js';

export class StructuredParseError extends Error {}

const SUBMIT_TOOL = 'submit';

export interface CompleteStructuredInput<T> {
  complete(req: CompletionRequest): Promise<{
    text: string;
    toolCalls: CompletionToolCall[];
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number | null;
    } | null;
  }>;
  identity: RunIdentity;
  model: string;
  systemPrompt: string;
  messages: EngineMessage[];
  /** TypeBox schema: becomes the `submit` tool's parameters. */
  parametersSchema: unknown;
  /** Parallel zod schema used for validation. */
  schema: ZodType<T>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Receives usage from every attempt (billing counts each call). */
  onUsage?: (
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number | null;
    } | null,
  ) => void;
}

/**
 * 外部智能体的「只输出 JSON」约定（D72 P6，design 28 §8）：一次性精简会话里
 * 没有可调用的 submit 工具，输出 Schema 写进系统提示词，结果走文本 JSON 回退。
 */
export function jsonOnlyInstruction(parametersSchema: unknown): string {
  return [
    '<output_format>',
    '只输出一个 JSON 对象，不要任何其他文字（不要 Markdown 代码块、不要解释），也不要调用任何工具。',
    '上文若提到 submit 工具：它在这里不可用——把本应提交给它的参数直接作为这个 JSON 对象输出。',
    'JSON 必须符合以下 JSON Schema：',
    JSON.stringify(parametersSchema),
    '</output_format>',
  ].join('\n');
}

/**
 * Single-shot structured call (docs/dev/04-agent-runtime.md "结构化输出"):
 * 1. one `submit` tool whose parameters are the output schema;
 * 2. JSON parsed from the text when the model does not call the tool;
 * 3. zod validation; failures are fed back to the model for one retry.
 *
 * External agents (`agent:{id}/…` refs, D72 P6) get no tool: the schema goes
 * into the system prompt as a JSON-only instruction, the text JSON fallback
 * parses the answer and the retry asks for JSON only.
 */
export async function completeStructured<T>(input: CompleteStructuredInput<T>): Promise<T> {
  const jsonOnly = parseAgentModelRef(input.model) !== null;
  const submit = {
    name: SUBMIT_TOOL,
    description: '提交结构化结果；必须调用本工具提交。',
    parameters: input.parametersSchema,
  } as Tool;
  const systemPrompt = jsonOnly
    ? `${input.systemPrompt}\n\n${jsonOnlyInstruction(input.parametersSchema)}`
    : input.systemPrompt;

  const attempt = async (messages: EngineMessage[]): Promise<T> => {
    const result = await input.complete({
      identity: input.identity,
      model: input.model,
      systemPrompt,
      messages,
      ...(jsonOnly ? {} : { tools: [submit] }),
      maxTokens: input.maxTokens,
      signal: input.signal,
    });
    input.onUsage?.(result.usage ?? null);
    const submitted = result.toolCalls.find((c) => c.name === SUBMIT_TOOL);
    if (submitted) return validate(submitted.arguments, input.schema);
    return validateWithJsonFallback(result.text, input.schema, jsonOnly);
  };

  try {
    return await attempt(input.messages);
  } catch (error) {
    const reason = error instanceof StructuredParseError ? error.message : '调用失败';
    const feedback = jsonOnly
      ? `你上一次的输出无法通过校验：${reason}。请重新输出：只输出 JSON——一个符合 Schema 的 JSON 对象，不要任何其他文字。`
      : `你上一次的输出无法通过校验：${reason}。请再次输出，直接调用 submit 工具提交结果。`;
    return attempt([...input.messages, { role: 'user', content: feedback, timestamp: Date.now() }]);
  }
}

function validate<T>(value: unknown, schema: ZodType<T>): T {
  const check = schema.safeParse(value);
  if (!check.success) {
    throw new StructuredParseError(
      check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return check.data;
}

function validateWithJsonFallback<T>(text: string, schema: ZodType<T>, jsonOnly = false): T {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const braced = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (braced >= 0 && lastBrace > braced) candidates.push(text.slice(braced, lastBrace + 1));
  let lastError: StructuredParseError | null = null;
  for (const candidate of candidates) {
    try {
      return validate(JSON.parse(candidate), schema);
    } catch (error) {
      if (error instanceof StructuredParseError) lastError = error;
    }
  }
  throw (
    lastError ??
    new StructuredParseError(
      jsonOnly ? '输出中没有可解析的 JSON' : '模型没有调用 submit 且输出中没有可解析的 JSON',
    )
  );
}
