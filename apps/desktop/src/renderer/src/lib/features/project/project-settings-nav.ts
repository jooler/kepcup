import { PROJECT_DETAIL_SECTIONS, type ProjectSettingsSection } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 项目详情页的分区导航模型（D92 41 §11.3 master-detail）：左侧分类与详情
 * 区共用。宽屏（md+）的竖排分类列表与窄屏的横向滚动 segmented 是同一份
 * 数据、同一组 testid（e2e 的 project-settings-nav-* 点击两个形态都命中），
 * 与 `project-tabs.ts` 同款做法。
 */
export interface ProjectSettingsNavItem {
  id: ProjectSettingsSection;
  labelKey: MessageKey;
  testid: string;
}

export function projectSettingsNav(): ProjectSettingsNavItem[] {
  return PROJECT_DETAIL_SECTIONS.map((section) => ({
    id: section,
    labelKey: `projectSettings.nav.${section}` as MessageKey,
    testid: `project-settings-nav-${section}`,
  }));
}
