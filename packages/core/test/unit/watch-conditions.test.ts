import { describe, expect, it } from 'vitest';
import {
  WATCH_PAUSE_AFTER_FAILURES,
  watchConditionSchema,
  watchIntervalSecSchema,
  watchRedirectAllowed,
  watchSourceSchema,
  type WatchCondition,
} from '@kepcup/shared';
import {
  describeCondition,
  evaluateCondition,
  extractNumbers,
  failureBackoffMs,
  isEdge,
  pickNumber,
  shouldPause,
} from '../../src/watch/conditions.js';

/**
 * W7 确定性监看：条件求值、边沿触发、退避序列、5 次暂停与 schema 拒绝
 * 非 web_page 来源（todo/borrowings-from-personal-agents.md W7 测试）。
 */

describe('number extraction (price-like text)', () => {
  it('handles currency signs, thousands separators and decimals', () => {
    expect(extractNumbers('¥1,299.50')).toEqual([{ value: 1299.5, currency: true }]);
    expect(extractNumbers('$ 12,800')).toEqual([{ value: 12800, currency: true }]);
    expect(extractNumbers('€99.9')).toEqual([{ value: 99.9, currency: true }]);
    expect(extractNumbers('￥12，800')).toEqual([{ value: 12800, currency: true }]);
    expect(extractNumbers('共 3 件')).toEqual([{ value: 3, currency: false }]);
    expect(extractNumbers('降价 -¥5')).toEqual([{ value: -5, currency: true }]);
  });

  it('a hyphen inside a date or code is not a minus sign', () => {
    expect(extractNumbers('2026-10-09').map((n) => n.value)).toEqual([2026, 10, 9]);
  });

  it('prefers the first price-like number', () => {
    expect(pickNumber('2026-10-09 已售 3 件 现价 ¥90 原价 ¥100')).toBe(90);
    expect(pickNumber('库存 12 件')).toBe(12);
    expect(pickNumber('暂无报价')).toBeNull();
  });
});

describe('evaluateCondition', () => {
  it('contains / not_contains (case- and whitespace-insensitive)', () => {
    const contains: WatchCondition = { kind: 'contains', text: 'In  Stock' };
    expect(evaluateCondition(contains, { text: 'Status: in stock' })).toMatchObject({
      ok: true,
      matched: true,
    });
    expect(evaluateCondition(contains, { text: 'Status: sold out' })).toMatchObject({
      ok: true,
      matched: false,
    });
    const gone: WatchCondition = { kind: 'not_contains', text: '缺货' };
    expect(evaluateCondition(gone, { text: '有货' })).toMatchObject({ ok: true, matched: true });
    expect(evaluateCondition(gone, { text: '暂时缺货' })).toMatchObject({
      ok: true,
      matched: false,
    });
  });

  it('number_below / number_above; the selector text wins; a missing number is a failure', () => {
    const below: WatchCondition = { kind: 'number_below', value: 95 };
    expect(evaluateCondition(below, { text: '现价 ¥90' })).toMatchObject({
      ok: true,
      matched: true,
    });
    expect(evaluateCondition(below, { text: '现价 ¥100' })).toMatchObject({
      ok: true,
      matched: false,
    });
    const above: WatchCondition = { kind: 'number_above', value: 1000, selector: '#price' };
    expect(evaluateCondition(above, { text: '¥5', numberText: '¥1,299' })).toMatchObject({
      ok: true,
      matched: true,
    });
    expect(evaluateCondition(above, { text: '¥5', numberText: null })).toMatchObject({ ok: false });
    expect(evaluateCondition(below, { text: '暂无报价' })).toEqual({
      ok: false,
      error: '页面上没有找到数字',
    });
  });

  it('describes conditions for cards and tools', () => {
    expect(describeCondition({ kind: 'number_below', value: 95 })).toBe('数值低于 95');
    expect(describeCondition({ kind: 'changed' })).toBe('页面内容有变化');
  });
});

