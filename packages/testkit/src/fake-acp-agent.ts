/**
 * 剧本化的假 ACP 智能体（todo/acp-external-agents.md §4.1，D72）。
 *
 * 基于 SDK 的 `AgentSideConnection`：按剧本发 `session/update`、发起
 * `request_permission` 与任意 Agent→客户端请求，模拟取消、崩溃、
 * `auth_required`、自主 turn（run 外输出）、`session/load` 重放与 steering
 * 扩展。两种接法：
 * - 进程内：`startFakeAcpAgent(script)` 返回字节通道（单测 / 契约测试）；
 * - 子进程：`bin/fake-acp-agent.mjs <script.json> [record.jsonl]`（Electron 的
 *   Node 以 `ELECTRON_RUN_AS_NODE=1` 运行，直接加载本 .ts——Node 内置类型
 *   擦除），观测记录写 JSONL 供测试读取。
 *
 * 因为要被 Node 直接加载（类型擦除只对 node_modules 之外的文件生效）：本文件
 * 只用可擦除的 TS 语法（无 enum / namespace / 参数属性）、不 import 相对模块
 * （Node 不做 `.js` → `.ts` 解析），类型只用 `import type`；守卫测试见
 * packages/testkit/test/fake-acp-agent.test.ts。剧本是纯 JSON 数据。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  AuthMethod,
  ContentBlock,
  InitializeRequest,
  PermissionOption,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolKind,
} from '@agentclientprotocol/sdk';

export type FakeAgentAction =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'tool_call';
      id: string;
      title: string;
      name?: string;
      kind?: ToolKind;
      input?: unknown;
    }
  | { type: 'tool_result'; id: string; status?: 'completed' | 'failed'; output: string }
  | {
      type: 'plan';
      entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
    }
  /** Agent→client `session/request_permission`; the outcome is recorded. */
  | {
      type: 'permission';
      toolCallId: string;
      title: string;
      name?: string;
      /**
       * Structured name of a tool on the session's host bridge
       * (`mcp__{bridge server}__{tool}`; the bridge name is per session).
       */
      bridgeTool?: string;
      options?: PermissionOption[];
      /** ACP tool kind (read / edit / execute …); omitted = none given. */
      kind?: ToolKind;
      /** `toolCall.locations` (paths relative to the session cwd are resolved). */
      locations?: string[];
      rawInput?: unknown;
      /**
       * Send only `{toolCallId}` (+ options) like DeepSeek Harness: the host
       * must fill kind / title / input from the call's earlier updates.
       */
      bare?: boolean;
    }
  /** Emits `steered: <text>` for every steer injected into this session so far. */
  | { type: 'echo_steers' }
  /** The agent changes its own permission mode (`current_mode_update`). */
  | { type: 'mode_update'; modeId: string }
  /** The agent pushes its config options (`config_option_update`, e.g. the `mode` option). */
  | { type: 'config_update'; configOptions: SessionConfigOption[] }
  /**
   * A native tool really writes a file (relative to the session cwd) — the
   * agent's own tools bypass the host, like real agents do.
   */
  | { type: 'write_file'; path: string; content: string }
  /** Any Agent→client request (extension method, fs/*, terminal/*); result or error recorded. */
  | { type: 'request'; method: string; params?: Record<string, unknown> }
  /** Agent→client notification (e.g. `_auth/status_update`). */
  | { type: 'notify'; method: string; params?: Record<string, unknown> }
  /** The prompt request fails with this JSON-RPC error (e.g. a vendor "no API key"). */
  | { type: 'fail'; code: number; message: string }
  /** Blocks the turn until `session/cancel` arrives; the turn then ends `cancelled`. */
  | { type: 'wait_cancel' }
  | { type: 'sleep'; ms: number }
  /** The agent process dies mid-turn. */
  | { type: 'crash'; code?: number }
  /** Output after the prompt already returned (autonomous turn / out-of-run updates). */
  | { type: 'after_turn'; delayMs?: number; actions: FakeAgentAction[] }
  /**
   * Calls a tool on an MCP server the session was given (`session/new.mcpServers`,
   * Streamable HTTP, plain fetch): initialize → tools/call. Like real agents it
   * first reports the call as an ACP `tool_call` (`mirror`, default on, named
   * `mcp__{server}__{tool}` unless `mirrorName` says otherwise) and its result
   * as a `tool_call_update`. `token` replaces the bearer token (forged token).
   */
  | {
      type: 'mcp_call';
      id: string;
      tool: string;
      args?: Record<string, unknown>;
      server?: string;
      mirror?: boolean;
      mirrorName?: string;
      /**
       * Where the mirror carries the structured name (Claude:
       * `_meta.claudeCode.toolName`; Codex: rawInput `{server, tool, arguments}`;
       * Antigravity: `_meta.mcp.{server,tool}`; Cursor: rawInput
       * `{providerIdentifier, toolName, args}`; `opaque`: nowhere — only a
       * free-text title, like OpenCode).
       */
      mirrorNameIn?:
        | 'name'
        | 'claude_meta'
        | 'codex_raw_input'
        | 'antigravity_meta'
        | 'cursor_raw_input'
        | 'opaque';
      token?: string;
      /** Only report the mirror updates, never call the server (a fake "bridge" tool). */
      skipCall?: boolean;
    }
  /** `tools/list` on a session MCP server (recorded with names + descriptions). */
  | { type: 'mcp_list'; server?: string }
  /** Runs lanes concurrently, each lane in order (parallel tool calls of one model turn). */
  | { type: 'parallel'; lanes: FakeAgentAction[][] };

