import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';

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
    /** onTeamOnline 用例里可变的服务器状态（platform.list 按它返回）。 */
    platformStatus: 'connected' as string,
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

const mockCore = (await import('$lib/rpc/client.svelte')).core as unknown as {
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
};

// --- 团队端口假实现（birpc 帧协议：q / s / 事件推送） ---------------------------

class FakePort {
  posted: unknown[] = [];
  onStart: (() => void) | null = null;
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
  start(): void {
    this.onStart?.();
  }
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

/** handler 返回该哨兵 = 不回帧（模拟调用在途：帧已发、响应未回）。 */
const NO_REPLY = Symbol('no-reply');

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
    const result = handler(frame.a[0]);
    if (result === NO_REPLY) return; // 挂起：调用方一直 pending
    serverPort.postMessage({ t: 's', i: frame.i, r: result });
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
const { messageVisibilityScope } = await import('../stores/message-visibility.svelte');
const { teamContext } = await import('../features/team/team-context.svelte');

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

  it('port handshake sets identity before start and stale-account events are dropped', async () => {
    const serverA = createTeamServer({});
    const conn = connections.get('team:h1');
    let identityAtStart: string | null = null;
    serverA.clientPort.onStart = () => {
      identityAtStart = conn.memberId;
    };
    connections.attachTeamPort('h1', serverA.clientPort as unknown as MessagePort, 'mbr_a');
    expect(identityAtStart).toBe('mbr_a');
    const seen: unknown[] = [];
    conn.onEvent('message.created', (payload) => seen.push(payload));
    serverA.pushEvent('message.created', { id: 'a1' });
    await tick();
    expect(seen).toEqual([{ id: 'a1' }]);

    (conn as unknown as { memberId: string | null }).memberId = 'mbr_b';
    serverA.pushEvent('message.created', { id: 'stale-a' });
    await tick();
    expect(seen).toEqual([{ id: 'a1' }]);

    const serverB = createTeamServer({});
    connections.attachTeamPort('h1', serverB.clientPort as unknown as MessagePort, 'mbr_b');
    serverA.pushEvent('message.created', { id: 'old-port-a' });
    serverB.pushEvent('message.created', { id: 'b1' });
    await tick();
    expect(seen).toEqual([{ id: 'a1' }, { id: 'b1' }]);
  });

