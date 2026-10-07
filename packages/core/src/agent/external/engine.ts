import {
  AGENT_CANCEL_GRACE_MS,
  AGENT_RUN_TIMEOUT_MS,
  AppError,
  findAgentEntry,
  parseAgentModelRef,
  TOOL_OUTPUT_MAX_CHARS,
  type AgentCatalogEntry,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import { truncateToBudget } from '../tokens.js';
import type {
  AgentEngine,
  CompletionResult,
  EngineEvent,
  EngineUsage,
  RunHandle,
  RunOutcome,
  RunSpec,
} from '../types.js';
import {
  hostBridgeToolOf,
  type SessionBridge,
  type AcpContentBlock,
  type AcpInitializeResponse,
  type AcpMcpServer,
  type AcpRequestPermissionRequest,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpSessionUpdate,
  type AcpStopReason,
  type PermissionDecision,
} from './acp/client.js';
import { bridgeToolMeta, newHostServerName } from './capabilities.js';
import { classifierFor, toAgentError, type AgentErrorPhase } from './errors.js';
import type { AgentHost, AgentLease, SessionSink } from './host.js';
import type { BridgeRunBinding, BridgeToolCallEvent, BridgeToolResultEvent } from './mcp-bridge.js';
import { isForbiddenAgentMode, type AgentPermissionHandler } from './permission-bridge.js';
import type { AgentProvider } from './types.js';

/**
 * AgentEngine 的第二实现（docs/design/28-external-agents-acp.md，D72）：经
 * ACP 驱动外部智能体。协议无关的 run 编排在这里：会话建立、档位与模型选项、
 * prompt、事件映射、取消与结算；进程与连接在 AgentHost，协议细节在 acp/。
 *
 * 当前范围（P1 + P2）：每个 run 新建会话、结束即关闭；steer 恒返回 false
 * （run 结束后由 orchestrator 续投）；宿主工具（`RunSpec.tools`，已按能力包
 * 过滤）经宿主 MCP 桥注入，桥调用由桥自己报告、ACP 镜像更新忽略；
 * `skip_reply` 等终止型工具返回后发 `session/cancel`，结算为不发最终文本的
 * completed；complete() 不支持（P6）。
 */

/** 引擎用到的宿主 MCP 桥切片（mcp-bridge.ts 的 HostMcpBridge）。 */
export interface HostToolBridge {
  readonly running: boolean;
  readonly url: string;
  issueSessionToken(sessionKey: string): string;
  bindRun(sessionKey: string, binding: BridgeRunBinding): void;
  unbindRun(sessionKey: string, runId?: string): void;
  revoke(sessionKey: string, token?: string): void;
}

export interface ExternalAgentEngineDeps {
  host: AgentHost;
  /** 宿主 MCP 桥；缺省（或未启动）时不注入宿主工具。 */
  bridge?: HostToolBridge;
  /**
   * P3 权限桥：裁决 `session/request_permission`（可等待审批卡）并给出数据
   * 目录隔离；缺省（单测 / 契约测试）按 P1 规则默认拒绝。
   */
  permissions?: AgentPermissionHandler;
  /** 当前生效目录（已按发行门禁过滤）。 */
  catalog(): readonly AgentCatalogEntry[];
  logger: CoreLogger;
  runTimeoutMs?: number;
  cancelGraceMs?: number;
}

export class ExternalAgentEngine implements AgentEngine {
  readonly #deps: ExternalAgentEngineDeps;

  constructor(deps: ExternalAgentEngineDeps) {
    this.#deps = deps;
  }

  startRun(spec: RunSpec): RunHandle {
    const handle = new ExternalRunHandle(spec, this.#deps);
    void handle.start();
    return handle;
  }

  async complete(): Promise<CompletionResult> {
    throw new AppError('NOT_SUPPORTED', '外部智能体暂不支持单次补全（后台任务请使用内置模型）');
  }
}

// ---------------------------------------------------------------------------
// Event mapping (ACP session/update → EngineEvent, field-aligned with PiEngine)
// ---------------------------------------------------------------------------

/** PiEngine 的 assistant stopReason 取值（orchestrator 按 'toolUse' 切分中间说明）。 */
type PiStopReason = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';

function piStopReasonOf(stopReason: AcpStopReason): PiStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'cancelled':
      return 'aborted';
    case 'max_tokens':
    case 'max_turn_requests':
      return 'length';
    case 'refusal':
      return 'error';
  }
}

export type ToolCallLike = Extract<
  AcpSessionUpdate,
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>;

function toolNameOf(update: ToolCallLike): string {
  return update.name ?? update.title ?? update.kind ?? 'tool';
}

