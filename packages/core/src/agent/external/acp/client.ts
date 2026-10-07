import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthMethod,
  type Client,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { AppError } from '@kepcup/shared';
import type { CoreLogger } from '../../../infra/logger.js';

/**
 * 宿主侧 ACP 客户端（docs/design/28-external-agents-acp.md §10，D72）。
 *
 * ACP SDK 只在 `agent/external/acp/` 下引用（D21 精神延伸）：其余模块经本文件
 * 再导出的类型与 `AcpConnection` 访问协议。本文件只做协议层的事：
 * - `initialize` 如实填 KepCup 的 clientInfo，不声明 fs / terminal 能力；
 * - `session/update` 交给会话路由（无进行中 run → 丢弃 + 日志）；
 * - `session/request_permission` 交给会话的 run（P3 权限桥，
 *   permission-bridge.ts）；会话没有接权限桥时按 P1 规则默认拒绝（本会话
 *   宿主桥工具除外）；
 * - 任何未处理的 Agent→客户端请求（未知扩展方法、未声明能力的 fs / terminal）
 *   立即返回「不支持」错误，绝不悬挂——部分 Agent 在客户端不应答时会卡住。
 */

export type AcpAuthMethod = AuthMethod;
export type AcpContentBlock = ContentBlock;
export type AcpInitializeResponse = InitializeResponse;
export type AcpMcpServer = McpServer;
export type AcpNewSessionResponse = NewSessionResponse;
export type AcpPermissionOption = PermissionOption;
export type AcpPromptResponse = PromptResponse;
export type AcpSessionConfigOption = SessionConfigOption;
export type AcpSessionModeState = SessionModeState;
export type AcpSessionNotification = SessionNotification;
export type AcpSessionUpdate = SessionUpdate;
export type AcpStopReason = StopReason;
export type AcpRequestPermissionRequest = RequestPermissionRequest;
export type AcpRequestPermissionResponse = RequestPermissionResponse;
/** 权限请求里的 `toolCall`（kind / locations / rawInput …）。 */
export type AcpPermissionToolCall = ToolCallUpdate;
/** 进程内垫片（shim 型 Provider）实现的 ACP Agent 接口。 */
export type AcpAgentLike = Agent;

export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
/** 认证状态扩展通知（Claude / Codex 未登录时推 `{authStatus:{kind:'none'}}`）。 */
export const ACP_AUTH_STATUS_NOTIFICATION = '_auth/status_update';

/** Agent 进程的字节通道（子进程的 stdout / stdin，或进程内假 Agent）。 */
export interface AcpByteChannel {
  /** Bytes from the agent (its stdout). */
  readable: ReadableStream<Uint8Array>;
  /** Bytes to the agent (its stdin). */
  writable: WritableStream<Uint8Array>;
}

/** 一个 Agent 进程内所有会话的路由（由 AgentHost 实现）。 */
export interface AcpSessionRouter {
  /** Delivers an update to the session's current run; false = no run (dropped). */
  deliver(notification: AcpSessionNotification): boolean;
  /** Whether the session currently belongs to an in-flight run. */
  hasRun(sessionId: string): boolean;
  /**
   * The host MCP bridge the session was created with (P2), or null. Only a
   * bridge tool of *this* session (its server name, its run's tool set) may
   * have a permission request allowed.
   */
  bridgeOf(sessionId: string): SessionBridge | null;
  /** Tells the session's run about a permission decision (status line / steps). */
  notePermission(sessionId: string, title: string, decision: PermissionDecision): void;
  /**
   * P3：会话的 run 自己裁决权限请求（权限桥，可能等待用户审批）；null =
   * 该会话没有接权限桥，按 P1 规则（`decidePermission`）默认拒绝。
   */
  requestPermission?(
    sessionId: string,
    request: AcpRequestPermissionRequest,
  ): Promise<PermissionVerdict> | null;
}

/** 一次权限请求的裁决：给 Agent 的应答 + 宿主侧结论。 */
export interface PermissionVerdict {
  response: AcpRequestPermissionResponse;
  decision: PermissionDecision;
}

