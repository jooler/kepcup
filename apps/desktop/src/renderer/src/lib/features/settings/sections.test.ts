import { describe, expect, it } from 'vitest';
import { APPS_TABS, appsTabForKey, resolveSettingsSection } from './sections';

describe('resolveSettingsSection', () => {
  it('maps the legacy mcp id onto the apps custom tab', () => {
    expect(resolveSettingsSection('mcp')).toEqual({ section: 'apps', appsTab: 'custom' });
    // 别名不受传入页签影响
    expect(resolveSettingsSection('mcp', 'catalog')).toEqual({
      section: 'apps',
      appsTab: 'custom',
    });
  });

  it('opens apps on the catalog tab by default, or the requested one', () => {
    expect(resolveSettingsSection('apps')).toEqual({ section: 'apps', appsTab: 'catalog' });
    expect(resolveSettingsSection('apps', 'connected')).toEqual({
      section: 'apps',
      appsTab: 'connected',
    });
  });

  it('passes other sections through without a tab', () => {
    expect(resolveSettingsSection('models')).toEqual({ section: 'models' });
    expect(resolveSettingsSection('general', 'custom')).toEqual({ section: 'general' });
  });

  it('exposes the three tabs in display order', () => {
    expect(APPS_TABS).toEqual(['catalog', 'connected', 'custom']);
  });
});

describe('appsTabForKey', () => {
  it('cycles with the arrow keys and jumps with Home / End', () => {
    expect(appsTabForKey('catalog', 'ArrowRight')).toBe('connected');
    expect(appsTabForKey('custom', 'ArrowRight')).toBe('catalog');
    expect(appsTabForKey('catalog', 'ArrowLeft')).toBe('custom');
    expect(appsTabForKey('connected', 'ArrowLeft')).toBe('catalog');
    expect(appsTabForKey('connected', 'Home')).toBe('catalog');
    expect(appsTabForKey('connected', 'End')).toBe('custom');
  });

  it('ignores other keys', () => {
    expect(appsTabForKey('catalog', 'Enter')).toBeNull();
    expect(appsTabForKey('catalog', 'ArrowDown')).toBeNull();
  });
});
