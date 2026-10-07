import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { executeToolSafely, toolResultBlocks } from '../tool-execution.js';
import { HOST_MCP_SERVER_PREFIX } from './acp/client.js';
import { toolAnnotations } from './capabilities.js';
import type { RunIdentity, ToolContext, ToolDefinition } from '../types.js';

/**
 * 宿主 MCP 桥（docs/design/28-external-agents-acp.md §4.4，D72）：把一个外部
 * 智能体 run 的宿主工具（按能力包过滤后的 `RunSpec.tools`）以 Streamable HTTP
 * MCP server 暴露给 Agent。
 *
 * - 只监听 `127.0.0.1` 随机端口，随 core 启停；
 * - token 按**会话**签发（256 bit），桥按 token 找会话的**当前 run**；没有进行
 *   中的 run 一律拒绝（Agent 的自主 turn、run 结束后的迟到调用）；
 * - `Host` 必须是 `127.0.0.1:{port}`、`Origin`（若有）必须是本机，否则 403
 *   （防 DNS rebinding）；
 * - `tools/call` 构造 ToolContext（run 的身份与取消信号）调用原工具的
 *   `execute`——审批 / 审计 / `<untrusted>` / 脱敏都在工具与网关里，与内置
 *   引擎同一管道；结果的截断与图片判定与 PiEngine 共用（`tool-execution.ts`）；
 * - 桥自己向 run 报告 `tool_call` / `tool_result`（保留 `errorCode`，使
 *   SETUP_REQUIRED 中断照常生效），引擎忽略 ACP 侧对这些工具的镜像更新。
 *
 * 无状态：每个 HTTP 请求新建一个 MCP Server + transport（JSON 响应，不开 SSE），
 * 会话语义全部由 token → run 绑定承担。MCP SDK 只在本文件（及 stdio 代理）引用。
 */

const MCP_PATH = '/mcp';
/** Audit rows keep at most this much of a call's arguments (JSON). */
export const BRIDGE_AUDIT_ARGS_MAX_CHARS = 2_000;

/** Arguments for the audit row: verbatim when small, else a truncated JSON summary. */
function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(args);
  return json.length <= BRIDGE_AUDIT_ARGS_MAX_CHARS
    ? { args }
    : {
        argsSummary: `${json.slice(0, BRIDGE_AUDIT_ARGS_MAX_CHARS)}…（已截断）`,
        argsTruncated: true,
      };
}

/**
 * Per-run call bookkeeping: a terminating tool (skip_reply) ends the run only
 * once every call of the same run in flight has answered, so its
 * session/cancel never aborts a sibling call of the same model turn.
 */
interface RunCallState {
  inFlight: number;
  terminate: string | null;
  fired: boolean;
}

/** Bridge-side report of one call (run_steps `tool_call`, design 28 §4.2 统计). */
export interface BridgeToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** The capability pack the tool belongs to. */
  capability: string | null;
  /** The agent declares a native tool for the same ability (原生优先遵守度). */
  nativeOverlap: boolean;
}

export interface BridgeToolResultEvent {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  content: string;
  errorCode?: string;
}

/** 一个 run 在桥上的绑定（由 ExternalAgentEngine 提供）。 */
export interface BridgeRunBinding {
  identity: RunIdentity;
  tools: readonly ToolDefinition[];
  /** Aborted when the run is cancelled: in-flight calls observe it. */
  signal: AbortSignal;
  /** The agent accepts image content (promptCapabilities.image). */
  acceptsImages: boolean;
  meta(toolName: string): { capability: string | null; nativeOverlap: boolean };
  onToolCall(event: BridgeToolCallEvent): void;
  onToolResult(event: BridgeToolResultEvent): void;
  progress(text: string): void;
  /** A terminating tool (skip_reply) returned; fired once its response was sent. */
  onTerminate(reason: string): void;
}