describe('edge trigger', () => {
  const below: WatchCondition = { kind: 'number_below', value: 95 };

  it('alerts only on false → true', () => {
    expect(
      isEdge(below, { lastMatched: false, lastQuietHash: 'a' }, { matched: true, quietHash: 'b' }),
    ).toBe(true);
    // Staying true: no second alert.
    expect(
      isEdge(below, { lastMatched: true, lastQuietHash: 'b' }, { matched: true, quietHash: 'c' }),
    ).toBe(false);
    expect(
      isEdge(below, { lastMatched: true, lastQuietHash: 'b' }, { matched: false, quietHash: 'd' }),
    ).toBe(false);
    expect(
      isEdge(below, { lastMatched: false, lastQuietHash: 'd' }, { matched: true, quietHash: 'e' }),
    ).toBe(true);
  });

  it('a condition already true at the first check alerts once', () => {
    expect(
      isEdge(below, { lastMatched: false, lastQuietHash: null }, { matched: true, quietHash: 'x' }),
    ).toBe(true);
  });

  it('changed: first check is the baseline; then only a different quiet hash alerts', () => {
    const changed: WatchCondition = { kind: 'changed' };
    expect(
      isEdge(
        changed,
        { lastMatched: false, lastQuietHash: null },
        { matched: true, quietHash: 'a' },
      ),
    ).toBe(false);
    expect(
      isEdge(
        changed,
        { lastMatched: false, lastQuietHash: 'a' },
        { matched: true, quietHash: 'a' },
      ),
    ).toBe(false);
    expect(
      isEdge(
        changed,
        { lastMatched: false, lastQuietHash: 'a' },
        { matched: true, quietHash: 'b' },
      ),
    ).toBe(true);
  });
});

describe('failure backoff and pause', () => {
  it('backs off min(60, 2^failures) minutes, never sooner than the 5-minute minimum interval', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => failureBackoffMs(n) / 60_000)).toEqual([
      5, 5, 8, 16, 32, 60, 60, 60,
    ]);
  });

  it('pauses after 5 consecutive failures', () => {
    expect(WATCH_PAUSE_AFTER_FAILURES).toBe(5);
    expect([1, 2, 3, 4].map(shouldPause)).toEqual([false, false, false, false]);
    expect(shouldPause(5)).toBe(true);
  });
});

describe('watchRedirectAllowed (background page final URL)', () => {
  it.each([
    ['https://shop.example.com/item', 'https://shop.example.com/item/'],
    ['https://shop.example.com/a', 'https://shop.example.com/b?ref=1#top'],
    ['http://shop.example.com/a', 'https://shop.example.com/a'],
    ['https://example.com/a', 'https://www.example.com/a'],
    ['https://www.Example.com/a', 'https://example.com/a'],
    ['http://127.0.0.1:8080/a', 'http://127.0.0.1:8080/b'],
  ])('allows %s → %s', (from, to) => {
    expect(watchRedirectAllowed(from, to)).toBe(true);
  });

  it.each([
    ['https://shop.example.com/item', 'https://login.example.com/sso?next=/item'],
    ['https://shop.example.com/item', 'https://accounts.other.com/login'],
    ['https://shop.example.com/a', 'http://shop.example.com/a'],
    ['http://127.0.0.1:8080/a', 'http://127.0.0.1:9090/a'],
    ['http://shop.example.com:8080/a', 'https://shop.example.com/a'],
    ['https://shop.example.com/a', 'not a url'],
  ])('refuses %s → %s', (from, to) => {
    expect(watchRedirectAllowed(from, to)).toBe(false);
  });
});

describe('schemas', () => {
  it('only web_page sources over http(s) are accepted', () => {
    expect(
      watchSourceSchema.safeParse({ kind: 'web_page', url: 'https://example.com/a' }).success,
    ).toBe(true);
    expect(watchSourceSchema.safeParse({ kind: 'sensor', sensor: 'camera' }).success).toBe(false);
    expect(
      watchSourceSchema.safeParse({ kind: 'web_page', url: 'file:///etc/passwd' }).success,
    ).toBe(false);
    expect(watchSourceSchema.safeParse({ kind: 'web_page', url: 'not a url' }).success).toBe(false);
  });

  it('conditions are validated by kind', () => {
    expect(watchConditionSchema.safeParse({ kind: 'contains', text: '有货' }).success).toBe(true);
    expect(watchConditionSchema.safeParse({ kind: 'contains' }).success).toBe(false);
    expect(
      watchConditionSchema.safeParse({ kind: 'number_below', value: Number.NaN }).success,
    ).toBe(false);
    expect(watchConditionSchema.safeParse({ kind: 'price' }).success).toBe(false);
  });

  it('the interval is at least 300 s', () => {
    expect(watchIntervalSecSchema.safeParse(299).success).toBe(false);
    expect(watchIntervalSecSchema.safeParse(300).success).toBe(true);
  });
});
