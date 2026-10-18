import type { ProjectModuleDescriptor, ProjectModuleId } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/** 项目组外壳顶栏第二行的 tab 模型（WP6 §4 步骤 4；文案 key 走 i18n）。 */
export interface ProjectTabItem {
  id: ProjectModuleId;
  labelKey: MessageKey;
}

/** Tab 行模型：只收 available 模块（planned 的直接不渲染，progressive disclosure）。 */
export function projectTabs(modules: readonly ProjectModuleDescriptor[]): ProjectTabItem[] {
  return modules
    .filter((module) => module.status === 'available')
    .map((module) => ({
      id: module.id,
      labelKey: `project.module.${module.id}` as MessageKey,
    }));
}
