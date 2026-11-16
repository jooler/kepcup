import { describe, expect, it } from 'vitest';
import {
  EXTENSION_CENTER_TABS,
  FILTER_COUNT_KEYS,
  extensionTabForKey,
  pluginFocusContentView,
  resolveExtensionCenterTarget,
} from './tabs';

describe('extensionTabForKey', () => {
  it('lists the groups in display order', () => {
    // D105 P4：两页签收敛（本机应用协作收编为已安装页的系统卡）；
    // 「设置」页签：原设置「插件」分区并入扩展中心。
    expect(EXTENSION_CENTER_TABS).toEqual(['market', 'installed', 'settings']);
  });

  it('cycles with the arrow keys and jumps with Home / End', () => {
    expect(extensionTabForKey('market', 'ArrowRight')).toBe('installed');
    expect(extensionTabForKey('installed', 'ArrowRight')).toBe('settings');
    expect(extensionTabForKey('settings', 'ArrowRight')).toBe('market');
    expect(extensionTabForKey('settings', 'ArrowLeft')).toBe('installed');
    expect(extensionTabForKey('installed', 'ArrowLeft')).toBe('market');
    expect(extensionTabForKey('market', 'ArrowLeft')).toBe('settings');
    expect(extensionTabForKey('settings', 'Home')).toBe('market');
    expect(extensionTabForKey('market', 'End')).toBe('settings');
  });

  it('ignores other keys', () => {
    expect(extensionTabForKey('market', 'Enter')).toBeNull();
    expect(extensionTabForKey('market', 'ArrowDown')).toBeNull();
  });
});

describe('resolveExtensionCenterTarget', () => {
  it('maps the legacy kind tabs onto installed filters', () => {
    expect(resolveExtensionCenterTarget('skills')).toEqual({
      tab: 'installed',
      filter: 'skill',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('connections')).toEqual({
      tab: 'installed',
      filter: 'connector',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('mcp')).toEqual({
      tab: 'installed',
      filter: 'mcp',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('mail')).toEqual({
      tab: 'installed',
      filter: 'mail',
      systemCard: false,
    });
  });

  it('maps the localCollab deep link onto installed + the system card', () => {
    expect(resolveExtensionCenterTarget('localCollab')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: true,
    });
  });

  it('maps the catalog filter anchors onto installed filters', () => {
    expect(resolveExtensionCenterTarget('installed', 'plugins-filter-mail')).toEqual({
      tab: 'installed',
      filter: 'mail',
      systemCard: false,
    });
    // 2026-11-03：微信上架后新增「即时通讯」分类（市场 + 已安装筛选）。
    expect(resolveExtensionCenterTarget('installed', 'plugins-filter-im')).toEqual({
      tab: 'installed',
      filter: 'im',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('market', 'plugins-filter-all')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: false,
    });
  });

  it('counts the instant-messaging filter from the im contribution count', () => {
    expect(FILTER_COUNT_KEYS.im).toBe('im');
  });

  it('keeps the real tabs and resets the filter to all', () => {
    expect(resolveExtensionCenterTarget('market')).toEqual({
      tab: 'market',
      filter: 'all',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('installed')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: false,
    });
    expect(resolveExtensionCenterTarget('settings')).toEqual({
      tab: 'settings',
      filter: 'all',
      systemCard: false,
    });
  });

  it('ignores unknown anchors', () => {
    expect(resolveExtensionCenterTarget('installed', 'default-models')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: false,
    });
  });
});

describe('pluginFocusContentView（D124 插件详情深链的消费判定）', () => {
  const installed = ['p/one', 'p/two'];

  it('清单已拉到且插件在列：落该插件的详情视图', () => {
    expect(pluginFocusContentView('p/one', true, installed)).toEqual({
      kind: 'capability-model',
      pluginId: 'p/one',
    });
  });

  it('清单未拉到（冷启动直达深链）：不消费，focus 保持挂起等 load 完成后重判', () => {
    // 目标插件其实在清单里也不能立即落：此时列表为空，立即消费会误判并吞掉深链。
    expect(pluginFocusContentView('p/one', false, [])).toBeNull();
    expect(pluginFocusContentView('p/one', false, installed)).toBeNull();
  });

  it('清单已拉到但插件不在列（已卸载 / 深链过期）：不消费也不落视图', () => {
    expect(pluginFocusContentView('gone', true, installed)).toBeNull();
  });

  it('没有深链（focus 已被上次消费复位）：返回 null', () => {
    expect(pluginFocusContentView(null, true, installed)).toBeNull();
  });
});
