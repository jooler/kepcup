import {
  MCP_SERVER_ID_PATTERN,
  type AppConnectionStatus,
  type McpServer,
  type SetupRequirement,
} from '@kepcup/shared';
import { customConnectionId } from '../apps/connection-store.js';
import { isExposableStatus, type BotAppsExposure, type ConnectedApps } from '../apps/exposure.js';
import { oneLine, REASON_TEXT } from '../apps/prompt.js';
import type { McpService } from '../mcp/service.js';
import type { CoreLogger } from '../infra/logger.js';
import type { McpUnavailableServer } from '../mcp/tools.js';

/**
 * 能力目录（D91，design 40 §2）：一个能力 = 一个外部工具来源——一条目录连接（连接应用 / 本机连接）
 * 或一个自定义 MCP 服务器。目录只读 DB / 内存，**不连接任何服务器、不列工具**：对话轮靠它在系统
 * 提示里说明「我接入了哪些能力」，run 开头因此不再等 `listTools`。
 */

export type CapabilityKind = 'app' | 'mcp';

/**
 * - `ready`：可以去解析工具（目录连接为 connected / tools_changed / error；自定义 MCP 没有连接行
 *   或连接行可用）；
 * - `reconnect`：授权失效 / 缺权限 / 已断开，需要用户（重新）连接；
 * - `disabled`：用户已停用该连接；
 * - `unavailable`：其余（正在连接中、服务缺失……）。
 */
export type CapabilityStatus = 'ready' | 'reconnect' | 'unavailable' | 'disabled';

export interface CapabilityEntry {
  /** `app:{connectorSlug}` | `mcp:{serverId}`。 */
  id: string;
  kind: CapabilityKind;
  /** 应用名 / 服务器名（已清洗，单行）。 */
  name: string;
  /** 目录连接的账号标签（已清洗）。 */
  account?: string;
  /** 目录条目说明 / 服务器用途说明（已清洗）。 */
  description: string;
  status: CapabilityStatus;
  statusText: string;
  /** `app_request_connection` 用：目录连接 id / `custom:{serverId}`。 */
  connectionId?: string;
  /** 可解析时的（合成）server；`status !== 'ready'` 时缺省。 */
  server?: McpServer;
  /** 该能力的工具在工具列表里的名字前缀（`app_{slug}_` / `mcp_{serverId}_`）。 */
  toolPrefix: string;
  /** 目录连接的信任分级（`developer` = 未审核的本机连接）。 */
  tier?: string;
}

/** 连接状态在提示词里的表述（`reconnect` = 需要用户重新连接，模型应调用 app_request_connection）。 */
export const STATUS_TEXT: Record<AppConnectionStatus, { text: string; reconnect: boolean }> = {
  connected: { text: '可用', reconnect: false },
  tools_changed: { text: '可用（有新增 / 变更的工具待用户复核，暂未开放）', reconnect: false },
  error: { text: '服务暂时不可达，可稍后重试', reconnect: false },
  expired: { text: '授权已失效，需重新连接', reconnect: true },
  needs_scope: { text: '需要追加权限，需重新连接', reconnect: true },
  not_connected: { text: '已断开，需重新连接', reconnect: true },
  connecting: { text: '正在连接中，稍后再试', reconnect: false },
  disabled: { text: '已被用户停用', reconnect: false },
};

/** 自定义 MCP 没有用途说明时目录行写的话（只进提示词，不参与任何权限判断）。 */
export const MCP_NO_DESCRIPTION_TEXT = '（未填写用途说明，可用 capability_search 查看它的工具）';

/**
 * 自定义 MCP 的一句话用途：用户填了 `McpServer.description` 就用它，否则缺省文案。
 * 描述来自用户输入，一律经 `oneLine` 清洗（去 `<` `>`、控制字符、限长），不能借标签逃出目录段。
 */
function mcpDescriptionOf(server: McpServer): string {
  const text = server.description === undefined ? '' : oneLine(server.description, 200);
  return text.length > 0 ? text : MCP_NO_DESCRIPTION_TEXT;
}

