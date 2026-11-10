import { describe, expect, it } from 'vitest';

import { RecentTargetsStore } from './targets.svelte';

import type { KeyValueStore } from './targets.svelte';

/** 内存后端:验证 store 的持久化契约(读写同一键、内容为 JSON 数组)。 */
function memoryStore(): KeyValueStore & { dump(): string | null } {
  let value: string | null = null;
  return {
    get: async () => value,
    set: async (_key, next) => {
      value = next;
    },
    dump: () => value,
  };
}

describe('RecentTargetsStore', () => {
  it('record:有效目标入列并持久化,无效目标被拒', async () => {
    const backend = memoryStore();
    const store = new RecentTargetsStore();
    await store.init(backend);
    expect(await store.record('192.168.1.5:8642', 1000)).toBe(true);
    expect(store.list).toHaveLength(1);
    expect(store.list[0]?.label).toBe('192.168.1.5:8642');
    expect(await store.record('不是地址', 2000)).toBe(false);
    expect(store.list).toHaveLength(1);
    // 持久化:JSON 数组落盘。
    expect(Array.isArray(JSON.parse(backend.dump() ?? 'null'))).toBe(true);
  });

  it('record:同一目标上浮不重复', async () => {
    const store = new RecentTargetsStore();
    await store.init(memoryStore());
    await store.record('192.168.1.5:8642', 1000);
    await store.record('192.168.1.6:8642', 2000);
    await store.record('192.168.1.5:8642', 3000);
    expect(store.list).toHaveLength(2);
    expect(store.list[0]?.lastUsedAt).toBe(3000);
  });

  it('init:恢复持久化过的列表,坏数据退化空列表', async () => {
    const backend = memoryStore();
    await backend.set(
      'kepcup.mobile.recentTargets.v1',
      JSON.stringify([
        {
          id: 'server:http://x:1/',
          kind: 'server',
          label: 'x:1',
          raw: 'http://x:1/',
          addedAt: 1,
          lastUsedAt: 1,
        },
      ]),
    );
    const store = new RecentTargetsStore();
    await store.init(backend);
    expect(store.list).toHaveLength(1);
    const broken = new RecentTargetsStore();
    await broken.init({
      get: async () => 'not-json{',
      set: async () => {},
    });
    expect(broken.list).toHaveLength(0);
  });

  it('remove / clear 更新列表与持久化', async () => {
    const backend = memoryStore();
    const store = new RecentTargetsStore();
    await store.init(backend);
    await store.record('192.168.1.5:8642', 1000);
    const id = store.list[0]?.id;
    expect(id).toBeDefined();
    await store.remove(id!);
    expect(store.list).toHaveLength(0);
    await store.record('192.168.1.7:8642', 2000);
    await store.clear();
    expect(store.list).toHaveLength(0);
    expect(JSON.parse(backend.dump() ?? '[]')).toHaveLength(0);
  });

  it('init 幂等:重复调用不重复注入后端', async () => {
    const backend = memoryStore();
    const store = new RecentTargetsStore();
    await store.init(backend);
    await store.record('192.168.1.5:8642', 1000);
    // 第二次 init 若重复加载会以磁盘旧值覆盖内存态;幂等守卫防住。
    await store.init(memoryStore());
    expect(store.list).toHaveLength(1);
  });
});
