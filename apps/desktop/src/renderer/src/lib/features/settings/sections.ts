/**
 * 设置分区 id（D73 §5.9）。宽屏设置是独立页面（不再是弹框）：左栏分类条目 +
 * 主体分区内容；扩展中心也是页面级分类，但不是设置分区（渲染扩展中心主体，
 * 深链走 extension-center surface）。
 *
 * 「插件」分区已并入扩展中心的「设置」页签（原「市场 / 已安装」行右侧新增）：
 * 旧深链 `plugins` 与 `mcp` / `developer` 一样由 `shell.openSettings` 改开扩展中心，
 * 不再渲染成设置分区。
 */
export type SettingsSectionId =
  | 'general'
  | 'hardware'
  | 'models'
  | 'search'
  | 'browser'
  | 'computer-use'
  | 'agents'
  | 'profile'
  | 'contacts'
  | 'unattended'
  | 'remote'
  | 'environment'
  | 'usage'
  | 'diagnostics'
  /** 旧深链 id：shell.openSettings 改开扩展中心，不会渲染成设置分区。 */
  | 'mcp'
  | 'developer'
  | 'plugins';

export interface ResolvedSection {
  /** 实际渲染的分区（旧深链别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp' | 'developer' | 'plugins'>;
}

/**
 * 宽屏设置页左栏的分类 id：真实设置分区 + 扩展中心（伪分区——主体渲染扩展中心
 * 的分组 tab 与内容，不是 SettingsSectionView 的设置分区）。
 */
export type SettingsPageSection = ResolvedSection['section'] | 'extension-center';

/**
 * 展开旧深链别名：`mcp` / `developer` / `plugins` 正常情况下由 shell 改开扩展中心，
 * 到不了这里；万一落到设置分区渲染（兜底），渲染「通用」而不是已移除的分区。
 * 其余分区原样返回。
 */
export function resolveSettingsSection(id: SettingsSectionId): ResolvedSection {
  if (id === 'mcp' || id === 'developer' || id === 'plugins') return { section: 'general' };
  return { section: id as Exclude<SettingsSectionId, 'mcp' | 'developer' | 'plugins'> };
}

/**
 * 这些设置分区 id（旧深链别名）应改开扩展中心，返回对应的扩展中心页签：
 * `mcp` / `developer` → 「已安装」的 MCP 筛选；`plugins` → 「设置」页签。
 * 其余分区返回 null（正常打开设置分区）。
 */
export function settingsSectionExtensionTarget(id: SettingsSectionId): 'mcp' | 'settings' | null {
  if (id === 'mcp' || id === 'developer') return 'mcp';
  if (id === 'plugins') return 'settings';
  return null;
}