/**
 * 工具名前缀里的 id 段：与真实工具名（`mcpToolName`）同一套替换，只剩 `[A-Za-z0-9_-]`
 * （server id 允许 `.`，工具名里不允许）。能力 id 本身不做任何改写：`McpServer.id` 由 schema 保证字符集
 * （`MCP_SERVER_ID_PATTERN`），应用 slug 由目录的 `CONNECTOR_SLUG_PATTERN` 保证。
 */
function toolPrefixSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** 目录连接的能力 id（`app:{slug}`）。slug 受目录的 `CONNECTOR_SLUG_PATTERN` 约束，可直接拼。 */
export function appCapabilityId(slug: string): string {
  return `app:${slug}`;
}

/** 自定义 MCP 的能力 id（`mcp:{serverId}`）。server id 受 `mcpServerObjectSchema` 的字符集约束。 */
export function mcpCapabilityId(serverId: string): string {
  return `mcp:${serverId}`;
}

/**
 * `connect-app` 需求所指向的能力 id（D91 后续：连好应用后的任务重试据此补声明）；其他需求 / 目标 → null。
 * 目录目标的 `connectorId` 就是目录 slug（`app_request_connection` 与 MCP 授权失败两处都以 slug 写入）。
 */
export function capabilityIdOfSetup(requirement: SetupRequirement | null): string | null {
  if (requirement === null || requirement.kind !== 'connect-app') return null;
  return requirement.target.kind === 'catalog'
    ? appCapabilityId(requirement.target.connectorId)
    : mcpCapabilityId(requirement.target.serverId);
}

function statusOf(status: AppConnectionStatus, hasServer: boolean): CapabilityStatus {
  if (status === 'disabled') return 'disabled';
  if (isExposableStatus(status)) return hasServer ? 'ready' : 'unavailable';
  if (STATUS_TEXT[status].reconnect) return 'reconnect';
  return 'unavailable';
}

export interface CapabilityCatalog {
  entries: CapabilityEntry[];
  /** 目录连接的解析视图（任何状态），`<available_apps>` 与 `app_request_connection` 要用。 */
  apps: BotAppsExposure;
}

/**
 * 该 Bot 的能力目录（纯读取，不连接、不列工具）。来源：`ConnectedApps.forBot(app_connection_ids)`
 * 的 views（任何状态）+ `McpService.serversForBot(mcp_server_ids)`。顺序：目录连接（按勾选顺序）
 * 在前，自定义 MCP（设置顺序）在后。
 *
 * P2 注入模型：`extraPluginIds`（有效启用集，**必传**——P4 收口去掉 undefined=不过滤
 * 的旧口径）原样传给两处来源——插件贡献的连接器 / MCP server 不在启用集内时不进目录。
 */
