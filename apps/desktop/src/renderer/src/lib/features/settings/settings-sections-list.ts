/**
 * 设置分区清单（图标 / 标题 / 顺序）：SettingsDialog（宽屏弹框）与 NarrowSettings
 * （窄屏全屏页）共用同一份事实。分区内容的渲染在 SettingsSectionView.svelte。
 * 单独成文件是因为图标清单引用 lucide 组件，不能进 sections.ts（node 单测环境）。
 */
import type { Component } from 'svelte';
import {
  Activity,
  BarChart3,
  BookUser,
  Bot,
  Compass,
  Globe,
  Mic,
  Monitor,
  MoonStar,
  Plug,
  Settings2,
  Cpu,
  Smartphone,
  UserRound,
  type LucideIcon,
} from '@lucide/svelte';
import { t } from '$lib/i18n';
import type { ResolvedSection } from './sections';
import { NARROW_HIDDEN_SETTINGS_SECTIONS } from '$lib/features/shell/narrow-layout';

export type SettingsViewSection = ResolvedSection['section'];

export interface SettingsSectionDef {
  id: SettingsViewSection;
  label: string;
  icon: LucideIcon;
}

export const settingsSections: SettingsSectionDef[] = [
  { id: 'general', label: t('settings.navGeneral'), icon: Settings2 },
  { id: 'hardware', label: t('settings.navHardware'), icon: Mic },
  { id: 'models', label: t('settings.navModels'), icon: Cpu },
  { id: 'search', label: t('settings.navWebSearch'), icon: Globe },
  { id: 'apps', label: t('settings.navApps'), icon: Plug },
  { id: 'browser', label: t('settings.navBrowserProfiles'), icon: Compass },
  { id: 'agents', label: t('settings.navAgents'), icon: Bot },
  { id: 'profile', label: t('settings.navProfile'), icon: UserRound },
  { id: 'contacts', label: t('settings.navContacts'), icon: BookUser },
  { id: 'unattended', label: t('settings.navUnattended'), icon: MoonStar },
  { id: 'remote', label: t('settings.navRemote'), icon: Smartphone },
  { id: 'environment', label: t('settings.navEnvironment'), icon: Monitor },
  { id: 'usage', label: t('settings.navUsage'), icon: BarChart3 },
  { id: 'diagnostics', label: t('settings.navDiagnostics'), icon: Activity },
];

/** 可见分区：窄屏隐藏「通讯录」「用户画像」（提取为底部 tab，33-narrow-layout）。 */
export function visibleSettingsSections(narrow: boolean): SettingsSectionDef[] {
  return narrow
    ? settingsSections.filter((section) => !NARROW_HIDDEN_SETTINGS_SECTIONS.has(section.id))
    : settingsSections;
}

/** 分区标题（未知 id 兜底「设置」）。 */
export function settingsSectionLabel(id: SettingsViewSection): string {
  return settingsSections.find((section) => section.id === id)?.label ?? t('settings.title');
}

/** 图标组件渲染用（svelte 模板里 as unknown as Component 的类型收窄放这里）。 */
export function asIconComponent(icon: LucideIcon): Component<{ class?: string }> {
  return icon as unknown as Component<{ class?: string }>;
}
