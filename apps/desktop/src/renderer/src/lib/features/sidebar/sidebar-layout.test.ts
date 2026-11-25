import { describe, expect, test } from 'vitest';
import {
  clampSidebarWidth,
  effectiveSidebarWidth,
  isSidebarCollapsed,
  maxSidebarWidthFor,
  nextPanelDrawer,
  sideBySideChatWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  settleSidebarWidth,
  PANEL_DRAWER_CHAT_ENTER_WIDTH,
  PANEL_DRAWER_CHAT_EXIT_WIDTH,
  PANEL_DRAWER_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  WIDE_CHAT_MIN_WIDTH,
  WIDE_RIGHT_PANEL_DEFAULT_SHARE,
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

describe('窗口宽度夹取（窄屏断点之上的宽屏区间 680 起）', () => {
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
});

describe('右栏形态（并排 / 覆盖抽屉，中窄窗口）', () => {
  test('并排对话可用宽 =（窗口−侧栏）×（1 − 右栏默认占比）；非法输入回退 0', () => {
    // 默认侧栏 280、窗口 1300：group 1020，右栏默认占比 41% → 对话 602。
    expect(sideBySideChatWidth(1300, 280)).toBe(602);
    expect(WIDE_RIGHT_PANEL_DEFAULT_SHARE).toBe(0.41);
    // 抽屉固定宽 ≥ 右栏内容最小可用宽。
    expect(PANEL_DRAWER_WIDTH).toBeGreaterThanOrEqual(WIDE_RIGHT_PANEL_MIN_WIDTH);
    expect(sideBySideChatWidth(Number.NaN, 280)).toBe(0);
    expect(sideBySideChatWidth(280, 280)).toBe(0);
  });

  test('未在抽屉：对话可用宽 < 530 才进入；≥ 530 保持并排', () => {
    // 默认侧栏 280：进入窗口宽 ≈ 1178（主 Bot 调研建议的 1150~1200 一档内）。
    expect(nextPanelDrawer(false, 1178, 280)).toBe(false);
    expect(nextPanelDrawer(false, 1177, 280)).toBe(true);
    // 用户实测的挤压区间 900~1100 全部抽屉。
    for (const width of [900, 1000, 1100]) expect(nextPanelDrawer(false, width, 280)).toBe(true);
    expect(nextPanelDrawer(false, 1300, 280)).toBe(false);
    // 非法宽度一律并排。
    expect(nextPanelDrawer(false, Number.NaN, 280)).toBe(false);
  });

  test('已在抽屉：对话可用宽 ≥ 570 才退出；[530, 570) 滞回缓冲不翻转', () => {
    // 滞回方向：进入线低于退出线（仿窄屏 640/680）。
    expect(PANEL_DRAWER_CHAT_ENTER_WIDTH).toBeLessThan(PANEL_DRAWER_CHAT_EXIT_WIDTH);
    // 默认侧栏 280：1245（对话 569）保持抽屉，1246（对话 570）才退出。
    expect(nextPanelDrawer(true, 1245, 280)).toBe(true);
    expect(nextPanelDrawer(true, 1246, 280)).toBe(false);
    expect(nextPanelDrawer(true, 1178, 280)).toBe(true);
  });

  test('判定轴是对话可用宽：侧栏拖宽同样触发抽屉', () => {
    // 窗口 1300 本是并排（侧栏 280 → 对话 602）；侧栏拖到 420 后对话 519 < 530。
    expect(nextPanelDrawer(false, 1300, 420)).toBe(true);
    expect(nextPanelDrawer(false, 1300, 280)).toBe(false);
  });

  test('断点附近来回抖动不翻转（逐帧序列只翻转一次）', () => {
    let drawer = false;
    const flips: number[] = [];
    // 对话可用宽轴上 530 进 / 570 出：窗口序列在 1177 / 1246 两侧来回拖拽。
    for (const width of [1250, 1200, 1177, 1200, 1220, 1246, 1200, 1245, 1246]) {
      const next = nextPanelDrawer(drawer, width, 280);
      if (next !== drawer) flips.push(width);
      drawer = next;
    }
    // 1177 进入抽屉；一路到 1246 才退出；1200~1245 的来回不再翻转。
    expect(flips).toEqual([1177, 1246]);
  });
});
