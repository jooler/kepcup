import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as authedTransport from './authed-transport';

/**
 * 账号密码传输的状态机单测（D102 修订，审查 P2：认证状态机原先零测试）：
 * 探测分类（404/200/401/5xx/网络失败）、连接状态迁移（连上/断线重连/会话失效）、
 * NAT 半开的心跳自愈（fake timers 驱动静默阈值）。node 环境无 DOM，WebSocket /
 * location / fetch 全部打桩；探测有模块级记忆化，每个用例 resetModules 取新模块。
 */

/** 浏览器 WebSocket 的最小桩：状态常量 + 事件回调 + 测试驱动方法。 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closeCode: number | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCode = code;
    this.onclose?.();
  }
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateInbound(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  /** 服务端断开（不经客户端 close()，closeCode 留空）。 */
  simulateDrop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function stubFetch(statusFor: (url: string, call: number) => number | 'throw'): void {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL): Promise<{ status: number }> => {
      calls += 1;
      const url = typeof input === 'string' ? input : String(input);
      const outcome = statusFor(url, calls);
      if (outcome === 'throw') return Promise.reject(new Error('network down'));
      return Promise.resolve({ status: outcome });
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'srv.test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.last = null;
});

/** 每个用例取新模块（probeServerAuth 的成功结果记忆化是模块级状态）。 */
function loadModule(): Promise<typeof authedTransport> {
  vi.resetModules();
  return import('./authed-transport');
}

