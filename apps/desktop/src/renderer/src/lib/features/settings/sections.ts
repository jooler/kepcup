/**
 * 设置弹框分区 id 与别名（D73 §5.9；扩展中心：自定义 MCP 迁到「扩展中心 → MCP」后调整）。
 * 纯函数，便于单测：shell store 与 SettingsDialog 共用。
 * `mcp` / `developer` / 旧 `apps`+`custom` 深链由 `shell.openSettings` 改开扩展中心 MCP，
 * 本函数若仍被调用则落到「应用」（已连接账号），避免渲染已移除的开发者分区。
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
  | 'remote'
  | 'environment'
  | 'usage'
  | 'diagnostics'
  | 'developer';

/**
 * 「应用」分区原有的页签（目录 / 已连接 / 自定义）。扩展中心之后分区只剩已连接账号管理，
 * 页签已移除；这个类型只为旧深链 `openSettings('apps', anchor, tab)` 保持可编译：
 * `custom` 与 `mcp` / `developer` 由 shell 改开扩展中心；其余落在「应用」。
 */
export type AppsTab = 'catalog' | 'connected' | 'custom';

export interface ResolvedSection {
  /** 实际渲染的分区（别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp' | 'developer'>;
}

/**
 * 展开分区别名：`mcp` / `developer` / `apps`+`custom` → `apps`（shell 应优先改开扩展中心）；
 * 其余分区原样返回。
 */
export function resolveSettingsSection(id: SettingsSectionId, appsTab?: AppsTab): ResolvedSection {
  if (id === 'mcp' || id === 'developer') return { section: 'apps' };
  if (id === 'apps' && appsTab === 'custom') return { section: 'apps' };
  return { section: id as Exclude<SettingsSectionId, 'mcp' | 'developer'> };
}

/** 这些设置分区 id（含别名）应改开扩展中心 MCP，而不是设置弹框。 */
export function settingsSectionOpensExtensionMcp(
  id: SettingsSectionId,
  appsTab?: AppsTab,
): boolean {
  return id === 'mcp' || id === 'developer' || (id === 'apps' && appsTab === 'custom');
}
