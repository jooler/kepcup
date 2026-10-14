import { settingsDeepEqual, type McpServer, type SettingValues } from '@kepcup/shared';

/**
 * 出卡时 before（带 focus 的读快照）里的服务 id。user-only 会把整份预填清空，
 * 服务 id 不能从 prefill 取。只改这一条的 `enabled` 由 core 的 `mcp.servers` 写入适配器在设置写锁里
 * 做（读最新列表、CAS），渲染层不再拼整表。
 */
export function mcpServerId(before: SettingValues | null | undefined): string | null {
  const id = before?.server;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/**
 * 编辑表单从不改的字段：启用、免审批（放宽权限，宿主按 user-only 把守）、逐工具策略（在工具列表
 * 里单独改）。保存时一律取**当前**值——表单打开时抄下的旧值不能借一次「改个名」把它们改回去。
 */
export const MCP_FORM_UNEDITED_FIELDS = ['enabled', 'autoApprove', 'toolPolicies'] as const;

/**
 * 编辑表单的保存（D89 审查修复）：表单在**打开时**抄了一份服务（`initial`）。保存的条目 =
 * 当前的服务（`live`），只叠上表单里**确实改过**的字段（与 `initial` 不同的）；
 * `MCP_FORM_UNEDITED_FIELDS` 永远取 `live`。这样用户开着编辑框时，Bot 的「停用 S」卡 / 列表上的
 * 开关 / 别处的修改都不会被这次保存悄悄改回去。
 *
 * - 新建（`initial` 为 null）：原样用表单的值（重试保存同一个新服务也一样）；
 * - 编辑期间服务在别处被删掉（有 `initial`、没有 `live`）：返回 null，调用方提示，不复活它。
 */
export function editedServerForSave(
  live: McpServer | undefined,
  initial: McpServer | null,
  edited: McpServer,
): McpServer | null {
  if (initial === null) return edited;
  if (live === undefined) return null;
  const unedited = new Set<string>(MCP_FORM_UNEDITED_FIELDS);
  const out = Object.fromEntries(Object.entries(live)) as Record<string, unknown>;
  const editedRecord = edited as unknown as Record<string, unknown>;
  const initialRecord = initial as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(editedRecord), ...Object.keys(initialRecord)])) {
    if (unedited.has(key)) continue;
    const before = Object.hasOwn(initialRecord, key) ? initialRecord[key] : undefined;
    const after = Object.hasOwn(editedRecord, key) ? editedRecord[key] : undefined;
    if (settingsDeepEqual(before, after)) continue;
    if (after === undefined) delete out[key];
    else out[key] = after;
  }
  return out as unknown as McpServer;
}
