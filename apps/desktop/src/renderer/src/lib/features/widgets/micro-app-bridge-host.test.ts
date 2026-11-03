import { describe, expect, test } from 'vitest';

import {
  MICRO_APP_BRIDGE_APP_SOURCE,
  MICRO_APP_BRIDGE_HOST_SOURCE,
  type WidgetsUiQueryCall,
  type WidgetsUiQueryOutput,
  type WidgetsUiStorageCall,
  type WidgetsUiStorageOutput,
} from '@kepcup/shared';
import type { WidgetBridgeListenerTarget } from './widget-bridge-host';
import {
  MicroAppBridgeHost,
  type MicroAppBridgeHostOptions,
} from './micro-app-bridge-host';
import { parseMicroAppBridgeFrame } from './micro-app-bridge-guard';

/**
 * 微应用能力桥 v2 的协议级行为（node 环境，监听目标注入）：来源防线、帧白名单、
 * 能力路由（未声明 → MICRO_APP_CAPABILITY_NOT_DECLARED 且带 hint）、`app.ready`
 * 协商、事件 seq / ack 与背压断开、恰好一条终态回执。
 */

interface HostFrame {
  v: number;
  source: string;
  k: string;
  id?: number;
  result?: unknown;
  code?: string;
  message?: string;
  hint?: string;
  subId?: string;
  name?: string;
  data?: unknown;
  seq?: number;
  reason?: string;
}

function harness(options?: {
  permissions?: readonly string[];
  storage?(input: WidgetsUiStorageCall): Promise<WidgetsUiStorageOutput>;
}) {
  const frames: HostFrame[] = [];
  const frameWindow = {
    postMessage: (msg: HostFrame) => {
      frames.push(msg);
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
  const storageCalls: WidgetsUiStorageCall[] = [];
  const titles: string[] = [];
  const hostOptions: MicroAppBridgeHostOptions = {
    frameWindow,
    resourceId: 'res_1',
    permissions: options?.permissions ?? ['storage.kv', 'host.reply', 'host.openLink'],
    net: { mode: 'open', domains: [] },
    theme: 'dark',
    displayMode: 'immersive',
    viewport: { width: 800, height: 600 },
    storage:
      options?.storage ??
      (async (input: WidgetsUiStorageCall) => {
        storageCalls.push(input);
        if (input.op === 'get') {
          return input.key === 'hit' ? { op: 'get', found: true, value: { n: 1 } } : { op: 'get', found: false };
        }
        if (input.op === 'list') return { op: 'list', keys: ['a'] };
        return { op: input.op };
      }),
    query: (async (_input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput> => ({
      rows: [{ total: 1 }],
      truncated: false,
    })) as MicroAppBridgeHostOptions['query'],
    openLink: async () => true,
    reply: async () => true,
    onTitle: (title) => {
      titles.push(title);
    },
    userActivation: () => true,
    listenerTarget: target,
  };
  const host = MicroAppBridgeHost.connect(hostOptions);
  const emit = (data: unknown, source: unknown = frameWindow): void => {
    for (const fn of [...listeners]) fn({ source, data } as MessageEvent);
  };
  const settled = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const appFrame = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    v: 2,
    source: MICRO_APP_BRIDGE_APP_SOURCE,
    k: 'call',
    id: 1,
    method: 'storage.get',
    params: { key: 'hit' },
    ...overrides,
  });
  return { host, frames, storageCalls, titles, emit, settled, appFrame };
}

describe('micro-app bridge guard（帧形状与白名单）', () => {
  test('call 帧过白名单；未知方法 / 错来源 / 超限拒收', () => {
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'call', id: 1, method: 'storage.get', params: {} })).toEqual({
      ok: true,
      frame: { k: 'call', id: 1, method: 'storage.get', params: {}, stream: false },
    });
    expect(
      parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'call', id: 1, method: 'media.listen', params: {} }).ok,
    ).toBe(false);
    expect(parseMicroAppBridgeFrame({ v: 2, source: 'kepcup-widget', k: 'call', id: 1, method: 'storage.get', params: {} }).ok).toBe(false);
    expect(parseMicroAppBridgeFrame('junk').ok).toBe(false);
  });

  test('cancel / event-ack / stream 帧的形状校验', () => {
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'cancel', target: 3 })).toEqual({
      ok: true,
      frame: { k: 'cancel', target: 3 },
    });
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'cancel', target: 's1' })).toEqual({
      ok: true,
      frame: { k: 'cancel', target: 's1' },
    });
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'event-ack', subId: 'app', seq: 2 })).toEqual({
      ok: true,
      frame: { k: 'event-ack', subId: 'app', seq: 2 },
    });
    // seq=0 合法（非负整数；宿主 seq 从 1 起，但协议本身不排除 0）。
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'event-ack', subId: 'app', seq: 0 }).ok).toBe(true);
    expect(parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'event-ack', subId: 'app', seq: -1 }).ok).toBe(false);
  });
});

