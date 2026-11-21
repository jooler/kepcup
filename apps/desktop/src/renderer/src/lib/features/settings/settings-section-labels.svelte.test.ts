import { describe, expect, it } from 'vitest';
import { i18n } from '$lib/i18n';
import { setTeamHiddenSurfaces } from '$lib/features/team/surface-gate';
import { resolveSettingsSection } from './sections';
import {
  settingsSectionSources,
  sectionLabel,
  visibleSectionSources,
} from './settings-section-labels';

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

  it('models and agents share one nav entry but keep per-section labels', () => {
    const prev = i18n.locale;
    try {
      i18n.setLocale('zh-CN');
      const ids = visibleSectionSources(false).map((s) => s.id);
      expect(ids).toContain('models');
      expect(ids).not.toContain('agents');
      expect(sectionLabel('models')).toBe('模型与智能体');
      expect(sectionLabel('agents')).toBe('模型与智能体');
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

/**
 * 团队 surfaces 门控（T5）：被 `team.bootstrap.surfaces.hidden` 拒绝的分区从
 * 导航消失、深链回落到可见分区；非团队上下文（active=false）列表与现状逐项
 * 一致（休眠铁律的快照断言）。
 */
describe('team surface gating（T5）', () => {
  function activate(hidden: string[]): void {
    setTeamHiddenSurfaces(hidden);
  }

  function deactivate(): void {
    setTeamHiddenSurfaces([]);
  }

  it('dormant（非团队上下文）：列表与现状一致（快照）', () => {
    expect(visibleSectionSources(false).map((s) => s.id)).toEqual(
      settingsSectionSources.map((s) => s.id).filter((id) => id !== 'agents'),
    );
    expect(visibleSectionSources(true).map((s) => s.id)).toEqual(
      settingsSectionSources
        .filter((s) => !['contacts', 'profile'].includes(s.id))
        .map((s) => s.id)
        .filter((id) => id !== 'agents'),
    );
  });

  it('team hidden：被拒分区从导航消失，其余保留', () => {
    try {
      activate(['browser', 'computer-use', 'remote']);
      const ids = visibleSectionSources(false).map((s) => s.id);
      expect(ids).not.toContain('browser');
      expect(ids).not.toContain('computer-use');
      expect(ids).not.toContain('remote');
      expect(ids).toContain('general');
      expect(ids).toContain('models');
      // 窄屏过滤与团队过滤叠加。
      const narrowIds = visibleSectionSources(true).map((s) => s.id);
      expect(narrowIds).not.toContain('contacts');
      expect(narrowIds).not.toContain('browser');
    } finally {
      deactivate();
    }
  });

  it('deep link：被隐藏分区的深链回落到第一个可见分区', () => {
    try {
      activate(['general', 'remote']);
      // general 被隐藏：回落到清单里第一个可见分区（profile）。
      expect(resolveSettingsSection('general').section).toBe('profile');
      expect(resolveSettingsSection('remote').section).toBe('profile');
      // 未被隐藏的分区原样返回。
      expect(resolveSettingsSection('models').section).toBe('models');
    } finally {
      deactivate();
    }
  });

  it('dormant：深链行为与现状一致', () => {
    expect(resolveSettingsSection('general').section).toBe('general');
    expect(resolveSettingsSection('plugins').section).toBe('general');
    expect(resolveSettingsSection('agents').section).toBe('agents');
  });
});
