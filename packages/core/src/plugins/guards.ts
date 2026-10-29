import { isDeepStrictEqual } from 'node:util';
import { AppError, type McpServer } from '@kepcup/shared';

/**
 * PLUGIN_MANAGED guards (D104 P0a-2 步骤 9): plugin-registered MCP servers are managed
 * by the plugin lifecycle — single-item deletion and structural rewrites through the
 * RPC surface are refused (`plugins.setEnabled` / `plugins.uninstall` are the way
 * out). `name`, `enabled`, `autoApprove`, `toolPolicies` and `description` stay
 * user-editable. The registry itself writes through `domain.settings.update` and
 * never runs these guards.
 */

/** Fields only the plugin pipeline may change on a plugin-registered server. */
export const PLUGIN_SERVER_PROTECTED_FIELDS = [
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'auth',
  'source',
  'tier',
] as const;

/**
 * Compares the previous settings snapshot against the next one for the RPC write
 * paths. MUST run inside the settings write lock against the LATEST state (form
 * submissions carry whole snapshots — never compare against their own `base`).
 *
 * ① A plugin server present before but gone after → managed, refuse.
 *    Present with a changed protected field → refuse (name/enabled/autoApprove/
 *    toolPolicies/description are free).
 * ② A plugin server appearing without a same-id plugin source before → forged, refuse.
 */
export function assertPluginServersIntact(
  previous: readonly McpServer[],
  next: readonly McpServer[],
): void {
  const pluginIdOf = (server: McpServer): string | null =>
    server.source?.kind === 'plugin' ? server.source.pluginId : null;
  for (const before of previous) {
    const pluginId = pluginIdOf(before);
    if (pluginId === null) continue;
    const after = next.find((entry) => entry.id === before.id);
    if (after === undefined) {
      throw new AppError(
        'PLUGIN_MANAGED',
        `「${before.name}」由插件 ${pluginId} 管理，请在扩展中心「已安装」里卸载该插件`,
      );
    }
    if (pluginIdOf(after) === null) {
      throw new AppError(
        'PLUGIN_MANAGED',
        `不能修改插件管理的 MCP 服务器的 source（「${before.name}」由插件 ${pluginId} 管理）`,
      );
    }
    for (const field of PLUGIN_SERVER_PROTECTED_FIELDS) {
      if (!isDeepStrictEqual(before[field], after[field])) {
        throw new AppError(
          'PLUGIN_MANAGED',
          `不能修改插件管理的 MCP 服务器的 ${field}（「${before.name}」由插件 ${pluginId} 管理）`,
        );
      }
    }
  }
  for (const after of next) {
    if (pluginIdOf(after) === null) continue;
    const before = previous.find((entry) => entry.id === after.id);
    if (before === undefined || pluginIdOf(before) === null) {
      throw new AppError('PLUGIN_MANAGED', '不能手工创建插件来源的 MCP 服务器');
    }
  }
}
