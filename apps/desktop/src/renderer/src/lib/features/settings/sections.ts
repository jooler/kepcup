/**
 * 设置弹框分区 id 与别名（D73 §5.9）。纯函数，便于单测：shell store 与
 * SettingsDialog 共用。`mcp` 是 `apps` 分区「自定义」页签的别名——历史上所有
 * `shell.openSettings('mcp')` 的入口继续有效。
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
  | 'diagnostics';

export type AppsTab = 'catalog' | 'connected' | 'custom';

export const APPS_TABS: readonly AppsTab[] = ['catalog', 'connected', 'custom'];

/**
 * 页签的键盘导航（WAI-ARIA tabs）：左右方向键循环切换，Home / End 到两端；其他键 null
 * （不处理）。
 */
export function appsTabForKey(current: AppsTab, key: string): AppsTab | null {
  const last = APPS_TABS.length - 1;
  const index = Math.max(0, APPS_TABS.indexOf(current));
  switch (key) {
    case 'ArrowRight':
      return APPS_TABS[index >= last ? 0 : index + 1]!;
    case 'ArrowLeft':
      return APPS_TABS[index <= 0 ? last : index - 1]!;
    case 'Home':
      return APPS_TABS[0]!;
    case 'End':
      return APPS_TABS[last]!;
    default:
      return null;
  }
}

export interface ResolvedSection {
  /** 实际渲染的分区（别名已展开）。 */
  section: Exclude<SettingsSectionId, 'mcp'>;
  /** 别名 / `apps` 指定的应用页签；其他分区为 undefined。 */
  appsTab?: AppsTab;
}

/**
 * 展开分区别名：`mcp` → `apps` + 「自定义」页；`apps` 不带页签时默认「目录」
 * （「去连接」入口），其余分区原样返回。
 */
export function resolveSettingsSection(id: SettingsSectionId, appsTab?: AppsTab): ResolvedSection {
  if (id === 'mcp') return { section: 'apps', appsTab: 'custom' };
  if (id === 'apps') return { section: 'apps', appsTab: appsTab ?? 'catalog' };
  return { section: id };
}
