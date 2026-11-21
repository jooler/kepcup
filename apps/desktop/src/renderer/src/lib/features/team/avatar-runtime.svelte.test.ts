import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 离开态分身运行时（T10）的行为断言（core 单例 / connections 全 mock，无网络）：
 * - 防环是硬护栏：origin='avatar' / Bot 消息 / 自己的回声一律不触发；
 * - 限频：每会话 2 分钟 1 条 + 每来源每小时 10 条（注入时钟）；
 * - 休眠：web 端点 / 未连接来源不注册（零事件订阅）；
 * - 代回经团队连接 messages.send（origin='avatar' + avatar.botName + client），
 *   生成走本机连接 bots.composeReply；
 * - 回归摘要：回来后 notify「代回 N 条」，计数清零（本机 storage 注入）。
 */

const h = vi.hoisted(() => {
  type Handler = (payload: unknown) => void;
  const endpointKind = { value: 'desktop' as 'desktop' | 'remote' };
  interface FakeConnection {
    status: 'connected' | 'offline';
    memberId: string | null;
    clientIdentity: { id: string; name: string; connectionId: string; color: string };
    handlers: Map<string, Set<Handler>>;
    connectedHandlers: Set<() => void>;
    calls: Array<{ method: string; input: unknown }>;
    responders: Map<string, (input: unknown) => unknown>;
    call(method: string, input?: unknown): Promise<unknown>;
    onEvent(event: string, handler: Handler): () => void;
    onTeamEvent(name: string, handler: Handler): () => void;
    onConnected(handler: () => void): () => void;
    emit(event: string, payload: unknown): void;
    respondWith(method: string, fn: (input: unknown) => unknown): void;
  }
  const connections: Record<string, FakeConnection> = {};
  const registeredSourcesListeners = new Set<() => void>();
  /** 事件订阅台账（休眠断言用：总数为 0 = 零订阅）。 */
  const subscriptionCount = (): number =>
    Object.values(connections).reduce(
      (total, connection) =>
        total +
        [...connection.handlers.values()].reduce((sum, set) => sum + set.size, 0) +
        connection.connectedHandlers.size,
      0,
    );
  return {
    endpointKind,
    connections,
    registeredSourcesListeners,
    subscriptionCount,
    makeConnection(
      id: string,
      options: { status?: 'connected' | 'offline'; memberId?: string | null } = {},
    ): FakeConnection {
      const connection: FakeConnection = {
        status: options.status ?? 'connected',
        memberId: options.memberId ?? null,
        clientIdentity: {
          id: `${id}-client`,
          name: '这台设备',
          connectionId: 'conn-1',
          color: '#123456',
        },
        handlers: new Map(),
        connectedHandlers: new Set(),
        calls: [],
        responders: new Map(),
        call(method: string, input?: unknown) {
          connection.calls.push({ method, input });
          const responder = connection.responders.get(method);
          if (responder === undefined) throw new Error(`no responder for ${method}`);
          return Promise.resolve(responder(input));
        },
        onEvent(event: string, handler: Handler) {
          let set = connection.handlers.get(event);
          if (!set) {
            set = new Set();
            connection.handlers.set(event, set);
          }
          set.add(handler);
          return () => set!.delete(handler);
        },
        onTeamEvent(name: string, handler: Handler) {
          return connection.onEvent(name, handler);
        },
        onConnected(handler: () => void) {
          connection.connectedHandlers.add(handler);
          return () => connection.connectedHandlers.delete(handler);
        },
        emit(event: string, payload: unknown) {
          for (const handler of connection.handlers.get(event) ?? []) handler(payload);
        },
        respondWith(method: string, fn: (input: unknown) => unknown) {
          connection.responders.set(method, fn);
        },
      };
      return connection;
    },
  };
});

vi.mock('$lib/features/web-shell/endpoint', () => ({
  get ENDPOINT_KIND() {
    return h.endpointKind.value;
  },
  endpointSupports: () => true,
}));

