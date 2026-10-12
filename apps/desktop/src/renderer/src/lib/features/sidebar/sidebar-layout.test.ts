import { describe, expect, test } from 'vitest';
import {
  clampSidebarWidth,
  effectiveSidebarWidth,
  isSidebarCollapsed,
  maxSidebarWidthFor,
  rightPanelFits,
  loadSidebarWidth,
  saveSidebarWidth,
  settleSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  WIDE_CHAT_MIN_WIDTH,
  WIDE_RIGHT_PANEL_MIN_WIDTH,
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

describe('窗口宽度夹取（窄屏断点之上的宽屏三栏区间 640~959）', () => {
  test('侧栏上限给聊天区留出最小可用宽度；大窗口不夹取', () => {
    expect(maxSidebarWidthFor(1280)).toBe(SIDEBAR_MAX_WIDTH);
    expect(maxSidebarWidthFor(680)).toBe(680 - WIDE_CHAT_MIN_WIDTH);
    expect(maxSidebarWidthFor(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(maxSidebarWidthFor(Number.NaN)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test('持久化 420px + 650px 窗口：渲染宽被夹到聊天区仍 ≥ 最小可用宽', () => {
    const windowWidth = 650;
    const sidebar = effectiveSidebarWidth(420, windowWidth);
    expect(sidebar).toBe(windowWidth - WIDE_CHAT_MIN_WIDTH);
    expect(windowWidth - sidebar).toBeGreaterThanOrEqual(WIDE_CHAT_MIN_WIDTH);
    // 偏好值本身不被改写：窗口拉回去又恢复 420。
    expect(effectiveSidebarWidth(420, 1280)).toBe(420);
  });

  test('任意窗口宽 × 任意偏好宽：聊天区永远 ≥ 最小可用宽（窗口足够大时）', () => {
    for (let windowWidth = 640; windowWidth <= 1400; windowWidth += 20) {
      for (const stored of [SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH]) {
        const sidebar = effectiveSidebarWidth(stored, windowWidth);
        expect(windowWidth - sidebar).toBeGreaterThanOrEqual(WIDE_CHAT_MIN_WIDTH);
      }
    }
  });

  test('右栏放不下就不并排（聊天区与右栏都要达到最小宽）', () => {
    const need = WIDE_CHAT_MIN_WIDTH + WIDE_RIGHT_PANEL_MIN_WIDTH;
    expect(rightPanelFits(SIDEBAR_DEFAULT_WIDTH + need, SIDEBAR_DEFAULT_WIDTH)).toBe(true);
    expect(rightPanelFits(SIDEBAR_DEFAULT_WIDTH + need - 1, SIDEBAR_DEFAULT_WIDTH)).toBe(false);
    // 默认侧栏下，旧的最小窗口宽 960 放得下，680~900 放不下（走覆盖层）。
    expect(rightPanelFits(960, SIDEBAR_DEFAULT_WIDTH)).toBe(true);
    expect(rightPanelFits(700, effectiveSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 700))).toBe(false);
    expect(rightPanelFits(Number.NaN, 280)).toBe(true);
  });
});
