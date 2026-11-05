import { describe, expect, test, vi } from 'vitest';
import type { WidgetCard } from '@kepcup/shared';
import {
  buildWidgetWindowTarget,
  parseOpenWidgetInput,
  WidgetWindowHost,
  WIDGET_WINDOW_PAYLOAD_CHANNEL,
  type WidgetWindowHostOptions,
  type WidgetWindowLike,
} from './widget-window';

const card: WidgetCard = {
  widgetId: 'w-1',
  version: 3,
  title: '晨间简报',
  description: '',
  scope: 'bot',
  sha256: 'a'.repeat(64),
  queriesSha256: '',
  queriesCount: 0,
  sizeBytes: 1024,
  botId: null,
  createdAt: 1_700_000_000_000,
  checkStatus: 'legacy',
  knownIssues: [],
};

interface FakeWindowExtras {
  sends: Array<{ channel: string; payload: unknown }>;
  destroyed: boolean;
  minimized: boolean;
  focused: number;
  restored: number;
  closed: number;
  close(): void;
  setMinimized(value: boolean): void;
}

/** 注册表测试桩：记录 createWindow 入参，可手动 close 触发 closed 回调。 */
function fakeWindow(): WidgetWindowLike & FakeWindowExtras {
  const state = {
    sends: [] as Array<{ channel: string; payload: unknown }>,
    destroyed: false,
    minimized: false,
    focused: 0,
    restored: 0,
    closed: 0,
    listener: undefined as (() => void) | undefined,
  };
  return {
    id: Math.floor(Math.random() * 1_000_000),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    restore: () => {
      state.restored += 1;
    },
    focus: () => {
      state.focused += 1;
    },
    on: (_channel: 'closed', listener: () => void) => {
      state.listener = listener;
      return {};
    },
    webContents: {
      send: (channel: string, payload: unknown) => {
        state.sends.push({ channel, payload });
      },
    },
    close: () => {
      state.closed += 1;
      state.destroyed = true;
      state.listener?.();
    },
    setMinimized: (value: boolean) => {
      state.minimized = value;
    },
    get sends() {
      return state.sends;
    },
    get destroyed() {
      return state.destroyed;
    },
    get minimized() {
      return state.minimized;
    },
    get focused() {
      return state.focused;
    },
    get restored() {
      return state.restored;
    },
    get closed() {
      return state.closed;
    },
  } as WidgetWindowLike & FakeWindowExtras;
}

function hostWith(
  createWindow: WidgetWindowHostOptions['createWindow'],
  overrides: Partial<WidgetWindowHostOptions> = {},
): WidgetWindowHost {
  return new WidgetWindowHost({
    isPackaged: false,
    devRendererUrl: 'http://localhost:5173',
    rendererIndexPath: '/app/index.html',
    preloadPath: '/app/preload.cjs',
    createWindow,
    ...overrides,
  });
}

describe('buildWidgetWindowTarget', () => {
  test('dev：dev server URL 带 kcWindow=widget 查询参数', () => {
    const target = buildWidgetWindowTarget({
      isPackaged: false,
      devRendererUrl: 'http://localhost:5173',
      rendererIndexPath: '/app/index.html',
    });
    expect(target).toEqual({ kind: 'url', url: 'http://localhost:5173/?kcWindow=widget' });
  });

  test('prod：loadFile index.html + query', () => {
    const target = buildWidgetWindowTarget({
      isPackaged: true,
      devRendererUrl: 'http://localhost:5173',
      rendererIndexPath: '/app/index.html',
    });
    expect(target).toEqual({
      kind: 'file',
      path: '/app/index.html',
      query: { kcWindow: 'widget' },
    });
  });

  test('dev 但未配 dev server：退回 loadFile（与主窗口 appUrl 判定一致）', () => {
    const target = buildWidgetWindowTarget({
      isPackaged: false,
      rendererIndexPath: '/app/index.html',
    });
    expect(target).toEqual({
      kind: 'file',
      path: '/app/index.html',
      query: { kcWindow: 'widget' },
    });
  });
});

describe('parseOpenWidgetInput', () => {
  test('合法 { messageId, card } 通过并回传解析后的卡', () => {
    const parsed = parseOpenWidgetInput({ messageId: 'm-1', card });
    expect(parsed).not.toBeNull();
    expect(parsed?.card.title).toBe('晨间简报');
  });

  test('卡片缺字段 / messageId 非法一律拒绝', () => {
    expect(parseOpenWidgetInput(null)).toBeNull();
    expect(parseOpenWidgetInput('x')).toBeNull();
    expect(parseOpenWidgetInput({ messageId: '', card })).toBeNull();
    expect(parseOpenWidgetInput({ messageId: 'm-1', card: { widgetId: 'w-1' } })).toBeNull();
    expect(parseOpenWidgetInput({ card })).toBeNull();
  });
});