vi.mock('$lib/rpc/connections.svelte', () => ({
  connections: {
    sources: () =>
      Object.keys(h.connections).map((id) => (id === 'local' ? 'local' : `team:${id}`)),
    get: (source: string) =>
      source === 'local'
        ? h.connections.local
        : (h.connections[source.slice('team:'.length)] ?? {
            status: 'offline',
            memberId: null,
            clientIdentity: { id: 'unknown', name: '', connectionId: '', color: '' },
            handlers: new Map(),
            connectedHandlers: new Set(),
            calls: [],
            call: async () => {
              throw new Error('not connected');
            },
            onEvent: () => () => {},
            onTeamEvent: () => () => {},
            onConnected: () => () => {},
          }),
    onSourcesChanged: (callback: () => void) => {
      h.registeredSourcesListeners.add(callback);
      return () => h.registeredSourcesListeners.delete(callback);
    },
    serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  },
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
}));

vi.mock('$lib/stores/contacts.svelte', () => ({
  contacts: {
    teamSelfOf: (source: string) =>
      source === 'local'
        ? null
        : { id: 'mbr_self', displayName: '张三', state: 'away', avatarBotName: '管家' },
    teamMemberById: (_source: string, memberId: string) =>
      memberId === 'mbr_peer' ? { id: memberId, displayName: '李四', state: 'online' } : null,
  },
}));

vi.mock('$lib/i18n', () => ({
  t: (key: string, params?: Record<string, string>) =>
    `${key}${params !== undefined ? `:${JSON.stringify(params)}` : ''}`,
}));

