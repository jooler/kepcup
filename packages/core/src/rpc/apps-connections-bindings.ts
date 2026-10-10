import { z } from 'zod';
import {
  AppError,
  appsCatalogListOutputSchema,
  appsConnectionIdInputSchema,
  appsDirectoryStatusOutputSchema,
  appsConnectionsGrantsOutputSchema,
  appsConnectionsReviewToolsInputSchema,
  appsConnectionsReviewToolsOutputSchema,
  appsConnectionsSetToolPolicyInputSchema,
  appsConnectionsToolsOutputSchema,
  appsConnectionsUpdateInputSchema,
  appsConnectionsUpdateOutputSchema,
  appsEgressSummaryInputSchema,
  appsEgressSummaryOutputSchema,
  appsGrantsRevokeInputSchema,
  appsLocalConnectorsConfirmInputSchema,
  appsLocalConnectorsConfirmOutputSchema,
  appsLocalConnectorsListOutputSchema,
  appsLocalConnectorsRejectInputSchema,
  appsLocalConnectorsRemoveInputSchema,
  appsToolsApproveAfterTestInputSchema,
  appsToolsApproveAfterTestOutputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { AppConnectionsService } from '../apps/connections.js';
import type { DirectorySync } from '../apps/directory-sync.js';
import type { LocalConnectors } from '../apps/local-connectors.js';
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
  const directory = (): DirectorySync => {
    if (services.directorySync === null) {
      throw new AppError('NOT_IMPLEMENTED', '目录同步模块未就绪');
    }
    return services.directorySync;
  };
  const local = (): LocalConnectors => {
    if (services.localConnectors === null) {
      throw new AppError('NOT_IMPLEMENTED', '本机连接模块未就绪');
    }
    return services.localConnectors;
  };
  return {
    'apps.catalog.list': method(z.void(), appsCatalogListOutputSchema, async () => ({
      entries: connections().catalogEntries(),
    })),
    // 本机连接（todo/local-connector-authoring.md §2.4）：confirm 在开发者模式关闭时被拒；
    // remove 任何时候可用（断开全部连接 → 删条目）；reject = 确认卡上点「取消」。
    'apps.localConnectors.list': method(
      z.void(),
      appsLocalConnectorsListOutputSchema,
      async () => ({
        connectors: local().list(),
      }),
    ),
    'apps.localConnectors.confirm': method(
      appsLocalConnectorsConfirmInputSchema,
      appsLocalConnectorsConfirmOutputSchema,
      async (input) => local().confirm(input.proposalId),
    ),
    'apps.localConnectors.reject': method(
      appsLocalConnectorsRejectInputSchema,
      okOutputSchema,
      async (input) => {
        local().reject(input.proposalId);
        return { ok: true as const };
      },
    ),
    'apps.localConnectors.remove': method(
      appsLocalConnectorsRemoveInputSchema,
      okOutputSchema,
      async (input) => {
        await local().remove(input.connectorId);
        return { ok: true as const };
      },
    ),
    // D73 P3 §7.1: signed directory sync status / manual sync (off = no network, status only).
    'apps.directory.status': method(z.void(), appsDirectoryStatusOutputSchema, async () =>
      directory().status(),
    ),
    'apps.directory.sync': method(z.void(), appsDirectoryStatusOutputSchema, async () =>
      directory().sync(),
    ),
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
    'apps.egressSummary': method(
      appsEgressSummaryInputSchema,
      appsEgressSummaryOutputSchema,
      async (input) => {
        const audit = services.domain?.audit;
        if (audit === undefined) throw new AppError('NOT_IMPLEMENTED', '审计模块未就绪');
        const { total, refused, recent } = audit.egressTainted(input.botId);
        return {
          total,
          refused,
          recent: recent.map((entry) => ({
            at: entry.createdAt,
            conversationId: entry.conversationId,
            channel: String(entry.detail['channel'] ?? ''),
            target: String(entry.detail['target'] ?? ''),
            approved: entry.detail['approved'] !== false,
          })),
        };
      },
    ),
    'apps.tools.approveAfterTest': method(
      appsToolsApproveAfterTestInputSchema,
      appsToolsApproveAfterTestOutputSchema,
      async (input) => connections().approveAfterTest(input),
    ),
  };
}
