import { describe, expect, test } from 'vitest';
import {
  createFileUpdateSourceStore,
  createUpdateSourceSelector,
  updateSourcesFromEnv,
  type UpdateSource,
  type UpdateSourceId,
} from './update-sources.js';

/**
 * 多源探测选源（docs/dev/06-release.md「更新镜像与选源」）：优先级顺序探测、
 * 第一个可用者胜出并持久化、持久化赢家零探测直达、失败后排除重探。
 */

interface Harness {
  pick(): Promise<UpdateSource | null>;
  pickAfterFailure(id: UpdateSourceId): Promise<UpdateSource | null>;
  store: { current: UpdateSourceId | null };
  probed: UpdateSourceId[];
  /** 让某个源「不可达」。默认全部可达。 */
  fail(id: UpdateSourceId): void;
}

function harness(options?: {
  env?: NodeJS.ProcessEnv;
  persisted?: UpdateSourceId | null;
}): Harness {
  const failed = new Set<UpdateSourceId>();
  const probed: UpdateSourceId[] = [];
  const store = { current: options?.persisted ?? null };
  const selector = createUpdateSourceSelector({
    sources: () => updateSourcesFromEnv(options?.env ?? {}),
    store: {
      load: () => store.current,
      save: (id) => {
        store.current = id;
      },
      clear: () => {
        store.current = null;
      },
    },
    probe: async (source) => {
      probed.push(source.id);
      return !failed.has(source.id);
    },
  });
  return {
    pick: () => selector.pick(),
    pickAfterFailure: (id) => selector.pickAfterFailure(id),
    store,
    probed,
    fail(id) {
      failed.add(id);
    },
  };
}

describe('updateSourcesFromEnv', () => {
  test('默认：github + r2 + oss 三个候选，顺序即优先级', () => {
    expect(updateSourcesFromEnv({})).toEqual([
      { id: 'github', feedUrl: null, probeUrl: 'https://api.github.com/rate_limit' },
      {
        id: 'r2',
        feedUrl: 'https://updates.kepcup.com/',
        probeUrl: 'https://updates.kepcup.com/latest.yml',
      },
      {
        id: 'oss',
        feedUrl: 'https://kepcup-updates.oss-cn-shanghai.aliyuncs.com/',
        probeUrl: 'https://kepcup-updates.oss-cn-shanghai.aliyuncs.com/latest.yml',
      },
    ]);
  });

  test('KEPCUP_UPDATE_MIRRORS 整体替换烘焙镜像，首位 r2、次位 oss，补尾斜杠', () => {
    const sources = updateSourcesFromEnv({
      KEPCUP_UPDATE_MIRRORS: ' https://mirror-a.example/base ,https://mirror-b.example',
    });
    expect(sources.map((source) => [source.id, source.feedUrl])).toEqual([
      ['github', null],
      ['r2', 'https://mirror-a.example/base/'],
      ['oss', 'https://mirror-b.example/'],
    ]);
    expect(sources[2]?.probeUrl).toBe('https://mirror-b.example/latest.yml');
  });

  test('空 override 视同未设置', () => {
    expect(
      updateSourcesFromEnv({ KEPCUP_UPDATE_MIRRORS: '  ' }).map((source) => source.id),
    ).toEqual(['github', 'r2', 'oss']);
  });
});

describe('createUpdateSourceSelector', () => {
  test('无持久化记录：按优先级探测，github 可用即胜出并保存（不再探测后面的）', async () => {
    const h = harness();
    await expect(h.pick()).resolves.toMatchObject({ id: 'github' });
    expect(h.store.current).toBe('github');
    expect(h.probed).toEqual(['github']);
  });

  test('github 不可达：落到 r2 并保存', async () => {
    const h = harness();
    h.fail('github');
    await expect(h.pick()).resolves.toMatchObject({ id: 'r2' });
    expect(h.store.current).toBe('r2');
    expect(h.probed).toEqual(['github', 'r2']);
  });

  test('全部不可达（离线）：null，store 清空', async () => {
    const h = harness({ persisted: 'r2' });
    h.fail('github');
    h.fail('r2');
    h.fail('oss');
    h.store.current = null; // 无持久化的全败场景
    await expect(h.pick()).resolves.toBe(null);
    expect(h.store.current).toBe(null);
    expect(h.probed).toEqual(['github', 'r2', 'oss']);
  });

  test('持久化的赢家直达：不探测', async () => {
    const h = harness({
      env: { KEPCUP_UPDATE_MIRRORS: 'https://a/,https://b/' },
      persisted: 'oss',
    });
    await expect(h.pick()).resolves.toMatchObject({ id: 'oss' });
    expect(h.probed).toEqual([]);
  });

  test('持久化的 id 已不在候选表（镜像配置变了）：清掉并重新探测', async () => {
    // override 只有一个镜像（r2），持久化的 oss 成为陈旧 id。
    const h = harness({ env: { KEPCUP_UPDATE_MIRRORS: 'https://a/' }, persisted: 'oss' });
    await expect(h.pick()).resolves.toMatchObject({ id: 'github' });
    expect(h.store.current).toBe('github');
    expect(h.probed).toEqual(['github']);
  });

  test('pickAfterFailure：排除失败源重探并更新持久化', async () => {
    const h = harness({ persisted: 'r2' });
    await expect(h.pick()).resolves.toMatchObject({ id: 'r2' });
    expect(h.probed).toEqual([]);
    await expect(h.pickAfterFailure('r2')).resolves.toMatchObject({ id: 'github' });
    expect(h.store.current).toBe('github');
    expect(h.probed).toEqual(['github']);
  });

  test('pickAfterFailure：其余源也全败 → null 且清空持久化', async () => {
    const h = harness({ env: { KEPCUP_UPDATE_MIRRORS: 'https://a/' }, persisted: 'r2' });
    h.fail('github');
    await expect(h.pickAfterFailure('r2')).resolves.toBe(null);
    expect(h.store.current).toBe(null);
  });
});

describe('createFileUpdateSourceStore', () => {
  test('save → load → clear 往返；坏文件当无记录', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    // 系统临时目录（不是源码树），finally 清理。
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-update-store-'));
    try {
      const store = createFileUpdateSourceStore(() => dir);
      expect(store.load()).toBe(null);
      store.save('oss');
      expect(store.load()).toBe('oss');
      store.clear();
      expect(store.load()).toBe(null);
      // 坏 JSON：吞掉，返回 null。
      writeFileSync(path.join(dir, 'update-source.json'), 'not json', 'utf8');
      expect(store.load()).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