describe('WidgetWindowHost', () => {
  test('open 新窗口：尺寸/标题/目标交给装配器，did-finish-load 推 payload', () => {
    const windows: Array<WidgetWindowLike & FakeWindowExtras> = [];
    const targets: Array<WidgetWindowHostOptions> = [];
    const host = hostWith((input) => {
      targets.push(input as unknown as WidgetWindowHostOptions);
      const win = fakeWindow();
      windows.push(win);
      input.onDidLoad(win);
      return win;
    });
    const first = host.open({ messageId: 'm-1', card });
    expect(first).toEqual({ opened: true });
    expect(targets[0]).toMatchObject({
      title: card.title,
      width: 960,
      minWidth: 420,
      preloadPath: '/app/preload.cjs',
      target: { kind: 'url', url: 'http://localhost:5173/?kcWindow=widget' },
    });
    expect(windows[0]!.sends).toEqual([
      { channel: WIDGET_WINDOW_PAYLOAD_CHANNEL, payload: { messageId: 'm-1', card } },
    ]);
    // 同 messageId 再开：focus 不重开，不重复推 payload。
    const second = host.open({ messageId: 'm-1', card });
    expect(second).toEqual({ opened: false });
    expect(windows[0]!.focused).toBe(1);
    expect(windows[0]!.sends.length).toBe(1);
    // 不同 messageId：另开一窗。
    expect(host.open({ messageId: 'm-2', card }).opened).toBe(true);
    expect(windows.length).toBe(2);
  });

  test('最小化中的既有窗口先 restore 再 focus', () => {
    const win = fakeWindow();
    win.setMinimized(true);
    const host = hostWith((input) => {
      input.onDidLoad(win);
      return win;
    });
    host.open({ messageId: 'm-1', card });
    expect(host.open({ messageId: 'm-1', card })).toEqual({ opened: false });
    expect(win.restored).toBe(1);
    expect(win.focused).toBe(1);
  });

  test('closed 出清注册表；eachWindow 跳过已销毁窗口', () => {
    const win = fakeWindow();
    const visits: Array<number> = [];
    const host = hostWith((input) => {
      input.onDidLoad(win);
      return win;
    });
    host.open({ messageId: 'm-1', card });
    host.eachWindow((w) => visits.push(w.id));
    expect(visits.length).toBe(1);
    // 窗口关闭 → closed 回调 → 出清。
    win.close();
    host.eachWindow((w) => visits.push(w.id));
    expect(visits.length).toBe(1);
  });

  test('closeAll 关闭全部窗口', () => {
    const windows: Array<WidgetWindowLike & FakeWindowExtras> = [];
    const host = hostWith((input) => {
      const win = fakeWindow();
      windows.push(win);
      input.onDidLoad(win);
      return win;
    });
    host.open({ messageId: 'm-1', card });
    host.open({ messageId: 'm-2', card });
    host.closeAll();
    expect(windows.map((w) => w.closed)).toEqual([1, 1]);
  });

  test('did-finish-load 先走宿主钩子（端口 A 握手）再推载荷', () => {
    const hooked: Array<number> = [];
    let win: (WidgetWindowLike & FakeWindowExtras) | null = null;
    const host = hostWith(
      (input) => {
        win = fakeWindow();
        input.onDidLoad(win);
        return win;
      },
      { onWindowDidLoad: (loaded) => hooked.push(loaded.id) },
    );
    expect(host.open({ messageId: 'm-1', card })).toEqual({ opened: true });
    expect(hooked).toEqual([win!.id]);
    // 载荷照推：钩子（index.ts 的 sendAppPort）与载荷是 did-finish-load 的两件事。
    expect(win!.sends).toEqual([
      { channel: WIDGET_WINDOW_PAYLOAD_CHANNEL, payload: { messageId: 'm-1', card } },
    ]);
  });

  test('入参不合法：不开窗、记 warn', () => {
    const log = vi.fn();
    let created = 0;
    const host = hostWith(
      () => {
        created += 1;
        return fakeWindow();
      },
      { log },
    );
    expect(host.open({ messageId: 'm-1', card: { junk: true } })).toEqual({ opened: false });
    expect(created).toBe(0);
    expect(log).toHaveBeenCalled();
  });
});
