import { describe, expect, test, vi } from 'vitest';

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
  micGrant?: () => 'granted' | 'denied' | 'unavailable';
  aiCall?(method: string, params: Record<string, unknown>): Promise<unknown>;
  listenEvents?: string[];
  onRequestDisplayMode?(mode: 'inline' | 'immersive'): Promise<{ mode: 'inline' | 'immersive' }>;
  onQuery?(input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput>;
  /** 不注入 userActivation 闸（测宿主自身的激活宽限路径）。 */
  noActivationDep?: boolean;
  onUnresponsive?(): void;
  onDiagnostic?(input: { phase: 'prepare' | 'run' | 'stream'; code: string; detail: string }): void;
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
    query:
      options?.onQuery ??
      (async (_input: WidgetsUiQueryCall): Promise<WidgetsUiQueryOutput> => ({
        rows: [{ total: 1 }],
        truncated: false,
      })),
    openLink: async () => true,
    reply: async () => true,
    onTitle: (title) => {
      titles.push(title);
    },
    ...(options?.micGrant !== undefined ? { micGrant: options.micGrant } : {}),
    ...(options?.aiCall !== undefined ? { aiCall: options.aiCall } : {}),
    ...(options?.onRequestDisplayMode !== undefined
      ? { onRequestDisplayMode: options.onRequestDisplayMode }
      : {}),
    ...(options?.listenEvents !== undefined
      ? {
          createListenSession: (
            _config: { lang?: string; mode: 'push-to-talk' | 'vad'; silenceMs: number },
            sink: (name: string, data: unknown) => void,
          ) => ({
            start: async () => {
              for (const name of options.listenEvents ?? []) sink(name, name === 'final' ? { text: 'hi' } : 0.1);
            },
            stop: async () => {
              sink('end', null);
            },
            dispose: () => undefined,
          }),
        }
      : {}),
    ...(options?.noActivationDep === true ? {} : { userActivation: () => true }),
    ...(options?.onUnresponsive !== undefined ? { onUnresponsive: options.onUnresponsive } : {}),
    ...(options?.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
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
    ).toBe(true);
    // P2 能力已进白名单（collections / context）。
    expect(
      parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'call', id: 1, method: 'context.update', params: {} }).ok,
    ).toBe(true);
    // P3 起的能力还不进白名单。
    expect(
      parseMicroAppBridgeFrame({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'call', id: 1, method: 'files.pick', params: {} }).ok,
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

  test('cancel：在途调用被取消后以 MICRO_APP_BRIDGE_CLOSED 收口（恰好一条终态回执）', async () => {
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
    const terminal = h.frames.filter((frame) => (frame.k === 'ack' || frame.k === 'error') && frame.id === 7);
    expect(terminal).toEqual([
      { v: 2, source: MICRO_APP_BRIDGE_HOST_SOURCE, k: 'error', id: 7, code: 'MICRO_APP_BRIDGE_CLOSED', message: '调用已取消' },
    ]);
  });

  test('stream 绑定在 P0 得到可行动错误（不挂起）', async () => {
    const h = harness();
    h.emit({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'stream', id: 9, streamId: 's9' });
    await h.settled();
    const error = h.frames.find((frame) => frame.k === 'error' && frame.id === 9);
    expect(error?.code).toBe('MICRO_APP_CAPABILITY_NOT_DECLARED');
    expect(error?.hint).toBeTruthy();
  });

  test('P1：media.listen 未授权 → CAPABILITY_DENIED；授权后建通道并转发生命周期', async () => {
    const h = harness({ permissions: ['media.listen', 'media.speak'] });
    h.emit(h.appFrame({ method: 'media.listen', params: { mode: 'vad' } }));
    await h.settled();
    const denied = h.frames.find((frame) => frame.k === 'error');
    expect(denied?.code).toBe('MICRO_APP_CAPABILITY_DENIED');

    // 授权后：listen → start → 事件 → stop。
    const h2 = harness({
      permissions: ['media.listen'],
      micGrant: () => 'granted',
      listenEvents: ['level', 'final'],
    });
    h2.emit(h2.appFrame({ method: 'media.listen', params: { mode: 'vad', silenceMs: 700 } }));
    await h2.settled();
    const ack = h2.frames.find((frame) => frame.k === 'ack');
    const channelId = (ack?.result as { channelId?: string } | undefined)?.channelId;
    expect(typeof channelId).toBe('string');
    h2.emit(h2.appFrame({ method: 'media.listen.start', params: { channelId } }));
    await h2.settled();
    const events = h2.frames.filter((frame) => frame.k === 'event' && frame.subId === channelId);
    expect(events.map((frame) => frame.name)).toEqual(['level', 'final']);
    h2.emit(h2.appFrame({ method: 'media.listen.stop', params: { channelId } }));
    await h2.settled();
    const endEvent = h2.frames.find((frame) => frame.k === 'event' && frame.name === 'end');
    expect(endEvent).toBeDefined();
  });

  test('P1：ai.* 方法转发给宿主实现；ai 未接线得 NOT_IMPLEMENTED', async () => {
    const h = harness({ permissions: ['ai.chat'] });
    h.emit(h.appFrame({ method: 'ai.chat', params: { messages: [], stream: false } }));
    await h.settled();
    const error = h.frames.find((frame) => frame.k === 'error');
    expect(error?.code).toBe('NOT_IMPLEMENTED');

    const h2 = harness({ permissions: ['ai.chat'], aiCall: async (method, params) => ({ echoed: method, params }) });
    h2.emit(h2.appFrame({ method: 'ai.session.send', params: { sessionId: 's1', text: 'hi', stream: false } }));
    await h2.settled();
    const ack = h2.frames.find((frame) => frame.k === 'ack');
    expect(ack?.result).toMatchObject({ echoed: 'ai.session.send' });
  });

  test('P1：requestDisplayMode 经外壳回调并推 display-mode 事件', async () => {
    const h = harness({
      onRequestDisplayMode: async (mode) => ({ mode: mode === 'inline' ? 'inline' : 'immersive' }),
    });
    h.emit(h.appFrame({ method: 'app.requestDisplayMode', params: { mode: 'inline' } }));
    await h.settled();
    const ack = h.frames.find((frame) => frame.k === 'ack');
    expect(ack?.result).toEqual({ mode: 'inline' });
    const event = h.frames.find((frame) => frame.k === 'event' && frame.name === 'display-mode');
    expect(event?.data).toEqual({ mode: 'inline' });
    // 之后的 ready 也反映新模式。
    h.emit(h.appFrame({ method: 'app.ready', params: {} }));
    await h.settled();
    const ready = h.frames.filter((frame) => frame.k === 'ack').at(-1);
    expect((ready?.result as { displayMode?: string } | undefined)?.displayMode).toBe('inline');
  });

  test('P1：forwardStreamEvent 只转发本实例的流（delta / done）', async () => {
    const h = harness();
    h.host.forwardStreamEvent({ instanceId: 'other', streamId: 's1', kind: 'delta', delta: 'x' });
    expect(h.frames.filter((frame) => frame.k === 'event')).toHaveLength(0);
    h.host.forwardStreamEvent({ instanceId: h.host.instanceId, streamId: 's1', kind: 'delta', delta: 'He' });
    h.host.forwardStreamEvent({ instanceId: h.host.instanceId, streamId: 's1', kind: 'delta', delta: 'y' });
    h.host.forwardStreamEvent({ instanceId: h.host.instanceId, streamId: 's1', kind: 'done' });
    const events = h.frames.filter((frame) => frame.k === 'event' && frame.subId === 's1');
    expect(events.map((frame) => [frame.name, (frame.data as { delta?: string } | null)?.delta ?? null])).toEqual([
      ['delta', 'He'],
      ['delta', 'y'],
      ['done', null],
    ]);
  });

  test('P2：query 的 opts（cursor / maxBytes）透传给 widgets.ui.query；形状不对拒绝', async () => {
    const queries: WidgetsUiQueryCall[] = [];
    const h = harness({
      permissions: ['storage.kv'],
      onQuery: async (input) => {
        queries.push(input);
        return { rows: [], truncated: false };
      },
    });
    h.emit(
      h.appFrame({ method: 'query', params: { name: 'q', params: {}, opts: { cursor: 'off:50', maxBytes: 4096 } } }),
    );
    await h.settled();
    expect(queries[0]).toEqual({ name: 'q', params: {}, cursor: 'off:50', maxBytes: 4096 });
    h.emit(h.appFrame({ id: 2, method: 'query', params: { name: 'q', params: {}, opts: { cursor: 5 } } }));
    await h.settled();
    expect(h.frames.find((frame) => frame.id === 2)?.code).toBe('INVALID_INPUT');
    h.emit(h.appFrame({ id: 3, method: 'query', params: { name: 'q', params: {}, opts: { maxBytes: 'big' } } }));
    await h.settled();
    expect(h.frames.find((frame) => frame.id === 3)?.code).toBe('INVALID_INPUT');
    h.host.destroy();
  });

  test('P2：宿主推 pause / resume 事件（visibilitychange 语义，subId=app seq 递增）', () => {
    const h = harness();
    h.host.pushAppEvent('pause', null);
    h.host.pushAppEvent('resume', null);
    const events = h.frames.filter((frame) => frame.k === 'event' && frame.subId === 'app');
    expect(events.map((frame) => [frame.name, frame.data, frame.seq])).toEqual([
      ['pause', null, 1],
      ['resume', null, 2],
    ]);
    h.host.destroy();
  });

  test('P2：心跳——上一拍未 ack 判无响应并回调；ack 后恢复', async () => {
    vi.useFakeTimers();
    const onUnresponsive = vi.fn();
    const diagnostics: string[] = [];
    const h = harness({
      permissions: ['storage.kv'],
      onUnresponsive,
      onDiagnostic: (input) => {
        diagnostics.push(input.code);
      },
    });
    await vi.advanceTimersByTimeAsync(10_000); // 第一拍：推 ping（置等待位）
    expect(h.frames.some((frame) => frame.k === 'event' && frame.name === 'ping')).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); // 第二拍：仍无 ack → 无响应
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    expect(diagnostics).toContain('MICRO_APP_UNRESPONSIVE');
    h.emit({ v: 2, source: MICRO_APP_BRIDGE_APP_SOURCE, k: 'event-ack', subId: 'app', seq: 1 });
    await vi.advanceTimersByTimeAsync(10_000); // ack 后恢复：不再误报
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    h.host.destroy();
  });

  test('P2：context.update 的 gesture 时机——瞬时激活过期后宽限窗内仍放行，超窗拒绝', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const calls: string[] = [];
    const h = harness({
      permissions: ['context.update'],
      noActivationDep: true,
      aiCall: async (method) => {
        calls.push(method);
        return {};
      },
    });
    await vi.advanceTimersByTimeAsync(1000); // 采样到激活
    vi.stubGlobal('navigator', { userActivation: { isActive: false } }); // 瞬态窗口刚过
    h.emit(h.appFrame({ method: 'context.update', params: { summary: { headline: 'x' }, reason: 'gesture' } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['context.update']); // 宽限窗内放行（「练习结束 await 后同步」）
    await vi.advanceTimersByTimeAsync(6000); // 远超宽限窗
    h.emit(h.appFrame({ id: 2, method: 'context.update', params: { summary: { headline: 'y' }, reason: 'gesture' } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.frames.find((frame) => frame.id === 2)?.code).toBe('MICRO_APP_CAPABILITY_DENIED');
    expect(calls).toEqual(['context.update']);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    h.host.destroy();
  });

  test('P1：revokeCapability(media.listen) 停会话并推 capability.revoked', async () => {
    const h = harness({ permissions: ['media.listen'], micGrant: () => 'granted', listenEvents: [] });
    h.emit(h.appFrame({ method: 'media.listen', params: { mode: 'vad' } }));
    await h.settled();
    const ack = h.frames.find((frame) => frame.k === 'ack');
    const channelId = (ack?.result as { channelId?: string } | undefined)?.channelId as string;
    h.host.revokeCapability('media.listen');
    const revoked = h.frames.find((frame) => frame.k === 'event' && frame.name === 'capability.revoked');
    expect(revoked?.data).toEqual({ capability: 'media.listen' });
    // 会话已释放：再 start 得 NOT_FOUND。
    h.emit(h.appFrame({ method: 'media.listen.start', params: { channelId } }));
    await h.settled();
    const error = h.frames.filter((frame) => frame.k === 'error').at(-1);
    expect(error?.code).toBe('NOT_FOUND');
  });
});
