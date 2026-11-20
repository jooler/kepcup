import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 多来源连接注册表（T7 步骤 2）：
 * - 本机来源恒映射 core 单例（不改任何现有调用方式——休眠验收项）；
 * - 团队端口接入（team-port 窗口消息 → birpc 客户端）与断开占位；
 * - 事件按来源隔离（同 id 本机 / 团队互不干扰的事件总线断言）；
 * - web 端点休眠（融合注册表不激活）。
 */

// --- 本机 core 单例 mock（既有渲染层测试的标准姿势） ---------------------------

const h = vi.hoisted(() => {
  const localEventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const localCalls: string[] = [];
  return {
    localEventHandlers,
    localCalls,
    coreConnection: 'connected' as string,
    emitLocal(event: string, payload: unknown): void {
      for (const handler of localEventHandlers.get(event) ?? []) handler(payload);
    },
  };
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    get connection() {
      return h.coreConnection;
    },
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      let set = h.localEventHandlers.get(event);
      if (!set) {
        set = new Set();
        h.localEventHandlers.set(event, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onTeamEvent: (name: string, handler: (payload: unknown) => void) =>
      mockCore.onEvent(name, handler),
    onConnected: () => () => undefined,
    call: async (method: string) => {
      h.localCalls.push(method);
      return { ok: true };
    },
    callTeam: async (method: string) => {
      h.localCalls.push(method);
      return { ok: true };
    },
  },
}));

const mockCore = (
  await import('$lib/rpc/client.svelte')
).core as unknown as {
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
};

// --- 团队端口假实现（birpc 帧协议：q / s / 事件推送） ---------------------------

class FakePort {
  posted: unknown[] = [];
  #listener: ((event: { data: unknown }) => void) | null = null;
  #other: FakePort | null = null;
  connect(other: FakePort): void {
    this.#other = other;
  }
  postMessage(data: unknown): void {
    this.posted.push(data);
    this.#other?.receive(data);
  }
  receive(data: unknown): void {
    this.#listener?.({ data });
  }
  addEventListener(_type: string, listener: (event: { data: unknown }) => void): void {
    this.#listener = listener;
  }
  removeEventListener(): void {
    this.#listener = null;
  }
  start(): void {}
  close(): void {}
}

interface TeamServerHarness {
  /** 渲染层侧端口（交给 connections.attachTeamPort）。 */
  clientPort: FakePort;
  /** 服务端收到的调用（method + input）。 */
  calls: Array<{ method: string; input: unknown }>;
  /** 服务端向渲染层推送一条事件。 */
  pushEvent(name: string, payload: unknown): void;
}

function createTeamServer(
  handlers: Record<string, (input: unknown) => unknown>,
): TeamServerHarness {
  const clientPort = new FakePort();
  const serverPort = new FakePort();
  clientPort.connect(serverPort);
  serverPort.connect(clientPort);
  const calls: Array<{ method: string; input: unknown }> = [];
  serverPort.addEventListener('message', ({ data }) => {
    const frame = data as { m: string; a: unknown[]; t: string; i?: string };
    if (frame.t !== 'q') return;
    const handler = handlers[frame.m];
    calls.push({ method: frame.m, input: frame.a[0] });
    if (frame.i === undefined) return; // 事件帧（无 i）不需要应答
    if (handler === undefined) {
      serverPort.postMessage({ t: 's', i: frame.i, e: new Error('not found') });
      return;
    }
    serverPort.postMessage({ t: 's', i: frame.i, r: handler(frame.a[0]) });
  });
  return {
    clientPort,
    calls,
    pushEvent(name, payload) {
      serverPort.postMessage({ m: name, a: [payload], t: 'q' });
    },
  };
}

const { connections } = await import('./connections.svelte');
const { isTeamPortMessage } = await import('./team-port');

