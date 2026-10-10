import { z } from 'zod';
import {
  AppError,
  appsConnectCancelInputSchema,
  appsConnectConfirmToolsInputSchema,
  appsConnectContinueInputSchema,
  appsConnectInputSchema,
  appsConnectOutputSchema,
  appsConnectionsListInputSchema,
  appsConnectionsListOutputSchema,
  appsFlowLogInputSchema,
  appsFlowLogOutputSchema,
  appsOauthClientsListOutputSchema,
  appsOauthClientsRemoveInputSchema,
  appsOauthClientsSetInputSchema,
  appsSetClientCredentialsInputSchema,
  mcpRawToolsInputSchema,
  mcpRawToolsOutputSchema,
  mcpRefreshToolsInputSchema,
  mcpRefreshToolsOutputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { AppServices } from '../apps/index.js';
import { isUnsettledScratch } from '../apps/connection-store.js';
import type { RpcMethodSpec } from './server.js';

const voidInput = z.void();

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * `apps.*` 的交互授权部分（D73 P0，docs/design/29-connected-apps.md §5.6）：连接 / 继续 /
 * 取消 / 手填客户端 / 连接列表；P1 增目录连接的工具复核确认。`apps.disconnect` 与 `mcp.removeServer` 在断开与吊销一侧
 * 另行绑定。所有返回值都**不含令牌**（连接行只有非机密元数据）。
 */
export function bindAppsMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const apps = (): AppServices => {
    if (services.apps === null) throw new AppError('NOT_IMPLEMENTED', '应用连接模块未就绪');
    return services.apps;
  };
  const mcp = (): NonNullable<CoreServices['mcp']> => {
    if (!services.mcp) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
    return services.mcp;
  };
  return {
    'apps.connect': method(appsConnectInputSchema, appsConnectOutputSchema, async (input) =>
      apps().flows.start({
        target: input.target,
        scopes: input.scopes,
        grantBotId: input.grantBotId,
        connectionId: input.connectionId,
      }),
    ),
    // 首连工具复核通过；拒绝 = apps.connect.cancel（吊销并清除新建的连接）。
    'apps.connect.confirmTools': method(
      appsConnectConfirmToolsInputSchema,
      okOutputSchema,
      async (input) => {
        apps().flows.confirmTools(input.flowId, {
          acknowledgeCommunity: input.acknowledgeCommunity === true,
        });
        return { ok: true as const };
      },
    ),
    'apps.connect.continue': method(
      appsConnectContinueInputSchema,
      okOutputSchema,
      async (input) => {
        apps().flows.continue(input.flowId);
        return { ok: true as const };
      },
    ),
    'apps.connect.cancel': method(appsConnectCancelInputSchema, okOutputSchema, async (input) => {
      apps().flows.cancel(input.flowId);
      return { ok: true as const };
    }),
    'apps.setClientCredentials': method(
      appsSetClientCredentialsInputSchema,
      okOutputSchema,
      async (input) => {
        apps().flows.setClientCredentials(input.flowId, input.clientId, input.clientSecret);
        return { ok: true as const };
      },
    ),
    // D73 P2 §6.4：BYO 客户端（按 issuer）。secret 只写不读；仍有连接使用该 issuer 时拒绝删除。
    'apps.oauthClients.list': method(voidInput, appsOauthClientsListOutputSchema, async () => ({
      clients: apps().oauthClients.list(),
    })),
    'apps.oauthClients.set': method(
      appsOauthClientsSetInputSchema,
      okOutputSchema,
      async (input) => {
        apps().oauthClients.set(input);
        return { ok: true as const };
      },
    ),
    'apps.oauthClients.remove': method(
      appsOauthClientsRemoveInputSchema,
      okOutputSchema,
      async (input) => {
        apps().oauthClients.remove(input.issuer);
        return { ok: true as const };
      },
    ),
    // D73 P2 §6.6 开发者模式：授权事件日志（脱敏）/ 原始工具定义 / 手动刷新工具。
    'apps.flowLog': method(appsFlowLogInputSchema, appsFlowLogOutputSchema, async (input) => ({
      entries: apps().flows.flowLog(input.serverId),
    })),
    'mcp.rawTools': method(mcpRawToolsInputSchema, mcpRawToolsOutputSchema, async (input) => ({
      tools: await mcp().rawTools(input.serverId),
    })),
    'mcp.refreshTools': method(
      mcpRefreshToolsInputSchema,
      mcpRefreshToolsOutputSchema,
      async (input) => ({ tools: await mcp().refreshTools(input.serverId) }),
    ),
    'apps.connections.list': method(
      appsConnectionsListInputSchema,
      appsConnectionsListOutputSchema,
      async (input) => ({
        // 临时行（授权进行中、还没成为账号）不算连接，见 isUnsettledScratch。
        connections: apps()
          .store.list({ includeCustom: input.includeCustom === true })
          .filter((row) => !isUnsettledScratch(row, apps().vault.getTokens(row.id) !== null)),
      }),
    ),
  };
}
