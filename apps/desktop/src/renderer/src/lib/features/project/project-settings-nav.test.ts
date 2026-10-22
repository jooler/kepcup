import { describe, expect, it } from 'vitest';
import { PROJECT_DETAIL_SECTIONS } from '@kepcup/shared';
// 相对导入：desktop 测试项目没有 $lib 别名（只有 desktop-svelte 有）。
import { enUS } from '../../i18n/locales/en-US';
import { zhCN } from '../../i18n/locales/zh-CN';
import { projectSettingsNav } from './project-settings-nav';

/**
 * 详情页分区导航模型（master-detail 审查修复）：窄屏 segmented 与宽屏分类
 * 列表共用的数据源。窄屏用户靠它到得了 members/danger 等每个分区，testid
 * 保持 project-settings-nav-*（e2e 与深链用）。
 */

describe('projectSettingsNav', () => {
  it('覆盖注册表全部分区且顺序一致（少一个分区窄屏就到不了）', () => {
    expect(projectSettingsNav().map((item) => item.id)).toEqual([...PROJECT_DETAIL_SECTIONS]);
  });

  it('testid 逐分区生成 project-settings-nav-<section>', () => {
    for (const item of projectSettingsNav()) {
      expect(item.testid).toBe(`project-settings-nav-${item.id}`);
    }
  });

  it('labelKey 在两份词典里都有文案（缺 key 的分区会渲染出键名）', () => {
    for (const item of projectSettingsNav()) {
      expect(zhCN[item.labelKey as keyof typeof zhCN], item.labelKey).toBeTruthy();
      expect(enUS[item.labelKey as keyof typeof enUS], item.labelKey).toBeTruthy();
    }
  });
});
