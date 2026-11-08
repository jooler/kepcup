import { describe, expect, it } from 'vitest';
import type { CollabPresenceEntry } from '@kepcup/shared';
import { remoteCaretFrom } from './remote-caret-model';

/** D121 远端光标：只有 owner 的 selection 且 docVersion 一致才显示。 */

function entry(overrides: Partial<CollabPresenceEntry> = {}): CollabPresenceEntry {
  return {
    clientId: 'owner',
    clientName: 'Owner',
    color: '#0284c7',
    connectionId: 'conn-owner',
    conversationId: 'conv-1',
    state: 'typing',
    selection: { anchor: 3, head: 5, docVersion: 7 },
    updatedAt: 1,
    ...overrides,
  };
}

describe('remoteCaretFrom', () => {
  it('returns the caret when owner selection matches the rendered version', () => {
    expect(remoteCaretFrom([entry()], 'owner', 7)).toEqual({
      anchor: 3,
      head: 5,
      name: 'Owner',
      color: '#0284c7',
    });
  });

  it('hides the caret on a version mismatch, missing selection or missing owner', () => {
    expect(remoteCaretFrom([entry()], 'owner', 6)).toBeNull();
    expect(remoteCaretFrom([entry({ selection: null })], 'owner', 7)).toBeNull();
    expect(remoteCaretFrom([entry()], 'someone-else', 7)).toBeNull();
    expect(remoteCaretFrom([], 'owner', 7)).toBeNull();
  });
});
