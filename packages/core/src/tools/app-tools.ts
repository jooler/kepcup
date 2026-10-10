import { Type } from '@earendil-works/pi-ai';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import { TOOL_SETUP_REQUIRED } from './image-tools.js';
import { formatAppToolSearch, type AppToolDiscovery } from '../apps/discovery.js';

/**
 * 连接应用工具（D73，design 29 §7）：`app_request_connection`——Bot 判断需要某个未连接的目录应用
 * （`connector` = 目录 slug），或某个已勾选的应用需要（重新）连接（`connection_id`；自定义 OAuth
 * 应用也可用 `server_id`）时调用。宿主记下 `connect-app` 需求并返回 SETUP_REQUIRED，run 中断 →
 * 对话里出现连接卡 → 连接完成后 `runs.retry` 续跑（D58）。Bot 不得以文字引导用户去别处粘贴令牌。
 */

/** 工具名带 `app_` 前缀，归 `apps` 能力包（design 29 §7 / §10）。 */
export const APP_REQUEST_CONNECTION_TOOL = 'app_request_connection';
/** 按需发现（D73 P2 §6.3）：应用工具总数超阈值时取代逐个暴露的两个稳定工具。 */
export const APP_SEARCH_TOOLS_TOOL = 'app_search_tools';
export const APP_CALL_TOOL_TOOL = 'app_call_tool';

export interface AppToolFacade {
  /**
   * 校验目标后记下 setup 需求（orchestrator 写入本 run 的 `setupHit`）：
   * - `connector`（目录 slug）→ 该 Bot 尚无授权连接的目录应用 → `target: catalog`；
   * - `connectionId` → 该 Bot 已勾选、需要重连的连接（目录连接为 `catalog` 目标 + connectionId，
   *   自定义 OAuth 应用为 `custom` 目标）；
   * - `serverId` → 自定义 OAuth 应用。
   * 目标无效时 `ok:false` + 给模型的说明。
   */
  requestConnection(input: {
    connector?: string;
    connectionId?: string;
    serverId?: string;
    reason?: string;
  }): {
    ok: boolean;
    message: string;
  };
  /**
   * 按需发现（D73 P2 §6.3）：仅当本 run 的应用工具总数超过 `APP_TOOLS_INLINE_MAX` 时存在——
   * 此时 `app_search_tools` / `app_call_tool` 取代逐个暴露的应用工具（run 内不变）。
   */
  discovery?: AppToolDiscovery | undefined;
}

export function buildAppTools(input: {
  identity: RunIdentity;
  apps: AppToolFacade;
}): ToolDefinition[] {
  const { apps } = input;
  const requestConnection: ToolDefinition<{
    connector?: string;
    connection_id?: string;
    server_id?: string;
    reason?: string;
  }> = {
    name: APP_REQUEST_CONNECTION_TOOL,
    description:
      '请用户连接或重新连接一个应用：当 <available_apps> 里的应用（尚未连接）或 <connected_apps> 里需要重新连接的应用能完成用户的请求时调用。未连接的应用传 connector（目录里的 slug）；需要重连的传 connection_id；reason 简述为什么需要它（给用户看）。调用后本次执行会暂停，用户在对话里完成连接后自动继续。不要让用户粘贴令牌或密钥。',
    parameters: Type.Object({
      connector: Type.Optional(
        Type.String({ description: '未连接应用的目录 slug，如 github（见 <available_apps>）' }),
      ),
      connection_id: Type.Optional(
        Type.String({ description: '需要重连的连接 ID（见 <connected_apps>）' }),
      ),
      server_id: Type.Optional(Type.String({ description: '自定义 MCP 服务器 ID' })),
      reason: Type.Optional(Type.String({ description: '为什么需要这个应用（给用户看）' })),
    }),
    execute: async (params) => {
      const clean = (value: string | undefined): string | undefined => {
        const trimmed = value?.trim();
        return trimmed === undefined || trimmed === '' ? undefined : trimmed;
      };
      const connector = clean(params.connector);
      const connectionId = clean(params.connection_id);
      const serverId = clean(params.server_id);
      if (connector === undefined && connectionId === undefined && serverId === undefined) {
        return {
          ok: false,
          content: '需要提供 connector（未连接的应用）或 connection_id（需要重连的连接）',
          errorCode: 'INVALID_INPUT',
        };
      }
      const result = apps.requestConnection({
        ...(connector !== undefined ? { connector } : {}),
        ...(connectionId !== undefined ? { connectionId } : {}),
        ...(serverId !== undefined ? { serverId } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
      if (!result.ok) return { ok: false, content: result.message, errorCode: 'INVALID_INPUT' };
      return { ok: false, content: result.message, errorCode: TOOL_SETUP_REQUIRED };
    },
  };
  if (apps.discovery === undefined) return [requestConnection];
  return [requestConnection, ...buildAppDiscoveryTools(apps.discovery)];
}

/** `app_search_tools` + `app_call_tool`（按需发现，D73 P2 §6.3；子代理的只读面也复用）。 */
export function buildAppDiscoveryTools(discovery: AppToolDiscovery): ToolDefinition[] {
  const searchTools: ToolDefinition<{ query?: string; connector?: string }> = {
    name: APP_SEARCH_TOOLS_TOOL,
    description:
      '在已授权给你的应用里按关键词查找工具（<connected_apps> 里标注「工具按需发现」的应用）：按工具名、标题和说明匹配，返回工具的完整名称、说明、风险、是否需要用户批准和参数 schema（最多 20 个）。query 留空 = 浏览；connector 填应用的 slug 可限定在一个应用内。找到后用 app_call_tool 调用。',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: '关键词，如「create issue」「创建 日程」；多个词用空格分隔' }),
      ),
      connector: Type.Optional(Type.String({ description: '限定应用的目录 slug，如 github' })),
    }),
    execute: async (params) => {
      const hits = discovery.search({
        query: params.query ?? '',
        connector: params.connector,
      });
      return { ok: true, content: formatAppToolSearch(hits) };
    },
  };
  const callTool: ToolDefinition<{ name?: string; arguments?: Record<string, unknown> }> = {
    name: APP_CALL_TOOL_TOOL,
    description:
      '调用 app_search_tools 找到的应用工具：name 是搜索结果里的完整工具名，arguments 按其 inputSchema 填写。审批、权限与账号与直接调用该工具完全一致（写入类工具会请求用户批准，卡片显示真实的工具与账号）；未批准、被停用或不在你授权范围内的工具会被拒绝。',
    parameters: Type.Object({
      name: Type.String({ description: 'app_search_tools 返回的完整工具名' }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: '工具参数（对象），按该工具的 inputSchema',
        }),
      ),
    }),
    mcpOf: (params) => discovery.originOf(params.name ?? ''),
    execute: async (params, ctx) => {
      const name = params.name?.trim() ?? '';
      if (name.length === 0) {
        return {
          ok: false,
          content: '需要提供 name（app_search_tools 返回的完整工具名）',
          errorCode: 'INVALID_INPUT',
        };
      }
      const args = params.arguments;
      if (
        args !== undefined &&
        (args === null || typeof args !== 'object' || Array.isArray(args))
      ) {
        return { ok: false, content: 'arguments 必须是对象', errorCode: 'INVALID_INPUT' };
      }
      return discovery.call(name, args ?? {}, ctx);
    },
  };
  return [searchTools, callTool] as ToolDefinition[];
}
