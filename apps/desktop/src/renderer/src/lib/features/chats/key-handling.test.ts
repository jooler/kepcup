import { describe, expect, it } from 'vitest';
import { resolveComposerAction } from './key-handling.js';

const base = {
  key: 'Enter',
  meta: false,
  shift: false,
  isComposing: false,
  hasText: false,
};

describe('composer key handling (直发按键逻辑)', () => {
  it('Enter with input text sends directly', () => {
    expect(resolveComposerAction({ ...base, hasText: true })).toBe('send');
  });

  it('pure attachments send too', () => {
    expect(resolveComposerAction({ ...base, hasAttachments: true })).toBe('send');
  });

  it('Enter with an empty input does nothing', () => {
    expect(resolveComposerAction(base)).toBe('none');
  });

  it('Cmd/Ctrl+Enter is an alias for send', () => {
    expect(resolveComposerAction({ ...base, meta: true, hasText: true })).toBe('send');
    expect(resolveComposerAction({ ...base, meta: true })).toBe('none');
  });

  it('Shift+Enter inserts a newline', () => {
    expect(resolveComposerAction({ ...base, shift: true, hasText: true })).toBe('newline');
  });

  it('never fires while the IME is composing', () => {
    expect(resolveComposerAction({ ...base, isComposing: true, hasText: true })).toBe('none');
    expect(resolveComposerAction({ ...base, isComposing: true, hasAttachments: true })).toBe(
      'none',
    );
  });

  it('ignores other keys', () => {
    expect(resolveComposerAction({ ...base, key: 'a', hasText: true })).toBe('none');
  });
});
