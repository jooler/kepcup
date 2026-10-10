/**
 * 设置弹框分区 id 与别名（D73 §5.9；扩展中心 X3 调整）。纯函数，便于单测：shell store 与
 * SettingsDialog 共用。`mcp` 是「开发者模式」分区的别名（自定义 MCP 服务器已移到那里）——
 * 历史上所有 `shell.openSettings('mcp')` 的入口继续有效。
 */
export type SettingsSectionId =
  | 'general'
  | 'hardware'
  | 'models'
  | 'search'
  | 'apps'
  | 'mcp'
  | 'browser'
  | 'agents'
  | 'profile'
  | 'contacts'
  | 'unattended'
  | 'environment'
  | 'usage'
  | 'diagnostics'
  | 'developer';

/**
 * 「应用」分区原有的页签（目录 / 已连接 / 自定义）。扩展中心之后分区只剩已连接账号管理，
 * 页签已移除；这个类型只为旧深链 `openSettings('apps', anchor, tab)` 保持可编译：
 * `custom` 落到「开发者模式」分区（自定义 MCP 在那里），`catalog` / `connected` 落在「应用」。
 */
export type AppsTab = 'catalog' | 'connected' | 'custom';

export interface ResolvedSection {
  /** 实际渲染的分区（别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp'>;
}

/**
 * 展开分区别名：`mcp` → `developer`（自定义 MCP 的新家）；`apps` + 旧的 `custom` 页签同样落
 * `developer`，其余（含 `apps` + `catalog` / `connected`）落在「应用」；其余分区原样返回。
 */
export function resolveSettingsSection(id: SettingsSectionId, appsTab?: AppsTab): ResolvedSection {
  if (id === 'mcp') return { section: 'developer' };
  if (id === 'apps' && appsTab === 'custom') return { section: 'developer' };
  return { section: id };
}
