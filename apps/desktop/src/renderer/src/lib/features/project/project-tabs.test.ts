import { describe, expect, it } from 'vitest';
import { PROJECT_MODULES } from '@kepcup/shared';
import { projectTabs } from './project-tabs';

/** 项目组 tab 行模型（WP6 步骤 2）：顺序同注册表、planned 灰显、文案 key。 */

describe('projectTabs', () => {
  it('顺序与 id 同模块注册表', () => {
    expect(projectTabs(PROJECT_MODULES).map((tab) => tab.id)).toEqual([
      'chat',
      'wiki',
      'board',
      'okr',
      'calendar',
    ]);
  });

  it('planned 模块 disabled，available 模块可点', () => {
    const tabs = projectTabs(PROJECT_MODULES);
    expect(tabs.map((tab) => tab.disabled)).toEqual([false, false, true, true, true]);
  });

  it('labelKey 逐模块指向 i18n 的 project.module.<id>', () => {
    expect(projectTabs(PROJECT_MODULES).map((tab) => tab.labelKey)).toEqual([
      'project.module.chat',
      'project.module.wiki',
      'project.module.board',
      'project.module.okr',
      'project.module.calendar',
    ]);
  });

  it('空注册表给出空 tab 行', () => {
    expect(projectTabs([])).toEqual([]);
  });
});
