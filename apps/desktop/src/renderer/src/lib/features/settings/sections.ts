/**
 * 设置弹框分区 id（D73 §5.9；扩展中心 X3 后「应用」分区已移除：已连接账号、连接应用
 * 目录、邮箱都在扩展中心对应分组）。纯函数，便于单测：shell store 与 SettingsDialog 共用。
 * 旧深链 `mcp` / `developer` 由 `shell.openSettings` 改开扩展中心 MCP，不再落进设置弹框。
 */
export type SettingsSectionId =
  | 'general'
  | 'hardware'
  | 'models'
  | 'search'
  | 'browser'
  | 'agents'
  | 'profile'
  | 'contacts'
  | 'unattended'
  | 'remote'
  | 'environment'
  | 'usage'
  | 'diagnostics'
  /** 旧深链 id：shell.openSettings 改开扩展中心 MCP，不会渲染成设置分区。 */
  | 'mcp'
  | 'developer';

export interface ResolvedSection {
  /** 实际渲染的分区（旧深链别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp' | 'developer'>;
}

/**
 * 展开旧深链别名：`mcp` / `developer` 正常情况下由 shell 改开扩展中心，到不了这里；
 * 万一落到设置弹框（兜底），渲染「通用」而不是已移除的分区。其余分区原样返回。
 */
export function resolveSettingsSection(id: SettingsSectionId): ResolvedSection {
  if (id === 'mcp' || id === 'developer') return { section: 'general' };
  return { section: id as Exclude<SettingsSectionId, 'mcp' | 'developer'> };
}

/** 这些设置分区 id（旧深链别名）应改开扩展中心 MCP，而不是设置弹框。 */
export function settingsSectionOpensExtensionMcp(id: SettingsSectionId): boolean {
  return id === 'mcp' || id === 'developer';
}
