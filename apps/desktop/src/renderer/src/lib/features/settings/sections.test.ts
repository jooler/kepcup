import { describe, expect, it } from 'vitest';
import { resolveSettingsSection, settingsSectionExtensionTarget } from './sections';

describe('resolveSettingsSection', () => {
  it('兜底旧深链 mcp / developer / plugins 到「通用」（正常由 shell 改开扩展中心）', () => {
    expect(resolveSettingsSection('mcp')).toEqual({ section: 'general' });
    expect(resolveSettingsSection('developer')).toEqual({ section: 'general' });
    expect(resolveSettingsSection('plugins')).toEqual({ section: 'general' });
  });

  it('其余分区原样返回', () => {
    expect(resolveSettingsSection('models')).toEqual({ section: 'models' });
    expect(resolveSettingsSection('general')).toEqual({ section: 'general' });
  });
});

describe('settingsSectionExtensionTarget', () => {
  it('mcp / developer 旧深链改开扩展中心「已安装」的 MCP 筛选', () => {
    expect(settingsSectionExtensionTarget('mcp')).toBe('mcp');
    expect(settingsSectionExtensionTarget('developer')).toBe('mcp');
  });

  it('plugins 旧深链改开扩展中心「设置」页签（原设置插件分区已并入）', () => {
    expect(settingsSectionExtensionTarget('plugins')).toBe('settings');
  });

  it('真实分区返回 null（正常打开设置分区）', () => {
    expect(settingsSectionExtensionTarget('models')).toBeNull();
    expect(settingsSectionExtensionTarget('general')).toBeNull();
  });
});
