import { describe, expect, it } from 'vitest';
import { resolveSettingsSection } from './sections';

describe('resolveSettingsSection', () => {
  it('maps the legacy mcp id onto the developer-mode section', () => {
    expect(resolveSettingsSection('mcp')).toEqual({ section: 'developer' });
    // 别名不受传入页签影响
    expect(resolveSettingsSection('mcp', 'catalog')).toEqual({ section: 'developer' });
  });

  it('keeps apps deep links on the apps section (connected-account management)', () => {
    expect(resolveSettingsSection('apps')).toEqual({ section: 'apps' });
    expect(resolveSettingsSection('apps', 'connected')).toEqual({ section: 'apps' });
    // 旧的「目录」页签已并入扩展中心：深链仍落在「应用」（那里有去扩展中心的入口）
    expect(resolveSettingsSection('apps', 'catalog')).toEqual({ section: 'apps' });
  });

  it('sends the legacy apps custom tab to the developer-mode section', () => {
    expect(resolveSettingsSection('apps', 'custom')).toEqual({ section: 'developer' });
  });

  it('passes other sections through', () => {
    expect(resolveSettingsSection('models')).toEqual({ section: 'models' });
    expect(resolveSettingsSection('developer')).toEqual({ section: 'developer' });
    expect(resolveSettingsSection('general', 'custom')).toEqual({ section: 'general' });
  });
});