describe('probeServerAuth', () => {
  it('404 = 配对模式；200/401 = 密码模式（authenticated 随状态）', async () => {
    for (const [status, expected] of [
      [404, { mode: 'pairing', authenticated: false }],
      [200, { mode: 'password', authenticated: true }],
      [401, { mode: 'password', authenticated: false }],
    ] as const) {
      stubFetch(() => status);
      const mod = await loadModule();
      expect(await mod.probeServerAuth()).toEqual(expected);
    }
  });

  it('5xx / 网络失败 → null 且不记忆（下次调用重新请求；不再把 502 当 password）', async () => {
    stubFetch((_url, call) => (call === 1 ? 502 : call === 2 ? 'throw' : 200));
    const mod = await loadModule();
    expect(await mod.probeServerAuth()).toBeNull();
    expect(await mod.probeServerAuth()).toBeNull();
    expect(await mod.probeServerAuth()).toEqual({ mode: 'password', authenticated: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('成功结果记忆化：同一成功只发一次请求', async () => {
    stubFetch(() => 200);
    const mod = await loadModule();
    const first = mod.probeServerAuth();
    const second = mod.probeServerAuth();
    expect(second).toBe(first);
    await first;
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('probeServerAuthUntilSettled / watchForPasswordServer', () => {
  it('不可达期间持续重试，拿到确定答案即返回', async () => {
    stubFetch((_url, call) => (call < 3 ? 'throw' : 404));
    const mod = await loadModule();
    expect(await mod.probeServerAuthUntilSettled(60_000, 1)).toEqual({
      mode: 'pairing',
      authenticated: false,
    });
  });

  it('到期限仍不可达返回 null（调用方回退 + 后台自愈）', async () => {
    stubFetch(() => 'throw');
    const mod = await loadModule();
    expect(await mod.probeServerAuthUntilSettled(30, 5)).toBeNull();
  });

  it('后台守望：确定是密码服务器 → 刷新页面进正路', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { protocol: 'https:', host: 'srv.test', reload });
    stubFetch((_url, call) => (call === 1 ? 'throw' : 200));
    const mod = await loadModule();
    mod.watchForPasswordServer(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('后台守望：确定是配对服务器 → 停表不刷新（每次新模块：探测成功有记忆化）', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { protocol: 'https:', host: 'srv.test', reload });
    stubFetch(() => 404);
    const mod = await loadModule();
    mod.watchForPasswordServer(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('AuthedWsTransport', () => {
  it('connect → open → connected；post 走 ws，onData 收 JSON', async () => {
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    try {
      const received: unknown[] = [];
      transport.onData((data) => received.push(data));
      transport.connect();
      expect(transport.linkState).toBe('connecting');
      const ws = FakeWebSocket.last!;
      expect(ws.url).toBe('wss://srv.test/rpc');
      ws.simulateOpen();
      expect(transport.linkState).toBe('connected');
      transport.post({ hello: 1 });
      expect(ws.sent).toEqual(['{"hello":1}']);
      ws.simulateInbound({ event: 'run.progress' });
      expect(received).toEqual([{ event: 'run.progress' }]);
    } finally {
      transport.close();
    }
  });

  /** onDrop 的 whoami 探测是 promise 链：fake timers 的 advance 不保证先冲刷微任务，显式排空。 */
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('断线 → whoami 200 → 网络断线退避重连；连续失败（未连上）退避翻倍', async () => {
    vi.useFakeTimers();
    stubFetch(() => 200);
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    try {
      transport.connect();
      const first = FakeWebSocket.last!;
      first.simulateOpen();
      first.simulateDrop();
      await flushMicrotasks();
      expect(transport.linkState).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1_000);
      const second = FakeWebSocket.last!;
      expect(second).not.toBe(first);
      // second 不 open 就再断（连续失败，没有 onopen 重置退避）：1s 处不换新连接，2s 处才拨。
      second.simulateDrop();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.last).toBe(second);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.last).not.toBe(second);
      // 重拨期间保持 reconnecting（只有 open 才翻 connected）——UI 横幅语义连续。
      expect(transport.linkState).toBe('reconnecting');
    } finally {
      transport.close();
    }
  });

  it('断线 + whoami 401 → unauthenticated（会话失效回登录页，停止自动重连）', async () => {
    vi.useFakeTimers();
    stubFetch(() => 401);
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    try {
      transport.connect();
      const ws = FakeWebSocket.last!;
      ws.simulateOpen();
      ws.simulateDrop();
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.linkState).toBe('unauthenticated');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(FakeWebSocket.last).toBe(ws);
      // 登录成功后 connectNow 立即拨号（跳过退避）。
      transport.connectNow();
      expect(FakeWebSocket.last).not.toBe(ws);
    } finally {
      transport.close();
    }
  });

  it('心跳自愈：静默超过阈值（90s 无入站）主动断开转重连', async () => {
    vi.useFakeTimers();
    stubFetch(() => 200);
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    try {
      transport.connect();
      const ws = FakeWebSocket.last!;
      ws.simulateOpen();
      await vi.advanceTimersByTimeAsync(95_000);
      // ws.close(4000) → onclose → onDrop → whoami 200 → reconnecting。
      expect(ws.closeCode).toBe(4000);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.linkState).toBe('reconnecting');
    } finally {
      transport.close();
    }
  });

  it('一直有入站（服务端 30s 心跳）则不误杀', async () => {
    vi.useFakeTimers();
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    try {
      transport.connect();
      const ws = FakeWebSocket.last!;
      ws.simulateOpen();
      for (let i = 0; i < 12; i += 1) {
        await vi.advanceTimersByTimeAsync(29_000);
        ws.simulateInbound({ event: 'session.heartbeat' });
      }
      expect(ws.closeCode).toBeNull();
      expect(transport.linkState).toBe('connected');
    } finally {
      transport.close();
    }
  });

  it('close()：断开连接并清理全部计时器/监听', async () => {
    vi.useFakeTimers();
    stubFetch(() => 200);
    const mod = await loadModule();
    const transport = new mod.AuthedWsTransport();
    transport.connect();
    const ws = FakeWebSocket.last!;
    ws.simulateOpen();
    transport.close();
    expect(ws.closeCode).toBe(1000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(FakeWebSocket.last).toBe(ws);
    expect(transport.linkState).toBe('connected'); // close 后不再迁移状态
  });
});
