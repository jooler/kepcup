import type { z } from 'zod';
import {
  AppError,
  appsDisconnectInputSchema,
  mcpRemoveServerInputSchema,
  okOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import { botsUsingServer, mcpRevocationsBetween } from '../permissions/revocations.js';
import type { RpcMethodSpec } from './server.js';

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

/**
 * `apps.disconnect` 与 `mcp.removeServer`（D73 P0，todo §4.9 / §4.2）：断开与吊销、显式删除
 * 自定义 server。交互授权的方法在 `apps-bindings.ts`。返回值不含令牌。
 */
export function bindAppsRuntimeMethods(
  services: CoreServices,
  options: {
    /** W3（D78）：被撤销的 MCP 权限 → 中断受影响的运行中任务（bindings 里同一个闭包）。 */
    revokeMcp: (revoked: Array<{ serverId: string; toolName?: string; botIds: string[] }>) => void;
  },
): Record<string, RpcMethodSpec> {
  const runtime = () => {
    if (services.appRuntime === null) {
      throw new AppError('NOT_IMPLEMENTED', '应用连接模块未就绪');
    }
    return services.appRuntime;
  };
  return {
    'apps.disconnect': method(appsDisconnectInputSchema, okOutputSchema, async (input) => {
      await runtime().disconnector.disconnect(input.connectionId);
      return { ok: true as const };
    }),
    // 显式删除自定义 server（不再依赖 settings.update 整体替换的差集：陈旧快照会误删）：
    // 删 settings 条目 → 吊销并清令牌 / 连接行 / `mcp:{id}:*` 密钥 → 关闭缓存连接。幂等。
    'mcp.removeServer': method(mcpRemoveServerInputSchema, okOutputSchema, async (input) => {
      const domain = services.domain!;
      const previous = domain.settings.get();
      if (previous.mcpServers.some((server) => server.id === input.serverId)) {
        const next = domain.settings.update({
          mcpServers: previous.mcpServers.filter((server) => server.id !== input.serverId),
        });
        const allBots = domain.bots.listActive();
        options.revokeMcp(
          mcpRevocationsBetween(
            previous.mcpServers,
            next.mcpServers,
            (serverId, toolName) => services.mcp?.riskOf(serverId, toolName).risk ?? 'destructive',
            (serverId) => services.mcp?.knownToolNames(serverId) ?? null,
          ).map((entry) => ({ ...entry, botIds: botsUsingServer(allBots, entry.serverId) })),
        );
      }
      await runtime().disconnector.removeCustomServer(input.serverId);
      return { ok: true as const };
    }),
  };
}
