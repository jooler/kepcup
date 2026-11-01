import { describe, expect, it } from 'vitest';
import {
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  countCodeLines,
  highlightCodeLines,
  plainCodeLines,
  shouldHighlightCode,
} from './code-highlight';

const join = (lines: Array<Array<{ content: string }>>): string =>
  lines.map((line) => line.map((token) => token.content).join('')).join('\n');

describe('code view limits', () => {
  it('counts lines like text.split', () => {
    expect(countCodeLines('')).toBe(1);
    expect(countCodeLines('a')).toBe(1);
    expect(countCodeLines('a\nb')).toBe(2);
    expect(countCodeLines('a\n')).toBe(2);
    expect(countCodeLines('a\n\n')).toBe(3);
  });

  it('only highlights files below the line / character thresholds', () => {
    expect(shouldHighlightCode('const a = 1;')).toBe(true);
    expect(shouldHighlightCode('x'.repeat(MAX_HIGHLIGHT_CHARS))).toBe(true);
    expect(shouldHighlightCode('x'.repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(false);
    // 正好 5000 行仍高亮，多一行退化。
    expect(countCodeLines('x\n'.repeat(MAX_HIGHLIGHT_LINES - 1) + 'x')).toBe(MAX_HIGHLIGHT_LINES);
    expect(shouldHighlightCode('x\n'.repeat(MAX_HIGHLIGHT_LINES - 1) + 'x')).toBe(true);
    expect(shouldHighlightCode('x\n'.repeat(MAX_HIGHLIGHT_LINES) + 'x')).toBe(false);
  });

  it('renders plain lines as tokenless rows', () => {
    const lines = plainCodeLines('a\n\nb');
    expect(lines).toEqual([[{ content: 'a' }], [{ content: '' }], [{ content: 'b' }]]);
  });
});

describe('code highlighting', () => {
  it('returns null for a language it cannot load', async () => {
    expect(await highlightCodeLines('x', 'no-such-language', 'github-light')).toBeNull();
  });

  it('tokenizes typescript and keeps the text intact', async () => {
    const code = 'const answer: number = 42;\nconsole.log(answer);';
    const lines = await highlightCodeLines(code, 'typescript', 'github-light');
    expect(lines).not.toBeNull();
    expect(lines?.length).toBe(2);
    expect(join(lines ?? [])).toBe(code);
    const colors = (lines ?? []).flatMap((line) => line.map((token) => token.color));
    expect(colors.some((color) => typeof color === 'string' && color.length > 0)).toBe(true);
  });

  it('caches per language + theme + content', async () => {
    const code = '{"a": 1}';
    const light = await highlightCodeLines(code, 'json', 'github-light');
    const again = await highlightCodeLines(code, 'json', 'github-light');
    const dark = await highlightCodeLines(code, 'json', 'github-dark');
    expect(again).toBe(light);
    expect(dark).not.toBe(light);
    expect(join(dark ?? [])).toBe(code);
  });
});