/** 工具结果的文本形态（run_steps 与续接回放读取；图片 / diff / 终端只留占位）。 */
export function toolContentText(update: ToolCallLike): string {
  const parts: string[] = [];
  for (const item of update.content ?? []) {
    if (item.type === 'diff') {
      parts.push(`[diff] ${item.path}`);
    } else if (item.type === 'terminal') {
      parts.push(`[terminal ${item.terminalId}]`);
    } else {
      const block = item.content;
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'image') parts.push(`[图片 ${block.mimeType}]`);
      else if (block.type === 'resource_link') parts.push(`[资源] ${block.uri}`);
      else if (block.type === 'resource') {
        const resource = block.resource as { text?: string; uri: string };
        parts.push(resource.text ?? `[资源] ${resource.uri}`);
      } else parts.push(`[${block.type}]`);
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined && update.rawOutput !== null) {
    parts.push(
      typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput),
    );
  }
  return truncateToBudget(parts.join('\n'), TOOL_OUTPUT_MAX_CHARS).text;
}

function planProgressText(
  entries: ReadonlyArray<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>,
): string {
  const done = entries.filter((entry) => entry.status === 'completed').length;
  const current =
    entries.find((entry) => entry.status === 'in_progress') ??
    entries.find((entry) => entry.status === 'pending');
  return current !== undefined
    ? `计划 ${done}/${entries.length}：${current.content}`
    : `计划 ${done}/${entries.length} 已完成`;
}

/**
 * 把一个 prompt turn 的 ACP 更新映射为与 PiEngine 逐字段对齐的引擎事件
 * （design 28 §7「事件映射」）：
 * - 文本块累积；遇顶层 `tool_call` 以 `stopReason:'toolUse'` 发 `assistant`
 *   （一个「模型轮」只发一次：同一轮的多个工具调用共用一条 assistant）；
 * - `tool_call` → `tool_call`，`tool_call_update`（completed / failed）→
 *   `tool_result`，以 `toolCallId` 配对；未回报结果的调用在结束时补失败结果；
 * - `agent_thought_chunk` 不落库；`plan` → `progress`；
 * - 结束时按 stopReason 发最后一条 `assistant`，`finalText` 取自它。
 */
export class AcpEventMapper {
  #text = '';
  /** A model turn is open: the next tool_call closes it with an assistant event. */
  #turnOpen = true;
  readonly #pending = new Map<string, string>();
  readonly #known = new Set<string>();
  /**
   * ACP mirrors of host-bridge calls (toolCallId → bridge tool): the bridge
   * reports those itself. `matched` = a bridge call really happened for it.
   */
  readonly #mirrored = new Map<string, { tool: string; matched: boolean; first: ToolCallLike }>();
  /** Bridge calls that arrived before their mirror (per tool). */
  readonly #unclaimed = new Map<string, number>();
  readonly #hostToolOf: (update: ToolCallLike) => string | null;

  /**
   * `hostToolOf` recognizes the agent's own updates about host MCP bridge
   * tools of this session (design 28 §4.4): they are dropped, the bridge
   * reports the call via `hostToolCall` / `hostToolResult` with the real
   * result and errorCode. A mirror no bridge call ever matched (something
   * else answering under the bridge's name) is recorded as a native call.
   */
  constructor(options: { hostToolOf?: (update: ToolCallLike) => string | null } = {}) {
    this.#hostToolOf = options.hostToolOf ?? (() => null);
  }

