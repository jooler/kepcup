import {
  AVAILABLE_APPS_MAX,
  connectorMetaOf,
  type AppConnection,
  type AppConnectionStatus,
  type ConnectorCatalogEntry,
  type McpServer,
} from '@kepcup/shared';
import type { Tool as McpTool } from '@earendil-works/pi-mcp';
import { decideMcpTool, type McpToolDecision } from '../mcp/policy.js';
import type { McpService } from '../mcp/service.js';
import type { ToolRiskDetail } from '../mcp/risk.js';
import type { AppConnectionStore } from './connection-store.js';
import { isCustomConnectionId } from './connection-store.js';
import type { ConnectorCatalog } from './catalog.js';
import { applyCatalogOverlay, classifyAppToolRisk, type CatalogToolPolicyInput } from './policy.js';
import type { ToolLockService } from './tool-lock.js';

/**
 * 连接应用的工具暴露门面（D73 P1 §5.7，design 29 §6 / §7）：把「Bot 勾选的目录连接」解析为
 * 运行时要用的东西——合成的 MCP server（`id = connectionId`）、每个连接的绑定（slug / 账号 /
 * 风险与审批决定）、提示词里的 `<connected_apps>` / `<available_apps>` 数据。
 *
 * 只做读取与纯计算，不连接任何 server、不改任何状态。工具定义锁定（`approved_hash ===
 * current_hash`、未被停用）的过滤仍由 `ToolLockService` 经 `mcp.toolFilter` 在
 * `resolveMcpToolEntries` 里完成；这里只决定**哪些连接**参与（`connected` / `tools_changed`
 * 等可用状态），`expired` / `needs_scope` 等不暴露任何工具，只进入提示词状态行。
 */

/** 连接此刻是否值得去列工具（其余状态一律不暴露工具）。 */
const EXPOSABLE_STATUSES: ReadonlySet<AppConnectionStatus> = new Set([
  'connected',
  // 有待复核的新工具，但已批准的工具仍可用（锁定过滤会挡住待复核的）。
  'tools_changed',
  // 服务端暂时不可达：保留授权，照常尝试（失败只跳过，不拖垮 run）。
  'error',
]);

export function isExposableStatus(status: AppConnectionStatus): boolean {
  return EXPOSABLE_STATUSES.has(status);
}

/** 一个已授权连接的解析视图（连接行 + 目录条目）。 */
export interface ConnectedAppView {
  connection: AppConnection;
  entry: ConnectorCatalogEntry;
  slug: string;
  /** 目录里的应用名（`title`）。 */
  appName: string;
  accountLabel: string;
  /** 目录条目的一句话说明。 */
  description: string;
  tier: string;
}

/**
 * 工具包装 / 网关用的连接上下文：随 `wrapMcpTool` 带进 `mcpToolCall`，进入审批载荷与审计。
 */
export interface AppToolContext {
  connectionId: string;
  /** `app_connections.connector_id`（目录 slug），连接需求的 `catalog` 目标用它。 */
  connectorId: string;
  connectorSlug: string;
  accountLabel: string;
  /** 应用名（卡片里的「在 {app} 执行」）。 */
  appName: string;
}

/** `resolveMcpToolEntries` 为目录连接 server 使用的绑定。 */
export interface AppServerBinding extends AppToolContext {
  /** 工具的风险（W5 分级 + 目录叠加）与有效审批（用户逐工具策略 > 风险档默认）。 */
  decide(tool: McpTool): McpToolDecision;
}

export interface BotAppsExposure {
  /** 参与工具解析的合成 server（可用状态的连接）。 */
  servers: McpServer[];
  /** 本 Bot 勾选且可解析的全部连接（含不可用状态的），供 `<connected_apps>` 状态行。 */
  views: ConnectedAppView[];
}

export interface ConnectedAppsDeps {
  store: Pick<AppConnectionStore, 'get'>;
  /**
   * 目录连接合成的 server 来源（`McpService.serverFor(connectionId)`，合成契约见
   * `mcp/service.ts` 的 `connectionToMcpServer`）：id = 连接 id，`name` = 应用名（账号）。
   */
  mcp: Pick<McpService, 'serverFor'>;
  catalog: Pick<ConnectorCatalog, 'list' | 'get'>;
  toolLock: Pick<ToolLockService, 'getUserPolicy'>;
}

function catalogPolicyOf(entry: ConnectorCatalogEntry): CatalogToolPolicyInput {
  const meta = connectorMetaOf(entry);
  return { tier: meta.tier, toolPolicy: meta.toolPolicy };
}

export class ConnectedApps {
  readonly #deps: ConnectedAppsDeps;

  constructor(deps: ConnectedAppsDeps) {
    this.#deps = deps;
  }

