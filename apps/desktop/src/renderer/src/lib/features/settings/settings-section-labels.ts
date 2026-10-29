/**
 * 设置分区标题源（lucide-free）：图标清单（settings-sections-list）引用 lucide
 * 组件，单测环境加载不了；标题的 i18n 单独放这里。label 存 i18n key，在
 * visibleSectionSources / sectionLabel 被调用时才翻译——组件在 $derived 中调用，
 * 语言切换即响应式更新；若在模块顶层固化成字符串，就要刷新前端才能恢复。
 */
import { t, type MessageKey } from '$lib/i18n';
import type { ResolvedSection } from './sections';
import { NARROW_HIDDEN_SETTINGS_SECTIONS } from '$lib/features/shell/narrow-layout';

export type SettingsViewSection = ResolvedSection['section'];

export interface SettingsSectionSource {
  id: SettingsViewSection;
  labelKey: MessageKey;
}

export const settingsSectionSources: SettingsSectionSource[] = [
  { id: 'profile', labelKey: 'settings.navProfile' },
  { id: 'general', labelKey: 'settings.navGeneral' },
  { id: 'hardware', labelKey: 'settings.navHardware' },
  { id: 'models', labelKey: 'settings.navModels' },
  { id: 'search', labelKey: 'settings.navWebSearch' },
  { id: 'browser', labelKey: 'settings.navBrowserProfiles' },
  { id: 'agents', labelKey: 'settings.navAgents' },
  { id: 'plugins', labelKey: 'settings.navPlugins' },
  { id: 'contacts', labelKey: 'settings.navContacts' },
  { id: 'unattended', labelKey: 'settings.navUnattended' },
  { id: 'remote', labelKey: 'settings.navRemote' },
  { id: 'environment', labelKey: 'settings.navEnvironment' },
  { id: 'usage', labelKey: 'settings.navUsage' },
  { id: 'diagnostics', labelKey: 'settings.navDiagnostics' },
];

/** 可见分区源：窄屏隐藏「通讯录」「个人资料」（提取为底部 tab，33-narrow-layout）。 */
export function visibleSectionSources(narrow: boolean): SettingsSectionSource[] {
  return narrow
    ? settingsSectionSources.filter((section) => !NARROW_HIDDEN_SETTINGS_SECTIONS.has(section.id))
    : settingsSectionSources;
}

/** 分区标题，调用时翻译（未知 id 兜底「设置」）。 */
export function sectionLabel(id: SettingsViewSection): string {
  const source = settingsSectionSources.find((section) => section.id === id);
  return source === undefined ? t('settings.title') : t(source.labelKey);
}