export interface HostMcpBridgeDeps {
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  appVersion: string;
  /** Audit trail of bridge calls (gateway.audit: redacted, RunIdentity rows). */
  audit?(identity: RunIdentity, action: string, detail: Record<string, unknown>): void;
}

/** Rejection reasons, for logs and the JSON-RPC error body. */
type Denial = { status: number; message: string };

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** TypeBox / JSON schema → plain JSON object schema for `tools/list`. */
function inputSchemaOf(parameters: unknown): { type: 'object'; [key: string]: unknown } {
  const plain =
    parameters !== null && typeof parameters === 'object'
      ? (JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>)
      : {};
  return { ...plain, type: 'object', properties: plain.properties ?? {} };
}

function sendJsonRpcError(res: ServerResponse, denial: Denial): void {
  if (res.headersSent) return;
  res.writeHead(denial.status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: denial.message }, id: null }),
  );
}

export class HostMcpBridge {
  readonly #deps: HostMcpBridgeDeps;
  #server: HttpServer | null = null;
  #port = 0;
  /** token → session key. */
  readonly #tokens = new Map<string, string>();
  /** session key → its current token (re-issuing revokes the previous one). */
  readonly #sessionTokens = new Map<string, string>();
  /** session key → the run currently bound. */
  readonly #runs = new Map<string, BridgeRunBinding>();
  readonly #callState = new WeakMap<BridgeRunBinding, RunCallState>();

  constructor(deps: HostMcpBridgeDeps) {
    this.#deps = deps;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  get port(): number {
    return this.#port;
  }

  /** The URL handed to agents in `session/new.mcpServers`. */
  get url(): string {
    return `http://127.0.0.1:${this.#port}${MCP_PATH}`;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((error: unknown) => {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'host mcp bridge request failed',
        );
        sendJsonRpcError(res, { status: 500, message: 'internal error' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    // Never keeps the process alive on its own.
    server.unref();
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    this.#deps.logger.info({ port: this.#port }, 'host mcp bridge listening');
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    this.#tokens.clear();
    this.#sessionTokens.clear();
    this.#runs.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * A fresh 256-bit token for an agent session; the session's previous token
   * (an earlier session under the same key) stops working.
   */
  issueSessionToken(sessionKey: string): string {
    this.revoke(sessionKey);
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, sessionKey);
    this.#sessionTokens.set(sessionKey, token);
    return token;
  }

  /**
   * The session's token stops working (session closed / fingerprint changed).
   * With `token`, only when it is still the session's current one.
   */
  revoke(sessionKey: string, token?: string): void {
    const current = this.#sessionTokens.get(sessionKey);
    if (current === undefined || (token !== undefined && token !== current)) return;
    this.#tokens.delete(current);
    this.#sessionTokens.delete(sessionKey);
  }

  /** The session's calls now execute in this run. */
  bindRun(sessionKey: string, binding: BridgeRunBinding): void {
    this.#runs.set(sessionKey, binding);
  }

  /** No run any more: calls on the session are refused until the next bind. */
  unbindRun(sessionKey: string, runId?: string): void {
    const current = this.#runs.get(sessionKey);
    if (current === undefined) return;
    if (runId !== undefined && current.identity.runId !== runId) return;
    this.#runs.delete(sessionKey);
  }

  #authorize(req: IncomingMessage): Denial | { binding: BridgeRunBinding } {
    // DNS rebinding: a browser page reaching this port under another name
    // carries that name in Host / Origin.
    if (req.headers.host !== `127.0.0.1:${this.#port}`) {
      return { status: 403, message: 'forbidden host' };
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return { status: 403, message: 'forbidden origin' };
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) return { status: 404, message: 'not found' };
    const token = bearerToken(req.headers.authorization);
    const sessionKey = token !== null ? this.#tokens.get(token) : undefined;
    if (sessionKey === undefined) return { status: 401, message: 'invalid or expired token' };
    const binding = this.#runs.get(sessionKey);
    if (binding === undefined) return { status: 403, message: 'no run in progress' };
    if (req.method !== 'POST') return { status: 405, message: 'method not allowed' };
    return { binding };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verdict = this.#authorize(req);
    if (!('binding' in verdict)) {
      this.#deps.logger.info(
        { status: verdict.status, reason: verdict.message, method: req.method },
        'host mcp bridge request refused',
      );
      // Drain the body so the connection can be reused / closed cleanly.
      req.resume();
      sendJsonRpcError(res, verdict);
      return;
    }
    const { binding } = verdict;
    const state = this.#stateOf(binding);
    const server = this.#mcpServer(binding, state);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      // skip_reply & co.: the run ends only after the agent got the result
      // (and every sibling call of the run answered).
      if (state.terminate !== null && state.inFlight === 0 && !state.fired) {
        state.fired = true;
        binding.onTerminate(state.terminate);
      }
    }
  }

