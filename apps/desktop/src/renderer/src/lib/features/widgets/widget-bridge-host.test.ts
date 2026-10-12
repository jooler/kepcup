import { describe, expect, test, vi } from 'vitest';

import type {
  WidgetsUiQueryCall,
  WidgetsUiQueryOutput,
  WidgetsUiStorageCall,
  WidgetsUiStorageOutput,
} from '@kepcup/shared';
import { WidgetBridgeHost, type WidgetBridgeListenerTarget } from './widget-bridge-host';

/**
 * 能力桥宿主的协议级行为（node 环境，无 DOM——监听目标可注入）：来源防线、
 * 「每个带 id 的请求恰好回执一次」（含格式拒收与错误码透传）、setHeight 节流。
 * guard 的形状 / 白名单细节在 widget-bridge-guard.test.ts。
 */

interface Reply {
  source: string;
  id: number;
  ok: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

function harness(options?: {
  storage?(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput>;
  query?(input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput>;
}) {
  const replies: Reply[] = [];
  const frameWindow = {
    postMessage: (msg: Reply) => {
      replies.push(msg);
    },
  } as unknown as Window;
  const listeners: Array<(event: MessageEvent) => void> = [];
  const target: WidgetBridgeListenerTarget = {
    addEventListener: (_type, fn) => {
      listeners.push(fn);
    },
    removeEventListener: (_type, fn) => {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  const heights: number[] = [];
  const storageCalls: WidgetsUiStorageCall[] = [];
  const queryCalls: WidgetsUiQueryCall[] = [];
  const openLinkCalls: string[] = [];
  const host = WidgetBridgeHost.connect({
    frameWindow,
    resourceId: 'res_1',
    theme: 'dark',
    storage: options?.storage ?? (async (input: WidgetsUiStorageCall) => {
      storageCalls.push(input);
      if (input.op === 'get') {
        return input.key === 'hit'
          ? { op: 'get', found: true, value: { n: 1 } }
          : { op: 'get', found: false };
      }
      if (input.op === 'list') return { op: 'list', keys: ['a', 'b'] };
      return { op: input.op };
    }),
    query:
      options?.query ??
      (async (input: WidgetsUiQueryCall) => {
        queryCalls.push(input);
        return { rows: [{ total: input.params['month'] === '2026-02' ? 5 : 0 }], truncated: false };
      }),
    openLink: async (url) => {
      openLinkCalls.push(url);
      return url === 'https://good.example/';
    },
    onHeight: (value) => {
      heights.push(value);
    },
    listenerTarget: target,
  });
  const emit = (data: unknown, source: unknown = frameWindow): void => {
    for (const fn of [...listeners]) fn({ source, data } as MessageEvent);
  };
  const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { host, replies, heights, storageCalls, queryCalls, openLinkCalls, emit, settled };
}

const widgetMessage = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  source: 'kepcup-widget',
  id: 1,
  type: 'storage.get',
  payload: { key: 'hit' },
  ...overrides,
});

describe('WidgetBridgeHost', () => {
  test('messages from any other window are dropped without replies', async () => {
    const h = harness();
    h.emit(widgetMessage({}), {}); // 子 iframe / 其他卡片
    await h.settled();
    expect(h.replies).toHaveLength(0);
    expect(h.storageCalls).toHaveLength(0);
    h.host.destroy();
  });

  test('storage.get replies the value; a miss replies undefined; set/list/delete pass through', async () => {
    const h = harness();
    h.emit(widgetMessage({ id: 1, payload: { key: 'hit' } }));
    h.emit(widgetMessage({ id: 2, payload: { key: 'miss' } }));
    h.emit(widgetMessage({ id: 3, type: 'storage.set', payload: { key: 'k', value: 5 } }));
    h.emit(widgetMessage({ id: 4, type: 'storage.list', payload: {} }));
    h.emit(widgetMessage({ id: 5, type: 'storage.delete', payload: { key: 'k' } }));
    await h.settled();
    expect(h.replies.map((r) => [r.id, r.ok, r.value])).toEqual([
      [1, true, { n: 1 }],
      [2, true, undefined],
      [3, true, undefined],
      [4, true, ['a', 'b']],
      [5, true, undefined],
    ]);
    expect(h.storageCalls).toEqual([
      { op: 'get', key: 'hit' },
      { op: 'get', key: 'miss' },
      { op: 'set', key: 'k', value: 5 },
      { op: 'list' },
      { op: 'delete', key: 'k' },
    ]);
    h.host.destroy();
  });

  test('core errors carry the human message and the machine-readable code', async () => {
    const h = harness({
      storage: async () => {
        throw Object.assign(new Error('组件调用宿主能力过于频繁，请稍后再试'), {
          code: 'WIDGET_RATE_LIMITED',
        });
      },
    });
    h.emit(widgetMessage({ payload: { key: 'hit' } }));
    await h.settled();
    expect(h.replies).toEqual([
      { source: 'kepcup-host', id: 1, ok: false, error: '组件调用宿主能力过于频繁，请稍后再试', code: 'WIDGET_RATE_LIMITED' },
    ]);
    h.host.destroy();
  });

  test('guard-rejected but id-parseable messages still get one error reply (no hanging promises)', async () => {
    const h = harness();
    // BigInt 值能过 structured clone，但 guard 的 JSON.stringify 抛错 → 形状拒收。
    h.emit(widgetMessage({ type: 'storage.set', payload: { key: 'k', value: 10n } }));
    // 白名单外的方法。
    h.emit(widgetMessage({ id: 2, type: 'fs.read', payload: {} }));
    await h.settled();
    expect(h.replies).toEqual([
      { source: 'kepcup-host', id: 1, ok: false, error: '不支持的消息格式', code: 'INVALID_INPUT' },
      { source: 'kepcup-host', id: 2, ok: false, error: '不支持的消息格式', code: 'INVALID_INPUT' },
    ]);
    expect(h.storageCalls).toHaveLength(0);
    h.host.destroy();
  });

  test('openLink: https reaches the confirm callback; others are refused before it', async () => {
    const h = harness();
    h.emit(widgetMessage({ id: 1, type: 'openLink', payload: { url: 'http://example.com/' } }));
    h.emit(widgetMessage({ id: 2, type: 'openLink', payload: { url: 'https://good.example/' } }));
    await h.settled();
    expect(h.openLinkCalls).toEqual(['https://good.example/']);
    expect(h.replies.map((r) => [r.id, r.ok, r.value, r.code])).toEqual([
      [1, false, undefined, 'INVALID_INPUT'],
      [2, true, true, undefined],
    ]);
    h.host.destroy();
  });

  test('an over-long key is refused with an actionable message before reaching core', async () => {
    const h = harness();
    h.emit(widgetMessage({ payload: { key: 'k'.repeat(201) } }));
    await h.settled();
    expect(h.replies[0]).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(String(h.replies[0]?.error)).toContain('key 过长');
    expect(h.storageCalls).toHaveLength(0);
    h.host.destroy();
  });

  test('theme.get answers the connect-time theme', async () => {
    const h = harness();
    h.emit(widgetMessage({ id: 7, type: 'theme.get', payload: {} }));
    await h.settled();
    expect(h.replies).toEqual([{ source: 'kepcup-host', id: 7, ok: true, value: 'dark' }]);
    h.host.destroy();
  });

  test('query: name+params reach core; params defaults to {}; result value is replied', async () => {
    const h = harness();
    h.emit(widgetMessage({ id: 1, type: 'query', payload: { name: 'by_month', params: { month: '2026-02' } } }));
    h.emit(widgetMessage({ id: 2, type: 'query', payload: { name: 'all' } }));
    await h.settled();
    expect(h.queryCalls).toEqual([
      { name: 'by_month', params: { month: '2026-02' } },
      { name: 'all', params: {} },
    ]);
    expect(h.replies.map((r) => [r.id, r.ok, r.value])).toEqual([
      [1, true, { rows: [{ total: 5 }], truncated: false }],
      [2, true, { rows: [{ total: 0 }], truncated: false }],
    ]);
    h.host.destroy();
  });

  test('query: malformed name / params are refused before reaching core', async () => {
    const h = harness();
    h.emit(widgetMessage({ id: 1, type: 'query', payload: { name: '', params: {} } }));
    h.emit(widgetMessage({ id: 2, type: 'query', payload: { params: {} } }));
    h.emit(widgetMessage({ id: 3, type: 'query', payload: { name: 'q'.repeat(65), params: {} } }));
    h.emit(widgetMessage({ id: 4, type: 'query', payload: { name: 'q', params: [1, 2] } }));
    await h.settled();
    expect(h.queryCalls).toHaveLength(0);
    expect(h.replies.map((r) => [r.id, r.ok, r.code])).toEqual([
      [1, false, 'INVALID_INPUT'],
      [2, false, 'INVALID_INPUT'],
      [3, false, 'INVALID_INPUT'],
      [4, false, 'INVALID_INPUT'],
    ]);
    expect(String(h.replies[2]?.error)).toContain('查询名过长');
    h.host.destroy();
  });

  test('query: core errors carry the human message and the machine-readable code', async () => {
    const h = harness({
      query: async () => {
        throw Object.assign(new Error('查询「all」没有在这个组件版本里登记'), {
          code: 'WIDGET_QUERY_UNKNOWN',
        });
      },
    });
    h.emit(widgetMessage({ id: 1, type: 'query', payload: { name: 'all', params: {} } }));
    await h.settled();
    expect(h.replies).toEqual([
      {
        source: 'kepcup-host',
        id: 1,
        ok: false,
        error: '查询「all」没有在这个组件版本里登记',
        code: 'WIDGET_QUERY_UNKNOWN',
      },
    ]);
    h.host.destroy();
  });

  test('setHeight is clamped and throttled, and never replies', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.emit(widgetMessage({ id: 0, type: 'setHeight', payload: { height: 50 } }));
      expect(h.heights).toEqual([100]);
      // 100ms 内的连发折叠为一次尾随上报（同 MCP Apps 的 size-changed 节流）。
      h.emit(widgetMessage({ id: 0, type: 'setHeight', payload: { height: 420 } }));
      h.emit(widgetMessage({ id: 0, type: 'setHeight', payload: { height: 600 } }));
      expect(h.heights).toEqual([100]);
      vi.advanceTimersByTime(150);
      expect(h.heights).toEqual([100, 600]);
      expect(h.replies).toHaveLength(0);
      h.host.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  test('destroy cancels a pending trailing setHeight (no stale height after the card resets it)', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.emit(widgetMessage({ id: 0, type: 'setHeight', payload: { height: 300 } }));
      // 节流窗口内的第二次上报排进尾随定时器。
      h.emit(widgetMessage({ id: 0, type: 'setHeight', payload: { height: 700 } }));
      expect(h.heights).toEqual([300]);
      // 卡片 stop()：拆桥并把高度复位；尾随定时器之后到点也不能把 700 写回去。
      h.host.destroy();
      vi.advanceTimersByTime(500);
      expect(h.heights).toEqual([300]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('destroy stops listening and replying', async () => {
    const h = harness();
    h.host.destroy();
    h.emit(widgetMessage({}));
    await h.settled();
    expect(h.replies).toHaveLength(0);
    expect(h.storageCalls).toHaveLength(0);
  });
});
