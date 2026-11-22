import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 成员侧 Bot 面 store（member-bots B4 子域 A）：
 * - loadTeamBots 填切片（loaded=true）；失败写 error、不伪造数据；
 * - 团队来源通道的 core `bot.updated` / `bot.deleted`（经该来源连接的 onEvent）
 *   到达即重拉收敛——但闸在「已成功加载过」：未激活来源（个人版 core）零副作用；
 * - botCapabilities：bootstrap setter 写入；privateBotsUsed 以已加载列表实时折算；
 * - myPrivateBotsOf 按「mode private ∧ owner=当前成员」过滤（成员 id：显式
 *   setter 优先，其次桌面融合连接的 memberId）。
 *
 * connections 全 mock（无网络）。
 */

const h = vi.hoisted(() => {
  const state = {
    sources: ['local'] as string[],
    connected: true,
    memberId: null as string | null,
    calls: [] as Array<{ method: string; input: unknown }>,
    responsesFor(method: string): Array<unknown> {
      return responses.get(method) ?? [];
    },
  };
  const eventHandlers = new Map<string, Set<(payload?: unknown) => void>>();
  /** 每个方法的脚本式应答队列（单元素幂等重复；Error 实例 = 抛出）。 */
  const responses = new Map<string, Array<unknown>>();
  /** 按来源 memoize 的连接实例（模拟真实注册表的实例稳定性）。 */
  const connections = new Map<string, unknown>();
  return { state, eventHandlers, responses, connections };
});

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => h.state.sources,
    onSourcesChanged: () => () => undefined,
    // 真实注册表按来源返回同一连接实例（store 的接线幂等以实例为键）——mock
    // 同样按来源 memoize，否则每次 get 一个新对象会把守卫打穿（重复订阅）。
    get: (source: string) => {
      const existing = h.connections.get(source);
      if (existing !== undefined) return existing;
      const conn = {
        status: h.state.connected ? 'connected' : 'offline',
        memberId: h.state.memberId,
        onConnected: (handler: () => void) => {
          let set = h.eventHandlers.get('__connected__');
          if (!set) {
            set = new Set();
            h.eventHandlers.set('__connected__', set);
          }
          set.add(handler);
          return () => set?.delete(handler);
        },
        onEvent: (name: string, handler: (payload: unknown) => void) => {
          let set = h.eventHandlers.get(name);
          if (!set) {
            set = new Set();
            h.eventHandlers.set(name, set);
          }
          set.add(handler);
          return () => set?.delete(handler);
        },
        call: async (method: string, input?: unknown) => {
          h.state.calls.push({ method, input });
          if (method === 'bots.get') {
            return h.state.responsesFor('bots.get')[0] ?? { bot: { profile: {} } };
          }
          throw new Error(`unexpected core call ${method}`);
        },
        callTeam: async (method: string, input?: unknown) => {
          h.state.calls.push({ method, input });
          const queue = h.state.responsesFor(method);
          const value = queue.length > 1 ? queue.shift() : queue[0];
          if (value instanceof Error) throw value;
          return value ?? {};
        },
      };
      h.connections.set(source, conn);
      return conn;
    },
  },
}));

type TeamBotsStore = Awaited<ReturnType<typeof loadStore>>;

async function loadStore() {
  return (await import('./team-bots.svelte')).teamBots;
}

async function freshStore(): Promise<TeamBotsStore> {
  vi.resetModules();
  return loadStore();
}

function botView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot_1',
    name: 'Bot',
    mode: 'private',
    ownerMemberId: 'mbr_me',
    canEdit: true,
    canDelete: true,
    setupState: 'ready',
    ...overrides,
  };
}

function emit(event: string, payload: unknown): void {
  for (const handler of [...(h.eventHandlers.get(event) ?? [])]) handler(payload);
}

beforeEach(() => {
  h.state.sources = ['local'];
  h.state.connected = true;
  h.state.memberId = null;
  h.state.calls = [];
  h.responses.clear();
  h.eventHandlers.clear();
  h.connections.clear();
});