  it('member changes reject in-flight RPCs and drop the old transport immediately', async () => {
    const serverA = createTeamServer({ 'system.info': () => NO_REPLY });
    const conn = connections.get('team:h1');
    connections.attachTeamPort('h1', serverA.clientPort as unknown as MessagePort, 'mbr_a');
    const pending = conn.call('system.info');

    (conn as unknown as { memberId: string | null }).memberId = 'mbr_b';
    expect(conn.status).toBe('offline');
    await expect(pending).rejects.toThrow('team source identity changed');
    await expect(conn.call('system.info')).rejects.toThrow('team source not connected');

    const seen: unknown[] = [];
    conn.onEvent('message.created', (payload) => seen.push(payload));
    serverA.pushEvent('message.created', { id: 'old-account' });
    await tick();
    expect(seen).toEqual([]);
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
            // probe 是 platform.teamServers 面的必备方法（缺了整个面判不可用）。
            probe: async () => ({ reachable: true, kind: 'team' as const }),
            disconnect,
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            rename: async () => ({ ok: true as const }),
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

  it('重连竞争：connecting/error 只标记重连中、保留端口；connected 自动恢复', async () => {
    const server = createTeamServer({ 'system.info': () => ({ version: '1' }) });
    const conn = connections.get('team:h1');
    connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
    expect(conn.status).toBe('connected');

    // 主进程的旧 'connecting' 帧晚于端口交付：不能销毁客户端（桥重连复用同一端口）。
    conn.markOffline(true);
    expect(conn.status).toBe('reconnecting');
    const result = (await conn.call('system.info')) as { version: string };
    expect(result.version).toBe('1');

    (conn as unknown as { markConnected(): void }).markConnected();
    expect(conn.status).toBe('connected');
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
    const seen: unknown[] = [];
    conn.onEvent('message.created', (payload) => seen.push(payload));
    server.pushEvent('message.created', { id: 'old-port' });
    second.pushEvent('message.created', { id: 'new-port' });
    await tick();
    expect(seen).toEqual([{ id: 'new-port' }]);
    // 旧端口上不再有帧往来（新调用走新端口）。
    await conn.call('system.info');
    expect(second.calls.map((call) => call.method)).toContain('system.info');
    expect(server.calls.map((call) => call.method)).not.toContain('system.info');
  });

  it('isTeamPortMessage 校验 type / nonce / serverHash 三样（同 core-port 先例）', () => {
    const self = {};
    const port = new FakePort();
    const good = {
      data: { type: 'team-port', nonce: 'n1', serverHash: 'h1', activeMemberId: 'mbr_1' },
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
      isTeamPortMessage(
        { ...good, data: { type: 'team-port', nonce: 'n1', serverHash: '' } } as never,
        self,
        'n1',
      ),
    ).toBe(false);
    expect(isTeamPortMessage({ ...good, ports: [] } as never, self, 'n1')).toBe(false);
    expect(
      isTeamPortMessage(
        {
          ...good,
          data: { type: 'team-port', nonce: 'n1', serverHash: 'h1' },
        } as never,
        self,
        'n1',
      ),
    ).toBe(false);
    expect(
      isTeamPortMessage(
        {
          ...good,
          data: { type: 'team-port', nonce: 'n1', serverHash: 'h1', activeMemberId: 42 },
        } as never,
        self,
        'n1',
      ),
    ).toBe(false);
    expect(
      isTeamPortMessage(
        {
          ...good,
          data: { type: 'team-port', nonce: 'n1', serverHash: 'h1', activeMemberId: null },
        } as never,
        self,
        'n1',
      ),
    ).toBe(true);
  });
});

describe('真·在线边沿（onTeamOnline）', () => {
  /** 桌面 platform 桩：list 返回单台已登录服务器，状态由 h.platformStatus 驱动。 */
  async function startWithPlatform(): Promise<void> {
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      kepcup: {
        isWeb: false,
        portNonce: 'n',
        platform: {
          teamServers: {
            list: async () => [
              {
                serverHash: 'h1',
                url: 'https://team.example.com',
                name: '',
                accounts: [
                  { memberId: 'mbr_1', username: 'a', displayName: '甲', remembered: true },
                ],
                activeMemberId: 'mbr_1',
                status: h.platformStatus,
              },
            ],
            connect: async () => ({ ok: true as const }),
            probe: async () => ({ reachable: true, kind: 'team' as const }),
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            rename: async () => ({ ok: true as const }),
            onChanged: () => () => undefined,
          },
        },
      },
    });
    connections.reset();
    connections.start();
    await vi.waitFor(() => expect(connections.serverOf('h1')).not.toBeNull());
  }

