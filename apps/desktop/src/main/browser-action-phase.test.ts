import { AppError } from '@kepcup/shared';
import { describe, expect, test } from 'vitest';
import { toPageError, withPhase } from './browser-action-phase.js';

describe('browser action phase tagging (W1)', () => {
  test('tags AppErrors, keeps code / message / prior details', () => {
    const tagged = withPhase(new AppError('BROWSER_REF_STALE', '元素已变化', { ref: 'e1' }), 'pre');
    expect(tagged.code).toBe('BROWSER_REF_STALE');
    expect(tagged.message).toBe('元素已变化');
    expect(tagged.details).toEqual({ ref: 'e1', phase: 'pre' });
  });

  test('CDP failures after dispatch become PAGE_CLOSED / INTERNAL with phase post', () => {
    const closed = withPhase(new Error('Target closed'), 'post');
    expect(closed.code).toBe('BROWSER_PAGE_CLOSED');
    expect(closed.details).toEqual({ phase: 'post' });
    const other = withPhase('boom', 'post', { passwordField: true });
    expect(other.code).toBe('INTERNAL');
    expect(other.details).toEqual({ passwordField: true, phase: 'post' });
  });

  test('a destroyed execution context is not a closed page', () => {
    const reset = toPageError(new Error('Execution context was destroyed.'));
    expect(reset.code).toBe('INTERNAL');
    expect(reset.message).toContain('执行上下文已销毁');
    // AppErrors pass through untouched even when their text mentions "destroyed".
    const app = new AppError('BROWSER_REF_STALE', 'node destroyed');
    expect(toPageError(app)).toBe(app);
  });

  test('tags survive JSON serialization (port B carries AppError.toJSON)', () => {
    const wire = JSON.parse(
      JSON.stringify(withPhase(new Error('Debugger is detached'), 'post')),
    ) as {
      code: string;
      details: { phase: string };
    };
    expect(wire).toMatchObject({ code: 'BROWSER_PAGE_CLOSED', details: { phase: 'post' } });
    expect(toPageError(new AppError('BROWSER_BLOCKED', 'x')).code).toBe('BROWSER_BLOCKED');
  });
});