describe('loadTeamBots：切片装载', () => {
  it('成功：bots 落切片、loaded=true', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.list', [{ bots: [botView(), botView({ id: 'bot_2', mode: 'public' })] }]);
    await store.loadTeamBots('local');
    expect(store.teamBotsOf('local')).toMatchObject({ loaded: true });
    expect(store.teamBotsOf('local').bots).toHaveLength(2);
  });

  it('失败（个人版 core 无团队层）：error 写码、不伪造 bots', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.list', [Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' })]);
    await store.loadTeamBots('local');
    const slice = store.teamBotsOf('local');
    expect(slice.loaded).toBe(false);
    expect(slice.error).toBe('FORBIDDEN');
    expect(slice.bots).toEqual([]);
  });
});

describe('事件增量刷新（bot.updated / bot.deleted，B-12）', () => {
  it('已加载来源：事件到达即重拉（双通道各自生效）', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.list', [{ bots: [botView()] }]);
    await store.loadTeamBots('local');
    const callsBefore = h.state.calls.filter((c) => c.method === 'team.bots.list').length;
    expect(callsBefore).toBe(1);

    emit('bot.updated', { bot: { id: 'bot_1' } });
    await vi.waitFor(() =>
      expect(h.state.calls.filter((c) => c.method === 'team.bots.list').length).toBe(2),
    );
    emit('bot.deleted', { id: 'bot_2' });
    await vi.waitFor(() =>
      expect(h.state.calls.filter((c) => c.method === 'team.bots.list').length).toBe(3),
    );
  });

  it('未加载来源：事件零副作用（休眠铁律——不自动拉个人版 core）', async () => {
    const store = await freshStore();
    store.start();
    emit('bot.updated', { bot: { id: 'bot_1' } });
    emit('bot.deleted', { id: 'bot_1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.state.calls.filter((c) => c.method === 'team.bots.list')).toHaveLength(0);
    expect(store.teamBotsOf('local').loaded).toBe(false);
  });

  it('重连（onConnected）同样只在已加载来源重拉', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.list', [{ bots: [] }]);
    await store.loadTeamBots('local');
    for (const handler of [...(h.eventHandlers.get('__connected__') ?? [])]) handler();
    await vi.waitFor(() =>
      expect(h.state.calls.filter((c) => c.method === 'team.bots.list').length).toBe(2),
    );
  });
});

describe('botCapabilities（bootstrap 写入 + 配额实时折算）', () => {
  it('默认 null（旧服务端）；setter 写入后可读', async () => {
    const store = await freshStore();
    expect(store.botCapabilitiesOf('local')).toBeNull();
    store.setTeamBotCapabilities('local', {
      canCreatePublicBot: false,
      privateBotsUsed: 2,
      privateBotsLimit: 10,
    });
    expect(store.botCapabilitiesOf('local')).toMatchObject({
      canCreatePublicBot: false,
      privateBotsUsed: 2,
      privateBotsLimit: 10,
    });
    store.setTeamBotCapabilities('local', null);
    expect(store.botCapabilitiesOf('local')).toBeNull();
  });

  it('列表已加载时 privateBotsUsed 以列表为准（创建 / 转交后无需重跑 bootstrap）', async () => {
    const store = await freshStore();
    store.setTeamMemberId('local', 'mbr_me');
    store.setTeamBotCapabilities('local', {
      canCreatePublicBot: false,
      privateBotsUsed: 1,
      privateBotsLimit: 10,
    });
    h.responses.set('team.bots.list', [
      { bots: [botView(), botView({ id: 'bot_2', mode: 'private' }), botView({ id: 'bot_3', mode: 'public' })] },
    ]);
    await store.loadTeamBots('local');
    expect(store.botCapabilitiesOf('local')).toMatchObject({ privateBotsUsed: 2 });
  });

  it('列表未加载：保持 bootstrap 值（不拿空列表折算成 0）', async () => {
    const store = await freshStore();
    store.setTeamBotCapabilities('local', {
      canCreatePublicBot: false,
      privateBotsUsed: 5,
      privateBotsLimit: 10,
    });
    expect(store.botCapabilitiesOf('local')).toMatchObject({ privateBotsUsed: 5 });
  });
});