  #stateOf(binding: BridgeRunBinding): RunCallState {
    let state = this.#callState.get(binding);
    if (state === undefined) {
      state = { inFlight: 0, terminate: null, fired: false };
      this.#callState.set(binding, state);
    }
    return state;
  }

  #mcpServer(binding: BridgeRunBinding, state: RunCallState): Server {
    const server = new Server(
      { name: HOST_MCP_SERVER_PREFIX, version: this.#deps.appVersion },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: binding.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchemaOf(tool.parameters),
        annotations: toolAnnotations(tool.name),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      state.inFlight += 1;
      try {
        return await this.#callTool(
          binding,
          request.params.name,
          request.params.arguments ?? {},
          extra.signal,
          (reason) => {
            state.terminate ??= reason;
          },
        );
      } finally {
        state.inFlight -= 1;
      }
    });
    return server;
  }

  async #callTool(
    binding: BridgeRunBinding,
    toolName: string,
    rawArgs: Record<string, unknown>,
    requestSignal: AbortSignal,
    onTerminate: (reason: string) => void,
  ): Promise<CallToolResult> {
    const tool = binding.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      return {
        content: [{ type: 'text', text: `工具不存在或未注入：${toolName}` }],
        isError: true,
      };
    }
    const toolCallId = `kc_${randomUUID()}`;
    const meta = binding.meta(toolName);
    binding.onToolCall({ toolCallId, toolName, args: rawArgs, ...meta });
    this.#deps.audit?.(binding.identity, 'agent_bridge_tool_call', {
      toolName,
      capability: meta.capability,
      ...auditArgs(rawArgs),
    });

    let args: unknown;
    try {
      // Same argument validation / coercion as pi applies before execute.
      args = validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters as never },
        { type: 'toolCall', id: toolCallId, name: tool.name, arguments: rawArgs as never },
      );
    } catch (error) {
      const content = `参数不合法：${error instanceof Error ? error.message : String(error)}`;
      binding.onToolResult({
        toolCallId,
        toolName,
        ok: false,
        content,
        errorCode: 'INVALID_INPUT',
      });
      return { content: [{ type: 'text', text: content }], isError: true };
    }

    let terminatedBy: string | null = null;
    const ctx: ToolContext = {
      identity: binding.identity,
      signal: AbortSignal.any([binding.signal, requestSignal]),
      terminate: (reason) => {
        terminatedBy = reason ?? 'skip_reply';
      },
      progress: (text) => binding.progress(text),
    };
    const result = await executeToolSafely(tool, args, ctx);
    binding.onToolResult({
      toolCallId,
      toolName,
      ok: result.ok,
      content: result.content,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    });
    if (terminatedBy !== null) onTerminate(terminatedBy);
    else if (result.terminate === true) onTerminate(toolName);
    return {
      content: toolResultBlocks(result, binding.acceptsImages),
      ...(result.ok ? {} : { isError: true }),
    };
  }
}