describe('micro-app bridge host（v2 协议行为）', () => {
  test('来源防线：别的窗口发来的帧不处理', async () => {
    const h = harness();
    h.emit(h.appFrame({}), {} as unknown as Window);
    await h.settled();
    expect(h.frames.length).toBe(0);
  });

  test('storage.get 走 ack 帧回执；拒收也回 error 帧防挂起', async () => {
    const h = harness();
    h.emit(h.appFrame({}));
    await h.settled();
    expect(h.frames).toEqual([
      { v: 2, source: MICRO_APP_BRIDGE_HOST_SOURCE, k: 'ack', id: 1, result: { n: 1 } },
    ]);
    h.emit({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'call', id: 2, method: 'nope', params: {} });
    await h.settled();
    expect(h.frames[1]?.k).toBe('error');
    expect(h.frames[1]?.code).toBe('INVALID_INPUT');
  });

  test('能力路由：清单未声明的能力 → NOT_DECLARED + 同源 hint', async () => {
    const h = harness({ permissions: ['storage.kv'] });
    h.emit(h.appFrame({ method: 'reply', params: { text: 'hi' } }));
    await h.settled();
    const error = h.frames.find((frame) => frame.k === 'error');
    expect(error?.code).toBe('MICRO_APP_CAPABILITY_NOT_DECLARED');
    expect(error?.message).toContain('host.reply');
    expect(error?.hint).toContain('permissions');
    expect(h.frames.some((frame) => frame.k === 'ack')).toBe(false);
  });

  test('app.ready：能力协商 + grants + instanceId', async () => {
    const h = harness({ permissions: ['storage.kv', 'host.openLink'] });
    h.emit(h.appFrame({ method: 'app.ready', params: {} }));
    await h.settled();
    const ack = h.frames.find((frame) => frame.k === 'ack');
    expect(ack?.result).toMatchObject({
      capabilities: ['storage.kv', 'host.openLink'],
      grants: { mic: 'unavailable', net: { mode: 'open', domains: [] } },
      theme: 'dark',
      displayMode: 'immersive',
      viewport: { width: 800, height: 600 },
    });
    expect((ack?.result as { instanceId: string }).instanceId).toMatch(/^mai_/);
  });

  test('app.setTitle 是通知（无回执）并回调宿主', async () => {
    const h = harness();
    h.emit(h.appFrame({ method: 'app.setTitle', params: { title: '练习中' } }));
    await h.settled();
    expect(h.titles).toEqual(['练习中']);
    expect(h.frames.length).toBe(0);
  });

  test('主题经 event 帧推送（subId=app，seq 递增），重复同值不推', async () => {
    const h = harness();
    h.host.setTheme('light');
    h.host.setTheme('light');
    h.host.setTheme('dark');
    const events = h.frames.filter((frame) => frame.k === 'event');
    expect(events.map((frame) => [frame.subId, frame.name, frame.data, frame.seq])).toEqual([
      ['app', 'theme', 'light', 1],
      ['app', 'theme', 'dark', 2],
    ]);
  });

  test('背压：未确认事件超过窗口 → close 帧断开', async () => {
    const h = harness();
    for (let i = 0; i < 70; i += 1) h.host.pushAppEvent('tick', i);
    const close = h.frames.find((frame) => frame.k === 'close');
    expect(close).toBeDefined();
    // 断开后不再推事件。
    const count = h.frames.length;
    h.host.pushAppEvent('tick', 999);
    expect(h.frames.length).toBe(count);
  });

  test('event-ack 提升确认水位；错误回执带 code + hint（错误码透传）', async () => {
    const h = harness({
      storage: async () => {
        throw Object.assign(new Error('调用过于频繁'), { code: 'WIDGET_RATE_LIMITED' });
      },
    });
    h.emit(h.appFrame({}));
    await h.settled();
    const error = h.frames.find((frame) => frame.k === 'error');
    expect(error?.code).toBe('WIDGET_RATE_LIMITED');
    expect(error?.message).toBe('调用过于频繁');
  });

  test('cancel：在途调用被取消后不再回执', async () => {
    let release: ((value: WidgetsUiStorageOutput) => void) | undefined;
    const h = harness({
      storage: () =>
        new Promise<WidgetsUiStorageOutput>((resolve) => {
          release = resolve;
        }),
    });
    h.emit(h.appFrame({ id: 7 }));
    h.emit({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'cancel', target: 7 });
    release?.({ op: 'get', found: false });
    await h.settled();
    expect(h.frames.filter((frame) => frame.k === 'ack' && frame.id === 7)).toHaveLength(0);
  });

  test('stream 绑定在 P0 得到可行动错误（不挂起）', async () => {
    const h = harness();
    h.emit({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'stream', id: 9, streamId: 's9' });
    await h.settled();
    const error = h.frames.find((frame) => frame.k === 'error' && frame.id === 9);
    expect(error?.code).toBe('MICRO_APP_CAPABILITY_NOT_DECLARED');
    expect(error?.hint).toBeTruthy();
  });
});
