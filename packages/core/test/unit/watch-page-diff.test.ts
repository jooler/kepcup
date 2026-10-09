import { describe, expect, it } from 'vitest';
import { WATCH_DIFF_SUMMARY_MAX_CHARS } from '@kepcup/shared';
import {
  RELATIVE_TIME_PLACEHOLDER,
  describePageDiff,
  diffPage,
  pageHash,
  pageLines,
  quietHash,
  withoutRelativeTimes,
} from '../../src/watch/page-diff.js';

/**
 * W7 确定性监看：页面按行 diff 与相对时间去噪（todo/borrowings-from-personal-agents.md
 * W7 测试）。只有相对时间在走的页面，「安静 hash」不变。
 */

describe('pageLines', () => {
  it('trims, collapses whitespace (incl. nbsp / 全角空格) and drops empty lines', () => {
    expect(pageLines('  标题 \n\n\t价格： ¥100　元 \r\n  \n尾行')).toEqual([
      '标题',
      '价格： ¥100 元',
      '尾行',
    ]);
  });
});

describe('withoutRelativeTimes', () => {
  it.each([
    '3 分钟前',
    '3分钟前',
    '两小时前',
    '半小时前',
    '几秒前',
    '5 天前',
    '1个月前',
    '刚刚',
    '刚才',
    '昨天',
    '3 天后',
    '5 minutes ago',
    'an hour ago',
    'a few seconds ago',
    '2 days ago',
    '5m ago',
    '3h ago',
    'just now',
    'Yesterday',
    'in 3 days',
  ])('replaces %s', (phrase) => {
    expect(withoutRelativeTimes(`发布于 ${phrase}`)).toBe(`发布于 ${RELATIVE_TIME_PLACEHOLDER}`);
  });

  it('keeps absolute dates, clock times and plain numbers', () => {
    const line = '2026-10-09 14:30 价格 ¥1,299 库存 3 件';
    expect(withoutRelativeTimes(line)).toBe(line);
  });

  it.each(['10日前发货', '3月前完成报名', '比赛得了100分后晋级', '满 100 分后可兑换'])(
    'keeps calendar days / months and point counts: %s',
    (line) => {
      expect(withoutRelativeTimes(line)).toBe(line);
    },
  );

  it.each(['5日前', '3 月前', '10分前'])(
    'still strips a bare 日 / 月 / short 分 at the end: %s',
    (phrase) => {
      expect(withoutRelativeTimes(`更新 ${phrase}`)).toBe(`更新 ${RELATIVE_TIME_PLACEHOLDER}`);
    },
  );
});

describe('hashes', () => {
  it('quiet hash ignores 3 分钟前 → 4 分钟前; the raw hash does not', () => {
    const before = pageLines('商品 A\n更新于 3 分钟前\n价格 ¥100');
    const after = pageLines('商品 A\n更新于 4 分钟前\n价格 ¥100');
    expect(quietHash(before)).toBe(quietHash(after));
    expect(pageHash(before)).not.toBe(pageHash(after));
  });

  it('quiet hash changes with real content', () => {
    const before = pageLines('商品 A\n更新于 3 分钟前\n价格 ¥100');
    const after = pageLines('商品 A\n更新于 4 分钟前\n价格 ¥90');
    expect(quietHash(before)).not.toBe(quietHash(after));
  });
});

describe('diffPage / describePageDiff', () => {
  it('pairs similar lines as changed, the rest as added / removed', () => {
    const diff = diffPage(
      ['商品 A', '价格：¥100', '库存充足', '旧公告'],
      ['商品 A', '价格：¥90', '库存充足', '新品上市：B 款手机'],
    );
    expect(diff.changed).toEqual([{ before: '价格：¥100', after: '价格：¥90' }]);
    expect(diff.added).toEqual(['新品上市：B 款手机']);
    expect(diff.removed).toEqual(['旧公告']);
    const text = describePageDiff(diff);
    expect(text).toContain('修改 1 行，新增 1 行，删除 1 行');
    expect(text).toContain('~ 价格：¥100 → 价格：¥90');
    expect(text).toContain('+ 新品上市：B 款手机');
    expect(text).toContain('- 旧公告');
  });

  it('relative-time-only differences are no diff', () => {
    const diff = diffPage(['评论 3 分钟前'], ['评论 4 分钟前']);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
    expect(describePageDiff(diff)).toContain('没有变化');
  });

  it('only the line order changed: says so instead of "no change"', () => {
    const diff = diffPage(['A 款', 'B 款', 'C 款'], ['C 款', 'A 款', 'B 款']);
    expect(diff.reordered).toBe(true);
    const text = describePageDiff(diff);
    expect(text).toContain('顺序有变化');
    expect(text).not.toContain('没有变化');
  });

  it('a cut comparison says how much was compared', () => {
    const text = describePageDiff(diffPage(['a', 'b'], ['a', 'c']), 1500, { comparedChars: 50000 });
    expect(text).toContain('仅比较前 50000 字');
    expect(describePageDiff(diffPage(['a'], ['a']), 1500, { comparedChars: 50000 })).toContain(
      '变化可能在页面后部',
    );
  });

  it('is count-aware for repeated lines', () => {
    const diff = diffPage(['- 条目', '- 条目'], ['- 条目', '- 条目', '- 条目']);
    expect(diff.added).toEqual(['- 条目']);
    expect(diff.removed).toEqual([]);
  });

  it('caps the summary at WATCH_DIFF_SUMMARY_MAX_CHARS and counts what was left out', () => {
    const after = Array.from(
      { length: 400 },
      (_, i) => `新增的第 ${i} 行，带一些内容让它更长一点 ${'x'.repeat(20)}`,
    );
    const text = describePageDiff(diffPage([], after));
    expect(text.length).toBeLessThanOrEqual(WATCH_DIFF_SUMMARY_MAX_CHARS);
    expect(text).toMatch(/另有 \d+ 处变化未列出/);
  });

  it('clips very long lines', () => {
    const text = describePageDiff(diffPage([], ['长'.repeat(1000)]));
    expect(text.length).toBeLessThan(300);
    expect(text).toContain('…');
  });
});