  it('端口就绪 + 平台 connected 才触发；断开（重连中）复位、重连成功再触发', async () => {
    h.platformStatus = 'connected';
    try {
      await startWithPlatform();
      const conn = connections.get('team:h1'); // 建 TeamConnection 实例
      let onlineCount = 0;
      connections.onTeamOnline('h1', () => {
        onlineCount += 1;
      });

      // 平台已是 connected，端口到达 → 就绪 → 触发一次。
      const server = createTeamServer({});
      connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
      expect(onlineCount).toBe(1);

      // 平台掉线（桥重连中）：不误触发，边沿复位。
      conn.markOffline(true);
      h.platformStatus = 'error';
      await connections.refreshServers();
      expect(onlineCount).toBe(1);

      // 重连成功（平台 connected + 端口还在）：再触发一次。
      h.platformStatus = 'connected';
      await connections.refreshServers();
      expect(onlineCount).toBe(2);

      // 已在线的重复 refresh 不重复触发。
      await connections.refreshServers();
      expect(onlineCount).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('服务器未启动（平台未 connected）：端口先到不触发，服务器恢复后触发', async () => {
    // 桥在建连时先交付端口、WS 在后台握手：端口就绪 ≠ 服务器可达。
    h.platformStatus = 'connecting';
    try {
      await startWithPlatform();
      const conn = connections.get('team:h1');
      let onlineCount = 0;
      connections.onTeamOnline('h1', () => {
        onlineCount += 1;
      });
      const server = createTeamServer({});
      connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
      // bind 先按「数据面就绪」记 connected，随即被平台清单（connecting）扳回
      // 重连中：端口与帧队列保留（重连中不拦调用），只是标签诚实。
      expect(conn.status).toBe('reconnecting');
      expect(onlineCount).toBe(0); // 但对端未确认在线：不触发

      await connections.refreshServers(); // 平台仍 connecting：仍不触发
      expect(onlineCount).toBe(0);

      // 服务器恢复（WS 建立成功，平台报 connected）：触发一次。
      h.platformStatus = 'connected';
      await connections.refreshServers();
      expect(onlineCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('平台 unreachable（连续重试未果）→ 标记「服务器不可用」、拒 pending 与新调用；端口保留，恢复回 connected', async () => {
    h.platformStatus = 'connected';
    try {
      await startWithPlatform();
      const conn = connections.get('team:h1');
      let hang = true;
      const server = createTeamServer({
        'system.info': () => (hang ? NO_REPLY : { version: '1' }),
      });
      connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
      expect(conn.status).toBe('connected');

      // 一笔调用在途（帧已发出、响应未回）。
      const pending = conn.call('system.info');

      h.platformStatus = 'unreachable';
      await connections.refreshServers();
      expect(conn.status).toBe('unreachable');
      // 端口保留（桥复用同一端口后台重试），但数据面停摆：在途调用立即被拒
      //（帧若还排在桥队列里，不拒的话调用方要挂到 birpc 超时，恢复后还会被
      // 冲放成陈旧重复执行）；新调用同样快速失败、不再排队（不发新帧）。
      await expect(pending).rejects.toThrow('team source unreachable');
      const callsWhenUnreachable = server.calls.length;
      await expect(conn.call('system.info')).rejects.toThrow('team source unreachable');
      expect(server.calls.length).toBe(callsWhenUnreachable);

      h.platformStatus = 'connected';
      await connections.refreshServers();
      expect(conn.status).toBe('connected');
      // 恢复后调用照常。
      hang = false;
      const result = (await conn.call('system.info')) as { version: string };
      expect(result.version).toBe('1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('窗口重载补发端口不翻回 connected：清单已 unreachable 时 bind 后仍是「服务器不可用」', async () => {
    // 桥对重试中的连接同样补发端口（refreshPorts）：窗口重载时 list 先返回
    //（unreachable 已入账），端口消息后到——bind 的 connected 若不被平台状态
    // 扳回，unreachable 稳态没有后续 onChanged 来校正，侧栏会永远显示绿点 +
    // 本地缓存名册（服务器实际离线）。
    h.platformStatus = 'unreachable';
    try {
      await startWithPlatform();
      const conn = connections.get('team:h1');
      expect(conn.status).toBe('offline'); // 端口未到：离线占位

      const server = createTeamServer({});
      connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort);
      expect(conn.status).toBe('unreachable');
      // 数据面守卫同步生效：unreachable 不发新帧。
      await expect(conn.call('system.info')).rejects.toThrow('team source unreachable');

      // 服务器恢复：清单报 connected → 端口还在，直接恢复数据面。
      h.platformStatus = 'connected';
      await connections.refreshServers();
      expect(conn.status).toBe('connected');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('message visibility account scopes', () => {
  it('reacts to TeamConnection.memberId changes in place', () => {
    connections.servers = [
      {
        serverHash: 'h1',
        url: 'https://team.example.com',
        name: '',
        accounts: [{ memberId: 'mbr_a', username: 'a', displayName: '甲', remembered: true }],
        activeMemberId: 'mbr_a',
        status: 'connected',
      },
    ];
    const connection = connections.get('team:h1');
    const scopes: string[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        scopes.push(messageVisibilityScope('team:h1'));
      });
    });
    try {
      flushSync();
      expect(scopes.at(-1)).toBe('team:h1:mbr_a');
      (connection as unknown as { memberId: string | null }).memberId = 'mbr_b';
      flushSync();
      expect(scopes.at(-1)).toBe('team:h1:mbr_b');
    } finally {
      stop();
    }
  });

  it('fails closed while a same-origin team endpoint is still resolving its member', () => {
    teamContext.reset();
    try {
      teamContext.endpointIsTeam = true;
      expect(messageVisibilityScope('local')).toBe('local:team:identity-pending');
      teamContext.active = true;
      teamContext.member = { id: 'web_a' } as NonNullable<typeof teamContext.member>;
      expect(messageVisibilityScope('local')).toBe('local:team:web_a');
    } finally {
      teamContext.reset();
    }
  });

  it('scopes same-origin web team members without changing personal local scope', () => {
    const scopes: string[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        scopes.push(messageVisibilityScope('local'));
      });
    });
    try {
      flushSync();
      expect(scopes.at(-1)).toBe('local');
      teamContext.active = true;
      teamContext.member = { id: 'web_a' } as NonNullable<typeof teamContext.member>;
      flushSync();
      expect(scopes.at(-1)).toBe('local:team:web_a');
      teamContext.member = { id: 'web_b' } as NonNullable<typeof teamContext.member>;
      flushSync();
      expect(scopes.at(-1)).toBe('local:team:web_b');
    } finally {
      stop();
      teamContext.reset();
    }
  });
});

describe('account switch refresh generations', () => {
  function stubList(list: () => Promise<unknown[]>): void {
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      kepcup: {
        isWeb: false,
        portNonce: 'n',
        platform: {
          teamServers: {
            list,
            connect: async () => ({ ok: true as const }),
            probe: async () => ({ reachable: true, kind: 'team' as const }),
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            rename: async () => ({ ok: true as const }),
            onChanged: () => () => undefined,
          },
        },
      },
    });
  }

  function serverEntry(activeMemberId: string) {
    return {
      serverHash: 'h1',
      url: 'https://team.example.com',
      name: '',
      accounts: [],
      activeMemberId,
      status: 'connected' as const,
    };
  }

  it('discards a pre-switch server list after a new member port is attached', async () => {
    let resolveList!: (value: unknown[]) => void;
    const list = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    stubList(list);
    try {
      connections.reset();
      connections.start();
      const conn = connections.get('team:h1');
      const serverB = createTeamServer({});
      connections.attachTeamPort('h1', serverB.clientPort as unknown as MessagePort, 'mbr_b');
      resolveList([serverEntry('mbr_a')]);
      await tick();
      expect(conn.memberId).toBe('mbr_b');
      expect(connections.serverOf('h1')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('invalidates a pre-port server list even when the member id is unchanged', async () => {
    connections.servers = [serverEntry('mbr_a')];
    let resolveList!: (value: unknown[]) => void;
    const list = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    stubList(list);
    try {
      connections.start();
      const conn = connections.get('team:h1');
      const replacement = createTeamServer({});
      connections.attachTeamPort('h1', replacement.clientPort as unknown as MessagePort, 'mbr_a');
      resolveList([serverEntry('mbr_b')]);
      await tick();
      expect(conn.memberId).toBe('mbr_a');
      expect(connections.serverOf('h1')?.activeMemberId).toBe('mbr_a');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recovers the server list after a port attach discarded an in-flight refresh', async () => {
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue([serverEntry('mbr_b')]);
    stubList(list);
    connections.reset();
    connections.start();
    const server = createTeamServer({});
    connections.attachTeamPort('h1', server.clientPort as unknown as MessagePort, 'mbr_b');
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(connections.serverOf('h1')?.activeMemberId).toBe('mbr_b'));
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
            probe: async () => ({ reachable: true, kind: 'team' as const }),
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            rename: async () => ({ ok: true as const }),
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
        name: '',
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
            probe: async () => ({ reachable: true, kind: 'team' as const }),
            disconnect: async () => ({ ok: true as const }),
            add: async () => ({ serverHash: 'x' }),
            remove: async () => ({ ok: true as const }),
            login: async () => ({ member: { id: 'm', displayName: '' } }),
            logout: async () => ({ ok: true as const }),
            switchAccount: async () => ({ ok: true as const }),
            rename: async () => ({ ok: true as const }),
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