vi.mock('svelte-sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

const { AvatarRuntime, AVATAR_COOLDOWN_MS, AVATAR_HOURLY_LIMIT } =
  await import('./avatar-runtime.svelte');

const SOURCE = 'team:hash1';

function messageOf(fields: {
  id?: string;
  senderType?: 'user' | 'bot' | 'system';
  senderPrincipalId?: string | null;
  origin?: string;
  text?: string;
}): Record<string, unknown> {
  return {
    id: fields.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    conversationId: 'dm1',
    seq: 1,
    senderType: fields.senderType ?? 'user',
    senderBotId: null,
    kind: 'text',
    content: {
      text: fields.text ?? '在吗',
      ...(fields.origin !== undefined ? { origin: fields.origin } : {}),
    },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    senderPrincipalId: fields.senderPrincipalId ?? 'mbr_peer',
    senderName: '李四',
  };
}

function stubConversationAndTranscript(): void {
  const team = h.connections['hash1']!;
  team.respondWith('conversations.get', () => ({
    conversation: { id: 'dm1', type: 'dm', peerPrincipalIds: ['mbr_peer', 'mbr_self'] },
  }));
  team.respondWith('messages.list', () => ({
    messages: [
      messageOf({ text: '在吗', senderPrincipalId: 'mbr_peer' }),
      messageOf({ text: '刚看到', senderPrincipalId: 'mbr_peer', id: 'msg_peer_2' }),
    ],
  }));
}

beforeEach(() => {
  h.endpointKind.value = 'desktop';
  h.connections.local = h.makeConnection('local');
  h.connections.hash1 = h.makeConnection('hash1', { memberId: 'mbr_self' });
  h.registeredSourcesListeners.clear();
  // 本机 Bot 清单（管家 + 一个普通 Bot）。
  h.connections.local.respondWith('bots.list', () => ({
    bots: [
      {
        id: 'bot_helper',
        profile: { identity: { name: '助手' } },
        systemRole: null,
        status: 'active',
      },
      {
        id: 'bot_butler',
        profile: { identity: { name: '管家' } },
        systemRole: 'butler',
        status: 'active',
      },
    ],
  }));
  stubConversationAndTranscript();
  h.connections.local.respondWith('bots.composeReply', () => ({ text: '我暂时不在，稍后回复。' }));
  h.connections['hash1']!.respondWith('messages.send', () => ({ ok: true }));
});

describe('休眠（未连接 / web 端点不注册）', () => {
  it('web 端点：start 与 activate 都不注册任何事件订阅', () => {
    h.endpointKind.value = 'remote';
    const runtime = new AvatarRuntime();
    runtime.start();
    runtime.activate(SOURCE, '');
    expect(h.subscriptionCount()).toBe(0);
    expect(runtime.isActive(SOURCE)).toBe(false);
  });

  it('未连接来源：activate 拒绝（零订阅）；start 后无来源也零订阅', () => {
    h.connections.hash1!.status = 'offline';
    const runtime = new AvatarRuntime();
    runtime.start();
    runtime.activate(SOURCE, '');
    expect(runtime.isActive(SOURCE)).toBe(false);
    expect(h.subscriptionCount()).toBe(0);
  });

  it('桌面 + 已连接但未激活：start 本身零订阅（休眠铁律）', () => {
    const runtime = new AvatarRuntime();
    runtime.start();
    expect(h.subscriptionCount()).toBe(0);
  });
});

describe('激活与代回管线', () => {
  it('激活后订阅团队事件；他人 dm 文本触发 composeReply（本机连接）+ 代回（团队连接带标注）', async () => {
    const runtime = new AvatarRuntime();
    runtime.start();
    runtime.activate(SOURCE, '');
    expect(runtime.isActive(SOURCE)).toBe(true);
    // 防环之外的正向路径先就位：他人纯文本。
    h.connections['hash1']!.emit('message.created', {
      conversationId: 'dm1',
      message: messageOf({ senderPrincipalId: 'mbr_peer' }),
    });
    await vi.waitFor(() => {
      expect(h.connections['hash1']!.calls.some((call) => call.method === 'messages.send')).toBe(
        true,
      );
    });
    // 生成走本机连接，代发走团队连接且标注齐全。
    const compose = h.connections.local!.calls.find((call) => call.method === 'bots.composeReply');
    expect(compose).toBeDefined();
    expect((compose!.input as { botId: string }).botId).toBe('bot_butler'); // '' = 缺省管家
    const transcript = (compose!.input as { transcript: Array<{ speaker: string; text: string }> })
      .transcript;
    expect(transcript[0]).toMatchObject({ speaker: '李四', text: '在吗' });
    const send = h.connections['hash1']!.calls.find((call) => call.method === 'messages.send');
    expect(send).toBeDefined();
    const sendInput = send!.input as {
      origin?: string;
      avatar?: { botName: string };
      client?: { id: string };
    };
    expect(sendInput.origin).toBe('avatar');
    expect(sendInput.avatar).toEqual({ botName: '管家' });
    expect(sendInput.client).toMatchObject({ id: 'hash1-client' });
    // instructions 模板带上双方名字。
    expect((compose!.input as { instructions: string }).instructions).toContain('张三');
    expect((compose!.input as { instructions: string }).instructions).toContain('李四');
  });

  it('防环：avatar 消息 / Bot 消息 / 自己的回声一律不触发（硬护栏）', async () => {
    const runtime = new AvatarRuntime();
    runtime.start();
    runtime.activate(SOURCE, '');
    const team = h.connections['hash1']!;
    // 分身代回的消息（origin avatar）——不回。
    team.emit('message.created', {
      conversationId: 'dm1',
      message: messageOf({ senderPrincipalId: 'mbr_peer', origin: 'avatar' }),
    });
    // Bot 消息——不回。
    team.emit('message.created', {
      conversationId: 'dm1',
      message: messageOf({ senderType: 'bot', senderPrincipalId: null, text: 'Bot 说话' }),
    });
    // 自己的回声——不回。
    team.emit('message.created', {
      conversationId: 'dm1',
      message: messageOf({ senderPrincipalId: 'mbr_self' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(team.calls.some((call) => call.method === 'messages.send')).toBe(false);
    expect(h.connections.local!.calls.some((call) => call.method === 'bots.composeReply')).toBe(
      false,
    );
    // 非 dm 会话同样零行为。
    team.respondWith('conversations.get', () => ({
      conversation: { id: 'proj1', type: 'project', peerPrincipalIds: [] },
    }));
    team.emit('message.created', {
      conversationId: 'proj1',
      message: messageOf({ senderPrincipalId: 'mbr_peer' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(team.calls.some((call) => call.method === 'messages.send')).toBe(false);
  });
});

describe('限频（注入时钟）', () => {
  it('每会话 2 分钟 1 条；每小时 10 条封顶', async () => {
    let now = 1_000_000;
    const runtime = new AvatarRuntime({
      now: () => now,
    });
    runtime.start();
    runtime.activate(SOURCE, '');
    const team = h.connections['hash1']!;
    const peerMessage = (): unknown => ({
      conversationId: 'dm1',
      message: messageOf({ senderPrincipalId: 'mbr_peer' }),
    });

    team.emit('message.created', peerMessage());
    await vi.waitFor(() =>
      expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(1),
    );
    // 冷却期内的第二条：不发。
    now += AVATAR_COOLDOWN_MS - 1_000;
    team.emit('message.created', peerMessage());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(1);
    // 冷却过后的第二条：发（不同会话也不受影响——这里同会话走冷却）。
    now += 1_001;
    team.emit('message.created', peerMessage());
    await vi.waitFor(() =>
      expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(2),
    );
    // 小时窗封顶：再发 8 条（每次跨过冷却），第 10 条之后不再发。
    for (let index = 2; index < AVATAR_HOURLY_LIMIT; index += 1) {
      now += AVATAR_COOLDOWN_MS + 1_000;
      team.emit('message.created', peerMessage());
      await vi.waitFor(() =>
        expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(
          index + 1,
        ),
      );
    }
    now += AVATAR_COOLDOWN_MS + 1_000;
    team.emit('message.created', peerMessage());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(
      AVATAR_HOURLY_LIMIT,
    );
    // 一小时后窗口滑出：恢复发送。
    now += 60 * 60_000;
    team.emit('message.created', peerMessage());
    await vi.waitFor(() =>
      expect(team.calls.filter((call) => call.method === 'messages.send')).toHaveLength(
        AVATAR_HOURLY_LIMIT + 1,
      ),
    );
  });
});

describe('停用与回归摘要', () => {
  it('avatarRevoked 定向撤销：命中自己的 clientId 才停用；回来（presence online）出代回摘要并清零计数', async () => {
    const notes: string[] = [];
    const memoryStorage = {
      data: new Map<string, string>(),
      getItem: (key: string) => memoryStorage.data.get(key) ?? null,
      setItem: (key: string, value: string) => void memoryStorage.data.set(key, value),
      removeItem: (key: string) => void memoryStorage.data.delete(key),
    };
    const runtime = new AvatarRuntime({
      storage: memoryStorage,
      notify: (message: string) => void notes.push(message),
    });
    runtime.start();
    runtime.activate(SOURCE, '');
    const team = h.connections['hash1']!;
    // 代回一条 → 计数 1。
    team.emit('message.created', {
      conversationId: 'dm1',
      message: messageOf({ senderPrincipalId: 'mbr_peer' }),
    });
    await vi.waitFor(() =>
      expect(team.calls.some((call) => call.method === 'messages.send')).toBe(true),
    );

    // 定向撤销给别人：不停用。
    team.emit('team.avatarRevoked', { memberId: 'mbr_self', targetClientId: 'other-client' });
    expect(runtime.isActive(SOURCE)).toBe(true);
    // 定向撤销给自己：停用（接管场景，不出摘要）。
    team.emit('team.avatarRevoked', { memberId: 'mbr_self', targetClientId: 'hash1-client' });
    expect(runtime.isActive(SOURCE)).toBe(false);
    expect(notes).toHaveLength(0);

    // 重新激活 → 回来（presence online）：停用 + 摘要带计数，计数清零。
    runtime.activate(SOURCE, '');
    team.emit('member.presenceChanged', { memberId: 'mbr_self', state: 'away' });
    team.emit('member.presenceChanged', { memberId: 'mbr_self', state: 'online' });
    expect(runtime.isActive(SOURCE)).toBe(false);
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]).toContain('avatarSummaryToast');
    expect(notes[0]).toContain('"1"');
    // 再次回来：计数已清零，不再出摘要。
    runtime.activate(SOURCE, '');
    team.emit('member.presenceChanged', { memberId: 'mbr_self', state: 'online' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toHaveLength(1);
  });
});
