import { describe, expect, it } from 'vitest';
import { resolveComposerAction } from './key-handling.js';

const base = {
  key: 'Enter',
  meta: false,
  shift: false,
  isComposing: false,
  hasText: false,
  queueLength: 0,
};

describe('composer key handling (待发送队列按键逻辑)', () => {
  it('Enter with input text queues a draft', () => {
    expect(resolveComposerAction({ ...base, hasText: true })).toBe('add-draft');
  });

  it('Enter with an empty input flushes a non-empty queue', () => {
    expect(resolveComposerAction({ ...base, queueLength: 2 })).toBe('flush');
  });

  it('Enter with an empty input and empty queue does nothing', () => {
    expect(resolveComposerAction(base)).toBe('none');
  });

  it('Cmd/Ctrl+Enter appends the draft and flushes immediately', () => {
    expect(resolveComposerAction({ ...base, meta: true, hasText: true })).toBe('add-and-flush');
    // Empty input: just flush the queue.
    expect(resolveComposerAction({ ...base, meta: true, queueLength: 3 })).toBe('flush');
    // Nothing anywhere: no-op.
    expect(resolveComposerAction({ ...base, meta: true })).toBe('flush');
  });

  it('Shift+Enter inserts a newline', () => {
    expect(resolveComposerAction({ ...base, shift: true, hasText: true })).toBe('newline');
  });

  it('never fires while the IME is composing', () => {
    expect(resolveComposerAction({ ...base, isComposing: true, hasText: true })).toBe('none');
    expect(resolveComposerAction({ ...base, isComposing: true, queueLength: 1 })).toBe('none');
    expect(
      resolveComposerAction({ ...base, isComposing: true, meta: true, hasText: true }),
    ).toBe('none');
  });

  it('ignores other keys', () => {
    expect(resolveComposerAction({ ...base, key: 'a', hasText: true })).toBe('none');
  });
});
