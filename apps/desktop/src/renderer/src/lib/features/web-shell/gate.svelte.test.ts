import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as gateModule from './gate.svelte';

/**
 * WebGate 密码模式状态机（D102 修订，审查 P2：认证状态机原先零测试）：
 * 探测 → 登录页/直连、登录成功/失败（401/429）、会话失效回登录页。
 * 三个依赖模块全 mock（endpoint 定死 remote、authed-transport 给假传输），
 * 每个用例 resetModules 重导 gate.svelte——模块加载即触发一次 #boot。
 */

const h = vi.hoisted(() => {
  const linkHandlers = new Set<(state: string) => void>();
  class FakeAuthedTransport {
    linkState = 'connecting';
    calls: string[] = [];
    onLinkState(handler: (state: string) => void): () => void {
      linkHandlers.add(handler);
      return () => linkHandlers.delete(handler);
    }
    connect(): void {
      this.calls.push('connect');
    }
    connectNow(): void {
      this.calls.push('connectNow');
    }
    emit(state: string): void {
      this.linkState = state as never;
      for (const handler of linkHandlers) handler(state);
    }
  }
  return {
    transport: new FakeAuthedTransport(),
    /** #boot 读到的探测结果；null = 服务器不可达（回退配对路径分支不进这些用例）。 */
    probe: null as null | { mode: 'password' | 'pairing'; authenticated: boolean },
    linkHandlers,
  };
});

vi.mock('$lib/rpc/authed-transport', () => ({
  getAuthedTransport: () => h.transport,
  probeServerAuthUntilSettled: () => Promise.resolve(h.probe),
  watchForPasswordServer: () => () => {},
}));
vi.mock('$lib/rpc/ws-transport', () => ({
  // 配对路径不在本文件覆盖范围（原有 D96 行为）；误入即失败暴露。
  getWebTransport: () => {
    throw new Error('pairing transport not under test');
  },
  parsePairingLink: () => null,
}));
vi.mock('./endpoint', () => ({
  ENDPOINT_KIND: 'remote' as const,
  defaultDeviceName: () => 'Test Browser',
}));

beforeEach(() => {
  h.transport.calls.length = 0;
  h.linkHandlers.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 重导模块 → 触发一次全新 #boot，等探测落定。 */
async function bootGate(): Promise<typeof gateModule> {
  vi.resetModules();
  const mod = await import('./gate.svelte');
  await vi.waitFor(() => expect(mod.webGate.authMode).not.toBe('probing'));
  return mod;
}

function stubFetch(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: status === 200, status })),
  );
}

describe('WebGateState 密码模式', () => {
  it('未登录会话 → 登录页', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    expect(webGate.authMode).toBe('password');
    expect(webGate.view).toBe('login');
    expect(h.transport.calls).toEqual([]);
  });

  it('已登录会话 → booting 并立即拨号', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    expect(webGate.view).toBe('booting');
    expect(h.transport.calls).toEqual(['connect']);
  });

  it('登录成功 → booting + connectNow；连接建立 → connected', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200);
    await webGate.login('admin', 'correct horse battery');
    expect(webGate.view).toBe('booting');
    expect(webGate.loginError).toBeNull();
    expect(h.transport.calls).toEqual(['connectNow']);
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
  });

  it('登录失败：401 → invalid；429 → ratelimited；网络错误 → error（均留在登录页）', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    for (const [status, expected] of [
      [401, 'invalid'],
      [429, 'ratelimited'],
    ] as const) {
      stubFetch(status);
      await webGate.login('admin', 'wrong password!');
      expect(webGate.loginError).toBe(expected);
      expect(webGate.view).toBe('login');
      expect(h.transport.calls).toEqual([]);
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))));
    await webGate.login('admin', 'whatever password');
    expect(webGate.loginError).toBe('error');
    expect(webGate.view).toBe('login');
    vi.unstubAllGlobals();
  });

  it('会话失效（unauthenticated）→ 清错误回登录页', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
    h.transport.emit('unauthenticated');
    expect(webGate.view).toBe('login');
    expect(webGate.loginError).toBeNull();
    // 已在登录页时 connecting/reconnecting 不抢走视图（表单不被打断）。
    h.transport.emit('reconnecting');
    expect(webGate.view).toBe('login');
  });

  it('连接后断线（reconnecting）→ booting 等待重连', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    h.transport.emit('connected');
    h.transport.emit('reconnecting');
    expect(webGate.view).toBe('booting');
  });
});
