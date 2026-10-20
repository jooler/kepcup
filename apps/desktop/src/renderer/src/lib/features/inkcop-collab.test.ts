import { describe, expect, it } from 'vitest';
import { inkcopCollabEnabled } from './inkcop-collab-prefs';
import type { Settings } from '@kepcup/shared';

function settings(partial: Partial<Settings['inkcopLocalCollab']>): Settings {
  return {
    inkcopLocalCollab: {
      enabled: false,
      systemBotId: '',
      ...partial,
    },
  } as Settings;
}

describe('inkcop-collab prefs', () => {
  it('reads enabled flag', () => {
    expect(inkcopCollabEnabled(settings({ enabled: true }))).toBe(true);
    expect(inkcopCollabEnabled(settings({ enabled: false }))).toBe(false);
    expect(inkcopCollabEnabled(null)).toBe(false);
  });
});