/** birpc 的 onMessage 是异步的：事件投递落在微任务里。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  connections.reset();
  h.localCalls.length = 0;
  h.coreConnection = 'connected';
});

describe('本机来源（休眠铁律：与 core 单例行为一致）', () => {
  it("get('local') 委托 core 单例：call / onEvent / callTeam", async () => {
    expect(connections.get('local').status).toBe('connected');
    await connections.get('local').call('system.info');
    await connections.get('local').callTeam('team.bootstrap');
    expect(h.localCalls).toEqual(['system.info', 'team.bootstrap']);
    const seen: unknown[] = [];
    connections.get('local').onEvent('message.created', (payload) => seen.push(payload));
    h.emitLocal('message.created', { id: 'm1' });
    expect(seen).toEqual([{ id: 'm1' }]);
  });

  it('core 的 failed 状态映射为 offline（其余逐项同形）', () => {
    h.coreConnection = 'failed';
    expect(connections.get('local').status).toBe('offline');
    h.coreConnection = 'reconnecting';
    expect(connections.get('local').status).toBe('reconnecting');
  });

  it('sources() 未配置团队服务器时恒为 [local]', () => {
    expect(connections.sources()).toEqual(['local']);
  });

  it('get 同一来源返回同一视图对象', () => {
    expect(connections.get('local')).toBe(connections.get('local'));
  });
});

describe('团队端口接入与断开', () => {
  it('attachTeamPort → connected；call 走团队端口；服务端事件只达团队订阅', async () => {
    const server = createTeamServer({
      'team.bootstrap': () => ({ member: { id: 'mbr_1', displayName: '甲', state: 'online' } }),
    });
    const conn = connections.get('team:h1');
    expect(conn.status).toBe('offline');
    connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
    expect(conn.status).toBe('connected');

    const result = (await conn.callTeam('team.bootstrap')) as { member: { id: string } };
    expect(result.member.id).toBe('mbr_1');
    expect(server.calls.map((call) => call.method)).toContain('team.bootstrap');

    // 事件隔离：团队端口上的 message.created 只达团队订阅，core 的订阅收不到。
    const teamSeen: unknown[] = [];
    const localSeen: unknown[] = [];
    conn.onEvent('message.created', (payload) => teamSeen.push(payload));
    connections.get('local').onEvent('message.created', (payload) => localSeen.push(payload));
    server.pushEvent('message.created', { conversationId: 'c1', message: { id: 'tm1' } });
    await tick();
    expect(teamSeen).toEqual([{ conversationId: 'c1', message: { id: 'tm1' } }]);
    expect(localSeen).toEqual([]);
    h.emitLocal('message.created', { conversationId: 'c1', message: { id: 'lm1' } });
    expect(teamSeen).toHaveLength(1);
    expect(localSeen).toEqual([{ conversationId: 'c1', message: { id: 'lm1' } }]);
  });

  it('断开（requestDisconnect）→ offline 占位；call 拒绝，不伪造数据', async () => {
    const disconnect = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      kepcup: {
        isWeb: false,
        portNonce: 'n',
        platform: {
          teamServers: {
            list: async () => [],
            connect: async () => ({ ok: true as const }),
            disconnect,
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            onChanged: () => () => undefined,
          },
        },
      },
    });
    try {
      connections.reset();
      connections.start();
      const server = createTeamServer({});
      connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
      const conn = connections.get('team:h1');
      expect(conn.status).toBe('connected');
      await connections.requestDisconnect('h1');
      expect(disconnect).toHaveBeenCalledWith({ serverHash: 'h1' });
      expect(conn.status).toBe('offline');
      await expect(conn.call('conversations.list')).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('端口重建（重连）替换旧客户端并再触发 onConnected', async () => {
    const server = createTeamServer({});
    const conn = connections.get('team:h1');
    let connectedCount = 0;
    conn.onConnected(() => {
      connectedCount += 1;
    });
    connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
    const second = createTeamServer({ 'system.info': () => ({ version: '1' }) });
    connections.attachTeamPort('h1', second.clientPort as unknown as MessagePort);
    expect(conn.status).toBe('connected');
    expect(connectedCount).toBe(2);
    // 旧端口上不再有帧往来（新调用走新端口）。
    await conn.call('system.info');
    expect(second.calls.map((call) => call.method)).toContain('system.info');
    expect(server.calls.map((call) => call.method)).not.toContain('system.info');
  });

  it('isTeamPortMessage 校验 type / nonce / serverHash 三样（同 core-port 先例）', () => {
    const self = {};
    const port = new FakePort();
    const good = {
      data: { type: 'team-port', nonce: 'n1', serverHash: 'h1' },
      source: self,
      ports: [port],
    };
    expect(isTeamPortMessage(good as never, self, 'n1')).toBe(true);
    expect(isTeamPortMessage({ ...good, source: {} } as never, self, 'n1')).toBe(false);
    expect(
      isTeamPortMessage(
        { ...good, data: { type: 'core-port', nonce: 'n1', serverHash: 'h1' } } as never,
        self,
        'n1',
      ),
    ).toBe(false);
    expect(
      isTeamPortMessage({ ...good, data: { type: 'team-port', nonce: 'n1', serverHash: '' } } as never, self, 'n1'),
    ).toBe(false);
    expect(isTeamPortMessage({ ...good, ports: [] } as never, self, 'n1')).toBe(false);
  });
});

describe('web 端点休眠（融合注册表不激活）', () => {
  it('isWeb 端点 start() 不接 platform、不拉服务器清单', async () => {
    const list = vi.fn(async () => []);
    const connect = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      kepcup: {
        isWeb: true,
        portNonce: 'n',
        platform: {
          teamServers: {
            list,
            connect,
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            onChanged: () => () => undefined,
          },
        },
      },
    });
    try {
      connections.reset();
      connections.start();
      expect(list).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      // web 的团队上下文仍是 T5 的同源 core：sources 恒 [local]。
      expect(connections.sources()).toEqual(['local']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('桌面端点 start() 拉清单并对已登录的 idle 服务器请求一次连接', async () => {
    const list = vi.fn(async () => [
      {
        serverHash: 'h1',
        url: 'https://team.example.com',
        accounts: [{ memberId: 'mbr_1', username: 'a', displayName: '甲', remembered: true }],
        activeMemberId: 'mbr_1',
        status: 'idle',
      },
    ]);
    const connect = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      kepcup: {
        isWeb: false,
        portNonce: 'n',
        platform: {
          teamServers: {
            list,
            connect,
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            onChanged: () => () => undefined,
          },
        },
      },
    });
    try {
      connections.reset();
      connections.start();
      await vi.waitFor(() => expect(connect).toHaveBeenCalledWith({ serverHash: 'h1' }));
      expect(connections.sources()).toContain('team:h1');
      // onChanged 再触发也不会重复 connect（本会话只请求一次）。
      await connections.refreshServers();
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