export interface FakeAgentTurn {
  actions: FakeAgentAction[];
  stopReason?: StopReason;
  /** `PromptResponse.usage` (ACP unstable field). */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
}

export interface FakeAgentScript {
  agentInfo?: { name: string; version: string };
  authMethods?: AuthMethod[];
  /** `session/new` fails with ACP `auth_required` (-32000). */
  requireAuth?: boolean;
  promptCapabilities?: { image?: boolean };
  /**
   * Advertises `_meta.steering.supported` and accepts `_session/steering`:
   * `injected` while a prompt of the session runs, else `promptRequired`
   * (as claude-agent-acp with `idleBehavior:'promptRequired'`).
   */
  steering?: boolean;
  /** Forces the steering answer (`error` = JSON-RPC error). */
  steeringOutcome?: 'injected' | 'promptRequired' | 'startedNewTurn' | 'error';
  /** Delays the steering answer (it may then arrive after the prompt ended). */
  steeringDelayMs?: number;
  /** `session/set_mode` to these ids fails (an agent refusing a mode). */
  rejectModes?: string[];
  /** `session/set_mode` to these ids is never answered (an agent hanging). */
  hangModes?: string[];
  /** Delays every `session/set_mode` answer. */
  modeDelayMs?: number;
  /** Delays the `session/new` answer (the session is recorded first). */
  newSessionDelayMs?: number;
  /** Advertises `sessionCapabilities.close`. */
  sessionClose?: boolean;
  /** Advertises `sessionCapabilities.resume` (`session/resume`). */
  resume?: boolean;
  /** Advertises `sessionCapabilities.delete` (`session/delete`). */
  sessionDelete?: boolean;
  configOptions?: SessionConfigOption[];
  modes?: SessionModeState;
  /** Advertises `loadSession`; `session/load` replays these updates. */
  history?: FakeAgentAction[];
  /** Consumed one per `session/prompt`, across sessions. */
  turns: Array<FakeAgentTurn | FakeAgentTurnBuilder>;
}

