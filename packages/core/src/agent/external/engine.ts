import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_BRIDGE_TOOL_DETACH_MS,
  AGENT_CANCEL_GRACE_MS,
  AGENT_COMPLETE_MAX_TURNS,
  AGENT_COMPLETE_TIMEOUT_MS,
  AGENT_RUN_TIMEOUT_MS,
  AGENT_TURN_BUDGET_TOKENS,
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
  AgentSessionMode,
  CompletionRequest,
  CompletionResult,
  EngineEvent,
  EngineUsage,
  RunHandle,
  RunOutcome,
  RunSpec,
} from '../types.js';
import {
  ACP_STEERING_METHOD,
  advertisesSteering,
  hostBridgeToolOf,
  type SessionBridge,
  type AcpContentBlock,
  type AcpInitializeResponse,
  type AcpMcpServer,
  type AcpPromptResponse,
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
 * ACP 驱动外部智能体。协议无关的 run 编排在这里：会话建立 / 复用、档位与模型
 * 选项、prompt、事件映射、steering、取消与结算；进程与连接在 AgentHost，协议
 * 细节在 acp/。
 *
 * - 会话（P5）：`RunSpec.external.session` 缺省时每 run 一个会话、结束即关闭
 *   （P1）；给出时会话在 run 结束后留在 Agent 进程里，下一个 run 依次尝试
 *   同进程复用 → `session/resume` → `session/load`（重放静音）→ 新建；宿主
 *   MCP 桥的 token 随会话（新建 / 恢复时重签，复用时沿用），每个 run 重新
 *   绑定；
 * - steering（P5）：prompt 发出前到达的消息并入该 prompt；进行中的 prompt
 *   在 Provider 支持时经 `_session/steering`（`idleBehavior:'promptRequired'`）
 *   注入，被拒 / 出错交还 `RunSpec.onSteerRejected`；
 * - 宿主工具经宿主 MCP 桥注入（桥自己报告调用，ACP 镜像更新忽略）；超过
 *   `bridgeToolDetachMs` 的桥调用转入后台，结果在 prompt 结束后以 follow-up
 *   prompt 送回同一个 run（P5，Codex MCP 超时）；
 * - `skip_reply` 等终止型工具返回后发 `session/cancel`，结算为不发最终文本的
 *   completed；
 * - 后台精简会话（P6，`external.background`）：`complete()` 与无内置模型时的
 *   后台 loop 用——只读档、空私有临时目录作 cwd、不复用会话、权限请求只放行
 *   本 run 的桥工具（无审批卡），结束即 `session/close` 并删除临时目录。
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

/** 丢弃一个保留的 Agent 会话（P5：对话 / Bot 删除、会话被替换）。 */
export interface DiscardAgentSessionInput {
  agentId: string;
  agentSessionId: string;
  sessionKey: string;
  /**
   * 也删除 Agent 侧的会话历史（`session/delete`，Agent 声明支持时）；否则
   * 只关闭（`session/close`）。都只在会话仍开在活着的进程里时进行（尽力而为）。
   */
  deleteHistory: boolean;
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
  readonly #control: SessionControl = {
    discardOnRelease: new Map(),
    prompting: new Map(),
    invalidated: new Set(),
  };

  constructor(deps: ExternalAgentEngineDeps) {
    this.#deps = deps;
    // Kept sessions die with their process (crash, idle exit, out-of-run mode
    // change): their bridge tokens stop working at once (P5 审查 #18).
    deps.host.onSessionsLost?.((lost) => {
      for (const { state } of lost) {
        const kept = state as KeptSession | undefined;
        if (kept?.bridge != null) deps.bridge?.revoke(kept.sessionKey, kept.bridge.token);
      }
      for (const { agentId, sessionId, invalid } of lost) {
        if (invalid) notifyInvalidated(this.#control, agentId, sessionId);
      }
    });
  }

  /**
   * A kept agent session must not be continued any more (poisoned, closed
   * before it was usable, mode changed outside a run): the orchestrator drops
   * its `agent_sessions` row so it is neither reused nor resumed (P5 审查 #1).
   */
  onSessionInvalidated(listener: (agentId: string, agentSessionId: string) => void): () => void {
    this.#control.invalidated.add(listener);
    return () => {
      this.#control.invalidated.delete(listener);
    };
  }

  startRun(spec: RunSpec): RunHandle {
    const handle = new ExternalRunHandle(spec, this.#deps, this.#control);
    void handle.start();
    return handle;
  }

  /**
   * Gives up a kept agent session (P5): conversation / bot deletion
   * (`deleteHistory` → `session/delete` when the agent supports it) or a
   * session replaced by a new one. Only a session still open in a live agent
   * process can be closed (best effort); its bridge token is revoked either
   * way. A run still attached to it discards it on release.
   */
  async discardSession(input: DiscardAgentSessionInput): Promise<void> {
    const open = this.#deps.host.openSession(input.agentId, input.agentSessionId);
    const kept = open?.state as KeptSession | undefined;
    if (input.deleteHistory) this.#deps.bridge?.revoke(input.sessionKey);
    else if (kept?.bridge != null) this.#deps.bridge?.revoke(input.sessionKey, kept.bridge.token);
    if (open === null) return;
    if (open.busy) {
      this.#control.discardOnRelease.set(input.agentSessionId, {
        deleteHistory: input.deleteHistory,
      });
      return;
    }
    this.#deps.host.forgetSession(input.agentId, input.agentSessionId);
    await closeAgentSession(
      open.connection,
      open.init,
      input.agentSessionId,
      input.deleteHistory,
      (error) => {
        try {
          this.#deps.logger.warn(
            { agentId: input.agentId, sessionId: input.agentSessionId, error },
            'discarding the agent session failed',
          );
        } catch {
          // Logger already closed (shutdown).
        }
      },
    );
  }

  /**
   * 单次补全（P6，design 28 §8「后台 loop」）：一次性精简会话——Claude 用替换式
   * 系统提示词 + `tools: []` + `settingSources: []`，其他 Agent 用只读档；cwd
   * 为空私有临时目录（永不是用户 workspace）；不挂宿主 MCP 桥、不复用任何
   * 对话会话；结束即 `session/close`。进程照常经 AgentHost 租用（懒启动、
   * 空闲退出）。Agent 没有可供提交的工具：`req.tools` 不下发，`toolCalls`
   * 恒为空——结构化输出由调用方以「只输出 JSON」文本约定（`completeStructured`
   * 的文本 JSON 回退）。用量：各轮之和；Agent 未报 token 时仍返回零 token
   * 用量（记一行，连锁 / 后台预算按 AGENT_TURN_BUDGET_TOKENS 折算）。
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const ref = parseAgentModelRef(req.model);
    if (ref === null) {
      throw new AppError('INVALID_INPUT', `不是外部智能体的模型引用：${req.model}`);
    }
    if (req.signal?.aborted === true) throw new AppError('TIMEOUT', '补全请求已取消');
    const timeoutMs = Math.min(
      this.#deps.runTimeoutMs ?? AGENT_COMPLETE_TIMEOUT_MS,
      AGENT_COMPLETE_TIMEOUT_MS,
    );
    const handle = new ExternalRunHandle(
      {
        identity: req.identity,
        model: req.model,
        buildSystemPrompt: async () => req.systemPrompt,
        messages: req.messages,
        tools: [],
        limits: { maxTurns: AGENT_COMPLETE_MAX_TURNS },
        promptParts: {
          session: req.systemPrompt,
          run: '',
          conversation: req.messages.map((message) => message.content).join('\n\n'),
        },
        external: {
          agentId: ref.agentId,
          permission: 'read_only',
          capabilities: [],
          sessionKey: `complete:${randomUUID()}`,
          background: true,
        },
      },
      { ...this.#deps, runTimeoutMs: timeoutMs },
      this.#control,
    );
    const onAbort = () => handle.abort('completion aborted');
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      void handle.start();
      const outcome = await handle.done;
      if (outcome.status !== 'completed') {
        throw new AppError(
          outcome.status === 'cancelled' ? 'TIMEOUT' : (outcome.error?.code ?? 'AGENT_FAILED'),
          outcome.status === 'cancelled'
            ? '补全请求已取消'
            : (outcome.error?.message ?? '智能体补全失败'),
        );
      }
      const usage = outcome.usage.reduce<EngineUsage>(
        (sum, entry) => ({
          input: sum.input + entry.input,
          output: sum.output + entry.output,
          cacheRead: sum.cacheRead + entry.cacheRead,
          cacheWrite: sum.cacheWrite + entry.cacheWrite,
          costUsd: null,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
      );
      return { text: outcome.finalText, toolCalls: [], usage, stopReason: 'stop' };
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
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

/**
 * The subagent a report belongs to (claude-agent-acp stamps
 * `_meta.claudeCode.parentToolUseId` on its subagents' updates; a plain
 * `_meta.parentToolUseId` is accepted for other agents), or null for the
 * top-level model.
 */
