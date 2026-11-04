import { describe, expect, it } from 'vitest';
import { countLines, diffStatsOfEdits, lineDiffCounts } from '../../src/domain/diff-stats.js';

describe('lineDiffCounts', () => {
  it('counts added and removed lines', () => {
    expect(lineDiffCounts('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(lineDiffCounts('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 });
    expect(lineDiffCounts('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(lineDiffCounts('a\nb\n', '')).toEqual({ added: 0, removed: 2 });
    expect(lineDiffCounts('a\nb\nc', 'a\nc\nd')).toEqual({ added: 1, removed: 1 });
  });

  it('ignores a trailing newline', () => {
    expect(lineDiffCounts('a\n', 'a')).toEqual({ added: 0, removed: 0 });
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

describe('diffStatsOfEdits', () => {
  it('sums multiple edit blocks', () => {
    expect(
      diffStatsOfEdits([
        { oldText: 'a', newText: 'a\nb' },
        { oldText: 'c', newText: 'd' },
      ]),
    ).toEqual({ added: 2, removed: 1 });
  });

  it('returns null for missing / non-array edits', () => {
    expect(diffStatsOfEdits(undefined)).toBeNull();
    expect(diffStatsOfEdits([])).toBeNull();
  });
});
