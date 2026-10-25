import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineEditScheduler, normalizeMultiline } from './inline-editable.svelte';

/**
 * Inline edit scheduler: debounce, IME, deferred blur, empty values, dispose,
 * a failed save that keeps a newer draft, and a second round while a save is
 * in flight. The contenteditable itself is covered by e2e.
 */

const DELAY_MS = 400;

interface Fixture {
  field: InlineEditScheduler;
  calls: string[];
  fail: () => void;
  resolve: (index: number, ok: boolean) => void;
}

function setup(initial: string, immediate = true, autosave = true): Fixture {
  const calls: string[] = [];
  const pending: Array<(ok: boolean) => void> = [];
  let failNext = false;
  const field = new InlineEditScheduler({
    delayMs: DELAY_MS,
    autosave,
    normalize: normalizeMultiline,
    save: (value) => {
      calls.push(value);
      const fail = failNext;
      failNext = false;
      const settle = (ok: boolean): boolean => ok && !fail;
      if (immediate) return Promise.resolve(settle(true));
      return new Promise<boolean>((resolve) => {
        pending.push((ok) => resolve(settle(ok)));
      });
    },
  });
  field.sync(initial);
  return {
    field,
    calls,
    fail: () => {
      failNext = true;
    },
    resolve: (index, ok) => pending[index]?.(ok),
  };
}

const compositionInput = { isComposing: true } as InputEvent;
const plainInput = {} as InputEvent;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('InlineEditScheduler debounce', () => {
  it('coalesces keystrokes into one save of the latest draft', async () => {
    const { field, calls } = setup('saved');
    field.draft = 'a';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    field.draft = 'ab';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['ab']);
  });

  it('normalizes newlines and non-breaking spaces only when saving', async () => {
    const { field, calls } = setup('saved');
    field.draft = 'a\u00a0b\r\nc';
    field.onInput(plainInput);
    expect(field.draft).toBe('a\u00a0b\r\nc');
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['a b\nc']);
    expect(field.draft).toBe('a b\nc');
  });
});

describe('InlineEditScheduler composition', () => {
  it('does not save during composition, then saves the committed text', async () => {
    const { field, calls } = setup('saved');
    field.onCompositionStart();
    field.draft = 'pin';
    field.onInput(compositionInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 3);
    expect(calls).toEqual([]);
    field.draft = '拼';
    field.onCompositionEnd();
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['拼']);
  });

  it('defers a blur until compositionend, then commits immediately', async () => {
    const { field, calls } = setup('saved');
    field.onCompositionStart();
    field.draft = 'wei';
    field.onInput(compositionInput);
    const flushed = field.flush();
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual([]);
    await flushed;
    field.draft = '未';
    field.onCompositionEnd();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['未']);
  });
});

describe('InlineEditScheduler empty values', () => {
  it('does not save an empty draft and restores the saved text on blur', async () => {
    const { field, calls } = setup('saved');
    field.draft = '   ';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual([]);
    expect(field.draft).toBe('   ');
    await field.flush();
    expect(calls).toEqual([]);
    expect(field.draft).toBe('saved');
  });
});

describe('InlineEditScheduler dispose', () => {
  it('flushes a pending edit on dispose', async () => {
    const { field, calls } = setup('saved');
    field.draft = 'leaving';
    field.onInput(plainInput);
    field.dispose();
    expect(calls).toEqual(['leaving']);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual(['leaving']);
  });

  it('discards a half-composed value on dispose', async () => {
    const { field, calls } = setup('saved');
    field.onCompositionStart();
    field.draft = 'pin';
    field.onInput(compositionInput);
    field.dispose();
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual([]);
  });
});

describe('InlineEditScheduler failures and in-flight edits', () => {
  it('rolls back when the draft has not changed since the failed save', async () => {
    const { field, calls, fail } = setup('saved');
    fail();
    field.draft = 'nope';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['nope']);
    expect(field.draft).toBe('saved');
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(calls).toEqual(['nope']);
  });

  it('keeps a newer draft when the save fails and sends it on the next round', async () => {
    const { field, calls, resolve } = setup('saved', false);
    field.draft = 'first';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['first']);
    field.draft = 'second';
    resolve(0, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(field.draft).toBe('second');
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(calls).toEqual(['first', 'second']);
  });

  it('starts another round when the user types during an in-flight save', async () => {
    const { field, calls, resolve } = setup('saved', false);
    field.draft = 'first';
    field.onInput(plainInput);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    field.draft = 'second';
    field.flush();
    expect(calls).toEqual(['first']);
    resolve(0, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['first', 'second']);
  });
});
