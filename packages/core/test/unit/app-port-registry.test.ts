import { describe, expect, test, vi } from 'vitest';
import { AppPortRegistry } from '../../src/app-port-registry.js';
import type { RpcServerHandle } from '../../src/rpc/server.js';

/** 测试用 server 桩：pushEvent 可配置为抛错（模拟端口已死）。 */
function fakeServer(options: { failPush?: boolean } = {}): RpcServerHandle & {
  pushes: Array<{ name: string; payload: unknown }>;
  closed: boolean;
} {
  const state: { pushes: Array<{ name: string; payload: unknown }>; closed: boolean } = {
    pushes: [],
    closed: false,
  };
  return {
    get pushes() {
      return state.pushes;
    },
    get closed() {
      return state.closed;
    },
    pushEvent(name: string, payload: unknown) {
      if (options.failPush) throw new Error('port gone');
      state.pushes.push({ name, payload });
    },
    close() {
      state.closed = true;
    },
  } as never;
}

describe('AppPortRegistry（端口 A 多客户端）', () => {
  test('多个客户端各自 bind、pushStatusTo 逐客户端触发', () => {
    const registry = new AppPortRegistry();
    const onBound = vi.fn();
    const a = registry.bind({ createServer: () => fakeServer(), onBound });
    const b = registry.bind({ createServer: () => fakeServer(), onBound });
    expect(registry.size).toBe(2);
    expect(onBound).toHaveBeenCalledTimes(2);
    expect(onBound).toHaveBeenCalledWith(a);
    expect(onBound).toHaveBeenCalledWith(b);
    expect(a).not.toBe(b);
  });

  test('pushEvent 广播到全部客户端', () => {
    const registry = new AppPortRegistry();
    const a = registry.bind({ createServer: () => fakeServer() });
    const b = registry.bind({ createServer: () => fakeServer() });
    registry.pushEvent('micro-app.stream', { delta: 'x' });
    expect(a.pushes).toEqual([{ name: 'micro-app.stream', payload: { delta: 'x' } }]);
    expect(b.pushes).toEqual([{ name: 'micro-app.stream', payload: { delta: 'x' } }]);
  });

  test('remove 出清：close 调用且不再收到事件', () => {
    const registry = new AppPortRegistry();
    const a = registry.bind({ createServer: () => fakeServer() });
    const b = registry.bind({ createServer: () => fakeServer() });
    registry.remove(a);
    expect(a.closed).toBe(true);
    expect(registry.size).toBe(1);
    registry.pushEvent('e', 1);
    expect(a.pushes).toEqual([]);
    expect(b.pushes).toEqual([{ name: 'e', payload: 1 }]);
  });

  test('死端口 pushEvent 抛错：摘除该客户端并继续推其余，不放大成全体丢事件', () => {
    const registry = new AppPortRegistry();
    const dead = registry.bind({ createServer: () => fakeServer({ failPush: true }) });
    const alive = registry.bind({ createServer: () => fakeServer() });
    const onError = vi.fn();
    registry.pushEvent('e', 1, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
    registry.pushEvent('e2', 2);
    expect(dead.pushes).toEqual([]);
    expect(alive.pushes).toEqual([
      { name: 'e', payload: 1 },
      { name: 'e2', payload: 2 },
    ]);
  });

  test('closeAll 关掉全部并清空', () => {
    const registry = new AppPortRegistry();
    const a = registry.bind({ createServer: () => fakeServer() });
    const b = registry.bind({ createServer: () => fakeServer() });
    registry.closeAll();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(registry.size).toBe(0);
  });
});
