import {
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  McpConnectionClosedError,
  type CallToolResult,
  type Tool as McpTool,
} from '@earendil-works/pi-mcp';
import { SseTransport } from './sse-transport.js';
import {
  AppError,
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_RECONNECT_MAX,
  MCP_TOOL_LIST_CACHE_MS,
  MCP_TOOLS_PER_SERVER_MAX,
  type McpServer,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import type { SecretsService } from '../domain/secrets.js';
import type { SettingsService } from '../domain/settings.js';

/**
 * MCP 接入（D65，docs/design/23-mcp-and-subagent.md）：管理用户配置的 MCP
 * server 连接生命周期。首次使用懒连接；stdio 崩溃后下次调用自动重连（重试
 * 超限标记 failed 并发 `mcp.server_status` 事件）；tools 列表缓存 +
 * `notifications/tools/list_changed` 失效；core 关停统一 close。
 */

export type McpServerStatus = 'connecting' | 'connected' | 'failed' | 'closed';

export interface McpServiceEvents {
  'mcp.server_status': {
    serverId: string;
    serverName: string;
    status: McpServerStatus;
    detail?: string;
  };
}

interface ConnectionState {
  client: McpClient;
  status: McpServerStatus;
  tools: McpTool[] | null;
  toolsCachedAt: number;
  /** Registered cleanup for the tools/list_changed notification. */
  offNotification?: () => void;
}

export interface McpServerStatusSink {
  emit(payload: {
    serverId: string;
    serverName: string;
    status: McpServerStatus;
    detail?: string;
  }): void;
}

/** 草稿态密钥覆盖（设置页保存前测试）：键为变量名，优先于 secrets 表。 */
export interface McpSecretOverrides {
  env?: Record<string, string> | undefined;
  header?: Record<string, string> | undefined;
}

export interface McpServiceDeps {
  settings: SettingsService;
  secrets: SecretsService;
  logger: CoreLogger;
  clock: Clock;
  /** Status fan-out (RPC event bus); kept narrow for testability. */
  statusSink: McpServerStatusSink;
}

/** 应用级 enabled 的 server（Bot 侧再取交集，见 serversForBot）。 */
export function enabledServers(servers: McpServer[]): McpServer[] {
  return servers.filter((server) => server.enabled);
}

/** 「应用级 enabled ∩ Bot 选中」——Bot 未勾选的 server 不暴露。 */
export function serversForBot(servers: McpServer[], selectedIds: string[]): McpServer[] {
  if (selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  return enabledServers(servers).filter((server) => selected.has(server.id));
}

/**
 * `mcp_{serverId}_{toolName}`，sanitize 为 `[A-Za-z0-9_-]` 且 ≤64 字符
 * （模型侧工具名上限）。与内置工具重名时由调用方拒绝注册。
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const raw = `mcp_${serverId}_${toolName}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized.slice(0, 64);
}

export class McpService {
  readonly #deps: McpServiceDeps;
  readonly #connections = new Map<string, ConnectionState>();
  /** 连续连接/断开失败计数（serverId → failures）；成功连接后清零。 */
  readonly #failures = new Map<string, number>();

  constructor(deps: McpServiceDeps) {
    this.#deps = deps;
  }

  /** settings.mcpServers 的当前配置。 */
  listServers(): McpServer[] {
    return this.#deps.settings.get().mcpServers;
  }

  /** 应用 enabled ∩ Bot 选中（mcp_server_ids）。 */
  serversForBot(selectedIds: string[]): McpServer[] {
    return serversForBot(this.listServers(), selectedIds);
  }

  /**
   * 设置页连接测试：用给定配置连接并列出工具（不落缓存，结束后关闭）。
   * secretValues 为表单草稿里新输入的密钥（未保存），仅本次测试生效。
   */
  async testServer(
    server: McpServer,
    secretValues?: McpSecretOverrides | undefined,
  ): Promise<{ tools: string[]; missingSecrets: string[] }> {
    const missingSecrets = this.missingSecrets(server, secretValues);
    const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
    try {
      await this.#connectClient(client, server, secretValues);
      const tools = await client.listTools({ timeoutMs: MCP_CONNECT_TIMEOUT_MS });
      // 配置修好后解除 failed 停用：下次 loop 内调用按新配置重新计数。
      this.#failures.delete(server.id);
      return { tools: tools.map((tool) => tool.name), missingSecrets };
    } catch (error) {
      const hint = this.#endpointHint(server, error);
      if (hint !== '') {
        const message = error instanceof Error ? error.message : String(error);
        throw new AppError('MCP_CONNECT_FAILED', `${message}（${hint}）`);
      }
      throw error;
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * 401 = 服务端要求 Bearer 认证；404/405 = URL 没命中端点路径或协议类型
   * 选错（本地服务新旧协议混用很常见）。给设置页一条可操作的提示，而不是
   * 裸的 HTTP 状态码。
   */
  #endpointHint(server: McpServer, error: unknown): string {
    if (!(error instanceof McpHttpError)) return '';
    if (error.status === 401) {
      return '服务端要求认证：请在「请求头（密钥）」添加名称 Authorization，值为 Bearer <token>（需带 Bearer 前缀）';
    }
    if (error.status !== 404 && error.status !== 405) return '';
    if (server.transport === 'http') {
      return '请确认 URL 指向 MCP 端点（通常以 /mcp 结尾）；若服务为旧版 SSE 协议，请把类型改为 SSE';
    }
    if (server.transport === 'sse') {
      return '请确认 URL 指向 SSE 端点（通常以 /sse 结尾）；若服务为新版 Streamable HTTP 协议，请把类型改为 HTTP';
    }
    return '';
  }

  /** 配置中无法从覆盖值或 secrets 解析的占位符（`secret:env:x` / `secret:header:y`）。 */
  missingSecrets(server: McpServer, secretValues?: McpSecretOverrides | undefined): string[] {
    const missing: string[] = [];
    const check = (value: string) => {
      for (const kind of ['env', 'header'] as const) {
        const prefix = `secret:${kind}:`;
        if (value.startsWith(prefix)) {
          const name = value.slice(prefix.length);
          if (
            secretValues?.[kind]?.[name] !== undefined ||
            this.#deps.secrets.hasValue(`mcp:${server.id}:${kind}:${name}`)
          ) {
            continue;
          }
          missing.push(value);
        }
      }
    };
    for (const arg of server.args ?? []) check(arg);
    for (const value of Object.values(server.env ?? {})) check(value);
    for (const value of Object.values(server.headers ?? {})) check(value);
    return missing;
  }

  /**
   * server 的工具列表（懒连接 + 缓存；`tools/list_changed` 或 TTL 失效）。
   * 抛 MCP_CONNECT_FAILED（含重试超限）/ MCP_SERVER_FAILED。
   */
  async listTools(server: McpServer): Promise<McpTool[]> {
    const state = await this.#ensureConnected(server);
    if (state.tools !== null && this.#deps.clock.now() - state.toolsCachedAt <= MCP_TOOL_LIST_CACHE_MS) {
      return state.tools;
    }
    const tools = await state.client.listTools({ timeoutMs: MCP_CONNECT_TIMEOUT_MS });
    state.tools = tools.slice(0, MCP_TOOLS_PER_SERVER_MAX);
    state.toolsCachedAt = this.#deps.clock.now();
    if (tools.length > MCP_TOOLS_PER_SERVER_MAX) {
      this.#deps.logger.warn(
        { serverId: server.id, total: tools.length, cap: MCP_TOOLS_PER_SERVER_MAX },
        'mcp server tool list truncated',
      );
    }
    return state.tools;
  }

  /** 调用 MCP 工具（审批/审计在网关层，见 ../gateway/index.ts mcpToolCall）。 */
  async callTool(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<CallToolResult> {
    const state = await this.#ensureConnected(server);
    try {
      return await state.client.callTool(toolName, args, {
        signal: options.signal,
        timeoutMs: MCP_CALL_TIMEOUT_MS,
      });
    } catch (error) {
      // 连接断开（stdio 崩溃 / HTTP 会话失效）：丢弃连接，下次调用重连。
      if (error instanceof McpConnectionClosedError || this.#isTransportFailure(error)) {
        this.#dropConnection(server, state, error);
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        'MCP_CALL_FAILED',
        `MCP 工具 ${toolName} 调用失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** core 关停：统一 close，全部标记 closed。 */
  async closeAll(): Promise<void> {
    for (const [serverId, state] of [...this.#connections.entries()]) {
      const server = this.listServers().find((entry) => entry.id === serverId);
      await state.client.close().catch(() => {});
      state.offNotification?.();
      this.#connections.delete(serverId);
      this.#deps.statusSink.emit({
        serverId,
        serverName: server?.name ?? serverId,
        status: 'closed',
      });
    }
    this.#failures.clear();
  }

  async #ensureConnected(server: McpServer): Promise<ConnectionState> {
    const existing = this.#connections.get(server.id);
    if (existing?.status === 'connected') return existing;
    existing?.offNotification?.();
    this.#connections.delete(server.id);
    const failures = this.#failures.get(server.id) ?? 0;
    if (failures >= MCP_RECONNECT_MAX) {
      throw new AppError(
        'MCP_SERVER_FAILED',
        `MCP 服务器 ${server.name} 连接多次失败，已停用（请在设置页检查配置后重试）`,
      );
    }

    this.#deps.statusSink.emit({ serverId: server.id, serverName: server.name, status: 'connecting' });
    const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
    try {
      await this.#connectClient(client, server);
    } catch (error) {
      await client.close().catch(() => {});
      const attempts = failures + 1;
      this.#failures.set(server.id, attempts);
      const hint = this.#endpointHint(server, error);
      const detail = `${error instanceof Error ? error.message : String(error)}${hint !== '' ? `（${hint}）` : ''}`;
      if (attempts >= MCP_RECONNECT_MAX) {
        this.#deps.statusSink.emit({
          serverId: server.id,
          serverName: server.name,
          status: 'failed',
          detail: `重试 ${attempts} 次后停用：${detail}`,
        });
      }
      throw new AppError('MCP_CONNECT_FAILED', `MCP 服务器 ${server.name} 连接失败：${detail}`);
    }

    const state: ConnectionState = {
      client,
      status: 'connected',
      tools: null,
      toolsCachedAt: 0,
    };
    this.#failures.delete(server.id);
    state.offNotification = client.onNotification('notifications/tools/list_changed', () => {
      state.tools = null;
      this.#deps.logger.info({ serverId: server.id }, 'mcp tool list invalidated');
    });
    client.onClose(() => {
      // 服务端主动断开：连接丢弃（failures 计数 +1），由下次调用重连。
      // #dropConnection 已先行清理时不再重复计数/重复发事件。
      if (this.#connections.get(server.id) !== state) return;
      state.status = 'closed';
      this.#connections.delete(server.id);
      const attempts = (this.#failures.get(server.id) ?? 0) + 1;
      this.#failures.set(server.id, attempts);
      this.#deps.statusSink.emit({
        serverId: server.id,
        serverName: server.name,
        status: 'closed',
        detail: '连接被服务端关闭',
      });
    });
    this.#connections.set(server.id, state);
    this.#deps.statusSink.emit({ serverId: server.id, serverName: server.name, status: 'connected' });
    return state;
  }

  async #connectClient(
    client: McpClient,
    server: McpServer,
    secretValues?: McpSecretOverrides | undefined,
  ): Promise<void> {
    const transport =
      server.transport === 'stdio'
        ? new StdioTransport({
            command: server.command ?? '',
            args: this.#resolveSecretValues(server.id, server.args ?? [], 'env', secretValues),
            env: this.#resolveRecordSecrets(server.id, server.env, 'env', secretValues),
          })
        : server.transport === 'sse'
          ? new SseTransport({
              url: server.url ?? '',
              headers: this.#resolveRecordSecrets(
                server.id,
                server.headers,
                'header',
                secretValues,
              ),
            })
          : new StreamableHttpTransport({
              url: server.url ?? '',
              headers: this.#resolveRecordSecrets(
                server.id,
                server.headers,
                'header',
                secretValues,
              ),
            });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), MCP_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timeout.signal.addEventListener('abort', () => {
            reject(new Error(`连接超时（${Math.round(MCP_CONNECT_TIMEOUT_MS / 1000)} 秒）`));
          });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #dropConnection(server: McpServer, state: ConnectionState, error: unknown): void {
    state.offNotification?.();
    this.#connections.delete(server.id);
    state.status = 'failed';
    const attempts = (this.#failures.get(server.id) ?? 0) + 1;
    this.#failures.set(server.id, attempts);
    this.#deps.logger.warn(
      {
        serverId: server.id,
        failures: attempts,
        error: error instanceof Error ? error.message : String(error),
      },
      'mcp connection dropped; will reconnect on next call',
    );
  }

  #isTransportFailure(error: unknown): boolean {
    return error instanceof Error && /closed|socket|EPIPE|ECONNRESET|fetch failed/i.test(error.message);
  }

  /**
   * 占位符解析：`secret:env:<name>` / `secret:header:<name>` → 优先取测试
   * 传入的覆盖值（草稿未保存），否则查 secrets 表 `mcp:{serverId}:env|header:{name}`。
   * 未找到的占位符保留原样（连接侧会报错，设置页可见），绝不明文落日志。
   */
  #resolveSecretValues(
    serverId: string,
    values: string[],
    kind: 'env' | 'header',
    secretValues?: McpSecretOverrides | undefined,
  ): string[] {
    return values.map((value) => this.#resolveSecretValue(serverId, value, kind, secretValues));
  }

  #resolveRecordSecrets(
    serverId: string,
    record: Record<string, string> | undefined,
    kind: 'env' | 'header',
    secretValues?: McpSecretOverrides | undefined,
  ): Record<string, string> | undefined {
    if (record === undefined) return undefined;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      resolved[key] = this.#resolveSecretValue(serverId, value, kind, secretValues);
    }
    return resolved;
  }

  #resolveSecretValue(
    serverId: string,
    value: string,
    kind: 'env' | 'header',
    secretValues?: McpSecretOverrides | undefined,
  ): string {
    const prefix = kind === 'env' ? 'secret:env:' : 'secret:header:';
    if (!value.startsWith(prefix)) return value;
    const name = value.slice(prefix.length);
    return (
      secretValues?.[kind]?.[name] ??
      this.#deps.secrets.getValue(`mcp:${serverId}:${kind}:${name}`) ??
      value
    );
  }
}
