import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type InitializeResponse,
  type NewSessionResponse,
} from '@agentclientprotocol/sdk';
import { AppError } from '@kepcup/shared';
import { ACP_AUTH_STATUS_NOTIFICATION, type AcpByteChannel } from './client.js';

/**
 * 管理用 ACP 连接（D72 P4，docs/design/28-external-agents-acp.md §2.2 / §9.1）：
 * 设置页的登录方式探测、`authenticate` / `logout`、模型与推理强度选项读取
 * 走一个**独立的短命进程**，不占用 AgentHost 上跑 run 的进程，也不影响其
 * 会话路由。用完即杀；登录 / 退出成功后由调用方让 AgentHost 重启进程，使
 * 新的登录态生效。
 *
 * 与 run 连接的差异：`initialize` 声明 `auth.terminal = true`（及
 * `_meta['terminal-auth']`），以拿到 terminal 类登录方式；此连接上从不发
 * prompt，任何 Agent→客户端请求一律立即拒绝（权限 = cancelled，其余 =
 * methodNotFound），绝不悬挂。
 */

export interface AcpControlSessionOptions {
  channel: AcpByteChannel;
  appVersion: string;
  /** `_auth/status_update` 扩展通知（Claude / Codex 未登录时推 kind 'none'）。 */
  onAuthStatus?(kind: string): void;
}

function refuse(method: string): never {
  throw RequestError.methodNotFound(method);
}

export class AcpControlSession {
  readonly #connection: ClientSideConnection;

  constructor(options: AcpControlSessionOptions) {
    const client: Client = {
      sessionUpdate: async () => undefined,
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      readTextFile: () => refuse('fs/read_text_file'),
      writeTextFile: () => refuse('fs/write_text_file'),
      createTerminal: () => refuse('terminal/create'),
      terminalOutput: () => refuse('terminal/output'),
      releaseTerminal: () => refuse('terminal/release'),
      waitForTerminalExit: () => refuse('terminal/wait_for_exit'),
      killTerminal: () => refuse('terminal/kill'),
      extMethod: async (method) => refuse(method),
      extNotification: async (method, params) => {
        if (method !== ACP_AUTH_STATUS_NOTIFICATION) return;
        const status = (params as { authStatus?: { kind?: unknown } } | undefined)?.authStatus;
        options.onAuthStatus?.(typeof status?.kind === 'string' ? status.kind : 'unknown');
      },
    };
    this.#appVersion = options.appVersion;
    this.#connection = new ClientSideConnection(
      () => client,
      ndJsonStream(options.channel.writable, options.channel.readable),
    );
  }

  readonly #appVersion: string;

  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  async initialize(): Promise<InitializeResponse> {
    const response = await this.#connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: true },
        _meta: { 'terminal-auth': true },
      },
      clientInfo: { name: 'KepCup', title: 'KepCup', version: this.#appVersion },
    });
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new AppError(
        'AGENT_INCOMPATIBLE',
        `智能体协议版本不兼容（需要 ACP v${PROTOCOL_VERSION}，实际 v${response.protocolVersion}）`,
      );
    }
    return response;
  }

  newSession(cwd: string, meta?: Record<string, unknown>): Promise<NewSessionResponse> {
    return this.#connection.newSession({
      cwd,
      mcpServers: [],
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#connection.closeSession({ sessionId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.#connection.authenticate({ methodId });
  }

  async logout(): Promise<void> {
    await this.#connection.logout({});
  }
}
