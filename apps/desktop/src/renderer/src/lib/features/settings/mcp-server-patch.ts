import type { McpServer, SettingValues } from '@kepcup/shared';

/**
 * 出卡时 before（带 focus 的读快照）里的服务 id。user-only 会把整份预填清空，
 * 服务 id 不能从 prefill 取。
 */
export function mcpServerId(before: SettingValues | null | undefined): string | null {
  const id = before?.server;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/**
 * 只改这一个服务的 `enabled`。`servers` 必须是保存当下读到的列表：找不到就不改，
 * 避免整表替换时把服务删掉。兄弟服务和 `toolPolicies` 原样保留。
 */
export function patchMcpServerEnabled(
  servers: readonly McpServer[],
  serverId: string,
  enabled: boolean,
): { ok: true; servers: McpServer[] } | { ok: false } {
  if (!servers.some((entry) => entry.id === serverId)) return { ok: false };
  return {
    ok: true,
    servers: servers.map((entry) => (entry.id === serverId ? { ...entry, enabled } : entry)),
  };
}
