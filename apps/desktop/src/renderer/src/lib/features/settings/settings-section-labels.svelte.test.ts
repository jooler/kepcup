import { describe, expect, it } from 'vitest';
import { i18n } from '$lib/i18n';
import { sectionLabel, visibleSectionSources } from './settings-section-labels';

/**
 * 分区标题必须在调用时翻译：若在模块加载时固化成字符串（曾在此翻车），语言
 * 切换后设置弹框左栏分组名不会更新，要刷新前端才能恢复。
 */
describe('settings section labels follow locale switches', () => {
  it('sectionLabel / visibleSectionSources re-translate per call', () => {
    const prev = i18n.locale;
    try {
      i18n.setLocale('zh-CN');
      expect(sectionLabel('general')).toBe('通用');
      expect(visibleSectionSources(false).find((s) => s.id === 'general')?.labelKey).toBe(
        'settings.navGeneral',
      );

      i18n.setLocale('en-US');
      expect(sectionLabel('general')).toBe('General');
      // 窄屏过滤不受重构影响（通讯录 / 个人资料仍隐藏）
      const narrowIds = visibleSectionSources(true).map((s) => s.id);
      expect(narrowIds).not.toContain('contacts');
      expect(narrowIds).not.toContain('profile');
    } finally {
      i18n.setLocale(prev);
    }
  });

  it('unknown id falls back to the settings title in the current locale', () => {
    const prev = i18n.locale;
    try {
      i18n.setLocale('zh-CN');
      expect(sectionLabel('mcp' as never)).toBe('设置');
      i18n.setLocale('en-US');
      expect(sectionLabel('mcp' as never)).toBe('Settings');
    } finally {
      i18n.setLocale(prev);
    }
  });
});
