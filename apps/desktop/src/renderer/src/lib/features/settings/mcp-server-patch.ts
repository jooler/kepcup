import type { SettingValues } from '@kepcup/shared';

/**
 * 出卡时 before（带 focus 的读快照）里的服务 id。user-only 会把整份预填清空，
 * 服务 id 不能从 prefill 取。只改这一条的 `enabled` 由 core 的 `mcp.servers` 写入适配器在设置写锁里
 * 做（读最新列表、CAS），渲染层不再拼整表。
 */
export function mcpServerId(before: SettingValues | null | undefined): string | null {
  const id = before?.server;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}