describe('myPrivateBotsOf（成员 id 的两个来路）', () => {
  it('显式 setter（web 团队端点：team-context bootstrap 写入）', async () => {
    const store = await freshStore();
    store.setTeamMemberId('local', 'mbr_me');
    h.responses.set('team.bots.list', [
      {
        bots: [
          botView(),
          botView({ id: 'bot_others', ownerMemberId: 'mbr_other' }),
          botView({ id: 'bot_pub', mode: 'public' }),
        ],
      },
    ]);
    await store.loadTeamBots('local');
    expect(store.myPrivateBotsOf('local').map((bot) => bot.id)).toEqual(['bot_1']);
  });

  it('桌面融合来源：connections.get(source).memberId', async () => {
    const store = await freshStore();
    h.state.sources = ['local', 'team:h1'];
    h.state.memberId = 'mbr_me';
    h.responses.set('team.bots.list', [{ bots: [botView(), botView({ id: 'bot_pub', mode: 'public' })] }]);
    await store.loadTeamBots('team:h1');
    expect(store.myPrivateBotsOf('team:h1').map((bot) => bot.id)).toEqual(['bot_1']);
  });

  it('成员 id 未知（未 bootstrap / 未登录）：空数组，不误判', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.list', [{ bots: [botView()] }]);
    await store.loadTeamBots('local');
    expect(store.myPrivateBotsOf('local')).toEqual([]);
  });
});

describe('动作方法（载荷 + 成功后重拉）', () => {
  it('createBot：interview:true、name 空串不传；成功后刷新列表', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.create', [{ bot: botView({ id: 'bot_new' }) }]);
    h.responses.set('team.bots.list', [{ bots: [botView({ id: 'bot_new' })] }]);
    const bot = await store.createBot('local', { mode: 'private', name: '  ' });
    expect(bot.id).toBe('bot_new');
    const create = h.state.calls.find((c) => c.method === 'team.bots.create');
    expect(create?.input).toEqual({ mode: 'private', interview: true });
    expect(h.state.calls.filter((c) => c.method === 'team.bots.list')).toHaveLength(1);
    expect(store.teamBotsOf('local').bots[0]?.id).toBe('bot_new');
  });

  it('createBot：workdirPath 透传', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.create', [{ bot: botView() }]);
    h.responses.set('team.bots.list', [{ bots: [] }]);
    await store.createBot('local', { mode: 'public', workdirPath: '/srv/root/a' });
    expect(h.state.calls.find((c) => c.method === 'team.bots.create')?.input).toEqual({
      mode: 'public',
      workdirPath: '/srv/root/a',
      interview: true,
    });
  });

  it('updateBot / deleteBot / transferBot：正确方法与载荷', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.update', [{ bot: botView() }]);
    h.responses.set('team.bots.delete', [{ deleted: true }]);
    h.responses.set('team.bots.transfer', [{ bot: botView({ ownerMemberId: 'mbr_other' }) }]);
    h.responses.set('team.bots.list', [{ bots: [] }]);
    await store.updateBot('local', 'bot_1', { persona: { personality: '严谨' } });
    await store.deleteBot('local', 'bot_1');
    await store.transferBot('local', 'bot_1', 'mbr_other');
    expect(h.state.calls.find((c) => c.method === 'team.bots.update')?.input).toEqual({
      botId: 'bot_1',
      patch: { persona: { personality: '严谨' } },
    });
    expect(h.state.calls.find((c) => c.method === 'team.bots.delete')?.input).toEqual({ botId: 'bot_1' });
    expect(h.state.calls.find((c) => c.method === 'team.bots.transfer')?.input).toEqual({
      botId: 'bot_1',
      toMemberId: 'mbr_other',
    });
  });

  it('错误原样抛出（对话框按码内联呈现）', async () => {
    const store = await freshStore();
    h.responses.set('team.bots.create', [
      Object.assign(new Error('limit'), { code: 'BOT_LIMIT_REACHED' }),
    ]);
    await expect(store.createBot('local', { mode: 'private' })).rejects.toMatchObject({
      code: 'BOT_LIMIT_REACHED',
    });
  });
});
