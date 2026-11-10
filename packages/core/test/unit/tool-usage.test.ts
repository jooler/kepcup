import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { ToolUsageTracker, TOOL_IMAGE_TOKENS } from '../../src/agent/tool-usage.js';
import { estimateTokens } from '../../src/agent/tokens.js';

function setup(maxPending?: number) {
  const entries: Array<{ toolName: string; callTokens: number; resultTokens: number }> = [];
  const tracker = new ToolUsageTracker({
    record: (entry) => entries.push(entry),
    ...(maxPending !== undefined ? { maxPending } : {}),
  });
  return { tracker, entries };
}

describe('ToolUsageTracker', () => {
  it('pairs call arguments with the result content', () => {
    const { tracker, entries } = setup();
    tracker.call({ toolCallId: 'c1', toolName: 'read', args: { path: 'src/a.ts' } });
    tracker.result({ toolCallId: 'c1', toolName: 'read', content: 'x'.repeat(400) });

    expect(entries).toEqual([
      {
        toolName: 'read',
        callTokens: estimateTokens(JSON.stringify({ path: 'src/a.ts' })),
        resultTokens: 100,
      },
    ]);
  });

  it('adds the fixed image cost only for images the model received', () => {
    const { tracker, entries } = setup();
    tracker.call({ toolCallId: 'c1', toolName: 'browser_screenshot', args: {} });
    tracker.result({
      toolCallId: 'c1',
      toolName: 'browser_screenshot',
      content: 'snapshot',
      imageCount: 2,
    });
    expect(entries[0]?.resultTokens).toBe(estimateTokens('snapshot') + 2 * TOOL_IMAGE_TOKENS);
  });

  it('truncates result content to the same budget the model sees', () => {
    const { tracker, entries } = setup();
    tracker.call({ toolCallId: 'c1', toolName: 'bash', args: { command: 'cat huge' } });
    tracker.result({ toolCallId: 'c1', toolName: 'bash', content: 'x'.repeat(200_000) });
    // 200k chars ≈ 50k token，截到 TOOL_OUTPUT_MAX_CHARS；再多只有截断标记。
    expect(entries[0]?.resultTokens).toBeGreaterThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
    expect(entries[0]?.resultTokens).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + 10);
  });

  it('records an unpaired result with zero call tokens', () => {
    const { tracker, entries } = setup();
    tracker.result({ toolCallId: 'missing', toolName: 'glob', content: 'a.ts' });
    expect(entries[0]?.callTokens).toBe(0);
    expect(entries[0]?.resultTokens).toBe(estimateTokens('a.ts'));
  });

  it('bounds pending calls and drops the oldest unmatched one', () => {
    const { tracker, entries } = setup(2);
    tracker.call({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    tracker.call({ toolCallId: 'c2', toolName: 'read', args: { path: 'b' } });
    tracker.call({ toolCallId: 'c3', toolName: 'read', args: { path: 'c' } });
    tracker.result({ toolCallId: 'c1', toolName: 'read', content: '' });
    tracker.result({ toolCallId: 'c2', toolName: 'read', content: '' });
    tracker.result({ toolCallId: 'c3', toolName: 'read', content: '' });

    expect(entries.map((entry) => entry.callTokens)).toEqual([
      0,
      estimateTokens(JSON.stringify({ path: 'b' })),
      estimateTokens(JSON.stringify({ path: 'c' })),
    ]);
  });

  it('never lets a ledger failure break the task', () => {
    const tracker = new ToolUsageTracker({
      record: () => {
        throw new Error('ledger closed');
      },
    });
    tracker.call({ toolCallId: 'c1', toolName: 'read', args: {} });
    expect(() =>
      tracker.result({ toolCallId: 'c1', toolName: 'read', content: 'ok' }),
    ).not.toThrow();
  });

  it('clear drops unmatched calls', () => {
    const { tracker, entries } = setup();
    tracker.call({ toolCallId: 'c1', toolName: 'read', args: { path: 'a' } });
    tracker.clear();
    tracker.result({ toolCallId: 'c1', toolName: 'read', content: 'late' });
    expect(entries[0]?.callTokens).toBe(0);
  });
});
