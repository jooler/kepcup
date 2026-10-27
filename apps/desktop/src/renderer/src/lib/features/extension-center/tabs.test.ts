import { describe, expect, it } from 'vitest';
import { EXTENSION_CENTER_TABS, extensionTabForKey, resolveExtensionCenterTarget } from './tabs';

describe('extensionTabForKey', () => {
  it('lists the groups in display order', () => {
    expect(EXTENSION_CENTER_TABS).toEqual(['market', 'installed', 'localCollab']);
  });

  it('cycles with the arrow keys and jumps with Home / End', () => {
    expect(extensionTabForKey('market', 'ArrowRight')).toBe('installed');
    expect(extensionTabForKey('installed', 'ArrowRight')).toBe('localCollab');
    expect(extensionTabForKey('installed', 'ArrowLeft')).toBe('market');
    expect(extensionTabForKey('localCollab', 'ArrowRight')).toBe('market');
    expect(extensionTabForKey('localCollab', 'ArrowLeft')).toBe('installed');
    expect(extensionTabForKey('installed', 'Home')).toBe('market');
    expect(extensionTabForKey('installed', 'End')).toBe('localCollab');
  });

  it('ignores other keys', () => {
    expect(extensionTabForKey('market', 'Enter')).toBeNull();
    expect(extensionTabForKey('market', 'ArrowDown')).toBeNull();
  });
});

describe('resolveExtensionCenterTarget', () => {
  it('maps the legacy kind tabs onto installed filters', () => {
    expect(resolveExtensionCenterTarget('skills')).toEqual({ tab: 'installed', filter: 'skill' });
    expect(resolveExtensionCenterTarget('connections')).toEqual({
      tab: 'installed',
      filter: 'connector',
    });
    expect(resolveExtensionCenterTarget('mcp')).toEqual({ tab: 'installed', filter: 'mcp' });
    expect(resolveExtensionCenterTarget('mail')).toEqual({ tab: 'installed', filter: 'mail' });
  });

  it('maps the catalog filter anchors onto installed filters', () => {
    expect(resolveExtensionCenterTarget('installed', 'plugins-filter-mail')).toEqual({
      tab: 'installed',
      filter: 'mail',
    });
    expect(resolveExtensionCenterTarget('market', 'plugins-filter-all')).toEqual({
      tab: 'installed',
      filter: 'all',
    });
  });

  it('keeps the real tabs and resets the filter to all', () => {
    expect(resolveExtensionCenterTarget('market')).toEqual({ tab: 'market', filter: 'all' });
    expect(resolveExtensionCenterTarget('installed')).toEqual({
      tab: 'installed',
      filter: 'all',
    });
    expect(resolveExtensionCenterTarget('localCollab')).toEqual({
      tab: 'localCollab',
      filter: 'all',
    });
  });

  it('ignores unknown anchors', () => {
    expect(resolveExtensionCenterTarget('installed', 'default-models')).toEqual({
      tab: 'installed',
      filter: 'all',
    });
  });
});
