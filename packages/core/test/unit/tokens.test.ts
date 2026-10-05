import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToBudget } from '../../src/agent/tokens.js';

describe('token estimation', () => {
  it('counts CJK characters as one token each', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('counts other text as one token per four characters', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abc')).toBe(1);
  });

  it('handles mixed text', () => {
    // 2 CJK + 8 latin -> 2 + 2
    expect(estimateTokens('你好abcdefgh')).toBe(4);
  });

  it('truncates to the budget and marks the cut', () => {
    const text = 'a'.repeat(400);
    const result = truncateToBudget(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('已截断');
    expect(estimateTokens(result.text.replace('[已截断]', ''))).toBeLessThanOrEqual(12);
  });

  it('keeps short text untouched', () => {
    const result = truncateToBudget('你好', 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('你好');
  });
});
