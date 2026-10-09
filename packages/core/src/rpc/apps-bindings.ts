import type { z } from 'zod';
import {
  AppError,
  appsConnectCancelInputSchema,
  appsConnectConfirmToolsInputSchema,
  appsConnectContinueInputSchema,
  appsConnectInputSchema,
  appsConnectOutputSchema,
  appsConnectionsListInputSchema,
  appsConnectionsListOutputSchema,
  appsSetClientCredentialsInputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { AppServices } from '../apps/index.js';
import type { RpcMethodSpec } from './server.js';

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
        apps().flows.confirmTools(input.flowId);
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
    'apps.connections.list': method(
      appsConnectionsListInputSchema,
      appsConnectionsListOutputSchema,
      async (input) => ({
        connections: apps().store.list({ includeCustom: input.includeCustom === true }),
      }),
    ),
  };
}