/** 最近一次 `_auth/status_update`（P4 的 Agent 状态机读取）。 */
export interface AgentAuthStatus {
  kind: string;
  /** The notification params verbatim (diagnostics). */
  raw: unknown;
}

export type PermissionDecision = 'allowed' | 'rejected' | 'cancelled';

/** 工具调用（`tool_call` / `tool_call_update` / 权限请求的 `toolCall`）的公共切片。 */
export interface AcpToolCallLike {
  name?: string | null;
  kind?: string | null;
  title?: string | null;
  rawInput?: unknown;
  _meta?: Record<string, unknown> | null;
}

/**
 * 宿主 MCP 桥 server 名的前缀。实际名字按会话随机（`kepcup_<8hex>`，见
 * `capabilities.ts` 的 `newHostServerName`）：用户 / 项目里同名的 MCP server
 * 无法冒充宿主桥（被自动放行、镜像被隐藏），Codex 也不会因同名去重而丢掉桥。
 */
export const HOST_MCP_SERVER_PREFIX = 'kepcup';

/** 会话挂着的宿主桥：server 名与当前 run 注入的工具集合。 */
export interface SessionBridge {
  serverName: string;
  toolNames: ReadonlySet<string>;
}

/** 权限请求与扩展请求需要的 Provider 切片（避免 acp/ 反向依赖 Provider 模块）。 */
export interface AcpProviderHooks {
  permissionOptions: { allowOnce: readonly string[]; rejectOnce: readonly string[] };
  toolName(server: string, tool: string): string;
  bridgeToolFromCall?(toolCall: AcpToolCallLike, serverName: string): string | null;
  extRequests?: Readonly<
    Record<
      string,
      (
        params: Record<string, unknown>,
        ctx: { agentId: string; sessionId: string | null; hasRun: boolean },
      ) => Promise<Record<string, unknown>>
    >
  >;
}

/** The logging slice the connection needs (the host passes a close-safe wrapper). */
export type AcpLogger = Pick<CoreLogger, 'debug' | 'info' | 'warn' | 'error'>;

export interface AcpConnectionOptions {
  agentId: string;
  channel: AcpByteChannel;
  provider: AcpProviderHooks;
  router: AcpSessionRouter;
  appVersion: string;
  logger: AcpLogger;
  onAuthStatus?(status: AgentAuthStatus): void;
}

/**
 * 通用识别（ACP 标准之外各家不同，P5 新增 Provider 时须逐家实测）：结构化
 * `toolCall.name` 等于 `toolName(server, tool)` 写法；或 `rawInput` 是适配器
 * 构造的 `{server, tool, arguments}`（Codex 形态）。永不看自由文本的 `title`。
 */
export function defaultBridgeToolFromCall(
  toolCall: AcpToolCallLike,
  serverName: string,
  toolName: (server: string, tool: string) => string,
): string | null {
  const name = toolCall.name;
  const prefix = toolName(serverName, '');
  if (typeof name === 'string' && prefix.length > 0 && name.startsWith(prefix)) {
    const tool = name.slice(prefix.length);
    return tool.length > 0 ? tool : null;
  }
  // The adapter-built `rawInput{server,tool,arguments}` shape only counts on
  // tool calls of no specific kind: an `execute` / `edit` request whose input
  // happens to look like it must never pass as a bridge tool (review L2).
  const kind = toolCall.kind ?? null;
  if (kind !== null && kind !== 'other') return null;
  const input = toolCall.rawInput as { server?: unknown; tool?: unknown } | null | undefined;
  if (
    input !== null &&
    typeof input === 'object' &&
    input.server === serverName &&
    typeof input.tool === 'string' &&
    input.tool.length > 0 &&
    'arguments' in input
  ) {
    return input.tool;
  }
  return null;
}

/**
 * The host-bridge tool a call refers to (`send_message` for
 * `mcp__kepcup_ab12cd34__send_message`), or null: it must name *this*
 * session's bridge server and a tool of the bound run.
 */
