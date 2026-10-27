import { describe, expect, it } from 'vitest';
import { EXTENSION_CENTER_TABS, extensionTabForKey } from './tabs';

describe('extensionTabForKey', () => {
  it('lists the groups in display order', () => {
    expect(EXTENSION_CENTER_TABS).toEqual([
      'installed',
      'skills',
      'connections',
      'mcp',
      'mail',
      'localCollab',
    ]);
  });

  it('cycles with the arrow keys and jumps with Home / End', () => {
    expect(extensionTabForKey('installed', 'ArrowRight')).toBe('skills');
    expect(extensionTabForKey('skills', 'ArrowLeft')).toBe('installed');
    expect(extensionTabForKey('mcp', 'ArrowRight')).toBe('mail');
    expect(extensionTabForKey('mail', 'ArrowRight')).toBe('localCollab');
    expect(extensionTabForKey('localCollab', 'ArrowRight')).toBe('installed');
    expect(extensionTabForKey('localCollab', 'ArrowLeft')).toBe('mail');
    expect(extensionTabForKey('connections', 'Home')).toBe('installed');
    expect(extensionTabForKey('connections', 'End')).toBe('localCollab');
  });

  it('ignores other keys', () => {
    expect(extensionTabForKey('skills', 'Enter')).toBeNull();
    expect(extensionTabForKey('skills', 'ArrowDown')).toBeNull();
  });
});