/** One recorded thing the agent observed (JSONL line in subprocess mode). */
export type FakeAgentEvent =
  | { kind: 'initialize'; params: InitializeRequest }
  | { kind: 'new_session'; sessionId: string; cwd: string; mcpServers: unknown[]; meta: unknown }
  | { kind: 'load_session'; sessionId: string; cwd: string; mcpServers: unknown[] }
  | { kind: 'resume_session'; sessionId: string; cwd: string; mcpServers: unknown[] }
  | { kind: 'delete_session'; sessionId: string }
  | { kind: 'prompt'; sessionId: string; text: string; blocks: ContentBlock[] }
  | { kind: 'cancel'; sessionId: string }
  | { kind: 'permission'; toolCallId: string; outcome: RequestPermissionOutcome }
  | {
      kind: 'request';
      method: string;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { kind: 'config'; sessionId: string; configId: string; value: unknown }
  | { kind: 'mode'; sessionId: string; modeId: string }
  | { kind: 'close_session'; sessionId: string }
  | { kind: 'emitted'; sessionId: string; update: string }
  | { kind: 'steering'; params: Record<string, unknown> }
  /** A request the agent made to a session MCP server (P2 host bridge). */
  | {
      kind: 'mcp';
      sessionId: string;
      method: 'tools/call' | 'tools/list';
      tool?: string;
      ok: boolean;
      /** HTTP status of a refused request. */
      status?: number;
      /** tools/call: the CallToolResult; tools/list: name + description list. */
      result?: unknown;
      error?: string;
    }
  /** ACP `authenticate` / `logout`（D72 P4 登录与退出）。 */
  | { kind: 'authenticate'; methodId: string }
  | { kind: 'logout' }
  /** `session/new` refused with `auth_required` (`requireAuth`). */
  | { kind: 'session_rejected'; cwd: string };

export interface FakeAgentObservation {
  events: FakeAgentEvent[];
  initialize: InitializeRequest | null;
  sessions: Array<{ sessionId: string; cwd: string; mcpServers: unknown[]; meta: unknown }>;
  prompts: Array<{ sessionId: string; text: string; blocks: ContentBlock[] }>;
  cancels: string[];
  permissions: Array<{ toolCallId: string; outcome: RequestPermissionOutcome }>;
  requests: Array<{
    method: string;
    result?: unknown;
    error?: { code: number; message: string };
  }>;
  configSets: Array<{ sessionId: string; configId: string; value: unknown }>;
  closedSessions: string[];
  loadedSessions: string[];
  resumedSessions: Array<{ sessionId: string; mcpServers: unknown[] }>;
  deletedSessions: string[];
  /** `_session/steering` requests (params verbatim). */
  steerings: Array<Record<string, unknown>>;
  /** Every session/update the agent sent (in order), with its session id. */
  emitted: Array<{ sessionId: string; update: string }>;
  /** MCP requests the agent made to session MCP servers. */
  mcp: Array<Extract<FakeAgentEvent, { kind: 'mcp' }>>;
}

export function emptyObservation(): FakeAgentObservation {
  return {
    events: [],
    initialize: null,
    sessions: [],
    prompts: [],
    cancels: [],
    permissions: [],
    requests: [],
    configSets: [],
    closedSessions: [],
    loadedSessions: [],
    resumedSessions: [],
    deletedSessions: [],
    steerings: [],
    emitted: [],
    mcp: [],
  };
}

export function observe(observation: FakeAgentObservation, event: FakeAgentEvent): void {
  observation.events.push(event);
  switch (event.kind) {
    case 'initialize':
      observation.initialize = event.params;
      return;
    case 'new_session':
      observation.sessions.push({
        sessionId: event.sessionId,
        cwd: event.cwd,
        mcpServers: event.mcpServers,
        meta: event.meta,
      });
      return;
    case 'prompt':
      observation.prompts.push({
        sessionId: event.sessionId,
        text: event.text,
        blocks: event.blocks,
      });
      return;
    case 'cancel':
      observation.cancels.push(event.sessionId);
      return;
    case 'permission':
      observation.permissions.push({ toolCallId: event.toolCallId, outcome: event.outcome });
      return;
    case 'request':
      observation.requests.push({
        method: event.method,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      return;
    case 'config':
      observation.configSets.push({
        sessionId: event.sessionId,
        configId: event.configId,
        value: event.value,
      });
      return;
    case 'close_session':
      observation.closedSessions.push(event.sessionId);
      return;
    case 'load_session':
      observation.loadedSessions.push(event.sessionId);
      return;
    case 'resume_session':
      observation.resumedSessions.push({
        sessionId: event.sessionId,
        mcpServers: event.mcpServers,
      });
      return;
    case 'delete_session':
      observation.deletedSessions.push(event.sessionId);
      return;
    case 'steering':
      observation.steerings.push(event.params);
      return;
    case 'emitted':
      observation.emitted.push({ sessionId: event.sessionId, update: event.update });
      return;
    case 'mcp':
      observation.mcp.push(event);
      return;
    default:
      return;
  }
}

/** Reads the JSONL record a subprocess agent wrote. */
export function readFakeAgentRecord(recordPath: string): FakeAgentObservation {
  const observation = emptyObservation();
  let text: string;
  try {
    text = readFileSync(recordPath, 'utf8');
  } catch {
    return observation;
  }
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) observe(observation, JSON.parse(line) as FakeAgentEvent);
  }
  return observation;
}

// ---------------------------------------------------------------------------
// Turn builder (mock-llm `step()` style; serializes to plain JSON data)
// ---------------------------------------------------------------------------

export class FakeAgentTurnBuilder {
  readonly actions: FakeAgentAction[] = [];
  stopReason: StopReason = 'end_turn';
  usageReport: FakeAgentTurn['usage'] = undefined;

  text(text: string): this {
    this.actions.push({ type: 'text', text });
    return this;
  }
  thought(text: string): this {
    this.actions.push({ type: 'thought', text });
    return this;
  }
  toolCall(
    id: string,
    title: string,
    options: { name?: string; kind?: ToolKind; input?: unknown } = {},
  ): this {
    this.actions.push({ type: 'tool_call', id, title, ...options });
    return this;
  }
  toolResult(id: string, output: string, status: 'completed' | 'failed' = 'completed'): this {
    this.actions.push({ type: 'tool_result', id, output, status });
    return this;
  }
  plan(entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): this {
    this.actions.push({ type: 'plan', entries });
    return this;
  }
  permission(
    toolCallId: string,
    title: string,
    extra: {
      name?: string;
      bridgeTool?: string;
      options?: PermissionOption[];
      kind?: ToolKind;
      locations?: string[];
      rawInput?: unknown;
      bare?: boolean;
    } = {},
  ): this {
    this.actions.push({ type: 'permission', toolCallId, title, ...extra });
    return this;
  }
  modeUpdate(modeId: string): this {
    this.actions.push({ type: 'mode_update', modeId });
    return this;
  }
  configUpdate(configOptions: SessionConfigOption[]): this {
    this.actions.push({ type: 'config_update', configOptions });
    return this;
  }
  writeFile(filePath: string, content: string): this {
    this.actions.push({ type: 'write_file', path: filePath, content });
    return this;
  }
  fail(code: number, message: string): this {
    this.actions.push({ type: 'fail', code, message });
    return this;
  }
  notify(method: string, params?: Record<string, unknown>): this {
    this.actions.push({ type: 'notify', method, ...(params ? { params } : {}) });
    return this;
  }
  request(method: string, params?: Record<string, unknown>): this {
    this.actions.push({ type: 'request', method, ...(params ? { params } : {}) });
    return this;
  }
  waitCancel(): this {
    this.actions.push({ type: 'wait_cancel' });
    return this;
  }
  sleep(ms: number): this {
    this.actions.push({ type: 'sleep', ms });
    return this;
  }
  crash(code = 1): this {
    this.actions.push({ type: 'crash', code });
    return this;
  }
  mcpCall(
    id: string,
    tool: string,
    args: Record<string, unknown> = {},
    options: Omit<
      Extract<FakeAgentAction, { type: 'mcp_call' }>,
      'type' | 'id' | 'tool' | 'args'
    > = {},
  ): this {
    this.actions.push({ type: 'mcp_call', id, tool, args, ...options });
    return this;
  }
  parallel(lanes: FakeAgentAction[][]): this {
    this.actions.push({ type: 'parallel', lanes });
    return this;
  }
  mcpList(server?: string): this {
    this.actions.push({ type: 'mcp_list', ...(server !== undefined ? { server } : {}) });
    return this;
  }
  echoSteers(): this {
    this.actions.push({ type: 'echo_steers' });
    return this;
  }
  usage(usage: NonNullable<FakeAgentTurn['usage']>): this {
    this.usageReport = usage;
    return this;
  }
  afterTurn(actions: FakeAgentAction[], delayMs = 20): this {
    this.actions.push({ type: 'after_turn', delayMs, actions });
    return this;
  }
  end(stopReason: StopReason = 'end_turn'): this {
    this.stopReason = stopReason;
    return this;
  }
  toJSON(): FakeAgentTurn {
    return {
      actions: this.actions,
      stopReason: this.stopReason,
      ...(this.usageReport !== undefined ? { usage: this.usageReport } : {}),
    };
  }
}

export function agentTurn(): FakeAgentTurnBuilder {
  return new FakeAgentTurnBuilder();
}

function normalizeTurn(turn: FakeAgentTurn | FakeAgentTurnBuilder): FakeAgentTurn {
  return turn instanceof FakeAgentTurnBuilder ? turn.toJSON() : turn;
}

/** Plain-JSON form of a script (subprocess agents read it from a file). */
export function serializeFakeAgentScript(script: FakeAgentScript): string {
  return JSON.stringify({ ...script, turns: script.turns.map(normalizeTurn) });
}

const DEFAULT_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

interface AgentRuntime {
  record(event: FakeAgentEvent): void;
  crash(code: number): void;
}

class FakeAcpAgent implements Agent {
  readonly #script: FakeAgentScript;
  readonly #turns: FakeAgentTurn[];
  readonly #runtime: AgentRuntime;
  #conn!: AgentSideConnection;
  #sessionCount = 0;
  /** session id → its `session/new.mcpServers`. */
  readonly #mcpServers = new Map<string, unknown[]>();
  readonly #cwds = new Map<string, string>();
  readonly #cancelWaiters = new Map<string, Array<() => void>>();
  readonly #cancelled = new Set<string>();
  /** Sessions with a prompt in flight (steering target). */
  readonly #prompting = new Set<string>();
  readonly #steers = new Map<string, string[]>();

  constructor(script: FakeAgentScript, runtime: AgentRuntime) {
    this.#script = script;
    this.#turns = script.turns.map(normalizeTurn);
    this.#runtime = runtime;
  }

  bind(conn: AgentSideConnection): this {
    this.#conn = conn;
    return this;
  }

  async initialize(params: InitializeRequest) {
    this.#runtime.record({ kind: 'initialize', params });
    const script = this.#script;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: script.history !== undefined,
        promptCapabilities: { image: script.promptCapabilities?.image === true },
        mcpCapabilities: { http: true },
        sessionCapabilities: {
          ...(script.sessionClose === true ? { close: {} } : {}),
          ...(script.resume === true ? { resume: {} } : {}),
          ...(script.sessionDelete === true ? { delete: {} } : {}),
        },
      },
      authMethods: script.authMethods ?? [],
      agentInfo: script.agentInfo ?? { name: 'fake-acp-agent', version: '0.0.0' },
      ...(script.steering === true ? { _meta: { steering: { supported: true } } } : {}),
    };
  }

  async newSession(params: { cwd: string; mcpServers: unknown[]; _meta?: unknown }) {
    if (this.#script.requireAuth === true) {
      this.#runtime.record({ kind: 'session_rejected', cwd: params.cwd });
      throw RequestError.authRequired();
    }
    this.#sessionCount += 1;
    const sessionId = `fake-session-${this.#sessionCount}`;
    this.#cwds.set(sessionId, params.cwd);
    this.#mcpServers.set(sessionId, params.mcpServers);
    this.#runtime.record({
      kind: 'new_session',
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      meta: params._meta ?? null,
    });
    if (this.#script.newSessionDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.#script.newSessionDelayMs));
    }
    return {
      sessionId,
      ...(this.#script.configOptions !== undefined
        ? { configOptions: this.#script.configOptions }
        : {}),
      ...(this.#script.modes !== undefined ? { modes: this.#script.modes } : {}),
    };
  }

  async loadSession(params: { sessionId: string; cwd: string; mcpServers: unknown[] }) {
    this.#runtime.record({
      kind: 'load_session',
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    this.#cwds.set(params.sessionId, params.cwd);
    this.#mcpServers.set(params.sessionId, params.mcpServers);
    for (const action of this.#script.history ?? []) {
      await this.#perform(params.sessionId, action);
    }
    return {
      ...(this.#script.configOptions !== undefined
        ? { configOptions: this.#script.configOptions }
        : {}),
      ...(this.#script.modes !== undefined ? { modes: this.#script.modes } : {}),
    };
  }

  async resumeSession(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }) {
    this.#runtime.record({
      kind: 'resume_session',
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    this.#cwds.set(params.sessionId, params.cwd);
    this.#mcpServers.set(params.sessionId, params.mcpServers ?? []);
    return {
      ...(this.#script.configOptions !== undefined
        ? { configOptions: this.#script.configOptions }
        : {}),
      ...(this.#script.modes !== undefined ? { modes: this.#script.modes } : {}),
    };
  }

  async deleteSession(params: { sessionId: string }) {
    this.#runtime.record({ kind: 'delete_session', sessionId: params.sessionId });
    return {};
  }

  async authenticate(params: { methodId: string }) {
    this.#runtime.record({ kind: 'authenticate', methodId: params.methodId });
    return {};
  }

  async logout() {
    this.#runtime.record({ kind: 'logout' });
    return {};
  }

  async setSessionConfigOption(params: { sessionId: string; configId: string; value: unknown }) {
    this.#runtime.record({
      kind: 'config',
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    return { configOptions: this.#script.configOptions ?? [] };
  }

  async setSessionMode(params: { sessionId: string; modeId: string }) {
    this.#runtime.record({ kind: 'mode', sessionId: params.sessionId, modeId: params.modeId });
    if (this.#script.rejectModes?.includes(params.modeId) === true) {
      throw RequestError.invalidParams({ reason: `mode ${params.modeId} refused` });
    }
    if (this.#script.hangModes?.includes(params.modeId) === true) {
      await new Promise<never>(() => undefined);
    }
    if (this.#script.modeDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.#script.modeDelayMs));
    }
    return {};
  }

  async closeSession(params: { sessionId: string }) {
    this.#runtime.record({ kind: 'close_session', sessionId: params.sessionId });
    return {};
  }

  async prompt(params: { sessionId: string; prompt: ContentBlock[] }) {
    const { sessionId } = params;
    this.#cancelled.delete(sessionId);
    this.#runtime.record({
      kind: 'prompt',
      sessionId,
      text: params.prompt
        .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n'),
      blocks: params.prompt,
    });
    const turn = this.#turns.shift();
    if (turn === undefined) throw RequestError.internalError({ reason: 'unscripted prompt' });
    this.#prompting.add(sessionId);
    try {
      return await this.#playTurn(sessionId, turn);
    } finally {
      this.#prompting.delete(sessionId);
    }
  }

  async #playTurn(sessionId: string, turn: FakeAgentTurn) {
    const usage = turn.usage !== undefined ? { usage: turn.usage } : {};
    for (const action of turn.actions) {
      if (this.#cancelled.has(sessionId)) return { stopReason: 'cancelled' as const };
      if (action.type === 'fail') throw new RequestError(action.code, action.message);
      if (action.type === 'wait_cancel') {
        await this.#waitCancel(sessionId);
        return { stopReason: 'cancelled' as const };
      }
      if (action.type === 'after_turn') {
        const timer = setTimeout(() => {
          void (async () => {
            for (const later of action.actions) await this.#perform(sessionId, later);
          })().catch(() => undefined);
        }, action.delayMs ?? 20);
        timer.unref?.();
        continue;
      }
      await this.#perform(sessionId, action);
    }
    if (this.#cancelled.has(sessionId)) return { stopReason: 'cancelled' as const };
    return { stopReason: turn.stopReason ?? 'end_turn', ...usage };
  }

  async cancel(params: { sessionId: string }) {
    this.#runtime.record({ kind: 'cancel', sessionId: params.sessionId });
    this.#cancelled.add(params.sessionId);
    for (const waiter of this.#cancelWaiters.get(params.sessionId) ?? []) waiter();
    this.#cancelWaiters.delete(params.sessionId);
  }

  async extMethod(method: string, params: Record<string, unknown>) {
    if (method === '_session/steering' && this.#script.steering === true) {
      this.#runtime.record({ kind: 'steering', params });
      const sessionId = String(params.sessionId);
      if (this.#script.steeringDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.#script.steeringDelayMs));
      }
      const outcome =
        this.#script.steeringOutcome ??
        (this.#prompting.has(sessionId) ? 'injected' : 'promptRequired');
      if (outcome === 'error') throw RequestError.internalError({ reason: 'steering failed' });
      if (outcome === 'injected') {
        const prompt = (params.prompt ?? []) as Array<{ type: string; text?: string }>;
        const text = prompt.map((block) => block.text ?? '').join('');
        this.#steers.set(sessionId, [...(this.#steers.get(sessionId) ?? []), text]);
      }
      return outcome === 'promptRequired' ? { outcome, reason: 'noRunningTurn' } : { outcome };
    }
    throw RequestError.methodNotFound(method);
  }

  #waitCancel(sessionId: string): Promise<void> {
    if (this.#cancelled.has(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#cancelWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.#cancelWaiters.set(sessionId, waiters);
    });
  }

  async #update(sessionId: string, update: SessionUpdate): Promise<void> {
    await this.#conn.sessionUpdate({ sessionId, update });
    // Lets tests prove an update really left the agent (e.g. out-of-run output).
    this.#runtime.record({ kind: 'emitted', sessionId, update: update.sessionUpdate });
  }

  async #perform(sessionId: string, action: FakeAgentAction): Promise<void> {
    switch (action.type) {
      case 'text':
        return this.#update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: action.text },
        });
      case 'thought':
        return this.#update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: action.text },
        });
      case 'tool_call':
        return this.#update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: action.id,
          title: action.title,
          ...(action.name !== undefined ? { name: action.name } : {}),
          kind: action.kind ?? 'other',
          status: 'pending',
          rawInput: action.input ?? {},
        });
      case 'tool_result':
        return this.#update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: action.id,
          status: action.status ?? 'completed',
          content: [{ type: 'content', content: { type: 'text', text: action.output } }],
        });
      case 'plan':
        return this.#update(sessionId, {
          sessionUpdate: 'plan',
          entries: action.entries.map((entry) => ({ ...entry, priority: 'medium' as const })),
        });
      case 'permission': {
        const response = await this.#conn.requestPermission({
          sessionId,
          toolCall:
            action.bare === true
              ? { toolCallId: action.toolCallId }
              : {
                  toolCallId: action.toolCallId,
                  title: action.title,
                  ...(action.name !== undefined ? { name: action.name } : {}),
                  ...(action.bridgeTool !== undefined
                    ? { name: `mcp__${this.#bridgeName(sessionId)}__${action.bridgeTool}` }
                    : {}),
                  ...(action.kind !== undefined ? { kind: action.kind } : {}),
                  ...(action.locations !== undefined
                    ? {
                        locations: action.locations.map((p) => ({
                          path: this.#inCwd(sessionId, p),
                        })),
                      }
                    : {}),
                  ...(action.rawInput !== undefined ? { rawInput: action.rawInput } : {}),
                },
          options: action.options ?? DEFAULT_PERMISSION_OPTIONS,
        });
        this.#runtime.record({
          kind: 'permission',
          toolCallId: action.toolCallId,
          outcome: response.outcome,
        });
        return;
      }
      case 'request': {
        try {
          const result = await this.#conn.request(action.method, action.params ?? { sessionId });
          this.#runtime.record({ kind: 'request', method: action.method, result: result ?? null });
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown };
          this.#runtime.record({
            kind: 'request',
            method: action.method,
            error: {
              code: typeof candidate.code === 'number' ? candidate.code : 0,
              message: String(candidate.message ?? error),
            },
          });
        }
        return;
      }
      case 'notify':
        await this.#conn.notify(action.method, action.params ?? {});
        return;
      case 'echo_steers':
        for (const text of this.#steers.get(sessionId) ?? []) {
          await this.#update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `steered: ${text}` },
          });
        }
        return;
      case 'mode_update':
        return this.#update(sessionId, {
          sessionUpdate: 'current_mode_update',
          currentModeId: action.modeId,
        });
      case 'config_update':
        return this.#update(sessionId, {
          sessionUpdate: 'config_option_update',
          configOptions: action.configOptions,
        });
      case 'write_file': {
        const target = this.#inCwd(sessionId, action.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, action.content);
        return;
      }
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, action.ms));
        return;
      case 'crash':
        this.#runtime.crash(action.code ?? 1);
        // Never resolves: the process / connection is gone.
        await new Promise(() => undefined);
        return;
      case 'mcp_list':
        return this.#mcpList(sessionId, action.server ?? this.#bridgeName(sessionId));
      case 'mcp_call':
        return this.#mcpCall(sessionId, action);
      case 'parallel':
        await Promise.all(
          action.lanes.map(async (lane) => {
            for (const inner of lane) await this.#perform(sessionId, inner);
          }),
        );
        return;
      case 'wait_cancel':
      case 'after_turn':
      case 'fail':
        return;
    }
  }

  /** A path of the session: absolute as is, relative against its cwd. */
  #inCwd(sessionId: string, target: string): string {
    return isAbsolute(target) ? target : join(this.#cwds.get(sessionId) ?? process.cwd(), target);
  }

  /** The session's host bridge server (`kepcup` or `kepcup_<hex>`); 'kepcup' when none. */
  #bridgeName(sessionId: string): string {
    const servers = (this.#mcpServers.get(sessionId) ?? []) as FakeMcpServer[];
    return (
      servers.find((server) => server.name === 'kepcup' || server.name.startsWith('kepcup_'))
        ?.name ?? 'kepcup'
    );
  }

  #mcpServer(sessionId: string, name: string): FakeMcpServer | null {
    const servers = (this.#mcpServers.get(sessionId) ?? []) as FakeMcpServer[];
    return servers.find((server) => server.name === name && server.type === 'http') ?? null;
  }

  async #mcpList(sessionId: string, serverName: string): Promise<void> {
    const server = this.#mcpServer(sessionId, serverName);
    if (server === null) {
      this.#runtime.record({
        kind: 'mcp',
        sessionId,
        method: 'tools/list',
        ok: false,
        error: 'no such server',
      });
      return;
    }
    try {
      await mcpInitialize(server);
      const result = (await mcpRequest(server, 'tools/list', {})) as {
        tools: Array<{ name: string; description?: string }>;
      };
      this.#runtime.record({
        kind: 'mcp',
        sessionId,
        method: 'tools/list',
        ok: true,
        result: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
        })),
      });
    } catch (error) {
      this.#runtime.record({ kind: 'mcp', sessionId, method: 'tools/list', ...mcpFailure(error) });
    }
  }

  async #mcpCall(
    sessionId: string,
    action: Extract<FakeAgentAction, { type: 'mcp_call' }>,
  ): Promise<void> {
    const serverName = action.server ?? this.#bridgeName(sessionId);
    const structured = action.mirrorName ?? `mcp__${serverName}__${action.tool}`;
    const mirror = action.mirror !== false;
    const where = action.mirrorNameIn ?? 'name';
    const meta =
      where === 'claude_meta'
        ? { _meta: { claudeCode: { toolName: structured } } }
        : where === 'antigravity_meta'
          ? { _meta: { mcp: { server: serverName, tool: action.tool }, is_mcp_tool_call: true } }
          : {};
    const title =
      where === 'codex_raw_input'
        ? `mcp.${serverName}.${action.tool}`
        : where === 'antigravity_meta' || where === 'opaque'
          ? `${serverName}_${action.tool}`
          : where === 'cursor_raw_input'
            ? `${serverName}: ${action.tool}`
            : structured;
    const rawInput =
      where === 'codex_raw_input'
        ? { server: serverName, tool: action.tool, arguments: action.args ?? {} }
        : where === 'cursor_raw_input'
          ? { providerIdentifier: serverName, toolName: action.tool, args: action.args ?? {} }
          : (action.args ?? {});
    if (mirror) {
      await this.#update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: action.id,
        title,
        ...(where === 'name' ? { name: structured } : {}),
        ...meta,
        kind: 'other',
        status: 'pending',
        rawInput,
      });
    }
    const server = action.skipCall === true ? null : this.#mcpServer(sessionId, serverName);
    let output = action.skipCall === true ? 'answered without the server' : 'no such server';
    let ok = action.skipCall === true;
    if (action.skipCall === true) {
      // Mirror only: nothing reached the MCP server.
    } else if (server === null) {
      this.#runtime.record({
        kind: 'mcp',
        sessionId,
        method: 'tools/call',
        tool: action.tool,
        ok: false,
        error: output,
      });
    } else {
      const target = action.token !== undefined ? withToken(server, action.token) : server;
      try {
        await mcpInitialize(target);
        const result = (await mcpRequest(target, 'tools/call', {
          name: action.tool,
          arguments: action.args ?? {},
        })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
        ok = result.isError !== true;
        output = (result.content ?? [])
          .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
          .join('\n');
        this.#runtime.record({
          kind: 'mcp',
          sessionId,
          method: 'tools/call',
          tool: action.tool,
          ok,
          result,
        });
      } catch (error) {
        const failure = mcpFailure(error);
        output = failure.error;
        this.#runtime.record({
          kind: 'mcp',
          sessionId,
          method: 'tools/call',
          tool: action.tool,
          ...failure,
        });
      }
    }
    if (mirror) {
      await this.#update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: action.id,
        status: ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: output } }],
        ...meta,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal Streamable HTTP MCP client (plain fetch, no SDK: this file must stay
// loadable by Node's type stripping)
// ---------------------------------------------------------------------------

interface FakeMcpServer {
  type?: string;
  name: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
}

interface McpHttpFailure {
  status?: number;
  message: string;
}

function withToken(server: FakeMcpServer, token: string): FakeMcpServer {
  return {
    ...server,
    headers: [
      ...(server.headers ?? []).filter((header) => header.name.toLowerCase() !== 'authorization'),
      { name: 'Authorization', value: `Bearer ${token}` },
    ],
  };
}

function mcpFailure(error: unknown): { ok: false; status?: number; error: string } {
  const failure = error as Partial<McpHttpFailure> | null;
  return {
    ok: false,
    ...(typeof failure?.status === 'number' ? { status: failure.status } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
}

let mcpRequestId = 0;

async function mcpPost(server: FakeMcpServer, body: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const response = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${text}`), { status: response.status });
  }
  if (body.id === undefined || text.trim().length === 0) return null;
  const json = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? JSON.parse(
        text
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join(''),
      )
    : JSON.parse(text);
  const message = json as { result?: unknown; error?: { message?: string } };
  if (message.error !== undefined) throw new Error(message.error.message ?? 'MCP error');
  return message.result;
}

async function mcpInitialize(server: FakeMcpServer): Promise<void> {
  await mcpPost(server, {
    id: ++mcpRequestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-acp-agent', version: '0.0.0' },
    },
  });
  await mcpPost(server, { method: 'notifications/initialized' });
}

function mcpRequest(
  server: FakeMcpServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return mcpPost(server, { id: ++mcpRequestId, method, params });
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/** Byte channel as seen by the ACP client (same shape as core's AcpByteChannel). */
export interface FakeAgentChannel {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface FakeAcpAgentHandle {
  channel: FakeAgentChannel;
  observed: FakeAgentObservation;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

function bytePipe(): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  end(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const end = () => {
    if (ended) return;
    ended = true;
    try {
      controller.close();
    } catch {
      // Already closed / errored.
    }
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (!ended) controller.enqueue(chunk);
    },
    close: end,
    abort: end,
  });
  return { readable, writable, end };
}

/**
 * In-process fake agent: the returned channel plugs into the host's ACP
 * client exactly like a child's stdio. `kill()` / a scripted `crash` end both
 * directions, so the client sees the connection close.
 */
export function startFakeAcpAgent(script: FakeAgentScript): FakeAcpAgentHandle {
  const toAgent = bytePipe();
  const toClient = bytePipe();
  const observed = emptyObservation();
  let resolveExited!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExited = resolve;
  });
  let gone = false;
  const stop = (code: number | null, signal: string | null) => {
    if (gone) return;
    gone = true;
    toAgent.end();
    toClient.end();
    resolveExited({ code, signal });
  };
  const agent = new FakeAcpAgent(script, {
    record: (event) => observe(observed, event),
    crash: (code) => stop(code, null),
  });
  const conn = new AgentSideConnection(
    () => agent,
    ndJsonStream(toClient.writable, toAgent.readable),
  );
  agent.bind(conn);
  void conn.closed.then(() => stop(0, null));
  return {
    channel: { readable: toClient.readable, writable: toAgent.writable },
    observed,
    exited,
    kill: () => stop(null, 'SIGTERM'),
  };
}

/** Subprocess entry (bin/fake-acp-agent.mjs): ACP over this process's stdio. */
export function runFakeAcpAgentStdio(
  script: FakeAgentScript,
  options: { recordPath?: string } = {},
): void {
  const recordPath = options.recordPath;
  const agent = new FakeAcpAgent(script, {
    record: (event) => {
      if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify(event)}\n`);
    },
    crash: (code) => process.exit(code),
  });
  const conn = new AgentSideConnection(
    () => agent,
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
  agent.bind(conn);
  void conn.closed.then(() => process.exit(0));
}