export function hostBridgeToolOf(
  toolCall: AcpToolCallLike,
  provider: Pick<AcpProviderHooks, 'bridgeToolFromCall' | 'toolName'>,
  bridge: SessionBridge,
): string | null {
  const tool =
    provider.bridgeToolFromCall?.(toolCall, bridge.serverName) ??
    defaultBridgeToolFromCall(toolCall, bridge.serverName, (server, name) =>
      provider.toolName(server, name),
    );
  return tool !== null && bridge.toolNames.has(tool) ? tool : null;
}

/**
 * P1 权限决策（纯函数）：只有会话确实挂了宿主 MCP 桥（P2 起）且请求按
 * **结构化** 字段（`toolCall.name` 或 Provider 声明的位置，不看 Agent 自由文本
 * 的 `title`——shell 工具的 title 常是命令本身）指向本会话的桥 server、且是
 * 当前 run 注入的工具时，才选白名单内的 allow_once；其余一律 reject_once，找不到合适选项时 `cancelled`。永不选
 * `*_always` 与任何会切换模式的选项。会话没有进行中 run 时一律 `cancelled`。
 */
export function decidePermission(
  request: RequestPermissionRequest,
  provider: AcpProviderHooks,
  session: { hasRun: boolean; bridge: SessionBridge | null },
): { response: RequestPermissionResponse; decision: PermissionDecision } {
  const cancelled = {
    response: { outcome: { outcome: 'cancelled' as const } },
    decision: 'cancelled' as const,
  };
  if (!session.hasRun) return cancelled;
  const wantsAllow =
    session.bridge !== null &&
    hostBridgeToolOf(request.toolCall as AcpToolCallLike, provider, session.bridge) !== null;
  return selectPermissionOption(request.options, provider, wantsAllow ? 'allow' : 'reject');
}

/**
 * Picks the option for a host verdict (design 28 §6「选项映射」): allow →
 * only an `allow_once` option whose id is in the Provider's whitelist
 * (whitelist order first; never `allow_always`, never a mode-switching id);
 * reject → a whitelisted `reject_once`, else any `reject_once` (rejecting is
 * always safe). An allow without a usable option degrades to reject; nothing
 * usable at all → `cancelled`.
 */
export function selectPermissionOption(
  options: readonly AcpPermissionOption[],
  provider: Pick<AcpProviderHooks, 'permissionOptions'>,
  verdict: 'allow' | 'reject',
): PermissionVerdict {
  const byWhitelist = (kind: 'allow_once' | 'reject_once', whitelist: readonly string[]) => {
    for (const id of whitelist) {
      const option = options.find((candidate) => candidate.kind === kind && candidate.optionId === id);
      if (option !== undefined) return option;
    }
    return undefined;
  };
  if (verdict === 'allow') {
    const allow = byWhitelist('allow_once', provider.permissionOptions.allowOnce);
    if (allow !== undefined) {
      return {
        response: { outcome: { outcome: 'selected', optionId: allow.optionId } },
        decision: 'allowed',
      };
    }
  }
  const reject =
    byWhitelist('reject_once', provider.permissionOptions.rejectOnce) ??
    options.find((option) => option.kind === 'reject_once');
  if (reject === undefined) {
    return { response: { outcome: { outcome: 'cancelled' } }, decision: 'cancelled' };
  }
  return {
    response: { outcome: { outcome: 'selected', optionId: reject.optionId } },
    decision: 'rejected',
  };
}

function unsupported(method: string): never {
  throw RequestError.methodNotFound(method);
}

/**
 * 一条到 Agent 进程的 ACP 连接（ClientSideConnection 的薄封装）。
 * 多个会话共用一条连接；会话 → run 的路由由 `router` 负责。
 */
export class AcpConnection {
  readonly #options: AcpConnectionOptions;
  readonly #connection: ClientSideConnection;

  constructor(options: AcpConnectionOptions) {
    this.#options = options;
    const stream = ndJsonStream(options.channel.writable, options.channel.readable);
    this.#connection = new ClientSideConnection(() => this.#client(), stream);
  }

