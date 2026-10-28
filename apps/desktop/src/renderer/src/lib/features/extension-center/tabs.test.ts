import { describe, expect, it } from 'vitest';
import { EXTENSION_CENTER_TABS, extensionTabForKey, resolveExtensionCenterTarget } from './tabs';

describe('extensionTabForKey', () => {
  it('lists the groups in display order', () => {
    // D105 P4：两页签收敛（本机应用协作收编为已安装页的系统卡）。
    expect(EXTENSION_CENTER_TABS).toEqual(['market', 'installed']);
  });

  it('cycles with the arrow keys and jumps with Home / End', () => {
    expect(extensionTabForKey('market', 'ArrowRight')).toBe('installed');
    expect(extensionTabForKey('installed', 'ArrowRight')).toBe('market');
    expect(extensionTabForKey('installed', 'ArrowLeft')).toBe('market');
    expect(extensionTabForKey('market', 'ArrowLeft')).toBe('installed');
    expect(extensionTabForKey('installed', 'Home')).toBe('market');
    expect(extensionTabForKey('installed', 'End')).toBe('installed');
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
    expect(resolveExtensionCenterTarget('market', 'plugins-filter-all')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: false,
    });
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
  });

  it('ignores unknown anchors', () => {
    expect(resolveExtensionCenterTarget('installed', 'default-models')).toEqual({
      tab: 'installed',
      filter: 'all',
      systemCard: false,
    });
  });
});