export function buildCapabilityCatalog(input: {
  connectedApps: Pick<ConnectedApps, 'forBot' | 'connectionStatus'> | null;
  mcp: Pick<McpService, 'serversForBot'> | null;
  appConnectionIds: readonly string[];
  mcpServerIds: readonly string[];
  extraPluginIds: ReadonlySet<string>;
  logger?: Pick<CoreLogger, 'warn'> | undefined;
}): CapabilityCatalog {
  const noApps: BotAppsExposure = { servers: [], views: [] };
  const apps =
    input.connectedApps !== null && input.appConnectionIds.length > 0
      ? input.connectedApps.forBot(input.appConnectionIds, input.extraPluginIds)
      : noApps;
  const entries: CapabilityEntry[] = [];
  const serverById = new Map(apps.servers.map((server) => [server.id, server]));
  for (const view of apps.views) {
    // `forBot` 只为可暴露状态且启用的连接给 server；其余没有 server。
    const server = serverById.get(view.connection.id);
    const status = statusOf(view.connection.status, server !== undefined);
    const text = STATUS_TEXT[view.connection.status].text;
    entries.push({
      id: appCapabilityId(view.slug),
      kind: 'app',
      name: oneLine(view.appName),
      account: oneLine(view.accountLabel),
      description: oneLine(view.description),
      status,
      // 状态可暴露、却没有可解析的 server（服务被停用 / 缺地址）：如实说暂时不可用。
      statusText:
        status === 'unavailable' && isExposableStatus(view.connection.status) ? '暂时不可用' : text,
      connectionId: view.connection.id,
      ...(status === 'ready' && server !== undefined ? { server } : {}),
      toolPrefix: `app_${toolPrefixSegment(view.slug)}_`,
      tier: view.tier,
    });
  }
  // P2：插件贡献的 server 只看启用集（不要求勾选），所以即便 `mcp_server_ids`
  // 为空也要向来源查询（空启用集同样是语义：插件 server 全部不可见）。
  if (input.mcp !== null && (input.mcpServerIds.length > 0 || input.extraPluginIds.size > 0)) {
    for (const server of input.mcp.serversForBot([...input.mcpServerIds], input.extraPluginIds)) {
      // 目录连接合成的 server 也会被 serversForBot 认出（id = 连接 id）：它们已在上面处理。
      if (serverById.has(server.id)) continue;
      // 防御（D91 后续）：`McpServer.id` 由 schema 保证字符集，读设置时也会丢掉不合规条目；这里再兜一层——
      // 直接构造出来的非法 id（带 `<` `>` 之类）不进目录，免得它借标签逃出 `<capabilities>` 段。
      if (!MCP_SERVER_ID_PATTERN.test(server.id)) {
        input.logger?.warn(
          { serverId: server.id.slice(0, 80) },
          'capability catalog: an MCP server with an invalid id was skipped',
        );
        continue;
      }
      // 自定义 OAuth MCP 查它的连接行（`custom:{serverId}`）；没有连接行 = 可用（连不上是调用时的事）。
      const connectionId = customConnectionId(server.id);
      const rowStatus =
        server.auth === 'oauth'
          ? (input.connectedApps?.connectionStatus(connectionId) ?? null)
          : null;
      const status: CapabilityStatus = rowStatus === null ? 'ready' : statusOf(rowStatus, true);
      entries.push({
        id: mcpCapabilityId(server.id),
        kind: 'mcp',
        name: oneLine(server.name),
        description: oneLine(mcpDescriptionOf(server), 200),
        status,
        statusText: rowStatus === null ? '可用' : STATUS_TEXT[rowStatus].text,
        ...(server.auth === 'oauth' ? { connectionId } : {}),
        ...(status === 'ready' ? { server } : {}),
        toolPrefix: `mcp_${toolPrefixSegment(server.id)}_`,
      });
    }
  }
  return { entries, apps };
}

/** 可以去解析工具的能力（`ready` 且带 server）。 */
export function readyCapabilities(
  entries: readonly CapabilityEntry[],
): Array<CapabilityEntry & { server: McpServer }> {
  return entries.filter(
    (entry): entry is CapabilityEntry & { server: McpServer } =>
      entry.status === 'ready' && entry.server !== undefined,
  );
}

/**
 * 任务在解析工具时发现授权问题（`AppAuthRequiredError`）的 server：对应能力改标为需要重新连接
 * （目录行 / 规则行据此如实说明），不再算 ready。
 */
export function markUnavailable(
  entries: readonly CapabilityEntry[],
  unavailable: readonly McpUnavailableServer[],
): CapabilityEntry[] {
  if (unavailable.length === 0) return [...entries];
  const byServer = new Map(unavailable.map((item) => [item.serverId, item]));
  return entries.map((entry) => {
    const hit = entry.server !== undefined ? byServer.get(entry.server.id) : undefined;
    if (hit === undefined) return entry;
    const { server: _server, ...rest } = entry;
    return {
      ...rest,
      status: 'reconnect' as const,
      statusText: `${REASON_TEXT[hit.reason]}，需重新连接`,
      connectionId: hit.connectionId || entry.connectionId,
    };
  });
}
