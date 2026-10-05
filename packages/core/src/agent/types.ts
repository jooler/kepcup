/** "provider/modelId" reference into the model registry. */
export type ModelRef = string;

/** Execution identity carried by every run and tool call (02-architecture.md). */
export type LoopType =
  | 'response'
  | 'triage'
  | 'reflection'
  | 'memory_consolidation'
  | 'profile_curation'
  | 'wiki_maintenance'
  | 'skill_authoring'
  | 'conversation_summary';

export interface RunIdentity {
  runId: string;
  botId: string | null;
  conversationId: string | null;
  loopType: LoopType;
  chainId?: string;
  chainDepth?: number;
}

export type RunStatus = 'completed' | 'failed' | 'cancelled';

export interface EngineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface RunOutcome {
  status: RunStatus;
  /** The model's final text (empty for skip_reply / failures). */
  finalText: string;
  /** Set when skip_reply terminated the run. */
  skipReply: boolean;
  usage: EngineUsage[];
  error?: { code: string; message: string };
}

export type EngineEvent =
  | { type: 'request'; payload: unknown }
  | { type: 'assistant'; payload: unknown }
  | { type: 'tool_call'; payload: { toolCallId: string; toolName: string; args: unknown } }
  | {
      type: 'tool_result';
      payload: { toolCallId: string; toolName: string; ok: boolean; content: string };
    }
  | { type: 'progress'; payload: { text: string } }
  | { type: 'steer'; payload: { text: string } };

export interface EngineMessage {
  role: 'user';
  content: string;
  timestamp: number;
  /**
   * 触发批携带的图片附件（docs/design/20-conversation-media.md）：引擎在模型
   * 支持图像输入（model.input 含 'image'）时转成 image 内容块；不支持时丢弃
   * 字节、在文本后追加提示。与 ToolResult.images 同一判定，字节不持久化。
   */
  images?: Array<{ mimeType: string; base64: string }>;
}

export interface RunSpec {
  identity: RunIdentity;
  model: ModelRef;
  buildSystemPrompt: () => Promise<string>;
  messages: EngineMessage[];
  tools: ToolDefinition[];
  limits: { maxTurns: number };
  // Cancellation goes through RunHandle.abort() (pi's agent.abort); a spec
  // signal would be dead wiring — the engine never polls it.
}

export interface ToolContext {
  identity: RunIdentity;
  signal: AbortSignal;
  /** Sent by skip_reply; ends the run without a final message. */
  terminate(reason?: string): void;
  progress(text: string): void;
}

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model (already truncated + redacted). */
  content: string;
  /**
   * Optional images (P11 browser_screenshot): the engine includes them in the
   * tool result only when the run's model accepts image input, and never
   * persists them (run steps keep the text content only).
   */
  images?: Array<{ mimeType: string; base64: string }>;
  errorCode?: string;
  terminate?: boolean;
}

export interface ToolDefinition<P = unknown> {
  name: string;
  description: string;
  /** TypeBox schema (pi's parameter format). */
  parameters: unknown;
  execute(params: P, ctx: ToolContext): Promise<ToolResult>;
}

export interface RunHandle {
  /**
   * Queues the text for the running loop. Returns false when the loop has
   * already ended (the queue would never be consumed) — the caller must then
   * treat the batch as arriving at a finished run (buffer → new run).
   */
  steer(text: string): boolean;
  abort(reason: string): void;
  onEvent(listener: (e: EngineEvent) => void): () => void;
  /** Input+output tokens spent so far in this run (chain budget, P05). */
  tokensSoFar(): number;
  done: Promise<RunOutcome>;
}

export interface AgentEngine {
  startRun(spec: RunSpec): RunHandle;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface CompletionRequest {
  identity: RunIdentity;
  model: ModelRef;
  systemPrompt: string;
  messages: EngineMessage[];
  /** Tools offered to the model; complete() never executes them. */
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionToolCall {
  name: string;
  arguments: unknown;
}

export interface CompletionResult {
  text: string;
  /** Tool calls returned by the model (not executed by complete()). */
  toolCalls: CompletionToolCall[];
  usage: EngineUsage | null;
  stopReason: string;
}
