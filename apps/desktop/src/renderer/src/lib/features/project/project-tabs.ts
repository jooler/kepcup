import type { ProjectModuleDescriptor, ProjectModuleId } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/** 项目组外壳顶栏第二行的 tab 模型（WP6 §4 步骤 4；文案 key 走 i18n）。 */
export interface ProjectTabItem {
  id: ProjectModuleId;
  labelKey: MessageKey;
  disabled: boolean;
}

/** Tab 行模型：顺序同模块注册表；planned 模块灰显不可点。 */
export function projectTabs(modules: readonly ProjectModuleDescriptor[]): ProjectTabItem[] {
  return modules.map((module) => ({
    id: module.id,
    labelKey: `project.module.${module.id}` as MessageKey,
    disabled: module.status !== 'available',
  }));
}
