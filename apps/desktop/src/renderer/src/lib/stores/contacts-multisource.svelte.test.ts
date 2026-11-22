import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 通讯录多来源（T7 步骤 3，62.04 §1 双源名册）：
 * - 本机名册（bots.list / conversations.all，既有路径）不变；
 * - 已融合团队来源经 team.bootstrap / team.members.list / bots.list /
 *   conversations.all 填充 teamSources[serverHash]；
 * - id 碰撞隔离：同 id 本机 / 团队会话各归各的名册；
 * - Bot / 成员 / dm 对端按来源解析；断开后切片转「未连接」占位。
 */

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  state: {
    bots: [] as unknown[],
    conversations: [] as unknown[],
  },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    connection: 'connected',
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    onConnected: () => () => undefined,
    call: async (method: string) => {
      if (method === 'bots.list') return { bots: state.bots };
      if (method === 'conversations.all' || method === 'conversations.list') {
        return { conversations: state.conversations };
      }
      return { ok: true };
    },
    callTeam: async () => {
      throw new Error('no team context on local source in this file');
    },
  },
}));

// --- 团队端口假实现（birpc 帧：q / s / 事件推送） -------------------------------

class FakePort {
  #listener: ((event: { data: unknown }) => void) | null = null;
  #other: FakePort | null = null;
  connect(other: FakePort): void {
    this.#other = other;
  }
  postMessage(data: unknown): void {
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

function conversationRow(id: string, type: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type,
    title: type === 'project' ? `项目-${id}` : null,
    directBotId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
    peerPrincipalIds: type === 'dm' ? ['mbr_self', 'mbr_peer'] : undefined,
    ...overrides,
  };
}

const TEAM = {
  serverHash: 'h1',
  bootstrap: {
    member: { id: 'mbr_self', displayName: '沈知微', state: 'online' },
    server: { name: 'Acme 团队', version: '1.0.0' },
    surfaces: { hidden: [] },
    conversations: [],
    permissionCeiling: 'auto',
  },
  members: {
    members: [
      { id: 'mbr_self', displayName: '沈知微', state: 'online' },
      { id: 'mbr_peer', displayName: '同事乙', state: 'away', avatarBotName: '管家' },
    ],
  },
  bots: {
    bots: [
      {
        id: 'team_bot_1',
        name: '团队 Bot',
        status: 'active',
        avatar: null,
        setupState: null,
        profile: { runtime: { model: '', agent: { id: '' } } },
      },
    ],
  },
  conversations: {
    conversations: [
      // 与本机故意同 id：id 碰撞隔离断言。
      conversationRow('c1', 'project', { title: '团队项目' }),
      conversationRow('dm_1', 'dm'),
    ],
  },
};

const h = vi.hoisted(() => ({
  teamHandlers: {} as Record<string, (input: unknown) => unknown>,
  serverCalls: [] as string[],
}));

let pushTeamEvent: (name: string, payload: unknown) => void = () => undefined;

function attachTeam(): void {
  const clientPort = new FakePort();
  const serverPort = new FakePort();
  clientPort.connect(serverPort);
  serverPort.connect(clientPort);
  serverPort.addEventListener('message', ({ data }) => {
    const frame = data as { m: string; a: unknown[]; t: string; i?: string };
    if (frame.t !== 'q') return;
    h.serverCalls.push(frame.m);
    const handler = h.teamHandlers[frame.m];
    if (frame.i === undefined) return;
    serverPort.postMessage({
      t: 's',
      i: frame.i,
      ...(handler === undefined ? { e: new Error('not found') } : { r: handler(frame.a[0]) }),
    });
  });
  const { connections } = rpcModule;
  connections.attachTeamPort(TEAM.serverHash, clientPort as unknown as MessagePort);
  pushTeamEvent = (name, payload) => {
    serverPort.postMessage({ m: name, a: [payload], t: 'q' });
  };
}

const rpcModule = await import('$lib/rpc/connections.svelte');
const { contacts } = await import('./contacts.svelte');

beforeEach(() => {
  handlers.clear();
  state.bots = [
    {
      id: 'local_bot_1',
      name: '本机 Bot',
      status: 'active',
      avatar: null,
      setupState: null,
      profile: { runtime: { model: '', agent: { id: '' } } },
    },
  ];
  state.conversations = [conversationRow('c1', 'project', { title: '本机项目' })];
  h.teamHandlers = {
    'team.bootstrap': () => TEAM.bootstrap,
    'team.members.list': () => TEAM.members,
    'bots.list': () => TEAM.bots,
    'conversations.all': () => TEAM.conversations,
    'team.dm.open': () => ({ conversation: conversationRow('dm_1', 'dm') }),
  };
  h.serverCalls = [];
  rpcModule.connections.reset();
  contacts.start();
  // 本机名册随用例自定（模块单例跨用例保留，这里复位）。
  contacts.bots = [];
  contacts.conversations = [];
});

describe('未融合（休眠）', () => {
  it('teamSources 恒空，本机名册照常', async () => {
    await contacts.refresh();
    expect(Object.keys(contacts.teamSources)).toEqual([]);
    expect(contacts.bots.map((bot) => bot.id)).toEqual(['local_bot_1']);
    expect(contacts.projects.map((project) => project.title)).toEqual(['本机项目']);
  });
});

describe('团队来源接入', () => {
  it('bootstrap + members + bots + conversations 填充切片', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1).toBeDefined());
    const slice = contacts.teamSources.h1!;
    expect(slice.connected).toBe(true);
    expect(slice.serverName).toBe('Acme 团队');
    expect(slice.self?.id).toBe('mbr_self');
    expect(slice.members.map((member) => member.id)).toEqual(['mbr_self', 'mbr_peer']);
    expect(slice.bots.map((bot) => bot.id)).toEqual(['team_bot_1']);
    expect(slice.conversations.map((conversation) => conversation.id)).toEqual(['c1', 'dm_1']);
    // 本机名册不受团队接入影响（同 id 各归各）。
    expect(contacts.bots.map((bot) => bot.id)).toEqual([]);
    expect(contacts.projects).toEqual([]);
  });

  it('id 碰撞隔离：同 id 的本机 / 团队会话各归各的名册（refresh 后仍成立）', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.conversations.length).toBe(2));
    await contacts.refresh();
    expect(contacts.conversations.map((conversation) => conversation.id)).toEqual(['c1']);
    expect((contacts.conversations[0] as { title: string }).title).toBe('本机项目');
    const teamRow = contacts.teamSources.h1!.conversations.find((row) => row.id === 'c1');
    expect((teamRow as { title: string }).title).toBe('团队项目');
  });

  it('Bot / 成员 / dm 对端按来源解析', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.members.length).toBe(2));
    const source = 'team:h1' as const;
    expect(contacts.botAt(source, 'team_bot_1')?.name).toBe('团队 Bot');
    expect(contacts.botAt(source, 'local_bot_1')).toBeNull();
    expect(contacts.teamMemberById(source, 'mbr_peer')?.state).toBe('away');
    const peer = contacts.dmPeerViewOf(source, ['mbr_self', 'mbr_peer']);
    expect(peer.title).toBe('同事乙');
    expect(peer.state).toBe('away');
    // 离开态提示带分身名（T6 的 presence avatar 字段）。
    expect(peer.awayNote).toContain('管家');
    // 自我会话：标题用「我」的服务端显示名（2026-11 与真人条目同口径）。
    const self = contacts.dmPeerViewOf(source, ['mbr_self']);
    expect(self.peerId).toBeNull();
    expect(self.title).toBe('沈知微');
  });

  it('openTeamDm 经团队连接（team.dm.open），返回带来源的引用', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.connected).toBe(true));
    const ref = await contacts.openTeamDm('team:h1', 'mbr_peer');
    expect(ref).toEqual({ source: 'team:h1', id: 'dm_1' });
    expect(h.serverCalls).toContain('team.dm.open');
  });

  it('member.presenceChanged 增量刷新团队名册（经团队端口的事件帧）', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.members.length).toBe(2));
    pushTeamEvent('member.presenceChanged', { memberId: 'mbr_peer', state: 'online' });
    await vi.waitFor(() => {
      const peer = contacts.teamSources.h1?.members.find((member) => member.id === 'mbr_peer');
      expect(peer?.state).toBe('online');
    });
    // 本机名册不受团队 presence 事件影响。
    expect(contacts.members).toEqual([]);
  });

  // 成员 Bot 能力面（member-bots B4 审查期合并校正）：桌面融合来源的
  // team.bootstrap 消费要写 team-bots store——否则桌面端建 Bot 对话框降级
  //（无公共档 / 无配额，必修项实证缺口）。
  it('bootstrap.botCapabilities → team-bots store（桌面融合来源）', async () => {
    const caps = { canCreatePublicBot: true, privateBotsUsed: 2, privateBotsLimit: 10 };
    h.teamHandlers['team.bootstrap'] = () => ({ ...TEAM.bootstrap, botCapabilities: caps });
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.connected).toBe(true));
    const { botCapabilitiesOf, teamBots } = await import('$lib/features/team/team-bots.svelte');
    expect(botCapabilitiesOf('team:h1')).toEqual(caps);
    // 成员 id 一并写入（myPrivateBotsOf 的 owner 过滤依赖它）。
    expect(teamBots.selfMemberIdOf('team:h1')).toBe('mbr_self');
    teamBots.reset();
  });

  it('旧服务器缺省 botCapabilities → null 降级（不残留 undefined）', async () => {
    attachTeam();
    await vi.waitFor(() => expect(contacts.teamSources.h1?.connected).toBe(true));
    const { botCapabilitiesOf, teamBots } = await import('$lib/features/team/team-bots.svelte');
    expect(botCapabilitiesOf('team:h1')).toBe(null);
    teamBots.reset();
  });
});
