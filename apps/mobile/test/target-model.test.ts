import { describe, expect, it } from 'vitest';

import { resolveConnectTarget } from '../src/lib/connect';
import {
  RECENT_TARGETS_CAP,
  toRecentTarget,
  upsertRecent,
  type RecentTarget,
} from '../src/lib/target-model';

function entry(raw: string, now: number): RecentTarget {
  const target = resolveConnectTarget(raw);
  if (target === null) throw new Error(`unresolvable: ${raw}`);
  return toRecentTarget(target, now);
}

describe('toRecentTarget', () => {
  it('配对目标:label 取源 host,raw 保留整条链接', () => {
    const item = entry(
      'http://192.168.1.5:8642/#pair=ws%3A%2F%2F192.168.1.5%3A8642,01J0000000000000000000000A,secret-value',
      1000,
    );
    expect(item.kind).toBe('pairing');
    expect(item.label).toBe('192.168.1.5:8642');
    expect(item.raw.startsWith('http://192.168.1.5:8642/#pair=')).toBe(true);
  });

  it('服务目标:raw 是规范化后的地址', () => {
    const item = entry('192.168.1.6:8642', 1000);
    expect(item.kind).toBe('server');
    expect(item.raw).toBe('http://192.168.1.6:8642/');
  });
});

describe('upsertRecent', () => {
  it('新条目插头', () => {
    const a = entry('192.168.1.5:8642', 1000);
    const b = entry('192.168.1.6:8642', 2000);
    const list = upsertRecent([a], b);
    expect(list.map((item) => item.id)).toEqual([b.id, a.id]);
  });

  it('同 id 上浮:换位到头、lastUsedAt 更新、addedAt 保留首次', () => {
    const a = entry('192.168.1.5:8642', 1000);
    const b = entry('192.168.1.6:8642', 2000);
    const again = entry('192.168.1.5:8642', 3000);
    const list = upsertRecent([a, b], again);
    expect(list.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(list[0]?.lastUsedAt).toBe(3000);
    expect(list[0]?.addedAt).toBe(1000);
  });

  it('超过上限从尾部截断', () => {
    let list: RecentTarget[] = [];
    for (let i = 0; i < RECENT_TARGETS_CAP + 2; i += 1) {
      list = upsertRecent(list, entry(`192.168.1.${100 + i}:8642`, i));
    }
    expect(list).toHaveLength(RECENT_TARGETS_CAP);
    expect(list[0]?.raw).toBe(`http://192.168.1.${100 + RECENT_TARGETS_CAP + 1}:8642/`);
  });

  it('不修改入参数组', () => {
    const a = entry('192.168.1.5:8642', 1000);
    const original = [a];
    upsertRecent(original, entry('192.168.1.9:8642', 2000));
    expect(original).toEqual([a]);
  });
});
