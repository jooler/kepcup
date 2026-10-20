import { describe, expect, test } from 'vitest';
import { activitySnapshotOf, sameActivitySnapshot } from './sidebar-activity';

describe('side activity snapshot', () => {
  test('取最后消息时间，没有消息时回退创建时间', () => {
    expect(
      activitySnapshotOf([
        { id: 'a', lastMessageAt: 30, createdAt: 10 },
        { id: 'b', lastMessageAt: null, createdAt: 20 },
        { id: 'c' },
        { id: 'd', lastMessageAt: Number.NaN, createdAt: 5 },
      ]),
    ).toEqual({ a: 30, b: 20, c: 0, d: 0 });
  });

  test('同一批会话的时间完全一致才算无变化', () => {
    expect(sameActivitySnapshot({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameActivitySnapshot({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameActivitySnapshot({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameActivitySnapshot({}, {})).toBe(true);
  });
});
