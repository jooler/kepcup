import { describe, expect, test } from 'vitest';
import {
  clampSidebarWidth,
  isSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarWidth,
  settleSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  type WidthStorage,
} from './sidebar-layout';

/** 极简 localStorage 替身（node 环境无 DOM）。 */
function fakeStorage(initial: Record<string, string> = {}): WidthStorage & {
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

describe('clampSidebarWidth', () => {
  test('夹取到 [最小宽, 最大宽] 并取整', () => {
    expect(clampSidebarWidth(120)).toBe(120);
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(160.6)).toBe(161);
  });

  test('非法值回退默认宽', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('settleSidebarWidth', () => {
  test('低于吸附阈值收成最小宽（图标模式）', () => {
    expect(settleSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(settleSidebarWidth(159)).toBe(SIDEBAR_MIN_WIDTH);
    // 已经是最小宽（图标模式）松手不回弹
    expect(settleSidebarWidth(SIDEBAR_MIN_WIDTH)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test('阈值及以上保持夹取结果', () => {
    expect(settleSidebarWidth(160)).toBe(160);
    expect(settleSidebarWidth(300)).toBe(300);
    expect(settleSidebarWidth(800)).toBe(SIDEBAR_MAX_WIDTH);
  });
});

describe('isSidebarCollapsed', () => {
  test('最小宽即图标模式，其余为展开', () => {
    expect(isSidebarCollapsed(SIDEBAR_MIN_WIDTH)).toBe(true);
    expect(isSidebarCollapsed(SIDEBAR_MIN_WIDTH + 1)).toBe(false);
    expect(isSidebarCollapsed(SIDEBAR_DEFAULT_WIDTH)).toBe(false);
  });
});

describe('loadSidebarWidth', () => {
  test('缺 key / 坏值 / 存储异常回退默认宽', () => {
    expect(loadSidebarWidth(fakeStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: 'oops' }))).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
    expect(loadSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test('合法值原样读取，越界值夹取', () => {
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '320' }))).toBe(320);
    expect(loadSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '5' }))).toBe(
      SIDEBAR_MIN_WIDTH,
    );
  });
});

describe('saveSidebarWidth', () => {
  test('写入夹取后的整数值', () => {
    const storage = fakeStorage();
    saveSidebarWidth(storage, 260.4);
    expect(storage.store.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('260');
    saveSidebarWidth(storage, 9999);
    expect(storage.store.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_MAX_WIDTH));
  });

  test('存储为 null / 抛异常时静默跳过', () => {
    expect(() => saveSidebarWidth(null, 300)).not.toThrow();
    expect(() =>
      saveSidebarWidth(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('quota');
          },
        },
        300,
      ),
    ).not.toThrow();
  });
});
