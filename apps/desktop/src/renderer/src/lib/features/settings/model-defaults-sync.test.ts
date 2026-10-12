import { describe, expect, it } from 'vitest';
import { nextLocalFromStore } from './model-defaults-sync';

describe('nextLocalFromStore', () => {
  it('applies the store value on first sync', () => {
    expect(
      nextLocalFromStore({ storeValue: 'a/main', lastApplied: null, localValue: '' }),
    ).toEqual({ localValue: 'a/main', lastApplied: 'a/main' });
  });

  it('keeps an unsaved local edit when refresh returns the same store value', () => {
    expect(
      nextLocalFromStore({
        storeValue: 'a/old',
        lastApplied: 'a/old',
        localValue: 'a/new',
      }),
    ).toEqual({ localValue: 'a/new', lastApplied: 'a/old' });
  });

  it('accepts a real store change (after save or external update)', () => {
    expect(
      nextLocalFromStore({
        storeValue: 'a/new',
        lastApplied: 'a/old',
        localValue: 'a/new',
      }),
    ).toEqual({ localValue: 'a/new', lastApplied: 'a/new' });
  });
});
