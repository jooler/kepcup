import { z } from 'zod';
import {
  AppError,
  appsCatalogListOutputSchema,
  appsConnectionIdInputSchema,
  appsConnectionsGrantsOutputSchema,
  appsConnectionsReviewToolsInputSchema,
  appsConnectionsReviewToolsOutputSchema,
  appsConnectionsSetToolPolicyInputSchema,
  appsConnectionsToolsOutputSchema,
  appsConnectionsUpdateInputSchema,
  appsConnectionsUpdateOutputSchema,
  appsGrantsRevokeInputSchema,
  appsToolsApproveAfterTestInputSchema,
  appsToolsApproveAfterTestOutputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { AppConnectionsService } from '../apps/connections.js';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * `apps.*` 的目录连接管理部分（D73 P1，execution plan §5.4）：目录列表、改名 / 停用、工具清单与
 * 复核、逐工具策略、持续授权列表 / 撤销、自定义 server 的“测试 → 保存”批准。所有返回值都不含令牌。
 */
export function bindAppsConnectionMethods(
  services: CoreServices,
  options: {
    /** W3（D78）：被收紧的 MCP 权限 → 中断受影响的运行中任务（bindings 里同一个闭包）。 */
    revokeMcp: (revoked: Array<{ serverId: string; toolName?: string; botIds: string[] }>) => void;
  },
): Record<string, RpcMethodSpec> {
  const connections = (): AppConnectionsService => {
    if (services.appConnections === null) {
      throw new AppError('NOT_IMPLEMENTED', '应用连接模块未就绪');
    }
    return services.appConnections;
  };
  return {
    'apps.catalog.list': method(z.void(), appsCatalogListOutputSchema, async () => ({
      entries: connections().catalogEntries(),
    })),
    'apps.connections.update': method(
      appsConnectionsUpdateInputSchema,
      appsConnectionsUpdateOutputSchema,
      async (input) => ({ connection: await connections().update(input) }),
    ),
    'apps.connections.tools': method(
      appsConnectionIdInputSchema,
      appsConnectionsToolsOutputSchema,
      async (input) => connections().tools(input.connectionId),
    ),
    'apps.connections.reviewTools': method(
      appsConnectionsReviewToolsInputSchema,
      appsConnectionsReviewToolsOutputSchema,
      async (input) => connections().reviewTools(input),
    ),
    'apps.connections.setToolPolicy': method(
      appsConnectionsSetToolPolicyInputSchema,
      okOutputSchema,
      async (input) => {
        const { restricted } = connections().setToolPolicy(input);
        if (restricted) {
          // W3：停用 / 免审批改为每次确认——正在用该连接的 Bot 的运行中任务被中断，
          // 重新开始后按新策略审批。
          const botIds = services.domain?.bots
            .listAppConnectionHolders(input.connectionId)
            .map((bot) => bot.id);
          if (botIds !== undefined && botIds.length > 0) {
            options.revokeMcp([{ serverId: input.connectionId, toolName: input.toolName, botIds }]);
          }
        }
        return { ok: true as const };
      },
    ),
    'apps.connections.grants': method(
      appsConnectionIdInputSchema,
      appsConnectionsGrantsOutputSchema,
      async (input) => ({ grants: connections().grantsOf(input.connectionId) }),
    ),
    'apps.grants.revoke': method(appsGrantsRevokeInputSchema, okOutputSchema, async (input) => {
      connections().revokeGrant(input.grantId);
      return { ok: true as const };
    }),
    'apps.tools.approveAfterTest': method(
      appsToolsApproveAfterTestInputSchema,
      appsToolsApproveAfterTestOutputSchema,
      async (input) => connections().approveAfterTest(input),
    ),
  };
}