  map(update: AcpSessionUpdate): EngineEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.#turnOpen = true;
          this.#text += update.content.text;
        }
        return [];
      case 'tool_call':
        return this.#onToolCall(update);
      case 'tool_call_update':
        return this.#onToolCall(update);
      case 'plan':
        return update.entries.length > 0
          ? [{ type: 'progress', payload: { text: planProgressText(update.entries) } }]
          : [];
      default:
        return [];
    }
  }

  /**
   * Failed results for every call still awaiting one, so run_steps stay
   * paired for replay (the turn ended abnormally or without reporting them).
   */
  abandon(): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const [toolCallId, toolName] of [...this.#pending.entries()]) {
      events.push({
        type: 'tool_result',
        payload: { toolCallId, toolName, ok: false, content: '（智能体未回报该工具调用的结果）' },
      });
    }
    this.#pending.clear();
    return events;
  }

  /** A host-bridge call started (bridge-side report, with pack markers). */
  hostToolCall(call: BridgeToolCallEvent): EngineEvent[] {
    const mirror = [...this.#mirrored.values()].find(
      (candidate) => candidate.tool === call.toolName && !candidate.matched,
    );
    if (mirror !== undefined) mirror.matched = true;
    else this.#unclaimed.set(call.toolName, (this.#unclaimed.get(call.toolName) ?? 0) + 1);
    const events = this.#closeTurn();
    this.#known.add(call.toolCallId);
    this.#pending.set(call.toolCallId, call.toolName);
    events.push({ type: 'tool_call', payload: call });
    return events;
  }

  /** A host-bridge call returned (keeps `errorCode`: SETUP_REQUIRED interrupts). */
  hostToolResult(result: BridgeToolResultEvent): EngineEvent[] {
    if (!this.#pending.delete(result.toolCallId)) return [];
    if (this.#pending.size === 0) this.#turnOpen = true;
    return [{ type: 'tool_result', payload: result }];
  }

  /**
   * Closes the turn; `finalText` is non-empty only for a normal end. A run a
   * tool terminated (skip_reply) adds no trailing empty assistant (as in pi).
   */
  finish(
    stopReason: AcpStopReason,
    options: { terminated?: boolean } = {},
  ): { events: EngineEvent[]; finalText: string } {
    const events = this.abandon();
    const piStop = piStopReasonOf(stopReason);
    const text = this.#text;
    this.#text = '';
    this.#turnOpen = false;
    if (options.terminated === true) {
      if (text.length > 0) {
        events.push({
          type: 'assistant',
          payload: { text, stopReason: piStop, errorMessage: undefined },
        });
      }
      return { events, finalText: '' };
    }
    events.push({
      type: 'assistant',
      payload: {
        text,
        stopReason: piStop,
        errorMessage: stopReason === 'refusal' ? 'refusal' : undefined,
      },
    });
    return { events, finalText: piStop === 'stop' ? text.trim() : '' };
  }

  /** The model turn ends at its first tool call (assistant with stopReason toolUse). */
  #closeTurn(): EngineEvent[] {
    if (!this.#turnOpen) return [];
    const event: EngineEvent = {
      type: 'assistant',
      payload: { text: this.#text, stopReason: 'toolUse', errorMessage: undefined },
    };
    this.#text = '';
    this.#turnOpen = false;
    return [event];
  }

  #onToolCall(update: ToolCallLike): EngineEvent[] {
    const id = update.toolCallId;
    const terminal = update.status === 'completed' || update.status === 'failed';
    let mirror = this.#mirrored.get(id);
    if (mirror === undefined && !this.#known.has(id)) {
      const tool = this.#hostToolOf(update);
      if (tool !== null) {
        const unclaimed = this.#unclaimed.get(tool) ?? 0;
        if (unclaimed > 0) this.#unclaimed.set(tool, unclaimed - 1);
        mirror = { tool, matched: unclaimed > 0, first: update };
        this.#mirrored.set(id, mirror);
      }
    }
    if (mirror !== undefined) {
      if (!terminal) return [];
      this.#mirrored.delete(id);
      // No bridge call behind it: keep it in the record as a native call.
      return mirror.matched ? [] : [...this.#native(mirror.first), ...this.#native(update)];
    }
    return this.#native(update);
  }

  #native(update: ToolCallLike): EngineEvent[] {
    const id = update.toolCallId;
    const events: EngineEvent[] = [];
    if (!this.#known.has(id)) {
      this.#known.add(id);
      events.push(...this.#closeTurn());
      const toolName = toolNameOf(update);
      this.#pending.set(id, toolName);
      events.push({
        type: 'tool_call',
        payload: { toolCallId: id, toolName, args: update.rawInput ?? {} },
      });
    }
    const toolName = this.#pending.get(id);
    if (toolName !== undefined && (update.status === 'completed' || update.status === 'failed')) {
      this.#pending.delete(id);
      events.push({
        type: 'tool_result',
        payload: {
          toolCallId: id,
          toolName,
          ok: update.status === 'completed',
          content: toolContentText(update),
        },
      });
      // All results are back: whatever comes next is a new model turn.
      if (this.#pending.size === 0) this.#turnOpen = true;
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Run handle
// ---------------------------------------------------------------------------

const IMAGE_NOT_SUPPORTED_NOTE = '（用户消息中的图片未注入：该智能体不支持图像输入。）';

class ExternalRunHandle implements RunHandle {
  readonly #spec: RunSpec;
  readonly #deps: ExternalAgentEngineDeps;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  #mapper = new AcpEventMapper();
  readonly #usage: EngineUsage[] = [];
  /** Run cancellation as seen by in-flight host-bridge tool calls. */
  readonly #toolAbort = new AbortController();
  #lease: AgentLease | null = null;
  #sessionId: string | null = null;
  /** Session key + token + server bound on the host MCP bridge (null = no bridge). */
  #bridge: { sessionKey: string; token: string; session: SessionBridge } | null = null;
  #agentName: string;
  #entry: AgentCatalogEntry | null = null;
  #provider: AgentProvider | null = null;
  /**
   * The permission mode / `mode` config value the tier mapping put the
   * session in (P3): a `current_mode_update` / `config_option_update` that
   * deviates is switched back and audited.
   */
  #expectedMode: string | null = null;
  #expectedModeOption: { id: string; value: string } | null = null;
  #modeReverts = 0;
  #aborted = false;
  /** Set by a terminating tool (skip_reply): completed without a final text. */
  #terminated: string | null = null;
  #resolved = false;
  #graceTimer: NodeJS.Timeout | null = null;
  readonly done: Promise<RunOutcome>;
  #resolveDone!: (outcome: RunOutcome) => void;

  constructor(spec: RunSpec, deps: ExternalAgentEngineDeps) {
    this.#spec = spec;
    this.#deps = deps;
    this.#agentName = spec.external?.agentId ?? '?';
    this.done = new Promise<RunOutcome>((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  async start(): Promise<void> {
    const spec = this.#spec;
    // Where a failure happened: providers classify errors per phase (each
    // agent reports "not logged in" at a different step, todo 附录 A.4).
    let phase: AgentErrorPhase = 'initialize';
    try {
      const external = spec.external;
      if (external === undefined || spec.workdir === undefined) {
        throw new AppError('INVALID_INPUT', '外部智能体 run 缺少 external / workdir');
      }
      const entry = findAgentEntry(this.#deps.catalog(), external.agentId);
      if (entry === null) {
        throw new AppError('AGENT_UNAVAILABLE', `智能体「${external.agentId}」不在目录中`);
      }
      this.#agentName = entry.name;
      this.#entry = entry;
      const lease = await this.#deps.host.acquire(entry);
      this.#lease = lease;
      if (this.#resolved) return;
      const { connection, provider, init } = lease;
      this.#provider = provider;

      const parts = spec.promptParts ?? (await this.#fallbackPromptParts());
      const metaAppend = provider.instructionMode === 'meta-append';
      const acceptsImages = init.agentCapabilities?.promptCapabilities?.image === true;
      const sessionOptions = provider.sessionNew({
        entry,
        cwd: spec.workdir,
        permission: external.permission,
        capabilities: external.capabilities,
        sessionPrompt: metaAppend ? parts.session : null,
        maxTurns: spec.limits.maxTurns,
        loadUserConfig: external.loadUserConfig === true,
        ...(this.#deps.permissions !== undefined
          ? { isolation: this.#deps.permissions.isolationFor(spec.identity, spec.workdir) }
          : {}),
      });
      // Bound before session/new: agents connect to their MCP servers while
      // creating the session, and the bridge refuses sessions without a run.
      const bridgeServer = this.#attachBridge(entry, provider, init, acceptsImages);
      phase = 'session_new';
      const session = await connection.newSession({
        cwd: spec.workdir,
        mcpServers: [
          ...(bridgeServer !== null ? [bridgeServer] : []),
          ...(sessionOptions.extraMcpServers ?? []),
        ],
        ...(sessionOptions._meta !== undefined ? { _meta: sessionOptions._meta } : {}),
      });
      this.#sessionId = session.sessionId;
      // Only a session that really carries the bridge may have kepcup tool
      // permission requests allowed (acp/client.ts decidePermission).
      lease.attach(session.sessionId, this.#sink(this.#bridge?.session ?? null));
      if (this.#resolved) return;
      external.onSession?.(session.sessionId);

      phase = 'other';
      const configOptions = session.configOptions ?? [];
      await this.#applyTier(session.sessionId, session.modes ?? null, configOptions);
      await this.#applyConfig(session.sessionId, configOptions, {
        model: parseAgentModelRef(spec.model)?.model ?? '',
        effort: external.effort ?? '',
      });
      if (this.#resolved) return;
      // An abort that landed during the tier / config calls only queued a
      // session/cancel: never start the prompt (nor record its request).
      if (this.#aborted) {
        this.#settle({ status: 'cancelled', finalText: '', skipReply: false, usage: this.#usage });
        return;
      }

      const prompt = this.#promptBlocks(
        metaAppend ? { ...parts, session: '' } : parts,
        acceptsImages,
      );
      this.emit({
        type: 'request',
        payload: {
          agentId: entry.id,
          sessionId: session.sessionId,
          prompt,
          ...(metaAppend && parts.session.length > 0 ? { sessionPrompt: parts.session } : {}),
          ...(bridgeServer !== null ? { hostTools: spec.tools.map((tool) => tool.name) } : {}),
        },
      });
      phase = 'prompt';
      const response = await this.#withRunTimeout(connection.prompt(session.sessionId, prompt));
      const { events, finalText } = this.#mapper.finish(response.stopReason, {
        terminated: this.#terminated !== null,
      });
      for (const event of events) this.emit(event);
      this.#settle(this.#outcomeOf(response.stopReason, finalText));
    } catch (error) {
      const appError = toAgentError(
        error,
        this.#agentName,
        this.#lease !== null ? classifierFor(this.#lease.provider) : undefined,
        phase,
      );
      this.#warn(
        { runId: spec.identity.runId, code: appError.code, error: appError.message },
        'external agent run failed',
      );
      this.#settle(
        this.#aborted
          ? { status: 'cancelled', finalText: '', skipReply: false, usage: this.#usage }
          : this.#terminated !== null
            ? this.#terminatedOutcome()
            : {
                status: 'failed',
                finalText: '',
                skipReply: false,
                usage: this.#usage,
                error: { code: appError.code, message: appError.message },
              },
      );
    } finally {
      this.#release();
    }
  }

  /**
   * Binds this run on the host MCP bridge and returns the `mcpServers` entry,
   * or null when no host tool is injected (no tools, no bridge, or an agent
   * without http MCP — the stdio proxy is not wired yet, P2).
   */
  #attachBridge(
    entry: AgentCatalogEntry,
    provider: AgentProvider,
    init: AcpInitializeResponse,
    acceptsImages: boolean,
  ): AcpMcpServer | null {
    const spec = this.#spec;
    const bridge = this.#deps.bridge;
    if (spec.tools.length === 0) return null;
    if (bridge === undefined || !bridge.running) {
      // Host tools were promised in the prompt: fail readably instead of
      // running an agent that cannot reach them.
      throw new AppError(
        'AGENT_UNAVAILABLE',
        'KepCup 宿主工具桥未启动，外部智能体暂不可用（请查看日志或重启应用）',
      );
    }
    if (!provider.features.httpMcp || init.agentCapabilities?.mcpCapabilities?.http !== true) {
      this.#warn(
        { runId: spec.identity.runId, agentId: entry.id },
        'agent has no http MCP support; host tools not injected',
      );
      return null;
    }
    const sessionKey = spec.external!.sessionKey;
    const serverName = spec.external!.hostServerName ?? newHostServerName();
    const token = bridge.issueSessionToken(sessionKey);
    bridge.bindRun(sessionKey, {
      identity: spec.identity,
      tools: spec.tools,
      signal: this.#toolAbort.signal,
      acceptsImages,
      meta: (toolName) => bridgeToolMeta(toolName, entry),
      onToolCall: (call) => {
        for (const event of this.#mapper.hostToolCall(call)) this.emit(event);
      },
      onToolResult: (result) => {
        for (const event of this.#mapper.hostToolResult(result)) this.emit(event);
      },
      progress: (text) => this.emit({ type: 'progress', payload: { text } }),
      onTerminate: (reason) => this.#terminate(reason),
    });
    const sessionBridge: SessionBridge = {
      serverName,
      toolNames: new Set(spec.tools.map((tool) => tool.name)),
    };
    this.#bridge = { sessionKey, token, session: sessionBridge };
    // The agent's own updates about bridge tools are mirrors: drop them.
    this.#mapper = new AcpEventMapper({
      hostToolOf: (update) => hostBridgeToolOf(update, provider, sessionBridge),
    });
    return {
      type: 'http',
      name: serverName,
      url: bridge.url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
  }

  /**
   * A terminating tool (skip_reply) returned through the bridge: cancel the
   * prompt; the run settles completed without a final message (design 28
   * §4.4, todo §13「skip_reply 与取消」).
   */
  #terminate(reason: string): void {
    if (this.#terminated !== null || this.#aborted || this.#resolved) return;
    this.#terminated = reason;
    this.#cancelPrompt(() => this.#terminatedOutcome());
  }

  #terminatedOutcome(): RunOutcome {
    return { status: 'completed', finalText: '', skipReply: true, usage: this.#usage };
  }

  /**
   * session/cancel; the agent must answer the prompt with `cancelled`, and a
   * stuck agent must not hold the mailbox forever (grace timer).
   */
  #cancelPrompt(onGrace: () => RunOutcome): void {
    const lease = this.#lease;
    const sessionId = this.#sessionId;
    if (lease === null || sessionId === null) return;
    void lease.connection.cancel(sessionId).catch(() => undefined);
    if (this.#graceTimer !== null) clearTimeout(this.#graceTimer);
    this.#graceTimer = setTimeout(() => {
      this.#settle(onGrace());
      this.#release();
    }, this.#deps.cancelGraceMs ?? AGENT_CANCEL_GRACE_MS);
    this.#graceTimer.unref?.();
  }

  steer(_text: string): boolean {
    // ACP steering lands in P5 (provider.features.steering); until then the
    // orchestrator re-delivers the batch as a new run after this one ends.
    return false;
  }

  abort(_reason: string): void {
    if (this.#aborted || this.#resolved) return;
    this.#aborted = true;
    // In-flight host-bridge calls observe the cancellation (ToolContext.signal).
    this.#toolAbort.abort();
    if (this.#lease === null || this.#sessionId === null) {
      // Not prompting yet: start() notices #resolved at its next step.
      this.#settle({ status: 'cancelled', finalText: '', skipReply: false, usage: this.#usage });
      return;
    }
    this.#cancelPrompt(() => ({
      status: 'cancelled',
      finalText: '',
      skipReply: false,
      usage: this.#usage,
    }));
  }

  onEvent(listener: (e: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  tokensSoFar(): number {
    // Subscription agents report no per-turn tokens in P1 (usage lands in P5).
    return 0;
  }

  emit(event: EngineEvent): void {
    if (this.#resolved) return;
    for (const listener of [...this.#listeners]) listener(event);
  }

  #sink(bridge: SessionBridge | null): SessionSink {
    return {
      bridge,
      onUpdate: (update) => {
        if (update.sessionUpdate === 'current_mode_update') {
          this.#onModeUpdate(update.currentModeId);
        } else if (update.sessionUpdate === 'config_option_update') {
          this.#onConfigOptionUpdate(update.configOptions);
        }
        for (const event of this.#mapper.map(update)) this.emit(event);
      },
      onPermission: (title, decision) => this.#notePermission(title, decision),
      ...(this.#deps.permissions !== undefined
        ? {
            requestPermission: (request: AcpRequestPermissionRequest) =>
              this.#deps.permissions!.decide(request, {
                identity: this.#spec.identity,
                entry: this.#entry!,
                provider: this.#provider!,
                tier: this.#spec.external!.permission,
                workdir: this.#spec.workdir!,
                signal: this.#toolAbort.signal,
                bridge,
              }),
          }
        : {}),
      onClosed: (error) => {
        this.#settle(
          this.#aborted
            ? { status: 'cancelled', finalText: '', skipReply: false, usage: this.#usage }
            : this.#terminated !== null
              ? this.#terminatedOutcome()
              : {
                  status: 'failed',
                  finalText: '',
                  skipReply: false,
                  usage: this.#usage,
                  error: { code: error.code, message: error.message },
                },
        );
      },
    };
  }

  /** Runs can settle during core shutdown, after the logger closed. */
  #warn(obj: object, message: string): void {
    try {
      this.#deps.logger.warn(obj, message);
    } catch {
      // Logger already torn down; nothing to report to.
    }
  }

  #notePermission(title: string, decision: PermissionDecision): void {
    if (decision === 'allowed') return;
    this.emit({
      type: 'progress',
      payload: {
        text:
          decision === 'rejected'
            ? `已拒绝智能体的权限请求：${title}`
            : `智能体的权限请求已取消：${title}`,
      },
    });
  }

  /**
   * Tier mapping through the provider (design 28 §6「权限档位」), with the
   * host's guard around it: a forbidden mode (bypass / auto / full-access …)
   * is never set, the mode the mapping lands on is remembered for the
   * deviation check, and a session still sitting in a forbidden mode
   * afterwards fails closed.
   */
  async #applyTier(
    sessionId: string,
    modes: AcpSessionModeState | null,
    configOptions: readonly AcpSessionConfigOption[],
  ): Promise<void> {
    const lease = this.#lease!;
    const provider = lease.provider;
    this.#expectedMode = modes?.currentModeId ?? null;
    const modeOption = configOptions.find((option) => option.category === 'mode');
    if (modeOption !== undefined && typeof modeOption.currentValue === 'string') {
      this.#expectedModeOption = { id: modeOption.id, value: modeOption.currentValue };
    }
    // Select values come flat or grouped.
    const modeOptionValues =
      modeOption !== undefined && modeOption.type === 'select'
        ? (
            modeOption.options as ReadonlyArray<{
              value?: string;
              options?: Array<{ value: string }>;
            }>
          ).flatMap((item) =>
            item.value !== undefined
              ? [item.value]
              : (item.options ?? []).map((inner) => inner.value),
          )
        : [];
    await provider.applyPermissionTier(this.#spec.external!.permission, {
      sessionId,
      modes,
      configOptions,
      setMode: async (modeId) => {
        if (isForbiddenAgentMode(modeId, provider)) {
          throw new AppError('AGENT_INCOMPATIBLE', `拒绝切换到不允许的权限模式「${modeId}」`);
        }
        // Set before awaiting: the agent's echo may arrive before the response.
        // The same preset may also be exposed as the `mode` config option
        // (Codex): keep both expectations in step (review M4).
        const previous = { mode: this.#expectedMode, option: this.#expectedModeOption };
        this.#expectedMode = modeId;
        if (this.#expectedModeOption !== null && modeOptionValues.includes(modeId)) {
          this.#expectedModeOption = { ...this.#expectedModeOption, value: modeId };
        }
        try {
          await lease.connection.setMode(sessionId, modeId);
        } catch (error) {
          this.#expectedMode = previous.mode;
          this.#expectedModeOption = previous.option;
          throw error;
        }
      },
      setConfigOption: async (configId, value) => {
        const isMode = configOptions.some(
          (option) => option.id === configId && option.category === 'mode',
        );
        if (isMode && isForbiddenAgentMode(value, provider)) {
          throw new AppError('AGENT_INCOMPATIBLE', `拒绝切换到不允许的权限模式「${value}」`);
        }
        const previous = { mode: this.#expectedMode, option: this.#expectedModeOption };
        if (isMode) {
          this.#expectedModeOption = { id: configId, value };
          // A mode list naming the same preset follows (review M4).
          if (modes?.availableModes.some((mode) => mode.id === value) === true) {
            this.#expectedMode = value;
          }
        }
        try {
          await lease.connection.setConfigOption(sessionId, configId, value);
        } catch (error) {
          this.#expectedMode = previous.mode;
          this.#expectedModeOption = previous.option;
          throw error;
        }
      },
    });
    const stuck = [this.#expectedMode, this.#expectedModeOption?.value].find(
      (mode): mode is string => typeof mode === 'string' && isForbiddenAgentMode(mode, provider),
    );
    if (stuck !== undefined) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体「${this.#agentName}」处于不允许的权限模式「${stuck}」，且无法按档位切换`,
      );
    }
  }

  /** Upper bound of mode reverts per run (an agent fighting the host is aborted). */
  static readonly MAX_MODE_REVERTS = 5;

  /** `current_mode_update` away from the tier's mode → switch back + audit. */
  #onModeUpdate(modeId: string): void {
    const expected = this.#expectedMode;
    if (expected === null || modeId === expected || this.#resolved) return;
    this.#revertMode(modeId, expected, (lease, sessionId) =>
      lease.connection.setMode(sessionId, expected),
    );
  }

  /** The same through the `mode` config option (Codex exposes both). */
  #onConfigOptionUpdate(options: readonly AcpSessionConfigOption[]): void {
    const expected = this.#expectedModeOption;
    if (expected === null || this.#resolved) return;
    const option = options.find((candidate) => candidate.id === expected.id);
    if (option === undefined || typeof option.currentValue !== 'string') return;
    if (option.currentValue === expected.value) return;
    this.#revertMode(option.currentValue, expected.value, (lease, sessionId) =>
      lease.connection.setConfigOption(sessionId, expected.id, expected.value),
    );
  }

  #revertMode(
    actual: string,
    expected: string,
    revert: (lease: AgentLease, sessionId: string) => Promise<void>,
  ): void {
    const lease = this.#lease;
    const sessionId = this.#sessionId;
    if (lease === null || sessionId === null) return;
    this.#modeReverts += 1;
    this.#deps.permissions?.audit(this.#spec.identity, 'agent_mode_reverted', {
      agentId: this.#entry?.id ?? '',
      sessionId,
      actual,
      expected,
      forbidden: isForbiddenAgentMode(actual, lease.provider),
      attempt: this.#modeReverts,
    });
    this.#warn(
      { runId: this.#spec.identity.runId, actual, expected, attempt: this.#modeReverts },
      'agent left its permission mode; switching back',
    );
    if (this.#modeReverts > ExternalRunHandle.MAX_MODE_REVERTS) {
      this.emit({
        type: 'progress',
        payload: { text: `智能体反复切换权限模式（${actual}），已中止本次执行` },
      });
      this.abort('agent kept leaving its permission mode');
      return;
    }
    this.emit({
      type: 'progress',
      payload: { text: `智能体切换了权限模式（${actual}），已改回「${expected}」` },
    });
    void revert(lease, sessionId).catch((error: unknown) => {
      this.#warn(
        {
          runId: this.#spec.identity.runId,
          error: error instanceof Error ? error.message : String(error),
        },
        'switching the permission mode back failed; aborting the run',
      );
      this.abort('permission mode could not be restored');
    });
  }

  async #fallbackPromptParts(): Promise<{ session: string; run: string; conversation: string }> {
    return {
      session: await this.#spec.buildSystemPrompt(),
      run: '',
      conversation: this.#spec.messages.map((message) => message.content).join('\n\n'),
    };
  }

  #promptBlocks(
    parts: { session: string; run: string; conversation: string },
    acceptsImages: boolean,
  ): AcpContentBlock[] {
    const text = [parts.session, parts.run, parts.conversation]
      .filter((part) => part.trim().length > 0)
      .join('\n\n');
    const images = this.#spec.messages.flatMap((message) => message.images ?? []);
    const blocks: AcpContentBlock[] = [{ type: 'text', text }];
    if (images.length === 0) return blocks;
    if (!acceptsImages) return [{ type: 'text', text: `${text}\n\n${IMAGE_NOT_SUPPORTED_NOTE}` }];
    return [
      ...blocks,
      ...images.map((image) => ({
        type: 'image' as const,
        data: image.base64,
        mimeType: image.mimeType,
      })),
    ];
  }

  /** model / thought_level config options (§3); unknown or failing values only warn. */
  async #applyConfig(
    sessionId: string,
    options: readonly AcpSessionConfigOption[],
    wanted: { model: string; effort: string },
  ): Promise<void> {
    const lease = this.#lease!;
    for (const [category, value] of [
      ['model', wanted.model],
      ['thought_level', wanted.effort],
    ] as const) {
      if (value.length === 0) continue;
      const option = options.find((candidate) => candidate.category === category);
      if (option === undefined) {
        this.#warn(
          { runId: this.#spec.identity.runId, category },
          'agent exposes no config option for this category; using its default',
        );
        continue;
      }
      try {
        await lease.connection.setConfigOption(sessionId, option.id, value);
      } catch (error) {
        this.#warn(
          {
            runId: this.#spec.identity.runId,
            category,
            error: error instanceof Error ? error.message : String(error),
          },
          'agent rejected config option; using its default',
        );
      }
    }
  }

  async #withRunTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.#deps.runTimeoutMs ?? AGENT_RUN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (this.#sessionId !== null) {
              void this.#lease?.connection.cancel(this.#sessionId).catch(() => undefined);
            }
            reject(
              new AppError('TIMEOUT', `智能体执行超时（${Math.round(timeoutMs / 60_000)} 分钟）`),
            );
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  #outcomeOf(stopReason: AcpStopReason, finalText: string): RunOutcome {
    const base = { finalText: '', skipReply: false, usage: this.#usage };
    if (this.#aborted) return { ...base, status: 'cancelled' };
    // skip_reply's session/cancel is not a cancellation (todo §13).
    if (this.#terminated !== null) return this.#terminatedOutcome();
    if (stopReason === 'cancelled') return { ...base, status: 'cancelled' };
    if (stopReason === 'end_turn') return { ...base, status: 'completed', finalText };
    const message =
      stopReason === 'refusal'
        ? `智能体「${this.#agentName}」拒绝了本次请求`
        : stopReason === 'max_tokens'
          ? `智能体「${this.#agentName}」输出达到长度上限`
          : `智能体「${this.#agentName}」达到单次请求轮数上限`;
    return { ...base, status: 'failed', error: { code: 'AGENT_FAILED', message } };
  }

  #settle(outcome: RunOutcome): void {
    if (this.#resolved) return;
    // Core shutdown: the databases are closed; restart recovery marks the run
    // interrupted (as for pi runs), so the run must not settle now.
    if (this.#deps.host.disposed) return;
    // Abnormal ends (crash, timeout, cancel grace, agent gone) never reach
    // mapper.finish: pair the dangling tool calls before settling.
    for (const event of this.#mapper.abandon()) this.emit(event);
    this.#resolved = true;
    if (this.#graceTimer !== null) clearTimeout(this.#graceTimer);
    this.#resolveDone(outcome);
  }

  /** Detaches the session (later updates are out-of-run) and frees the lease. */
  #release(): void {
    // The run is over: bridge calls still running see the abort, later ones
    // are refused (no run), and the session token stops working (P1/P2 close
    // the session with the run; P5 session reuse keeps the token).
    this.#toolAbort.abort();
    const bound = this.#bridge;
    if (bound !== null) {
      this.#bridge = null;
      // Scoped to this run / token: a later run on the same key keeps its own.
      this.#deps.bridge?.unbindRun(bound.sessionKey, this.#spec.identity.runId);
      this.#deps.bridge?.revoke(bound.sessionKey, bound.token);
    }
    const lease = this.#lease;
    if (lease === null) return;
    this.#lease = null;
    const sessionId = this.#sessionId;
    if (sessionId !== null) {
      lease.detach(sessionId);
      // P1: one session per run. Close it when the agent supports that;
      // otherwise it simply idles inside the agent until the process exits.
      if (lease.init.agentCapabilities?.sessionCapabilities?.close != null) {
        void lease.connection.closeSession(sessionId).catch(() => undefined);
      }
    }
    lease.release();
  }
}
