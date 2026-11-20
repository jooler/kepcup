import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 团队上下文（T5 步骤 2）的休眠与激活状态机：
 * - 非团队上下文（begin 未调用）：active=false、名册空、isTeamHidden 恒 false
 *   （休眠铁律——渲染层行为不变）；
 * - 团队端点：bootstrap 填充成员 / surfaces / 上限，名册经 team.members.list；
 * - member.* 事件驱动增量刷新；会话失效 reset 回休眠。
 *
 * core 单例全 mock（无网络、无 DOM）；bootstrap 载荷按 shared
 * teamBootstrapSchema 组装，schema 由实现侧 parse，形状错误即暴露。
 */

const h = vi.hoisted(() => {
  const teamEventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const connectedHandlers = new Set<() => void>();
  const calls: Array<{ method: string; input: unknown }> = [];
  /** 按 method 响应的桩；返回 undefined 表示让调用抛错（服务器拒绝路径）。 */
  let responder: ((method: string, input: unknown) => unknown) | null = null;
  return {
    teamEventHandlers,
    connectedHandlers,
    calls,
    setResponder(fn: ((method: string, input: unknown) => unknown) | null): void {
      responder = fn;
    },
    respond(method: string, input: unknown): unknown {
      if (responder === null) throw new Error('no responder');
      return responder(method, input);
    },
    emitTeamEvent(name: string, payload: unknown): void {
      for (const handler of teamEventHandlers.get(name) ?? []) handler(payload);
    },
    emitConnected(): void {
      for (const handler of connectedHandlers) handler();
    },
  };
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    connection: 'connected',
    onConnected: (handler: () => void) => {
      h.connectedHandlers.add(handler);
      return () => h.connectedHandlers.delete(handler);
    },
    onTeamEvent: (name: string, handler: (payload: unknown) => void) => {
      let set = h.teamEventHandlers.get(name);
      if (!set) {
        set = new Set();
        h.teamEventHandlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      let set = h.teamEventHandlers.get(name);
      if (!set) {
        set = new Set();
        h.teamEventHandlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    call: async (method: string, input?: unknown) => {
      h.calls.push({ method, input });
      return h.respond(method, input);
    },
    callTeam: async function callTeam(method: string, input?: unknown) {
      h.calls.push({ method, input });
      return h.respond(method, input);
    },
  },
}));

const { teamContext } = await import('./team-context.svelte');

const SELF = { id: 'mbr_self', displayName: '甲', state: 'online' } as const;
const PEER = { id: 'mbr_peer', displayName: '乙', state: 'offline', lastSeenAt: 100 } as const;

function bootstrapPayload(hidden: string[] = ['remote', 'extension-center', 'computer-use']) {
  return {
    member: SELF,
    server: { name: 'Acme 团队', version: '1.0.0' },
    surfaces: { hidden },
    conversations: [],
    permissionCeiling: 'auto',
  };
}

function stubBootstrap(hidden?: string[]): void {
  h.setResponder((method) => {
    if (method === 'team.bootstrap') return bootstrapPayload(hidden);
    if (method === 'team.members.list') return { members: [SELF, PEER] };
    throw new Error(`unexpected method ${method}`);
  });
}

beforeEach(() => {
  h.calls.length = 0;
  h.setResponder(null);
  teamContext.reset();
});

describe('休眠态（非团队上下文）', () => {
  it('默认全空：active=false、名册空、入口门控恒放行', () => {
    expect(teamContext.active).toBe(false);
    expect(teamContext.member).toBeNull();
    expect(teamContext.members).toEqual([]);
    expect(teamContext.serverName).toBe('');
    // surfaces 值域里的 id 一律不隐藏——渲染层行为与现状一致（逐 PR 验收项）。
    for (const id of ['remote', 'extension-center', 'computer-use', 'bot-create', 'workdir-pick']) {
      expect(teamContext.isTeamHidden(id)).toBe(false);
    }
    expect(teamContext.memberById('mbr_self')).toBeNull();
    expect(teamContext.memberState('mbr_self')).toBe('offline');
  });

  it('bootstrap 失败（服务器拒绝 / 断线）保持休眠', async () => {
    h.setResponder(() => {
      throw new Error('FORBIDDEN');
    });
    teamContext.begin();
    await vi.waitFor(() => expect(h.calls.some((c) => c.method === 'team.bootstrap')).toBe(true));
    expect(teamContext.active).toBe(false);
    expect(teamContext.isTeamHidden('remote')).toBe(false);
  });
});

describe('团队上下文激活（T5）', () => {
  it('bootstrap 填充成员 / surfaces / 上限，名册经 team.members.list', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    expect(teamContext.member?.id).toBe('mbr_self');
    expect(teamContext.serverName).toBe('Acme 团队');
    expect(teamContext.permissionCeiling).toBe('auto');
    expect(teamContext.members.map((m) => m.id)).toEqual(['mbr_self', 'mbr_peer']);
    expect(h.calls.some((c) => c.method === 'team.members.list')).toBe(true);
    // surfaces 门控：被隐藏的入口 true，其余 false。
    expect(teamContext.isTeamHidden('remote')).toBe(true);
    expect(teamContext.isTeamHidden('extension-center')).toBe(true);
    expect(teamContext.isTeamHidden('computer-use')).toBe(true);
    expect(teamContext.isTeamHidden('models')).toBe(false);
    expect(teamContext.isTeamHidden('bot-create')).toBe(false);
  });

  it('重连（onConnected）后自动重拉 bootstrap', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    h.calls.length = 0;
    h.emitConnected();
    await vi.waitFor(() =>
      expect(h.calls.some((c) => c.method === 'team.bootstrap')).toBe(true),
    );
  });

  it('member.presenceChanged 增量刷新在线状态', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    h.emitTeamEvent('member.presenceChanged', {
      memberId: 'mbr_peer',
      state: 'online',
      lastSeenAt: 999,
    });
    const peer = teamContext.memberById('mbr_peer');
    expect(peer?.state).toBe('online');
    expect(peer?.lastSeenAt).toBe(999);
    // 自己的状态也随事件更新。
    h.emitTeamEvent('member.presenceChanged', { memberId: 'mbr_self', state: 'away' });
    expect(teamContext.member?.state).toBe('away');
    expect(teamContext.memberState('mbr_peer')).toBe('online');
  });

  it('member.updated / member.disabled 触发名册重拉', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    h.setResponder((method) => {
      if (method === 'team.members.list') {
        return { members: [SELF] }; // 对端被禁用：名册里不再出现
      }
      if (method === 'team.bootstrap') return bootstrapPayload();
      throw new Error(`unexpected method ${method}`);
    });
    h.emitTeamEvent('member.updated', { memberId: 'mbr_peer' });
    await vi.waitFor(() =>
      expect(teamContext.members.map((m) => m.id)).toEqual(['mbr_self']),
    );
    h.emitTeamEvent('member.disabled', { memberId: 'mbr_peer' });
    await vi.waitFor(() => h.calls.filter((c) => c.method === 'team.members.list').length >= 2);
    expect(teamContext.memberById('mbr_peer')).toBeNull();
  });

  it('reset 回到休眠（会话失效后团队面全部消失）', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    expect(teamContext.isTeamHidden('remote')).toBe(true);
    teamContext.reset();
    expect(teamContext.active).toBe(false);
    expect(teamContext.members).toEqual([]);
    expect(teamContext.isTeamHidden('remote')).toBe(false);
  });

  it('begin 幂等：重复调用不重复拉 bootstrap', async () => {
    stubBootstrap();
    teamContext.begin();
    await vi.waitFor(() => expect(teamContext.active).toBe(true));
    const bootstrapCalls = h.calls.filter((c) => c.method === 'team.bootstrap').length;
    teamContext.begin();
    expect(h.calls.filter((c) => c.method === 'team.bootstrap').length).toBe(bootstrapCalls);
  });
});
