import {
  McpClient,
  McpHttpError,
  type AuthProvider,
  StdioTransport,
  StreamableHttpTransport,
  McpConnectionClosedError,
  type CallToolResult,
  type Tool as McpTool,
  type ToolAnnotations,
} from '@earendil-works/pi-mcp';
import { SseTransport } from './sse-transport.js';
import {
  AppError,
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_RECONNECT_MAX,
  MCP_TOOL_LIST_CACHE_MS,
  MCP_TOOLS_PER_SERVER_MAX,
  type AppAuthReason,
  type AppConnection,
  type McpServer,
  type McpToolPolicy,
  type McpToolRisksOutput,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import type { SecretsService } from '../domain/secrets.js';
import type { SettingsService } from '../domain/settings.js';
import { classifyRiskDetailed, type ToolRiskDetail } from './risk.js';
import { AppAuthRequiredError, findAppAuthRequiredError } from '../apps/auth/errors.js';
import {
  customConnectionId,
  isCatalogConnectionId,
  sameEndpoint,
} from '../apps/connection-store.js';
import { toolDefinitionHash } from '../apps/policy.js';
import { toolLockKey } from '../apps/tool-lock.js';

/**
 * MCP 接入（D65，docs/design/23-mcp-and-subagent.md）：管理用户配置的 MCP
 * server 连接生命周期。首次使用懒连接；stdio 崩溃后下次调用自动重连（重试
 * 超限标记 failed 并发 `mcp.server_status` 事件）；tools 列表缓存 +
 * `notifications/tools/list_changed` 失效；core 关停统一 close。
 */

/** W5：调用时刷新工具注解的上限（在线连接上的 tools/list；超时用已知注解）。 */
const MCP_RISK_REFRESH_TIMEOUT_MS = 5_000;

/** `needs_auth`（D73）：OAuth server 未连接 / 令牌失效 / 需追加权限——不是失败，不计入停用。 */
export type McpServerStatus = 'connecting' | 'connected' | 'failed' | 'closed' | 'needs_auth';

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

/**
 * OAuth server 的运行时授权来源（D73；实现见 `apps/auth/registry.ts`）：按连接 id
 * （自定义 server 为 `custom:{serverId}`）取每个连接唯一的 `AuthProvider`。
 */
export interface McpAuthSource {
  /**
   * `serverUrl` = 实际要连的 URL：与连接行记录的 URL 不一致（或行不存在）时必须拒绝
   * （抛 `AppAuthRequiredError` not_connected）——令牌只发给授权时的那个地址。
   */
  providerFor(connectionId: string, serverUrl?: string | null): AuthProvider;
  /** 是否已有令牌（设置页测试在未连接时不发起任何请求）。 */
  hasTokens(connectionId: string): boolean;
  /** 服务端在刷新后仍回 401：把连接标记为 expired（持久化 + 广播）。 */
  markExpired?(connectionId: string): void;
}

/**
 * 工具定义锁定的接入点（D73 P1，`apps/tool-lock.ts`）：每次从 server 拉到新的工具列表
 * （首次、`tools/list_changed` 之后、缓存过期）都同步登记，决定哪些工具被锁定。
 * 缺省（未接入）= 不锁定（McpService 单测 / 旧调用方）。
 */
export interface McpToolLockHook {
  refresh(
    connectionId: string,
    tools: McpTool[],
    ctx: { server: Pick<McpServer, 'id' | 'name' | 'url' | 'auth'> },
  ): unknown;
  /** 暴露过滤：已批准（且未被停用）的工具 vs 待复核而被锁定的工具。 */
  partition(
    connectionId: string,
    tools: McpTool[],
  ): { exposed: McpTool[]; locked: Array<{ name: string; reason: 'new' | 'changed' }> };
  /** 调用时再核一次：当前定义是否已批准（run 中途定义变化的工具不再放行）。 */
  isExposed(connectionId: string, toolName: string): boolean;
}

/**
 * 目录连接 → McpService（D73 P1，设计 29 §6 / 执行方案 §5.4）：把 `app_connections` 里的目录
 * 连接（`conn_…` 行）当作 MCP server 的第二个来源。由 `start.ts` 经 {@link McpService.attachConnections}
 * 接入；未接入时 McpService 的行为与 P0 完全一致（只有 settings.mcpServers）。
 */
export interface McpConnectionSource {
  /** 全部目录连接（不含 `custom:` 行）。 */
  list(): AppConnection[];
  get(connectionId: string): AppConnection | null;
  /** 连接所属应用的名称（目录条目 title，按 slug 查）；目录里已没有该条目时 undefined。 */
  appName(connectorId: string): string | undefined;
  /** 用户对该连接各工具的逐工具策略（`app_connection_tools.user_policy`），无则空。 */
  toolPolicies(connectionId: string): Record<string, McpToolPolicy>;
}

/**
 * 把一个目录连接合成为 `McpServer`（纯函数；McpService 的 server 来源 = `settings.mcpServers` ∪ 这些）。
 *
 * **合成契约**（orchestrator / 网关 / 设置页依赖，改动须同步）：
 * - `id` = 连接 id（`conn_…`），也是 `mcp.server_status` 事件的 `serverId`、`McpService` 内部连接缓存 /
 *   失败计数 / 注解缓存的键、`ToolLockService` 锁定行的键、`ConnectionAuthRegistry` 授权提供者的键
 *   （自定义 server 的授权键仍是 `custom:{serverId}`）；
 * - `name` = `应用名（账号）`，账号标签已含应用名时（`Notion #2`）直接用标签；
 * - `transport: 'http'`、`url` = 连接行的 `server_url`（`server_url` 为空的行不合成）、`auth: 'oauth'`；
 * - `enabled` = 连接状态不是 `disabled`（`expired` / `needs_scope` 等仍 enabled：连接时抛授权错误、
 *   发 `needs_auth`，而不是静默消失）；
 * - `autoApprove` 恒为 false —— settings 里的 `autoApprove`（“mcpAutoApprove”）只对自定义 server
 *   生效，应用连接的免审批只能来自逐工具策略；
 * - `toolPolicies` = 该连接各工具的 `user_policy`，所以对自定义 server 通用的 `decideMcpTool` /
 *   `mcpToolEnabled` 对合成 server 同样适用（无策略时省略该字段）。
 */
export function connectionToMcpServer(
  connection: AppConnection,
  options: {
    appName?: string | undefined;
    toolPolicies?: Record<string, McpToolPolicy> | undefined;
  } = {},
): McpServer | null {
  if (connection.serverUrl === null) return null;
  const appName = options.appName ?? connection.connectorId;
  const name = connection.label.includes(appName)
    ? connection.label
    : `${appName}（${connection.label}）`;
  const policies = options.toolPolicies ?? {};
  return {
    id: connection.id,
    name: name.slice(0, 100),
    transport: 'http',
    url: connection.serverUrl,
    enabled: connection.status !== 'disabled',
    autoApprove: false,
    auth: 'oauth',
    ...(Object.keys(policies).length > 0 ? { toolPolicies: policies } : {}),
  };
}

/** 授权连接 id：目录连接 server 的 id 即连接 id，自定义 server 为 `custom:{serverId}`。 */
export function authConnectionIdOf(server: Pick<McpServer, 'id'>): string {
  return isCatalogConnectionId(server.id) ? server.id : customConnectionId(server.id);
}

export interface McpServiceDeps {
  settings: SettingsService;
  secrets: SecretsService;
  logger: CoreLogger;
  clock: Clock;
  /** Status fan-out (RPC event bus); kept narrow for testability. */
  statusSink: McpServerStatusSink;
  /** D73：`auth: 'oauth'` 的 server 的授权来源；缺省时这类 server 视为未连接。 */
  auth?: McpAuthSource | undefined;
}

/** 设置页测试结果（`mcp.test`）：OAuth server 未连接 / 失效时 `tools` 为空并带 `needsAuth`。 */
export interface McpTestResult {
  tools: string[];
  missingSecrets: string[];
  /** 工具名 → 定义哈希（`toolDefinitionHash`），见 `apps.tools.approveAfterTest`。 */
  toolHashes?: Record<string, string>;
  needsAuth?: AppAuthReason;
  message?: string;
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
  /**
   * W5：每个 server 最近一次 tools/list 的注解（serverId → toolName →
   * annotations）。连接断开 / 列表失效后仍保留，供 riskOf 同步查询；下一次
   * listTools 整体替换（工具消失即移出）。
   */
  readonly #annotations = new Map<string, Map<string, ToolAnnotations | undefined>>();
  /**
   * W5 复查：进行中的连接（serverId → 连接中）。并发的 listTools / callTool /
   * resolveRisk 共用同一次连接，不再各起一个进程互相覆盖、留下孤儿 client。
   * `countFailure` 只要有一个等待者要计数（任务 / 工具调用）就计入重连预算。
   */
  readonly #pending = new Map<
    string,
    { promise: Promise<ConnectionState>; countFailure: boolean }
  >();
  /** D73 P1：工具定义锁定（见 {@link McpToolLockHook}）。 */
  #toolLock: McpToolLockHook | null = null;
  /** D73 P1：目录连接来源（见 {@link McpConnectionSource}）。 */
  #connectionSource: McpConnectionSource | null = null;
  /** 最近见到的 server 名（连接行删除后 `closed` 事件仍能带上名字）。 */
  readonly #serverNames = new Map<string, string>();

  constructor(deps: McpServiceDeps) {
    this.#deps = deps;
  }

  /** D73：start.ts 在连接应用运行时（registry）构造后接入（McpService 先于它构造）。 */
  attachAuth(auth: McpAuthSource): void {
    this.#deps.auth = auth;
  }

  /** D73 P1：接入工具定义锁定（列表刷新时登记；过滤在 `buildMcpTools` / `resolveMcpToolEntries`）。 */
  attachToolLock(lock: McpToolLockHook): void {
    this.#toolLock = lock;
  }

  /**
   * D73 P1：`buildMcpTools` / `resolveMcpToolEntries` 的 `toolFilter`；未接入锁定时为
   * undefined（不过滤）。
   */
  get toolFilter():
    | ((serverKey: string, tools: McpTool[]) => ReturnType<McpToolLockHook['partition']>)
    | undefined {
    const lock = this.#toolLock;
    return lock === null ? undefined : (key, tools) => lock.partition(key, tools);
  }

  /** D73 P1：工具此刻是否可调用（无锁定 = true）。网关在调用时核对。 */
  toolApproved(server: Pick<McpServer, 'id'>, toolName: string): boolean {
    return this.#toolLock === null || this.#toolLock.isExposed(toolLockKey(server), toolName);
  }

  /** D73 P1：接入目录连接来源（`start.ts`，在连接应用服务构造后）。 */
  attachConnections(source: McpConnectionSource): void {
    this.#connectionSource = source;
  }

  /** `settings.mcpServers`（仅用户配置的自定义 server）。 */
  listSettingsServers(): McpServer[] {
    return this.#deps.settings.get().mcpServers;
  }

  /**
   * server 全集 = `settings.mcpServers` ∪ 目录连接合成的 server（合成契约见
   * {@link connectionToMcpServer}）。settings 在前；id 冲突时 settings 的条目优先（目录连接 id 的
   * `conn_` 前缀为保留，正常不会冲突）。
   */
  listServers(): McpServer[] {
    const settings = this.listSettingsServers();
    const source = this.#connectionSource;
    if (source === null) return settings;
    const taken = new Set(settings.map((server) => server.id));
    const synthesized: McpServer[] = [];
    for (const connection of source.list()) {
      if (taken.has(connection.id)) continue;
      const server = this.#synthesize(source, connection);
      if (server !== null) synthesized.push(server);
    }
    return synthesized.length === 0 ? settings : [...settings, ...synthesized];
  }

  /**
   * 稳定查找：id 对应的 server（settings 自定义 server 或目录连接合成的 server）；不存在 /
   * 目录连接没有 server_url → undefined。每次调用现读设置与连接行（状态、标签、逐工具策略
   * 即时生效），不缓存返回对象。
   */
  serverFor(id: string): McpServer | undefined {
    const custom = this.listSettingsServers().find((server) => server.id === id);
    if (custom !== undefined) return custom;
    const source = this.#connectionSource;
    if (source === null || !isCatalogConnectionId(id)) return undefined;
    const connection = source.get(id);
    if (connection === null) return undefined;
    return this.#synthesize(source, connection) ?? undefined;
  }

  #synthesize(source: McpConnectionSource, connection: AppConnection): McpServer | null {
    const server = connectionToMcpServer(connection, {
      appName: source.appName(connection.connectorId),
      toolPolicies: source.toolPolicies(connection.id),
    });
    if (server !== null) this.#serverNames.set(server.id, server.name);
    return server;
  }

  #nameOf(serverId: string): string {
    return this.serverFor(serverId)?.name ?? this.#serverNames.get(serverId) ?? serverId;
  }

  /**
   * 应用 enabled ∩ Bot 选中。`selectedIds` 里既可以是自定义 server id（`mcp_server_ids`），也可以是
   * 目录连接 id（`app_connection_ids`，由 orchestrator 合并后传入）。向后兼容：只含 settings server
   * id 时结果与旧实现一致（settings 顺序）；目录连接排在后面，按 `selectedIds` 的顺序。
   */
  serversForBot(selectedIds: string[]): McpServer[] {
    if (selectedIds.length === 0) return [];
    const custom = serversForBot(this.listSettingsServers(), selectedIds);
    if (this.#connectionSource === null) return custom;
    const taken = new Set(custom.map((server) => server.id));
    const settingsIds = new Set(this.listSettingsServers().map((server) => server.id));
    const connections: McpServer[] = [];
    for (const id of new Set(selectedIds)) {
      if (taken.has(id) || settingsIds.has(id)) continue;
      const server = this.serverFor(id);
      if (server !== undefined && server.enabled) connections.push(server);
    }
    return connections.length === 0 ? custom : [...custom, ...connections];
  }

  /**
   * 设置页连接测试：用给定配置连接并列出工具（不落缓存，结束后关闭）。
   * secretValues 为表单草稿里新输入的密钥（未保存），仅本次测试生效。
   */
  async testServer(
    server: McpServer,
    secretValues?: McpSecretOverrides | undefined,
  ): Promise<McpTestResult> {
    const missingSecrets = this.missingSecrets(server, secretValues);
    if (server.auth === 'oauth') {
      // 已存的令牌只属于已保存的那个 server（按 id）且 URL / 认证方式没变：`mcp.test` 的入参来自
      // 渲染进程的表单草稿，草稿里的 URL 若与已保存的不同，绝不能带着该 server 的令牌去访问它
      // （也不能让草稿的 401 把真实连接标成 expired）。草稿态一律按「未连接」处理，不发请求。
      const saved = this.listSettingsServers().find((entry) => entry.id === server.id);
      const bound =
        saved !== undefined &&
        saved.auth === 'oauth' &&
        saved.url !== undefined &&
        sameEndpoint(saved.url, server.url);
      if (!bound || !this.#deps.auth?.hasTokens(authConnectionIdOf(server))) {
        // 未连接：不发起任何请求，更不会启动授权（授权只由用户点「连接」触发）。
        return {
          tools: [],
          missingSecrets,
          needsAuth: 'not_connected',
          message: bound
            ? '尚未连接：请先点击「连接」完成授权'
            : '尚未连接：请先保存配置，再点击「连接」完成授权',
        };
      }
    }
    const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
    try {
      await this.#connectClient(client, server, secretValues);
      const tools = await client.listTools({ timeoutMs: MCP_CONNECT_TIMEOUT_MS });
      // 配置修好后解除 failed 停用：下次 loop 内调用按新配置重新计数。
      this.#failures.delete(server.id);
      return {
        tools: tools.map((tool) => tool.name),
        missingSecrets,
        // D73 P1：测试时看到的定义哈希——保存后 `apps.tools.approveAfterTest` 只批准这一份。
        toolHashes: Object.fromEntries(tools.map((tool) => [tool.name, toolDefinitionHash(tool)])),
      };
    } catch (error) {
      const authError = this.#authFailureOf(server, error);
      if (authError !== null) {
        return {
          tools: [],
          missingSecrets,
          needsAuth: authError.reason,
          message:
            authError.reason === 'scope'
              ? '需要追加权限：请重新连接'
              : authError.reason === 'expired'
                ? '连接已失效：请重新连接'
                : '尚未连接：请先点击「连接」完成授权',
        };
      }
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
      if (server.auth === 'oauth') return '请在设置中连接该应用';
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
  async listTools(
    server: McpServer,
    options: {
      countFailure?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
      /** 跳过缓存，强制向 server 重新拉取（并登记工具锁定）。 */
      refresh?: boolean;
    } = {},
  ): Promise<McpTool[]> {
    const state = await this.#ensureConnected(server, options.countFailure ?? true);
    if (
      options.refresh !== true &&
      state.tools !== null &&
      this.#deps.clock.now() - state.toolsCachedAt <= MCP_TOOL_LIST_CACHE_MS
    ) {
      return state.tools;
    }
    let tools: McpTool[];
    try {
      tools = await state.client.listTools({
        timeoutMs: options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // 与 callTool 一致：缓存连接上刷新令牌后仍 401（或需追加权限）是授权问题，不是连接故障。
      const authError = this.#authFailureOf(server, error);
      if (authError !== null) {
        this.#emitNeedsAuth(server, authError);
        throw authError;
      }
      throw error;
    }
    state.tools = tools.slice(0, MCP_TOOLS_PER_SERVER_MAX);
    state.toolsCachedAt = this.#deps.clock.now();
    this.#rememberAnnotations(server.id, state.tools);
    this.#registerWithToolLock(server, state.tools);
    if (tools.length > MCP_TOOLS_PER_SERVER_MAX) {
      this.#deps.logger.warn(
        { serverId: server.id, total: tools.length, cap: MCP_TOOLS_PER_SERVER_MAX },
        'mcp server tool list truncated',
      );
    }
    return state.tools;
  }

  /**
   * W3：最近一次工具列表里的工具名（同步，不连接）；从未列出过 → null（调用方
   * 按「未知」取严）。
   */
  knownToolNames(serverId: string): string[] | null {
    const known = this.#annotations.get(serverId);
    return known !== undefined ? [...known.keys()] : null;
  }

  /**
   * W5：按最近一次工具列表的注解 + 工具名判定风险（同步，不连接）。未见过的
   * 工具（列表里没有 / 从未列出）按缺省取严：destructive。
   */
  riskOf(serverId: string, toolName: string): ToolRiskDetail {
    const known = this.#annotations.get(serverId);
    if (known === undefined || !known.has(toolName)) {
      return { risk: 'destructive', source: 'default' };
    }
    return classifyRiskDetailed({ name: toolName, annotations: known.get(toolName) });
  }

  /**
   * W5：调用时重新解析风险——连接在线且工具列表已失效（`tools/list_changed`）
   * 或过期时先刷新（随调用的 signal 中止、最多 MCP_RISK_REFRESH_TIMEOUT_MS），
   * 注解变化在下一次调用即生效。连接不在线时**不**为判定风险去连接（不消耗
   * 重连预算；连接由随后的 callTool 负责），直接用最近一次已知注解（没见过
   * 的工具按 destructive）；刷新失败同样退回已知注解。
   */
  async resolveRisk(
    server: McpServer,
    toolName: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolRiskDetail> {
    if (this.#connections.get(server.id)?.status === 'connected') {
      try {
        await this.listTools(server, {
          countFailure: false,
          timeoutMs: MCP_RISK_REFRESH_TIMEOUT_MS,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch {
        // 刷新失败：只用已知注解判定；连接问题由随后的 callTool 报出。
      }
    }
    return this.riskOf(server.id, toolName);
  }

  /**
   * W5 设置页：server 的工具及风险档。应用级启用的 server 走缓存连接；未启用
   * 的用一次性连接（不落连接缓存，只更新注解）。
   */
  async describeTools(
    server: McpServer,
  ): Promise<Array<{ name: string; description: string } & ToolRiskDetail>> {
    let tools: McpTool[];
    if (server.enabled) {
      // 设置页 / Bot 详情的查询不计入重连预算（只有任务与工具调用计数）。
      tools = await this.listTools(server, { countFailure: false });
    } else {
      const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
      try {
        await this.#connectClient(client, server);
        tools = (await client.listTools({ timeoutMs: MCP_CONNECT_TIMEOUT_MS })).slice(
          0,
          MCP_TOOLS_PER_SERVER_MAX,
        );
      } finally {
        await client.close().catch(() => {});
      }
      this.#rememberAnnotations(server.id, tools);
    }
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.title ?? '',
      ...classifyRiskDetailed({ name: tool.name, annotations: tool.annotations }),
    }));
  }

  /**
   * W5 `mcp.toolRisks`：已保存 server 的工具风险档。toolPolicies 里有、列表里
   * 已没有的工具以 missing:true 附在后面（设置页标灰，配置保留）；连接失败时
   * 返回 error 与这些已配置工具。
   */
  async toolRisks(serverId: string): Promise<McpToolRisksOutput> {
    const server = this.listServers().find((entry) => entry.id === serverId);
    if (server === undefined) throw new AppError('NOT_FOUND', `MCP 服务器 ${serverId} 不存在`);
    let listed: Array<{ name: string; description: string } & ToolRiskDetail> = [];
    let error: string | undefined;
    try {
      listed = await this.describeTools(server);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const seen = new Set(listed.map((tool) => tool.name));
    const missing = Object.keys(server.toolPolicies ?? {})
      .filter((name) => !seen.has(name))
      .map((name) => ({ name, description: '', ...this.riskOf(server.id, name), missing: true }));
    return {
      tools: [...listed.map((tool) => ({ ...tool, missing: false })), ...missing],
      ...(error !== undefined ? { error } : {}),
    };
  }

  /**
   * D73 P1：把刚拉到的工具列表登记到工具锁定（新增 / 定义变化 → 待复核）。登记失败不让
   * 列表失败——未登记的工具在过滤处按「未批准」处理（fail-closed）。
   */
  #registerWithToolLock(server: McpServer, tools: McpTool[]): void {
    if (this.#toolLock === null) return;
    try {
      this.#toolLock.refresh(toolLockKey(server), tools, { server });
    } catch (error) {
      this.#deps.logger.warn(
        { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
        'tool lock refresh failed',
      );
    }
  }

  #rememberAnnotations(serverId: string, tools: McpTool[]): void {
    this.#annotations.set(serverId, new Map(tools.map((tool) => [tool.name, tool.annotations])));
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
      // D73：授权失效 / 需追加权限不是连接故障——不丢连接、不计失败，原样上抛给
      // mcp/tools.ts 映射成 SETUP_REQUIRED（connect-app）。
      const authError = this.#authFailureOf(server, error);
      if (authError !== null) {
        this.#emitNeedsAuth(server, authError);
        throw authError;
      }
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

  /** D73：授权恢复 / 配置修好后清零某 server 的连接失败计数（解除“已停用”）。 */
  resetFailures(serverId: string): void {
    this.#failures.delete(serverId);
  }

  /**
   * 开发者模式（D73 P2 §6.6）：server 的原始工具定义（含 annotations / inputSchema，JSON 化）。
   * `refresh` = 丢弃工具缓存并向 server 重新拉取；重新拉取与其它刷新一样登记到工具锁定
   * （新增 / 定义变化的工具照常被锁定待复核），所以手动刷新绕不过锁定。未启用的 server 用一次性连接
   * （不落缓存、不登记锁定）。
   */
  async rawTools(
    serverId: string,
    options: { refresh?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const server = this.serverFor(serverId);
    if (server === undefined) throw new AppError('NOT_FOUND', `MCP 服务器 ${serverId} 不存在`);
    let tools: McpTool[];
    if (server.enabled) {
      if (options.refresh === true) {
        const state = this.#connections.get(server.id);
        if (state !== undefined) state.tools = null;
      }
      tools = await this.listTools(server, {
        countFailure: false,
        ...(options.refresh === true ? { refresh: true } : {}),
      });
    } else {
      const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
      try {
        await this.#connectClient(client, server);
        tools = (await client.listTools({ timeoutMs: MCP_CONNECT_TIMEOUT_MS })).slice(
          0,
          MCP_TOOLS_PER_SERVER_MAX,
        );
      } finally {
        await client.close().catch(() => {});
      }
    }
    return tools.map((tool) => JSON.parse(JSON.stringify(tool)) as Record<string, unknown>);
  }

  /** 开发者模式「手动刷新工具」：丢弃工具缓存并重新列出（工具锁定照常生效）。 */
  refreshTools(serverId: string): Promise<Array<Record<string, unknown>>> {
    return this.rawTools(serverId, { refresh: true });
  }

  /**
   * D73：关闭并丢弃某 server 缓存的连接（令牌被替换 / 断开 / server 被删除后，下次调用
   * 用新凭据重连）。不计入失败次数；进行中的连接先等它收尾。
   */
  async closeServer(serverId: string): Promise<void> {
    const inFlight = this.#pending.get(serverId);
    if (inFlight !== undefined) await inFlight.promise.catch(() => {});
    const state = this.#connections.get(serverId);
    if (state === undefined) return;
    const serverName = this.#nameOf(serverId);
    // 先摘掉再关：onClose 回调见到连接已不是当前连接，不会计失败。
    this.#connections.delete(serverId);
    state.offNotification?.();
    state.status = 'closed';
    await state.client.close().catch(() => {});
    this.#deps.statusSink.emit({ serverId, serverName, status: 'closed' });
  }

  /** core 关停：统一 close，全部标记 closed。 */
  async closeAll(): Promise<void> {
    // Connects still in flight settle first so none outlives the shutdown.
    await Promise.allSettled([...this.#pending.values()].map((entry) => entry.promise));
    for (const [serverId, state] of [...this.#connections.entries()]) {
      const serverName = this.#nameOf(serverId);
      await state.client.close().catch(() => {});
      state.offNotification?.();
      this.#connections.delete(serverId);
      this.#deps.statusSink.emit({ serverId, serverName, status: 'closed' });
    }
    this.#failures.clear();
  }

  /**
   * 连接（或复用在线 / 进行中的连接）。`countFailure:false`（对话轮解析工具面、
   * 设置页查询）的连接失败不计入 MCP_RECONNECT_MAX——否则对话轮与界面会把
   * 预算耗光，任务也跟着显示「已停用」；已停用的 server 对所有路径都不再连。
   */
  async #ensureConnected(server: McpServer, countFailure = true): Promise<ConnectionState> {
    const existing = this.#connections.get(server.id);
    if (existing?.status === 'connected') return existing;
    const inFlight = this.#pending.get(server.id);
    if (inFlight !== undefined) {
      if (countFailure) inFlight.countFailure = true;
      return inFlight.promise;
    }
    const entry = { countFailure, promise: null as unknown as Promise<ConnectionState> };
    entry.promise = this.#connect(server, () => entry.countFailure).finally(() => {
      if (this.#pending.get(server.id) === entry) this.#pending.delete(server.id);
    });
    this.#pending.set(server.id, entry);
    return entry.promise;
  }

  async #connect(server: McpServer, countFailure: () => boolean): Promise<ConnectionState> {
    const existing = this.#connections.get(server.id);
    existing?.offNotification?.();
    this.#connections.delete(server.id);
    const failures = this.#failures.get(server.id) ?? 0;
    if (failures >= MCP_RECONNECT_MAX) {
      throw new AppError(
        'MCP_SERVER_FAILED',
        `MCP 服务器 ${server.name} 连接多次失败，已停用（请在设置页检查配置后重试）`,
      );
    }

    this.#deps.statusSink.emit({
      serverId: server.id,
      serverName: server.name,
      status: 'connecting',
    });
    const client = new McpClient({ name: 'kepcup', version: '0.0.0' });
    try {
      await this.#connectClient(client, server);
    } catch (error) {
      await client.close().catch(() => {});
      // D73：授权错误（含被包装的）不是连接失败——不计数、不发 failed、不停用；
      // 发 needs_auth 状态并原样重抛，让调用方走“需要重新连接”的路径。
      const authError = this.#authFailureOf(server, error);
      if (authError !== null) {
        this.#emitNeedsAuth(server, authError);
        throw authError;
      }
      const counted = countFailure();
      const attempts = counted ? failures + 1 : failures;
      if (counted) this.#failures.set(server.id, attempts);
      const hint = this.#endpointHint(server, error);
      const detail = `${error instanceof Error ? error.message : String(error)}${hint !== '' ? `（${hint}）` : ''}`;
      if (counted && attempts >= MCP_RECONNECT_MAX) {
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
      // D73 P1：重拉并登记到工具锁定——定义变化立即让连接进入 tools_changed，而不是等到
      // 下一次有人解析工具面。无锁定时保持原有惰性行为（只失效缓存）。
      if (this.#toolLock !== null) {
        void this.listTools(server, { countFailure: false }).catch(() => {});
      }
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
    this.#deps.statusSink.emit({
      serverId: server.id,
      serverName: server.name,
      status: 'connected',
    });
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
              // D73：OAuth 令牌由运行时提供者供给（只读 Vault + 主动刷新；从不自行授权）。
              ...(server.auth === 'oauth' ? { authProvider: this.#authProviderFor(server) } : {}),
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

  #authProviderFor(server: McpServer): AuthProvider {
    const connectionId = authConnectionIdOf(server);
    const provider = this.#deps.auth?.providerFor(connectionId, server.url ?? null);
    if (provider === undefined)
      throw new AppAuthRequiredError({ connectionId, reason: 'not_connected' });
    return provider;
  }

  /**
   * 把错误识别为“需要（重新）授权”：运行时提供者抛的 `AppAuthRequiredError`（原样穿出
   * pi-mcp 传输，见 test/unit/mcp-auth-transport.test.ts；被包装时从 cause 链找出）；或 OAuth
   * server 在刷新后仍回 401（令牌被服务端拒绝）→ 视为 expired 并标记连接。
   */
  #authFailureOf(server: McpServer, error: unknown): AppAuthRequiredError | null {
    const found = findAppAuthRequiredError(error);
    if (found !== null) return found;
    if (server.auth === 'oauth' && error instanceof McpHttpError && error.status === 401) {
      const connectionId = authConnectionIdOf(server);
      this.#deps.auth?.markExpired?.(connectionId);
      return new AppAuthRequiredError({ connectionId, reason: 'expired' });
    }
    return null;
  }

  #emitNeedsAuth(server: McpServer, error: AppAuthRequiredError): void {
    this.#deps.statusSink.emit({
      serverId: server.id,
      serverName: server.name,
      status: 'needs_auth',
      detail: error.message,
    });
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

  /** 授权错误（含被包装的）不是传输故障。 */
  #isTransportFailure(error: unknown): boolean {
    if (findAppAuthRequiredError(error) !== null) return false;
    return (
      error instanceof Error && /closed|socket|EPIPE|ECONNRESET|fetch failed/i.test(error.message)
    );
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
