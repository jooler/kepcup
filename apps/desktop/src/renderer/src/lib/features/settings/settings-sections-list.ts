/**
 * 设置分区图标清单（SettingsDialog 宽屏弹框与 NarrowSettings 窄屏全屏页共用），
 * 标题 / 顺序的事实源在 settings-section-labels.ts（lucide-free，可单测）。分区
 * 内容的渲染在 SettingsSectionView.svelte。单独成文件是因为图标清单引用 lucide
 * 组件，不能进 sections.ts（node 单测环境）。
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
  Puzzle,
  Settings2,
  Cpu,
  Smartphone,
  UserRound,
  type LucideIcon,
} from '@lucide/svelte';
import { t } from '$lib/i18n';
import {
  visibleSectionSources,
  sectionLabel,
  type SettingsViewSection,
} from './settings-section-labels';

export type { SettingsViewSection } from './settings-section-labels';

export interface SettingsSectionDef {
  id: SettingsViewSection;
  label: string;
  icon: LucideIcon;
}

const SECTION_ICONS: Record<SettingsViewSection, LucideIcon> = {
  profile: UserRound,
  general: Settings2,
  hardware: Mic,
  models: Cpu,
  search: Globe,
  browser: Compass,
  agents: Bot,
  plugins: Puzzle,
  contacts: BookUser,
  unattended: MoonStar,
  remote: Smartphone,
  environment: Monitor,
  usage: BarChart3,
  diagnostics: Activity,
};

/** 可见分区（带图标）：label 在调用时翻译，$derived 中随语言切换响应式更新。 */
export function visibleSettingsSections(narrow: boolean): SettingsSectionDef[] {
  return visibleSectionSources(narrow).map((source) => ({
    id: source.id,
    label: t(source.labelKey),
    icon: SECTION_ICONS[source.id],
  }));
}

/** 分区标题（未知 id 兜底「设置」）。 */
export function settingsSectionLabel(id: SettingsViewSection): string {
  return sectionLabel(id);
}

/** 图标组件渲染用（svelte 模板里 as unknown as Component 的类型收窄放这里）。 */
export function asIconComponent(icon: LucideIcon): Component<{ class?: string }> {
  return icon as unknown as Component<{ class?: string }>;
}