export function parentToolUseIdOf(update: {
  _meta?: Record<string, unknown> | null;
}): string | null {
  const meta = update._meta as
    { claudeCode?: { parentToolUseId?: unknown }; parentToolUseId?: unknown } | null | undefined;
  const id = meta?.claudeCode?.parentToolUseId ?? meta?.parentToolUseId;
  return typeof id === 'string' && id.length > 0 ? id : null;
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
 * - 子代理（带 `parentToolUseId`）的调用与文本不切分、不落为步骤：调用只
 *   转成状态行 `progress`（P5）；
 * - 结束时按 stopReason 发最后一条 `assistant`，`finalText` 取自它。
 */
export class AcpEventMapper {
  #text = '';
  /** A model turn is open: the next tool_call closes it with an assistant event. */
  #turnOpen = true;
  /** Model rounds (assistant events) since the last `takeRounds()` (usage, P5). */
  #rounds = 0;
  /** Tool calls made by subagents (status line only). */
  readonly #nested = new Set<string>();
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
        // A subagent's own prose is internal to its tool call.
        if (parentToolUseIdOf(update) !== null) return [];
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
   * Model rounds closed by a tool call since the last `takeRounds()` (the
   * prompt's closing round comes on top: `#recordUsage` adds it).
   */
  get rounds(): number {
    return this.#rounds;
  }

  /** Model rounds counted since the previous call (one per assistant event). */
  takeRounds(): number {
    const rounds = this.#rounds;
    this.#rounds = 0;
    return rounds;
  }

  /**
   * A prompt ended but the run continues with a follow-up prompt (background
   * bridge results, P5): its prose becomes an interim message (stopReason
   * `toolUse`, delivered like the text before a tool call).
   */
  finishInterim(): EngineEvent[] {
    const events = this.abandon();
    const text = this.#text;
    this.#text = '';
    this.#turnOpen = true;
    if (text.trim().length > 0) {
      events.push({
        type: 'assistant',
        payload: { text, stopReason: 'toolUse', errorMessage: undefined },
      });
    }
    return events;
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
    this.#rounds += 1;
    return [event];
  }

  #onToolCall(update: ToolCallLike): EngineEvent[] {
    const id = update.toolCallId;
    // Subagent calls (design 28 §7「子代理内部调用不切分」): no turn split, no
    // step — the status line names them.
    if (this.#nested.has(id)) return [];
    if (!this.#known.has(id) && !this.#mirrored.has(id) && parentToolUseIdOf(update) !== null) {
      this.#nested.add(id);
      const title = update.title ?? update.name ?? null;
      return typeof title === 'string' && title.trim().length > 0
        ? [{ type: 'progress', payload: { text: `子任务：${title.trim()}` } }]
        : [];
    }
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
      const title = typeof update.title === 'string' ? update.title.trim() : '';
      events.push({
        type: 'tool_call',
        payload: {
          toolCallId: id,
          toolName,
          args: update.rawInput ?? {},
          // Status line text (design 28 §7): the agent's human-readable title.
          ...(title.length > 0 && title !== toolName ? { title } : {}),
        },
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

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * 引擎记在 Agent 进程里、供下一个 run 复用的会话状态（AgentLease.keepSession，
 * P5）。进程退出时随之消失。
 */
interface KeptSession {
  /** orchestrator's fingerprint (prompt, cwd, tier, model, packs, bridge name …). */
  fingerprint: string;
  /** What session/new carried (provider options, bridge, cwd): must match to reuse. */
  optionsHash: string;
  sessionKey: string;
  /** The bridge the agent connected with (token stays valid across runs). */
  bridge: { serverName: string; token: string } | null;
  expectedMode: string | null;
  expectedModeOption: { id: string; value: string } | null;
  /** Last cumulative usage the agent reported (`usageSemantics: 'session'`). */
  usage: UsageTotals | null;
}

/** Engine-wide session bookkeeping shared by the run handles. */
interface SessionControl {
  /** Sessions to discard when the run using them releases (deleted meanwhile). */
  discardOnRelease: Map<string, { deleteHistory: boolean }>;
  /** Prompts in flight per agent session (any run; steering cleanup, 审查 #6). */
  prompting: Map<string, number>;
  /** `ExternalAgentEngine.onSessionInvalidated` listeners. */
  invalidated: Set<(agentId: string, agentSessionId: string) => void>;
}

function notifyInvalidated(control: SessionControl, agentId: string, sessionId: string): void {
  for (const listener of [...control.invalidated]) {
    try {
      listener(agentId, sessionId);
    } catch {
      // A listener's failure never affects the engine.
    }
  }
}

/**
 * Where the prompt stands (steering, P5): before it is sent steers merge into
 * it; while it runs they go through `_session/steering`; between a prompt and
 * its follow-up (background bridge results) they join the follow-up.
 */
type PromptPhase = 'before' | 'prompting' | 'between' | 'done';

interface DetachedResult {
  toolName: string;
  ok: boolean;
  content: string;
  errorCode?: string;
}

function usageTotalsOf(usage: AcpPromptResponse['usage']): UsageTotals | null {
  if (usage === null || usage === undefined) return null;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    input: count(usage.inputTokens),
    output: count(usage.outputTokens),
    cacheRead: count(usage.cachedReadTokens),
    cacheWrite: count(usage.cachedWriteTokens),
  };
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Attribute-safe text (tool names come from the run's own tool set, but be strict). */
function attributeText(value: string): string {
  return value.replace(/[^\w.:-]/g, '_');
}

/**
 * Tool output inside the follow-up: a tool's text must not be able to close
 * the wrapper and pose as host text (P5 审查 #10).
 */
function fencedContent(content: string): string {
  return content.replace(/<(\/?)(tool_result|background_tool_results)/gi, '&lt;$1$2');
}

/** Follow-up prompt for background bridge results and late steers (P5). */
export function followUpText(
  results: readonly DetachedResult[],
  steers: readonly string[],
): string {
  const parts: string[] = [];
  if (results.length > 0) {
    parts.push(
      [
        '<background_tool_results>',
        '以下是之前转入后台的工具调用的结果：',
        ...results.map(
          (result) =>
            `<tool_result name="${attributeText(result.toolName)}" ok="${result.ok}"` +
            `${result.errorCode !== undefined ? ` error_code="${attributeText(result.errorCode)}"` : ''}>` +
            `\n${fencedContent(result.content)}\n</tool_result>`,
        ),
        '</background_tool_results>',
      ].join('\n'),
    );
  }
  parts.push(...steers);
  return parts.join('\n\n');
}

class ExternalRunHandle implements RunHandle {
  #spec: RunSpec;
  /** Private empty cwd of a background session (P6), removed on release. */
  #tempDir: string | null = null;
  readonly #deps: ExternalAgentEngineDeps;
  readonly #control: SessionControl;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  #mapper = new AcpEventMapper();
  readonly #usage: EngineUsage[] = [];
  /** Tokens the agent reported so far (chain budget). */
  #reportedTokens = 0;
  /** Model rounds without reported tokens (charged per round, P5). */
  #unreportedRounds = 0;
  /** Run cancellation as seen by in-flight host-bridge tool calls. */
  readonly #toolAbort = new AbortController();
  #lease: AgentLease | null = null;
  #sessionId: string | null = null;
  /** The reused session's kept state (mode `reused`). */
  #kept: KeptSession | null = null;
  #optionsHash = '';
  /** The session must not be reused (timeout, unresponsive agent, broken setup). */
  #poisoned = false;
  /** Tier / model applied (or re-confirmed on reuse): only then is the session kept. */
  #tierApplied = false;
  /** A prompt was really sent on the session. */
  #prompted = false;
  /** This run's sink (detach only removes our own registration). */
  #sinkObj: SessionSink | null = null;
  /** Background bridge calls are aborted at the run deadline (审查 #4). */
  readonly #detachedAbort = new AbortController();
  readonly #startedAt = Date.now();
  /** Cumulative usage baseline of the session (null = unknown). */
  #sessionUsage: UsageTotals | null = null;
  /** Session key + token + server bound on the host MCP bridge (null = no bridge). */
  #bridge: { sessionKey: string; token: string; session: SessionBridge } | null = null;
  /** The bridge the session carries (kept with it for the next run). */
  #bridgeInfo: { serverName: string; token: string } | null = null;
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
  #phase: PromptPhase = 'before';
  /** Steers waiting for the next prompt (before the first / between prompts). */
  readonly #queuedSteers: string[] = [];
  /** Bridge calls answered "moved to the background", still running. */
  readonly #detachedPending = new Map<string, string>();
  readonly #detachedResults: DetachedResult[] = [];
  #detachedWaiter: (() => void) | null = null;
  /**
   * What the agent's `tool_call` / `tool_call_update`s said about each call
   * (审查 H2): permission requests that carry only the id (DeepSeek Harness)
   * are completed from it before the permission bridge classifies them.
   */
  readonly #toolCalls = new Map<string, Record<string, unknown>>();
  readonly done: Promise<RunOutcome>;
  #resolveDone!: (outcome: RunOutcome) => void;

  constructor(spec: RunSpec, deps: ExternalAgentEngineDeps, control: SessionControl) {
    this.#spec = spec;
    this.#deps = deps;
    this.#control = control;
    this.#agentName = spec.external?.agentId ?? '?';
    this.done = new Promise<RunOutcome>((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.#spec.external?.background === true) {
      try {
        this.#prepareBackground();
      } catch (error) {
        this.#settle({
          status: 'failed',
          finalText: '',
          skipReply: false,
          usage: this.#usage,
          error: {
            code: 'INTERNAL',
            message: `无法创建后台会话的临时目录：${error instanceof Error ? error.message : String(error)}`,
          },
        });
        return;
      }
    }
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
        ...(external.background === true ? { oneShot: true } : {}),
        ...(this.#deps.permissions !== undefined
          ? { isolation: this.#deps.permissions.isolationFor(spec.identity, spec.workdir) }
          : {}),
      });
      phase = 'session_new';
      const opened = await this.#openSession(entry, lease, sessionOptions, acceptsImages);
      this.#sessionId = opened.sessionId;
      // Only a session that really carries the bridge may have kepcup tool
      // permission requests allowed (acp/client.ts decidePermission).
      this.#sinkObj = this.#sink(this.#bridge?.session ?? null);
      lease.attach(opened.sessionId, this.#sinkObj);
      if (this.#resolved) return;
      external.onSession?.(opened.sessionId, opened.mode);

      phase = 'other';
      if (opened.mode === 'reused') {
        // Same process, same fingerprint: tier, model and effort are still in
        // place (re-confirmed in #openSession) — re-arm the mode guard.
        this.#expectedMode = this.#kept?.expectedMode ?? null;
        this.#expectedModeOption = this.#kept?.expectedModeOption ?? null;
        this.#sessionUsage = this.#kept?.usage ?? null;
        this.#tierApplied = true;
      } else {
        await this.#applyTier(opened.sessionId, opened.modes, opened.configOptions);
        await this.#applyConfig(opened.sessionId, opened.configOptions, {
          model: parseAgentModelRef(spec.model)?.model ?? '',
          effort: external.effort ?? '',
        });
        // A restored session's earlier totals are unknown: its first report
        // only sets the baseline.
        this.#sessionUsage =
          opened.mode === 'new' ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null;
        this.#tierApplied = true;
      }
      if (this.#resolved) return;

      // A session that already holds the conversation gets the delta only
      // (and no session prompt: prompt-prefix sent it with its first prompt).
      const continued = opened.mode !== 'new';
      const steers = this.#queuedSteers.splice(0);
      let prompt = this.#promptBlocks(
        {
          session: continued || metaAppend ? '' : parts.session,
          run: parts.run,
          conversation: continued
            ? (parts.conversationDelta ?? parts.conversation)
            : parts.conversation,
        },
        acceptsImages,
        steers,
      );
      this.emit({
        type: 'request',
        payload: {
          agentId: entry.id,
          sessionId: opened.sessionId,
          session: opened.mode,
          prompt,
          ...(metaAppend && !continued && parts.session.length > 0
            ? { sessionPrompt: parts.session }
            : {}),
          ...(this.#bridge !== null ? { hostTools: spec.tools.map((tool) => tool.name) } : {}),
        },
      });
      for (const text of steers) this.emit({ type: 'steer', payload: { text } });
      phase = 'prompt';
      let response = await this.#prompt(connection, opened.sessionId, prompt);
      // Background bridge results / late steers: follow-up prompts in the
      // same run and session (P5).
      while (
        response.stopReason === 'end_turn' &&
        !this.#aborted &&
        !this.#resolved &&
        this.#terminated === null &&
        (this.#detachedPending.size > 0 ||
          this.#detachedResults.length > 0 ||
          this.#queuedSteers.length > 0)
      ) {
        for (const event of this.#mapper.finishInterim()) this.emit(event);
        await this.#awaitDetached();
        if (this.#aborted || this.#resolved) break;
        const results = this.#detachedResults.splice(0);
        const late = this.#queuedSteers.splice(0);
        // Woken with nothing to report (e.g. a steer handed back meanwhile).
        if (results.length === 0 && late.length === 0) continue;
        prompt = [{ type: 'text', text: followUpText(results, late) }];
        this.emit({
          type: 'request',
          payload: {
            agentId: entry.id,
            sessionId: opened.sessionId,
            session: 'reused',
            followUp: true,
            prompt,
          },
        });
        for (const text of late) this.emit({ type: 'steer', payload: { text } });
        response = await this.#prompt(connection, opened.sessionId, prompt);
      }
      this.#phase = 'done';
      const { events, finalText } = this.#mapper.finish(response.stopReason, {
        terminated: this.#terminated !== null,
      });
      for (const event of events) this.emit(event);
      this.#settle(this.#outcomeOf(response.stopReason, finalText));
    } catch (error) {
      // A session that failed half-way (tier refused, prompt error, timeout)
      // is not reused.
      if (this.#sessionId !== null && !this.#aborted && this.#terminated === null) {
        this.#poisoned = true;
      }
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
          ? this.#cancelledOutcome()
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
   * The session this run talks to (P5 reuse, design 28 §7): the kept session
   * of this process when it matches; else `session/resume` / `session/load`
   * of the requested one (provider and agent permitting); else a new one.
   */
  async #openSession(
    entry: AgentCatalogEntry,
    lease: AgentLease,
    sessionOptions: ReturnType<AgentProvider['sessionNew']>,
    acceptsImages: boolean,
  ): Promise<{
    sessionId: string;
    mode: AgentSessionMode;
    modes: AcpSessionModeState | null;
    configOptions: readonly AcpSessionConfigOption[];
  }> {
    const spec = this.#spec;
    const external = spec.external!;
    const provider = lease.provider;
    const serverName = external.hostServerName ?? newHostServerName();
    this.#optionsHash = hashOf({
      cwd: spec.workdir,
      meta: sessionOptions._meta ?? null,
      extra: sessionOptions.extraMcpServers ?? [],
      bridge: spec.tools.length > 0 ? serverName : null,
      tools: spec.tools.map((tool) => tool.name).sort(),
    });
    const reuse = external.session;
    const reuseId = reuse?.reuseId ?? null;
    let kept: KeptSession | undefined;
    // Open in this process (then never resumed / loaded: it is either reused
    // here or was just found unusable).
    let wasOpen = false;
    if (reuseId !== null) {
      kept = lease.openSession<KeptSession>(reuseId);
      wasOpen = kept !== undefined;
      if (
        kept !== undefined &&
        this.#control.discardOnRelease.get(reuseId) === undefined &&
        kept.fingerprint === reuse!.fingerprint &&
        kept.optionsHash === this.#optionsHash &&
        kept.sessionKey === external.sessionKey
      ) {
        // Busy sessions are never handed to another run (审查 #1): taken out of
        // the process's kept set, put back on release.
        lease.forgetSession(reuseId);
        if (await this.#reconfirmModes(lease, reuseId, kept)) {
          this.#kept = kept;
          this.#attachBridge(entry, provider, lease.init, acceptsImages, serverName, kept.bridge);
          return { sessionId: reuseId, mode: 'reused', modes: null, configOptions: [] };
        }
        // The agent refused to go back to the tier's mode: never continue it.
        if (kept.bridge !== null) this.#deps.bridge?.revoke(kept.sessionKey, kept.bridge.token);
        void this.#closeSession(lease, reuseId, false);
        notifyInvalidated(this.#control, external.agentId, reuseId);
      } else if (kept !== undefined) {
        // Kept but no longer matching (or deleted meanwhile): close it.
        lease.forgetSession(reuseId);
        if (kept.bridge !== null) this.#deps.bridge?.revoke(kept.sessionKey, kept.bridge.token);
        void this.#closeSession(lease, reuseId, false);
        notifyInvalidated(this.#control, external.agentId, reuseId);
      }
    }
    // Bound before session/new | resume | load: agents connect to their MCP
    // servers while setting the session up, and the bridge refuses sessions
    // without a run.
    const bridgeServer = this.#attachBridge(
      entry,
      provider,
      lease.init,
      acceptsImages,
      serverName,
      null,
    );
    const mcpServers = [
      ...(bridgeServer !== null ? [bridgeServer] : []),
      ...(sessionOptions.extraMcpServers ?? []),
    ];
    const meta = sessionOptions._meta !== undefined ? { _meta: sessionOptions._meta } : {};
    if (reuseId !== null && !wasOpen) {
      const caps = lease.init.agentCapabilities;
      const canResume = provider.features.resume && caps?.sessionCapabilities?.resume != null;
      const canLoad = provider.features.loadSession && caps?.loadSession === true;
      if (canResume || canLoad) {
        const request = { sessionId: reuseId, cwd: spec.workdir!, mcpServers, ...meta };
        try {
          const restored = canResume
            ? await lease.connection.resumeSession(request)
            : await lease.connection.loadSession(request);
          return {
            sessionId: reuseId,
            mode: canResume ? 'resumed' : 'loaded',
            modes: restored.modes ?? null,
            configOptions: restored.configOptions ?? [],
          };
        } catch (error) {
          // Gone on the agent's side (history deleted, other machine …):
          // start over; the prompt then carries the full context.
          this.#warn(
            {
              runId: spec.identity.runId,
              agentSessionId: reuseId,
              error: error instanceof Error ? error.message : String(error),
            },
            'agent session could not be restored; starting a new one',
          );
        }
      }
    }
    const session = await lease.connection.newSession({
      cwd: spec.workdir!,
      mcpServers,
      ...meta,
    });
    return {
      sessionId: session.sessionId,
      mode: 'new',
      modes: session.modes ?? null,
      configOptions: session.configOptions ?? [],
    };
  }

  /**
   * Binds this run on the host MCP bridge and returns the `mcpServers` entry,
   * or null when no host tool is injected (no tools, no bridge, or an agent
   * without http MCP — the stdio proxy is not wired yet, P2). `kept` = the
   * reused session's bridge: its token stays, the new run is bound to it.
   */
  #attachBridge(
    entry: AgentCatalogEntry,
    provider: AgentProvider,
    init: AcpInitializeResponse,
    acceptsImages: boolean,
    serverName: string,
    kept: { serverName: string; token: string } | null,
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
    const name = kept?.serverName ?? serverName;
    // Session-level token (P5): issued when the session is set up (new /
    // resumed / loaded — re-issuing revokes the key's previous token), kept
    // while the session lives in the agent process.
    const token = kept?.token ?? bridge.issueSessionToken(sessionKey);
    const detachMs =
      provider.bridgeToolDetachMs === undefined
        ? AGENT_BRIDGE_TOOL_DETACH_MS
        : provider.bridgeToolDetachMs;
    bridge.bindRun(sessionKey, {
      identity: spec.identity,
      tools: spec.tools,
      signal: this.#toolAbort.signal,
      acceptsImages,
      detachAfterMs: detachMs,
      meta: (toolName) => bridgeToolMeta(toolName, entry),
      onToolCall: (call) => {
        for (const event of this.#mapper.hostToolCall(call)) this.emit(event);
      },
      onToolResult: (result) => {
        for (const event of this.#mapper.hostToolResult(result)) this.emit(event);
      },
      detachedSignal: this.#detachedAbort.signal,
      onToolDetached: (call) => {
        this.#detachedPending.set(call.toolCallId, call.toolName);
        this.emit({
          type: 'progress',
          payload: { text: `工具「${call.toolName}」转入后台，完成后结果会再交给智能体` },
        });
      },
      onDetachedResult: (result) => this.#onDetachedResult(result),
      progress: (text) => this.emit({ type: 'progress', payload: { text } }),
      onTerminate: (reason) => this.#terminate(reason),
    });
    const sessionBridge: SessionBridge = {
      serverName: name,
      toolNames: new Set(spec.tools.map((tool) => tool.name)),
    };
    this.#bridge = { sessionKey, token, session: sessionBridge };
    this.#bridgeInfo = { serverName: name, token };
    // The agent's own updates about bridge tools are mirrors: drop them.
    this.#mapper = new AcpEventMapper({
      hostToolOf: (update) => hostBridgeToolOf(update, provider, sessionBridge),
    });
    return {
      type: 'http',
      name,
      url: bridge.url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
  }

  /**
   * A reused session goes back to the tier's mode before its prompt
   * (idempotent `set_mode` / `set_config_option`, 审查 #1): whatever happened
   * to it between runs, the run starts in the expected mode. False = the
   * agent refused — the session is dropped and a new one created.
   */
  async #reconfirmModes(lease: AgentLease, sessionId: string, kept: KeptSession): Promise<boolean> {
    try {
      if (kept.expectedMode !== null) {
        if (isForbiddenAgentMode(kept.expectedMode, lease.provider)) return false;
        await lease.connection.setMode(sessionId, kept.expectedMode);
      }
      if (kept.expectedModeOption !== null) {
        if (isForbiddenAgentMode(kept.expectedModeOption.value, lease.provider)) return false;
        await lease.connection.setConfigOption(
          sessionId,
          kept.expectedModeOption.id,
          kept.expectedModeOption.value,
        );
      }
      return true;
    } catch (error) {
      this.#warn(
        {
          runId: this.#spec.identity.runId,
          agentSessionId: sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'kept agent session refused its permission mode; starting a new one',
      );
      return false;
    }
  }

  /** One `session/prompt` (with the run timeout) and its usage. */
  async #prompt(
    connection: AgentLease['connection'],
    sessionId: string,
    prompt: AcpContentBlock[],
  ): Promise<AcpPromptResponse> {
    this.#phase = 'prompting';
    if (!this.#prompted) {
      this.#prompted = true;
      this.#spec.external?.onPromptSent?.();
    }
    const prompting = this.#control.prompting;
    prompting.set(sessionId, (prompting.get(sessionId) ?? 0) + 1);
    try {
      const response = await this.#withRunTimeout(connection.prompt(sessionId, prompt));
      this.#recordUsage(response);
      return response;
    } finally {
      const left = (prompting.get(sessionId) ?? 1) - 1;
      if (left > 0) prompting.set(sessionId, left);
      else prompting.delete(sessionId);
      if (this.#phase === 'prompting') this.#phase = 'between';
    }
  }

  /**
   * Usage of one prompt (design 28 §8): the agent's report (per session →
   * diffed, or per turn, `provider.usageSemantics`); without one, one zero
   * entry per model round (the ledger counts the rounds; the chain budget
   * charges AGENT_TURN_BUDGET_TOKENS each).
   */
  #recordUsage(response: AcpPromptResponse): void {
    // Rounds closed by tool calls + the prompt's closing round.
    const rounds = this.#mapper.takeRounds() + 1;
    const reported = usageTotalsOf(response.usage);
    let delta: UsageTotals | null = null;
    if (reported !== null) {
      if ((this.#provider?.usageSemantics ?? 'session') === 'turn') {
        delta = reported;
      } else {
        const base = this.#sessionUsage;
        // Only the input + output total counts (cache fields come and go, 审查 #16).
        const restarted =
          base !== null && reported.input + reported.output < base.input + base.output;
        delta =
          base === null
            ? null
            : restarted
              ? reported
              : {
                  input: Math.max(0, reported.input - base.input),
                  output: Math.max(0, reported.output - base.output),
                  cacheRead: Math.max(0, reported.cacheRead - base.cacheRead),
                  cacheWrite: Math.max(0, reported.cacheWrite - base.cacheWrite),
                };
        this.#sessionUsage = reported;
      }
    }
    if (delta !== null && delta.input + delta.output > 0) {
      this.#usage.push({
        input: delta.input,
        output: delta.output,
        cacheRead: delta.cacheRead,
        cacheWrite: delta.cacheWrite,
        costUsd: null,
      });
      this.#reportedTokens += delta.input + delta.output;
      return;
    }
    for (let round = 0; round < rounds; round += 1) {
      this.#usage.push({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });
    }
    this.#unreportedRounds += rounds;
  }

  /** A background bridge call finished: its result joins the next follow-up. */
  #onDetachedResult(result: BridgeToolResultEvent): void {
    if (!this.#detachedPending.delete(result.toolCallId)) return;
    if (this.#resolved) return;
    // errorCode reaches the agent in the follow-up; a terminating result
    // (skip_reply) no longer ends the run — the agent already moved on and
    // decides itself (审查 #11).
    this.#detachedResults.push({
      toolName: result.toolName,
      ok: result.ok,
      content: result.content,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    });
    this.emit({
      type: 'progress',
      payload: { text: `后台工具「${result.toolName}」已完成` },
    });
    if (this.#detachedPending.size === 0) this.#wakeDetached();
  }

  /**
   * Resolves once every background bridge call answered, a steer is queued
   * (it is answered without waiting for the tools), the run ends, or the run
   * deadline passes — then the remaining calls are aborted and reported as
   * timed out (审查 #4).
   */
  async #awaitDetached(): Promise<void> {
    if (this.#detachedPending.size === 0 || this.#aborted || this.#resolved) return;
    if (this.#queuedSteers.length > 0) return;
    const deadline = this.#startedAt + (this.#deps.runTimeoutMs ?? AGENT_RUN_TIMEOUT_MS);
    let timer: NodeJS.Timeout | null = null;
    await new Promise<void>((resolve) => {
      this.#detachedWaiter = resolve;
      timer = setTimeout(
        () => {
          this.#detachedAbort.abort();
          for (const [, toolName] of this.#detachedPending) {
            this.#detachedResults.push({
              toolName,
              ok: false,
              content: '后台执行超时，已取消（超过本次执行的时间上限）',
              errorCode: 'TIMEOUT',
            });
          }
          this.#detachedPending.clear();
          this.#wakeDetached();
        },
        Math.max(0, deadline - Date.now()),
      );
      timer.unref?.();
    });
    if (timer !== null) clearTimeout(timer);
  }

  #wakeDetached(): void {
    const waiter = this.#detachedWaiter;
    this.#detachedWaiter = null;
    waiter?.();
  }

  /**
   * A terminating tool (skip_reply) returned through the bridge: cancel the
   * prompt; the run settles completed without a final message (design 28
   * §4.4, todo §13「skip_reply 与取消」).
   */
  #terminate(reason: string): void {
    if (this.#terminated !== null || this.#aborted || this.#resolved) return;
    this.#terminated = reason;
    if (this.#phase !== 'prompting') {
      this.#settle(this.#terminatedOutcome());
      this.#wakeDetached();
      return;
    }
    this.#cancelPrompt(() => this.#terminatedOutcome());
  }

  #terminatedOutcome(): RunOutcome {
    return { status: 'completed', finalText: '', skipReply: true, usage: this.#usage };
  }

  #cancelledOutcome(): RunOutcome {
    return { status: 'cancelled', finalText: '', skipReply: false, usage: this.#usage };
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
      // An agent that ignores session/cancel is not trusted with the next run.
      this.#poisoned = true;
      this.#settle(onGrace());
      this.#release();
    }, this.#deps.cancelGraceMs ?? AGENT_CANCEL_GRACE_MS);
    this.#graceTimer.unref?.();
  }

  /**
   * Queues the text for the running loop (P5, design 28 §7): before the
   * prompt / between prompts it joins the next one; while the prompt runs it
   * is injected through `_session/steering` when the provider supports it
   * (asynchronous — a refusal hands it back via `RunSpec.onSteerRejected`).
   */
  steer(text: string): boolean {
    if (this.#resolved || this.#aborted || this.#terminated !== null) return false;
    switch (this.#phase) {
      case 'before':
      case 'between':
        this.#queuedSteers.push(text);
        // Waiting for background tools: answer the steer now (审查 #4).
        if (this.#phase === 'between') this.#wakeDetached();
        return true;
      case 'done':
        return false;
      case 'prompting': {
        const lease = this.#lease;
        const sessionId = this.#sessionId;
        if (lease === null || sessionId === null) return false;
        if (!lease.provider.features.steering || !advertisesSteering(lease.init)) return false;
        void this.#sendSteering(lease, sessionId, text);
        return true;
      }
    }
  }

  async #sendSteering(lease: AgentLease, sessionId: string, text: string): Promise<void> {
    try {
      const response = await lease.connection.extMethod(ACP_STEERING_METHOD, {
        sessionId,
        prompt: [{ type: 'text', text }],
        // Never let the agent start a turn of its own (output outside any run).
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      });
      const outcome = (response as { outcome?: unknown } | null | undefined)?.outcome;
      if (outcome === 'injected') {
        this.emit({ type: 'steer', payload: { text } });
        return;
      }
      if (outcome === 'startedNewTurn' && (this.#control.prompting.get(sessionId) ?? 0) === 0) {
        // codex-acp 2.1.1 ignores idleBehavior and starts a detached turn when
        // none is running: stop it — it belongs to no run. Never when a prompt
        // (this run's follow-up or a later run) is in flight (审查 #6).
        void lease.connection.cancel(sessionId).catch(() => undefined);
      }
      this.#warn(
        { runId: this.#spec.identity.runId, outcome: String(outcome) },
        'agent did not take the steer; handing it back',
      );
    } catch (error) {
      this.#warn(
        {
          runId: this.#spec.identity.runId,
          error: error instanceof Error ? error.message : String(error),
        },
        'steering failed; handing the message back',
      );
    }
    this.#steerRejected(text);
  }

  #steerRejected(text: string): void {
    // Still before a follow-up of this run: answer it there.
    if (!this.#resolved && !this.#aborted && this.#phase === 'between') {
      this.#queuedSteers.push(text);
      return;
    }
    this.#spec.onSteerRejected?.(text);
  }

  abort(_reason: string): void {
    if (this.#aborted || this.#resolved) return;
    this.#aborted = true;
    // In-flight host-bridge calls observe the cancellation (ToolContext.signal).
    this.#toolAbort.abort();
    if (this.#phase !== 'prompting' || this.#lease === null || this.#sessionId === null) {
      // No prompt in flight: start() notices #resolved at its next step.
      this.#settle(this.#cancelledOutcome());
      this.#wakeDetached();
      return;
    }
    this.#cancelPrompt(() => this.#cancelledOutcome());
  }

  onEvent(listener: (e: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  tokensSoFar(): number {
    // Rounds of the running prompt are charged until its usage arrives.
    const running = this.#phase === 'prompting' ? this.#mapper.rounds + 1 : 0;
    return this.#reportedTokens + (this.#unreportedRounds + running) * AGENT_TURN_BUDGET_TOKENS;
  }

  emit(event: EngineEvent): void {
    if (this.#resolved) return;
    for (const listener of [...this.#listeners]) listener(event);
  }

  /**
   * Background session (P6, `external.background`): read-only tier, a fresh
   * private empty directory as cwd (never the user's workspace / project),
   * no session reuse. Permission requests skip the permission bridge (see
   * `#sink`): only this run's bridge tools are allowed, nothing asks the user.
   */
  #prepareBackground(): void {
    const { session: _session, ...external } = this.#spec.external!;
    void _session;
    // mkdtemp creates the directory 0700 (owner only).
    this.#tempDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-agent-bg-'));
    this.#spec = {
      ...this.#spec,
      workdir: this.#tempDir,
      external: { ...external, permission: 'read_only' },
    };
  }

  #sink(bridge: SessionBridge | null): SessionSink {
    // Background sessions never reach the permission bridge (no approval
    // card for unattended loops): the P1 rule decides — this run's bridge
    // tools only, everything else rejected.
    const permissions =
      this.#spec.external?.background === true ? undefined : this.#deps.permissions;
    return {
      bridge,
      onUpdate: (update) => {
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          this.#noteToolCall(update);
        }
        if (update.sessionUpdate === 'current_mode_update') {
          this.#onModeUpdate(update.currentModeId);
        } else if (update.sessionUpdate === 'config_option_update') {
          this.#onConfigOptionUpdate(update.configOptions);
        }
        for (const event of this.#mapper.map(update)) this.emit(event);
      },
      onPermission: (title, decision) => this.#notePermission(title, decision),
      ...(permissions !== undefined
        ? {
            requestPermission: (request: AcpRequestPermissionRequest) =>
              permissions.decide(this.#enrichPermission(request), {
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
            ? this.#cancelledOutcome()
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
        this.#wakeDetached();
      },
    };
  }

  /** Upper bound of remembered tool calls per run (oldest dropped). */
  static readonly MAX_TOOL_CALLS_KEPT = 500;

  #noteToolCall(update: ToolCallLike): void {
    const known = this.#toolCalls.get(update.toolCallId) ?? {};
    for (const key of [
      'kind',
      'title',
      'name',
      'rawInput',
      'locations',
      'content',
      '_meta',
    ] as const) {
      const value = (update as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) known[key] = value;
    }
    this.#toolCalls.delete(update.toolCallId);
    this.#toolCalls.set(update.toolCallId, known);
    if (this.#toolCalls.size > ExternalRunHandle.MAX_TOOL_CALLS_KEPT) {
      const oldest = this.#toolCalls.keys().next().value;
      if (oldest !== undefined) this.#toolCalls.delete(oldest);
    }
  }

  /**
   * ACP defines the request's `toolCall` as a ToolCallUpdate (only changed
   * fields): fill in what the call's earlier updates said; the request's own
   * fields win.
   */
  #enrichPermission(request: AcpRequestPermissionRequest): AcpRequestPermissionRequest {
    const known = this.#toolCalls.get(request.toolCall.toolCallId);
    if (known === undefined) return request;
    const own = Object.fromEntries(
      Object.entries(request.toolCall).filter(([, value]) => value !== undefined && value !== null),
    );
    return { ...request, toolCall: { ...known, ...own } as typeof request.toolCall };
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
    // Requests carrying only the id (dsh): name the call by its earlier title.
    const known = this.#toolCalls.get(title)?.title;
    if (typeof known === 'string' && known.length > 0) title = known;
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
    if (expected === null || modeId === expected) return;
    if (this.#resolved) {
      // After settling nobody switches it back: the session is not kept.
      this.#poisoned = true;
      return;
    }
    this.#revertMode(modeId, expected, (lease, sessionId) =>
      lease.connection.setMode(sessionId, expected),
    );
  }

  /** The same through the `mode` config option (Codex exposes both). */
  #onConfigOptionUpdate(options: readonly AcpSessionConfigOption[]): void {
    const expected = this.#expectedModeOption;
    if (expected === null) return;
    const option = options.find((candidate) => candidate.id === expected.id);
    if (option === undefined || typeof option.currentValue !== 'string') return;
    if (option.currentValue === expected.value) return;
    if (this.#resolved) {
      this.#poisoned = true;
      return;
    }
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
      this.#poisoned = true;
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
      this.#poisoned = true;
      this.abort('permission mode could not be restored');
    });
  }

  async #fallbackPromptParts(): Promise<NonNullable<RunSpec['promptParts']>> {
    return {
      session: await this.#spec.buildSystemPrompt(),
      run: '',
      conversation: this.#spec.messages.map((message) => message.content).join('\n\n'),
    };
  }

  #promptBlocks(
    parts: { session: string; run: string; conversation: string },
    acceptsImages: boolean,
    steers: readonly string[] = [],
  ): AcpContentBlock[] {
    // Steers that arrived before the prompt was sent ride along (P5).
    const text = [parts.session, parts.run, parts.conversation, ...steers]
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
    // No bridge call is accepted for a settled run, even before release (审查 #9).
    if (this.#bridge !== null) {
      this.#deps.bridge?.unbindRun(this.#bridge.sessionKey, this.#spec.identity.runId);
    }
    this.#resolveDone(outcome);
  }

  /**
   * Detaches the session (later updates are out-of-run) and frees the lease.
   * With session reuse (P5) the session stays open in the agent process and
   * its bridge token stays valid; otherwise (or when it is poisoned / deleted
   * meanwhile) it is closed and the token revoked.
   */
  #release(): void {
    // The run is over: bridge calls still running see the abort, later ones
    // are refused (no run).
    this.#toolAbort.abort();
    this.#phase = 'done';
    this.#wakeDetached();
    // Steers that never reached a prompt go back to the orchestrator.
    for (const text of this.#queuedSteers.splice(0)) this.#spec.onSteerRejected?.(text);
    if (this.#tempDir !== null) {
      const dir = this.#tempDir;
      this.#tempDir = null;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        this.#warn(
          { dir, error: error instanceof Error ? error.message : String(error) },
          'removing the background session directory failed',
        );
      }
    }
    const lease = this.#lease;
    const sessionId = this.#sessionId;
    const discard = sessionId !== null ? this.#control.discardOnRelease.get(sessionId) : undefined;
    if (sessionId !== null && discard !== undefined)
      this.#control.discardOnRelease.delete(sessionId);
    const reusable = this.#spec.external?.session !== undefined;
    const keep =
      lease !== null &&
      sessionId !== null &&
      reusable &&
      !this.#poisoned &&
      this.#tierApplied &&
      this.#prompted &&
      discard === undefined;
    const bound = this.#bridge;
    if (bound !== null) {
      this.#bridge = null;
      // Scoped to this run / token: a later run on the same key keeps its own.
      this.#deps.bridge?.unbindRun(bound.sessionKey, this.#spec.identity.runId);
      if (!keep) this.#deps.bridge?.revoke(bound.sessionKey, bound.token);
    }
    if (lease === null) return;
    this.#lease = null;
    if (sessionId !== null) {
      lease.detach(sessionId, this.#sinkObj ?? undefined);
      if (keep) {
        lease.keepSession(sessionId, {
          fingerprint: this.#spec.external!.session!.fingerprint,
          optionsHash: this.#optionsHash,
          sessionKey: this.#spec.external!.sessionKey,
          bridge: this.#bridgeInfo,
          expectedMode: this.#expectedMode,
          expectedModeOption: this.#expectedModeOption,
          usage: this.#sessionUsage,
        } satisfies KeptSession);
      } else {
        lease.forgetSession(sessionId);
        void this.#closeSession(lease, sessionId, discard?.deleteHistory === true);
        // Its agent_sessions row must not be reused / resumed either.
        if (reusable && discard === undefined) {
          notifyInvalidated(this.#control, this.#spec.external!.agentId, sessionId);
        }
      }
    }
    lease.release();
  }

  /** Closes (or deletes) a session the agent supports closing; best effort. */
  async #closeSession(lease: AgentLease, sessionId: string, deleteHistory: boolean): Promise<void> {
    await closeAgentSession(lease.connection, lease.init, sessionId, deleteHistory, (error) =>
      this.#warn({ sessionId, error }, 'closing the agent session failed'),
    );
  }
}

/** `session/delete` (when wanted and supported) else `session/close` (when supported). */
async function closeAgentSession(
  connection: AgentLease['connection'],
  init: AcpInitializeResponse,
  sessionId: string,
  deleteHistory: boolean,
  onError: (message: string) => void,
): Promise<void> {
  const caps = init.agentCapabilities?.sessionCapabilities;
  try {
    if (deleteHistory && caps?.delete != null) await connection.deleteSession(sessionId);
    else if (caps?.close != null) await connection.closeSession(sessionId);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}
