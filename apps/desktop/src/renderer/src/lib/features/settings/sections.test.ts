import { describe, expect, it } from 'vitest';
import { resolveSettingsSection, settingsSectionOpensExtensionMcp } from './sections';

describe('resolveSettingsSection', () => {
  it('兜底旧深链 mcp / developer 到「通用」（正常由 shell 改开扩展中心 MCP）', () => {
    expect(resolveSettingsSection('mcp')).toEqual({ section: 'general' });
    expect(resolveSettingsSection('developer')).toEqual({ section: 'general' });
  });

  it('其余分区原样返回', () => {
    expect(resolveSettingsSection('models')).toEqual({ section: 'models' });
    expect(resolveSettingsSection('general')).toEqual({ section: 'general' });
  });
});

describe('settingsSectionOpensExtensionMcp', () => {
  it('flags mcp and developer legacy deep links', () => {
    expect(settingsSectionOpensExtensionMcp('mcp')).toBe(true);
    expect(settingsSectionOpensExtensionMcp('developer')).toBe(true);
    expect(settingsSectionOpensExtensionMcp('models')).toBe(false);
    expect(settingsSectionOpensExtensionMcp('general')).toBe(false);
  });
});
