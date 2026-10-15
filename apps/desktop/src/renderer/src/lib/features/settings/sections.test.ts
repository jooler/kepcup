import { describe, expect, it } from 'vitest';
import { resolveSettingsSection, settingsSectionOpensExtensionMcp } from './sections';

describe('resolveSettingsSection', () => {
  it('maps legacy mcp / developer / apps custom onto apps (shell redirects to extension MCP)', () => {
    expect(resolveSettingsSection('mcp')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('developer')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('apps', 'custom')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('mcp', 'catalog')).toEqual({ section: 'apps' });
  });

  it('keeps apps (non-custom) and other sections', () => {
    expect(resolveSettingsSection('apps')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('apps', 'connected')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('apps', 'catalog')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('models')).toEqual({ section: 'models' });
    expect(resolveSettingsSection('general', 'custom')).toEqual({ section: 'general' });
  });
});

describe('settingsSectionOpensExtensionMcp', () => {
  it('flags mcp, developer, and apps+custom', () => {
    expect(settingsSectionOpensExtensionMcp('mcp')).toBe(true);
    expect(settingsSectionOpensExtensionMcp('developer')).toBe(true);
    expect(settingsSectionOpensExtensionMcp('apps', 'custom')).toBe(true);
    expect(settingsSectionOpensExtensionMcp('apps')).toBe(false);
    expect(settingsSectionOpensExtensionMcp('apps', 'connected')).toBe(false);
    expect(settingsSectionOpensExtensionMcp('models')).toBe(false);
  });
});
