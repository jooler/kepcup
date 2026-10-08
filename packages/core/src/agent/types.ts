import type { AgentPermissionTier } from '@kepcup/shared';

/**
 * "provider/modelId" reference into the model registry; external agents use
 * the pseudo ref `agent:{id}/{model|default}` (D72).
 */
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
  | 'conversation_summary'
  /** 宿主 SubAgent（D66）：delegate_task 委派的嵌套子 run，不产生对话消息。 */
  | 'subagent'
  /** D75 对话轮（只读，执行期由工具网关硬拒写）；'response' 由 W2 改名后移除。 */
  | 'turn'
  /** D75 任务（task_writes=false 时只读）。 */
  | 'task';

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
  | {
      type: 'tool_call';
      payload: {
        toolCallId: string;
        toolName: string;
        args: unknown;
        /**
         * Human-readable title (external agents' `tool_call.title`, D72 P5):
         * the status line shows it instead of the tool name.
         */
        title?: string;
      };
    }
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
  //
  // —— 以下为外部智能体引擎（D72，docs/design/28-external-agents-acp.md）的
  // 可选字段；PiEngine 一律忽略。——
  /** Agent 会话的工作目录（`session/new.cwd`）：绑定的 project，否则 workspace。 */
  workdir?: string;
  /**
   * 分层提示词（§5）：会话级（相对静态，按 Provider 的 instructionMode 下发）、
   * run 级动态段、对话段（首个 prompt 为完整上下文 + 触发段；会话复用时为
   * 增量）。缺省时引擎以 buildSystemPrompt() + messages 组装。
   */
  promptParts?: {
    session: string;
    run: string;
    conversation: string;
    /**
     * P5 会话复用：Agent 会话已有前文时用的对话段——上次 run 之后的增量消息
     * + 触发段（不含 D56 回放）。引擎实际复用 / 恢复了会话才用它，否则用
     * `conversation`。
     */
    conversationDelta?: string;
  };
  external?: ExternalRunSpec;
  /**
   * ACP steering 是异步的：被 Agent 拒绝 / 出错时把文本交还 orchestrator 的
   * pending steer（P5）。同步返回 false 的 steer 不经此回调。
   */
  onSteerRejected?: (text: string) => void;
}

/** 外部 Agent 会话的建立方式（P5 会话复用）。 */
export type AgentSessionMode = 'new' | 'reused' | 'resumed' | 'loaded';

/** 外部 Agent run 的选择与会话参数（`RunSpec.external`）。 */
export interface ExternalRunSpec {
  /** 目录 id（`AgentCatalogEntry.id`）。 */
  agentId: string;
  permission: AgentPermissionTier;
  /**
   * 本 run 注入的能力包（`resolveCapabilities` 的结果）；对应工具已在
   * `RunSpec.tools` 中（经宿主 MCP 桥暴露）。
   */
  capabilities: string[];
  /** 会话复用键（Bot, 对话, Agent）；宿主 MCP 桥的 token 按它签发。 */
  sessionKey: string;
  /**
   * P5 会话复用（design 28 §7）：缺省 = 每 run 一个会话、结束即关闭（P1）。
   * 给出时会话在 run 结束后保留在 Agent 进程里；`reuseId` 是 orchestrator
   * 按 `agent_sessions`（窗口内、指纹一致）认为可续用的 Agent 侧会话——引擎
   * 依次尝试：同进程直接复用 → `session/resume` → `session/load`（重放静音）
   * → 新建（对话段回落为完整上下文 + D56 回放）。
   */
  session?: { reuseId: string | null; fingerprint: string };
  /** 推理强度（config option 类别 `thought_level`）；'' = Agent 默认。 */
  effort?: string;
  /**
   * Agent 会话建立后回报其 sessionId（落 `runs.agent_session_id`）与建立方式
   * （P5：new / reused / resumed / loaded）。
   */
  onSession?: (agentSessionId: string, mode: AgentSessionMode) => void;
  /**
   * 第一个 prompt 实际发出（P5 审查 #1）：orchestrator 此时才把本 run 的已展示
   * 消息记为会话已见、推进复用状态。
   */
  onPromptSent?: () => void;
  /** 「加载我的个人配置」（`settings.agents[id].loadUserConfig`，默认 false）。 */
  loadUserConfig?: boolean;
  /**
   * 本会话宿主 MCP 桥的 server 名（`kepcup_<8hex>`，按会话随机）。会话级
   * 提示词里的工具名按它映射，所以由 orchestrator 生成并与提示词一同传入；
   * 缺省时引擎自行生成。
   */
  hostServerName?: string;
  /**
   * 后台精简会话（P6，design 28 §8）：`complete()` 与无内置模型时改走外部
   * Agent 的后台 loop（Wiki 维护、技能生成）。引擎强制：只读档（忽略
   * `permission`）；cwd 为引擎新建的空私有临时目录（忽略 `RunSpec.workdir`，
   * 结束即删除——永不是用户的 workspace / project）；不复用会话（忽略
   * `session`，结束即 `session/close`）；权限请求不走权限桥与审批卡——只放行
   * 本 run 注入的桥工具，其余一律拒绝（无人值守）；Provider 收到
   * `oneShot`（Claude：替换式系统提示词、`tools: []`）。
   */
  background?: boolean;
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
