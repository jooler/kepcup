import { describe, expect, it } from 'vitest';
import { PROJECT_MODULES } from '@kepcup/shared';
import { projectTabs } from './project-tabs';

/** 项目组 tab 行模型（WP6 步骤 2）：只收 available 模块（planned 不渲染）、文案 key。 */

describe('projectTabs', () => {
  it('顺序与 id 同模块注册表里的 available 模块', () => {
    expect(projectTabs(PROJECT_MODULES).map((tab) => tab.id)).toEqual(['chat', 'board', 'wiki']);
  });

  it('planned 模块不进 tab 行', () => {
    expect(
      projectTabs(PROJECT_MODULES).find((tab) => ['okr', 'calendar'].includes(tab.id)),
    ).toBeUndefined();
  });

  it('labelKey 逐模块指向 i18n 的 project.module.<id>', () => {
    expect(projectTabs(PROJECT_MODULES).map((tab) => tab.labelKey)).toEqual([
      'project.module.chat',
      'project.module.board',
      'project.module.wiki',
    ]);
  });

  it('空注册表给出空 tab 行', () => {
    expect(projectTabs([])).toEqual([]);
  });
});