  /**
   * 目录条目：连接行的 `connector_id` 是目录 slug（兼容存清单 `name` 的行）。被发行门禁挡掉 /
   * 不在目录里 = null（连接成孤儿，不暴露）。
   */
  entryOf(connectorId: string): ConnectorCatalogEntry | null {
    return (
      this.#deps.catalog.get(connectorId) ??
      this.#deps.catalog.list().find((entry) => entry.name === connectorId) ??
      null
    );
  }

  /** 按目录 slug 取（门禁过滤后）的条目。 */
  entryBySlug(slug: string): ConnectorCatalogEntry | null {
    return this.#deps.catalog.get(slug);
  }

  /** 目录连接的视图；不存在 / 自定义连接 / 条目不在目录里 = null。 */
  view(connectionId: string): ConnectedAppView | null {
    if (isCustomConnectionId(connectionId)) return null;
    const connection = this.#deps.store.get(connectionId);
    if (connection === null) return null;
    const entry = this.entryOf(connection.connectorId);
    if (entry === null) return null;
    return {
      connection,
      entry,
      slug: connectorMetaOf(entry).slug,
      appName: entry.title,
      accountLabel: connection.label,
      description: entry.description,
      tier: connectorMetaOf(entry).tier,
    };
  }

  /** 是否是（可解析的）目录连接 id。 */
  isAppConnection(connectionId: string): boolean {
    return this.view(connectionId) !== null;
  }

  /**
   * Bot 勾选的连接 → 合成 server（仅可用状态）与全部视图。不存在 / 已删除 / 孤儿的 id 静默
   * 跳过（删除连接时 `removeConnectionFromAll` 会清掉它们）。
   */
  forBot(connectionIds: readonly string[]): BotAppsExposure {
    const views: ConnectedAppView[] = [];
    const servers: McpServer[] = [];
    const seen = new Set<string>();
    for (const id of connectionIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const view = this.view(id);
      if (view === null) continue;
      views.push(view);
      if (!isExposableStatus(view.connection.status)) continue;
      const server = this.#deps.mcp.serverFor(id);
      if (server !== undefined && server.enabled) servers.push(server);
    }
    return { servers, views };
  }

  /** `catalogPolicyFor`：工具锁定计算风险时叠加目录 `toolPolicy`（目录连接才有）。 */
  catalogPolicyFor(connectionId: string): CatalogToolPolicyInput | undefined {
    const view = this.view(connectionId);
    return view === null ? undefined : catalogPolicyOf(view.entry);
  }

  /** 工具上下文（审批载荷 / 审计）。 */
  contextOf(view: ConnectedAppView): AppToolContext {
    return {
      connectionId: view.connection.id,
      connectorId: view.slug,
      connectorSlug: view.slug,
      accountLabel: view.accountLabel,
      appName: view.appName,
    };
  }

  /** 供 `resolveMcpToolEntries` 使用的绑定；非目录连接 server = undefined。 */
  bindingFor(serverId: string): AppServerBinding | undefined {
    const view = this.view(serverId);
    if (view === null) return undefined;
    const policy = catalogPolicyOf(view.entry);
    return {
      ...this.contextOf(view),
      decide: (tool) =>
        this.#decide(view.connection.id, tool.name, classifyAppToolRisk(tool, policy)),
    };
  }

  /**
   * 调用时的决定（网关 `mcpToolDecision`）：W5 判定 `base`（`McpService.riskOf`）叠加目录规则，
   * 再按用户逐工具策略（`app_connection_tools.user_policy`）> 风险档默认得出有效审批。
   */
  decisionFor(
    connectionId: string,
    toolName: string,
    base: ToolRiskDetail,
  ): McpToolDecision | null {
    const view = this.view(connectionId);
    if (view === null) return null;
    return this.#decide(
      connectionId,
      toolName,
      applyCatalogOverlay(base, toolName, catalogPolicyOf(view.entry)),
    );
  }

  #decide(connectionId: string, toolName: string, detail: ToolRiskDetail): McpToolDecision {
    const policy = this.#deps.toolLock.getUserPolicy(connectionId, toolName);
    return decideMcpTool(
      { autoApprove: false, ...(policy !== null ? { toolPolicies: { [toolName]: policy } } : {}) },
      toolName,
      { risk: detail.risk, source: detail.source },
    );
  }

  /**
   * `<available_apps>`：目录里**这个 Bot 还没有授权连接**的已发行条目（含用户已连接过、但没勾给
   * 这个 Bot 的应用——请求连接的卡片同样能把已有账号授权给它），≤ {@link AVAILABLE_APPS_MAX} 条。
   */
  availableFor(authorized: readonly ConnectedAppView[]): ConnectorCatalogEntry[] {
    const taken = new Set(authorized.map((view) => view.slug));
    return this.#deps.catalog
      .list()
      .filter((entry) => !taken.has(connectorMetaOf(entry).slug))
      .slice(0, AVAILABLE_APPS_MAX);
  }
}