  /** Resolves when the underlying stream ends (process exit / crash / close). */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  async initialize(): Promise<AcpInitializeResponse> {
    const response = await this.#connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // No fs / terminal capability: the agents' native tools run in their own
      // sandbox (design 28 §6); the corresponding requests are refused below.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'KepCup', title: 'KepCup', version: this.#options.appVersion },
    });
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体协议版本不兼容（需要 ACP v${PROTOCOL_VERSION}，实际 v${response.protocolVersion}）`,
      );
    }
    return response;
  }

  newSession(request: NewSessionRequest): Promise<AcpNewSessionResponse> {
    return this.#connection.newSession(request);
  }

  prompt(sessionId: string, prompt: AcpContentBlock[]): Promise<AcpPromptResponse> {
    return this.#connection.prompt({ sessionId, prompt });
  }

  cancel(sessionId: string): Promise<void> {
    return this.#connection.cancel({ sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#connection.closeSession({ sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#connection.setSessionMode({ sessionId, modeId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.#connection.setSessionConfigOption({ sessionId, configId, value });
  }

  #client(): Client {
    const { agentId, provider, router, logger } = this.#options;
    return {
      sessionUpdate: (notification) => {
        if (router.deliver(notification)) return;
        const kind = notification.update.sessionUpdate;
        // Out-of-run output (autonomous turns, load replays, late chunks after
        // settle) never belongs to any run: drop it (design 28 §7).
        const contentBearing =
          kind === 'agent_message_chunk' || kind === 'tool_call' || kind === 'tool_call_update';
        logger[contentBearing ? 'info' : 'debug'](
          { agentId, sessionId: notification.sessionId, update: kind },
          'agent update outside any run dropped',
        );
      },
      requestPermission: async (request) => {
        let verdict: PermissionVerdict;
        const delegated = router.requestPermission?.(request.sessionId, request) ?? null;
        if (delegated !== null) {
          try {
            verdict = await delegated;
          } catch (error) {
            // Never hang the agent, never allow on an internal error.
            logger.warn(
              { agentId, error: error instanceof Error ? error.message : String(error) },
              'permission bridge failed; request cancelled',
            );
            verdict = { response: { outcome: { outcome: 'cancelled' } }, decision: 'cancelled' };
          }
        } else {
          verdict = decidePermission(request, provider, {
            hasRun: router.hasRun(request.sessionId),
            bridge: router.bridgeOf(request.sessionId),
          });
        }
        const { response, decision } = verdict;
        logger.info(
          { agentId, sessionId: request.sessionId, toolCallId: request.toolCall.toolCallId, decision },
          'agent permission request decided',
        );
        router.notePermission(
          request.sessionId,
          request.toolCall.title ?? request.toolCall.name ?? request.toolCall.toolCallId,
          decision,
        );
        return response;
      },
      // Capabilities KepCup never declares: answer immediately, never hang.
      readTextFile: () => unsupported('fs/read_text_file'),
      writeTextFile: () => unsupported('fs/write_text_file'),
      createTerminal: () => unsupported('terminal/create'),
      terminalOutput: () => unsupported('terminal/output'),
      releaseTerminal: () => unsupported('terminal/release'),
      waitForTerminalExit: () => unsupported('terminal/wait_for_exit'),
      killTerminal: () => unsupported('terminal/kill'),
      extMethod: async (method, params) => {
        const handler = provider.extRequests?.[method];
        if (handler === undefined) {
          logger.info({ agentId, method }, 'unsupported agent request refused');
          return unsupported(method);
        }
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
        return handler(params, {
          agentId,
          sessionId,
          hasRun: sessionId !== null && router.hasRun(sessionId),
        });
      },
      extNotification: async (method, params) => {
        if (method === ACP_AUTH_STATUS_NOTIFICATION) {
          const status = (params as { authStatus?: { kind?: unknown } } | undefined)?.authStatus;
          const kind = typeof status?.kind === 'string' ? status.kind : 'unknown';
          logger.info({ agentId, authStatus: kind }, 'agent auth status update');
          this.#options.onAuthStatus?.({ kind, raw: params });
          return;
        }
        logger.debug({ agentId, method }, 'agent extension notification ignored');
      },
    };
  }
}
