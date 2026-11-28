import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@kepcup/shared';
import { t } from '$lib/i18n';

/**
 * ChatSession 的来源化（T7 步骤 3）：
 * - `chat.select({source:'team:<hash>', id})` 经团队连接取数（本机 core 不被
 *   触及），会话视图照常装好；
 * - 发送（messages.send）走团队连接，client 标记用该来源的协作身份；
 * - 团队事件只更新团队切片；同 id 本机 / 团队各一条互不干扰（id 碰撞隔离）；
 * - 被提及（mentions 含 `principal:<自己>`）在团队切片上落提及角标。
 */

const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: toastMock }));

const h = vi.hoisted(() => ({
  localHandlers: new Map<string, Set<(payload: unknown) => void>>(),
  localCalls: [] as string[],
  teamHandlers: {} as Record<string, (input: unknown) => unknown>,
  teamCalls: [] as string[],
  activeMemberId: 'mbr_self' as string | null,
}));

function emitLocal(event: string, payload: unknown): void {
  for (const handler of h.localHandlers.get(event) ?? []) handler(payload);
}

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    connection: 'connected',
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      let set = h.localHandlers.get(name);
      if (!set) {
        set = new Set();
        h.localHandlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onConnected: () => () => undefined,
    call: async (method: string) => {
      h.localCalls.push(method);
      if (method === 'conversations.list') return { conversations: localState.conversations };
      if (method === 'conversations.get') {
        return { conversation: localState.conversations[0] ?? null };
      }
      if (method === 'messages.list') return { messages: [] };
      if (method === 'runs.list') return { runs: [] };
      if (method === 'tasks.active') return { tasks: [] };
      if (method === 'approvals.list') return { approvals: [] };
      if (method === 'grants.list') return { grants: [] };
      if (method === 'permissions.mode.get') {
        return {
          conversationId: 'c1',
          mode: 'manual',
          source: 'conversation',
          inheritedFrom: null,
          enabledAt: null,
          until: null,
        };
      }
      return { ok: true };
    },
    callTeam: async () => {
      throw new Error('local source has no team context in this file');
    },
  },
}));

const localState = vi.hoisted(() => ({ conversations: [] as unknown[] }));

function teamMessage(overrides: Record<string, unknown>): Message {
  return {
    id: 'tm1',
    conversationId: 'c1',
    seq: 1,
    senderType: 'bot',
    senderBotId: 'team_bot_1',
    kind: 'text',
    content: { text: '来自团队' },
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
    ...overrides,
  } as Message;
}

// --- 团队端口假实现（birpc 帧） -------------------------------------------------

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

let pushTeamEvent: (name: string, payload: unknown) => void = () => undefined;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function teamConversation(id: string, type: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type,
    title: type === 'project' ? `团队项目-${id}` : null,
    directBotId: type === 'direct' ? 'team_bot_1' : null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
    bot:
      type === 'direct'
        ? {
            id: 'team_bot_1',
            name: '团队 Bot',
            status: 'active',
            avatar: null,
            setupState: null,
            profile: { runtime: { model: '', agent: { id: '' } } },
          }
        : undefined,
    peerPrincipalIds: type === 'dm' ? ['mbr_self', 'mbr_peer'] : undefined,
    ...overrides,
  };
}

function attachTeam(): void {
  const clientPort = new FakePort();
  const serverPort = new FakePort();
  clientPort.connect(serverPort);
  serverPort.connect(clientPort);
  serverPort.addEventListener('message', ({ data }) => {
    const frame = data as { m: string; a: unknown[]; t: string; i?: string };
    if (frame.t !== 'q') return;
    h.teamCalls.push(frame.m);
    const handler = h.teamHandlers[frame.m];
    if (frame.i === undefined) return;
    if (handler === undefined) {
      serverPort.postMessage({ t: 's', i: frame.i, e: new Error('not found') });
      return;
    }
    const result = handler(frame.a[0]);
    if (result instanceof Promise) {
      void result.then(
        (value) => serverPort.postMessage({ t: 's', i: frame.i, r: value }),
        (error: unknown) => serverPort.postMessage({ t: 's', i: frame.i, e: error }),
      );
      return;
    }
    serverPort.postMessage({ t: 's', i: frame.i, r: result });
  });
  rpc.connections.attachTeamPort('h1', clientPort as unknown as MessagePort, h.activeMemberId);
  pushTeamEvent = (name, payload) => {
    serverPort.postMessage({ m: name, a: [payload], t: 'q' });
  };
}

const rpc = await import('$lib/rpc/connections.svelte');
const { chat } = await import('./chat.svelte');
const { permissions } = await import('./permissions.svelte');
const { messageVisibility } = await import('./message-visibility.svelte');
const { voiceMode } = await import('../features/chats/voice-mode.svelte');
const { speechAudio } = await import('../features/chats/speech-audio.svelte');

beforeEach(() => {
  h.localCalls = [];
  h.teamCalls = [];
  h.activeMemberId = 'mbr_self';
  // Hidden-overlay state is process-global; clear the ids these tests use so a
  // failed assertion cannot leak a mask into the next test.
  messageVisibility.forget('local', 'c1');
  messageVisibility.forget('team:h1', 'c1');
  // 事件注册表跨用例保留（订阅方在模块单例里只挂一次；清掉会让它们失联）。
  localState.conversations = [];
  h.teamHandlers = {
    'conversations.get': () => ({ conversation: teamConversation('c1', 'direct') }),
    'conversations.list': () => ({ conversations: [teamConversation('c1', 'direct')] }),
    'messages.list': () => ({ messages: [] }),
    'runs.list': () => ({ runs: [] }),
    'approvals.list': () => ({ approvals: [] }),
    'grants.list': () => ({ grants: [] }),
    'permissions.mode.get': () => ({
      conversationId: 'c1',
      mode: 'manual',
      source: 'conversation',
      inheritedFrom: null,
      enabledAt: null,
      until: null,
    }),
    'conversations.markRead': () => ({ ok: true }),
    'messages.send': () => ({ ok: true }),
  };
  toastMock.info.mockClear();
  rpc.connections.reset();
  // 活跃成员（提及判定与协作身份用）。
  rpc.connections.servers = [
    {
      serverHash: 'h1',
      url: 'https://team.example.com',
      name: '',
      accounts: [{ memberId: 'mbr_self', username: 'a', displayName: '我', remembered: true }],
      activeMemberId: 'mbr_self',
      status: 'connected',
    },
  ];
  chat.start();
});

describe('团队会话取数与收发', () => {
  it('select(团队 ref) 经团队连接取数，本机 core 不被触及', async () => {
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    expect(chat.currentId).toBe('c1');
    expect(chat.currentSource).toBe('team:h1');
    expect(h.teamCalls).toContain('conversations.get');
    expect(h.teamCalls).toContain('messages.list');
    expect(h.teamCalls).toContain('approvals.list');
    expect(h.localCalls).toEqual([]);
    // 本机左栏不含团队会话；团队切片含。
    expect(chat.conversations).toEqual([]);
    expect(chat.team.slices.h1?.conversations.map((row) => row.id)).toContain('c1');
  });

  it('字符串 id 仍是本机来源（既有调用点语义不变）', async () => {
    localState.conversations = [teamConversation('c1', 'direct')];
    await chat.refresh();
    await chat.select('c1');
    expect(chat.currentSource).toBe('local');
    expect(h.localCalls).toContain('conversations.get');
    expect(h.teamCalls).toEqual([]);
  });

  it('send 走团队连接，client 标记用该来源身份', async () => {
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    const result = await chat.send('c1', '你好');
    expect(result).toEqual({ ok: true });
    const send = h.teamCalls.filter((method) => method === 'messages.send');
    expect(send).toHaveLength(1);
    expect(h.localCalls).toEqual([]);
  });
});

describe('事件隔离与提及角标（id 碰撞：本机 / 团队同 id 各一条）', () => {
  it('团队事件只进团队切片；本机事件只进本机左栏', async () => {
    // 本机与会话同 id c1。
    localState.conversations = [teamConversation('c1', 'direct')];
    await chat.refresh();
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    await chat.leaveCurrent();

    // 团队端口推 c1 的新消息 → 团队切片未读 +1，本机左栏不动。
    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 't1', seq: 2 }),
    });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.unreadCount).toBe(1);
    });
    expect(chat.conversations[0]?.unreadCount ?? 0).toBe(0);

    // 本机 core 推 c1 的新消息 → 本机左栏未读 +1，团队切片不动。
    emitLocal('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'l1', seq: 3 }),
    });
    await vi.waitFor(() => {
      expect(chat.conversations[0]?.unreadCount).toBe(1);
    });
    const teamRow = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
    expect(teamRow?.unreadCount).toBe(1);
  });

  it('keeps same-id local events out of an open team view while preserving local forwarding', async () => {
    localState.conversations = [teamConversation('c1', 'direct')];
    await chat.refresh();
    const teamRow = teamMessage({ id: 'team-only', seq: 1, content: { text: 'team preview' } });
    h.teamHandlers['messages.list'] = () => ({ messages: [teamRow] });
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    pushTeamEvent('message.created', { conversationId: 'c1', message: teamRow });
    await vi.waitFor(() => expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('team preview'));

    messageVisibility.forget('local', 'c1');
    messageVisibility.setHidden('local', 'c1', 'local-hidden', true);
    const forwarded: Array<{ conversationId: string; message: Message }> = [];
    const stop = chat.main.onIncomingMessage((conversationId, message) => {
      forwarded.push({ conversationId, message });
    });
    try {
      emitLocal('message.created', {
        conversationId: 'c1',
        message: teamMessage({ id: 'local-hidden', seq: 2, content: { text: 'LOCAL_SECRET' } }),
      });
      emitLocal('message.created', {
        conversationId: 'c1',
        message: teamMessage({ id: 'local-visible', seq: 3, content: { text: 'local visible' } }),
      });
      await tick();

      expect(chat.main.messages.map((message) => message.id)).toEqual(['team-only']);
      expect(chat.main.conversation?.lastPreviewSeq).toBe(1);
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('team preview');
      expect(forwarded.map((entry) => entry.message.id)).toEqual(['local-visible']);
      expect(chat.conversations.find((row) => row.id === 'c1')?.unreadCount).toBe(2);
    } finally {
      stop();
      messageVisibility.forget('local', 'c1');
    }
  });

  it('hard-clears an open account, rejects stale refreshes, and reloads the new account slice', async () => {
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    expect(chat.currentId).toBe('c1');
    voiceMode.enter('c1');
    const stopAudio = vi.spyOn(speechAudio, 'stop');
    let resolveOldList!: (value: { conversations: unknown[] }) => void;
    const oldList = new Promise<{ conversations: unknown[] }>((resolve) => {
      resolveOldList = resolve;
    });
    h.teamHandlers['conversations.list'] = () => oldList;
    attachTeam();
    await vi.waitFor(() =>
      expect(
        h.teamCalls.filter((method) => method === 'conversations.list').length,
      ).toBeGreaterThan(1),
    );

    const connection = rpc.connections.get('team:h1');
    (connection as unknown as { memberId: string | null }).memberId = 'mbr_other';
    expect(chat.current).toBeNull();
    expect(chat.team.slices.h1?.conversations).toEqual([]);
    expect(voiceMode.active).toBe(false);
    expect(stopAudio).toHaveBeenCalled();

    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'old-port-after-switch', seq: 2 }),
    });
    await tick();
    expect(chat.team.slices.h1?.conversations).toEqual([]);

    h.activeMemberId = 'mbr_other';
    h.teamHandlers['conversations.list'] = () => ({
      conversations: [teamConversation('c2', 'direct')],
    });
    attachTeam();
    resolveOldList({ conversations: [teamConversation('c1', 'direct')] });
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.conversations.map((row) => row.id)).toEqual(['c2']),
    );
    await tick();
    expect(chat.team.slices.h1?.conversations.map((row) => row.id)).toEqual(['c2']);
    stopAudio.mockRestore();
    voiceMode.exit();
  });

  it('team previews ignore later system events and advance only on previewable rows', async () => {
    attachTeam();
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true);
    });
    messageVisibility.forget('team:h1', 'c1');
    messageVisibility.setHidden('team:h1', 'c1', 'team-preview-hidden', true);
    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'team-preview-hidden', seq: 2 }),
    });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.lastPreviewSeq).toBe(2);
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe(t('messages.hidden'));
    });
    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'team-system',
        seq: 3,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      }),
    });
    await tick();
    let row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
    expect(row?.lastPreviewSeq).toBe(2);
    expect(chat.team.slices.h1?.lastMessageText['c1']).toBe(t('messages.hidden'));

    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'team-preview-visible', seq: 4, content: { text: 'visible' } }),
    });
    await vi.waitFor(() => {
      row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.lastPreviewSeq).toBe(4);
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('visible');
    });
    chat.team.applyMessagePreview('team:h1', 'c1', null);
    expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('');
    expect(
      chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1')?.lastPreviewSeq,
    ).toBeUndefined();
    messageVisibility.forget('team:h1', 'c1');
  });

  it('reconciles team previews after recall and edit instead of keeping a stale placeholder', async () => {
    attachTeam();
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true),
    );
    const previous = teamMessage({ id: 'preview-previous', seq: 1, content: { text: 'previous' } });
    const latest = teamMessage({ id: 'preview-latest', seq: 2, content: { text: 'latest' } });
    let serverMessages: Message[] = [previous, latest];
    h.teamHandlers['messages.list'] = () => ({ messages: serverMessages });
    pushTeamEvent('message.created', { conversationId: 'c1', message: previous });
    pushTeamEvent('message.created', { conversationId: 'c1', message: latest });
    await vi.waitFor(() => expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('latest'));

    const recalled = { ...latest, status: 'recalled' as const };
    serverMessages = [previous, recalled];
    pushTeamEvent('message.updated', { conversationId: 'c1', message: recalled });
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('previous');
      expect(
        chat.team.slices.h1?.conversations.find((row) => row.id === 'c1')?.lastPreviewSeq,
      ).toBe(1);
    });

    const edited = { ...previous, status: 'edited' as const, content: { text: 'edited previous' } };
    serverMessages = [edited, recalled];
    pushTeamEvent('message.updated', { conversationId: 'c1', message: edited });
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('edited previous'),
    );
  });

  it('keeps a hidden preview outside a full system-event window masked after message.updated', async () => {
    attachTeam();
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true),
    );
    messageVisibility.forget('team:h1', 'c1');
    messageVisibility.setHidden('team:h1', 'c1', 'team-preview-hidden', true);
    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'team-preview-hidden',
        seq: 2,
        content: { text: 'HIDDEN_ORIGINAL' },
      }),
    });
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe(t('messages.hidden'));
    });

    // The newest 60 rows are all system events, so the previewable hidden row
    // sits outside the loaded window: an empty preview result is not authoritative.
    h.teamHandlers['messages.list'] = () => ({
      messages: Array.from({ length: 60 }, (_, index) =>
        teamMessage({
          id: `system-${index}`,
          seq: 10 + index,
          senderType: 'system',
          senderBotId: null,
          kind: 'system_event',
          content: { event: 'run_done', text: 'done' },
        }),
      ),
    });
    let listCalls = h.teamCalls.filter((method) => method === 'messages.list').length;
    // Only a row that owned the preview is re-read: recalling the hidden
    // preview row itself. An unrelated system event must not trigger an RPC.
    pushTeamEvent('message.updated', {
      conversationId: 'c1',
      message: { ...teamMessage({ id: 'team-preview-hidden', seq: 2 }), status: 'recalled' },
    });
    await vi.waitFor(() =>
      expect(h.teamCalls.filter((method) => method === 'messages.list').length).toBe(listCalls + 1),
    );
    await tick();
    let row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
    expect(row?.lastPreviewSeq).toBe(2);
    expect(chat.team.slices.h1?.lastMessageText['c1']).toBe(t('messages.hidden'));
    expect(messageVisibility.previewHidden('team:h1', 'c1')).toBe(true);
    // A system-event update that owned no preview does not re-read.
    pushTeamEvent('message.updated', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'system-59',
        seq: 69,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      }),
    });
    await tick();
    await tick();
    expect(h.teamCalls.filter((method) => method === 'messages.list').length).toBe(listCalls + 1);

    // A complete window (fewer than 60 rows) is authoritative: the mask clears.
    h.teamHandlers['messages.list'] = () => ({ messages: [] });
    listCalls = h.teamCalls.filter((method) => method === 'messages.list').length;
    pushTeamEvent('message.updated', {
      conversationId: 'c1',
      message: { ...teamMessage({ id: 'team-preview-hidden', seq: 2 }), status: 'recalled' },
    });
    await vi.waitFor(() =>
      expect(h.teamCalls.filter((method) => method === 'messages.list').length).toBe(listCalls + 1),
    );
    await vi.waitFor(() => {
      row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.lastPreviewSeq).toBeUndefined();
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('');
      expect(messageVisibility.previewHidden('team:h1', 'c1')).toBe(false);
    });
    messageVisibility.forget('team:h1', 'c1');
  });

  it('keeps team row preview metadata across conversation.updated events that omit it', async () => {
    attachTeam();
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true),
    );
    messageVisibility.forget('team:h1', 'c1');
    messageVisibility.setHidden('team:h1', 'c1', 'row-preview-hidden', true);
    pushTeamEvent('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'row-preview-hidden', seq: 2, content: { text: 'SECRET' } }),
    });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.lastPreviewSeq).toBe(2);
    });
    pushTeamEvent('conversation.updated', { conversation: teamConversation('c1', 'direct') });
    await tick();
    const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
    expect(row?.lastPreviewSeq).toBe(2);
    expect(chat.team.slices.h1?.lastMessageText['c1']).toBe(t('messages.hidden'));
    messageVisibility.forget('team:h1', 'c1');
  });

  it('discards a slow preview re-read superseded by a newer message', async () => {
    attachTeam();
    await vi.waitFor(() =>
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true),
    );
    messageVisibility.forget('team:h1', 'c1');
    const previous = teamMessage({ id: 'slow-previous', seq: 1, content: { text: 'previous' } });
    const latest = teamMessage({ id: 'slow-latest', seq: 2, content: { text: 'latest' } });
    h.teamHandlers['messages.list'] = () => ({ messages: [previous, latest] });
    pushTeamEvent('message.created', { conversationId: 'c1', message: previous });
    pushTeamEvent('message.created', { conversationId: 'c1', message: latest });
    await vi.waitFor(() => expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('latest'));

    // Recall the preview row; the re-read is slow and will return the old window.
    let resolveSlow!: (value: { messages: Message[] }) => void;
    h.teamHandlers['messages.list'] = () =>
      new Promise<{ messages: Message[] }>((resolve) => {
        resolveSlow = resolve;
      });
    pushTeamEvent('message.updated', {
      conversationId: 'c1',
      message: { ...latest, status: 'recalled' },
    });
    // Let the coalesced re-read start before the newer message arrives.
    await tick();
    expect(h.teamCalls.filter((method) => method === 'messages.list').length).toBeGreaterThan(0);
    const newer = teamMessage({ id: 'slow-newer', seq: 3, content: { text: 'newer' } });
    pushTeamEvent('message.created', { conversationId: 'c1', message: newer });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1');
      expect(row?.lastPreviewSeq).toBe(3);
      expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('newer');
    });

    // The stale response must not resurrect the recalled preview.
    resolveSlow({ messages: [previous] });
    await tick();
    await tick();
    expect(chat.team.slices.h1?.lastMessageText['c1']).toBe('newer');
    expect(
      chat.team.slices.h1?.conversations.find((entry) => entry.id === 'c1')?.lastPreviewSeq,
    ).toBe(3);
    messageVisibility.forget('team:h1', 'c1');
  });

  it('被 @（principal:<自己>）在团队切片落提及角标并提醒', async () => {
    attachTeam();
    // 先等首拉（conversations.list）落定，再经事件长出 dm_1——顺序与生产一致
    //（bind → onConnected → 首拉，事件增量随后叠加）。
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true);
    });
    pushTeamEvent('conversation.updated', {
      conversation: teamConversation('dm_1', 'dm'),
    });
    await tick();
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'dm_1')).toBe(true);
    });
    pushTeamEvent('message.created', {
      conversationId: 'dm_1',
      message: teamMessage({
        id: 't2',
        conversationId: 'dm_1',
        seq: 5,
        mentions: ['principal:mbr_self'],
      }),
    });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'dm_1');
      expect(row?.mentionCount).toBe(1);
    });
    // 提及提醒（通知发送点；免打扰抑制在 team-settings 测试覆盖）。
    await vi.waitFor(() => expect(toastMock.info).toHaveBeenCalled());
  });

  it('未被 @ 只进未读不提醒；其他成员的 @（人类发送）计数；自己的 @ 回声不算（62.04 §4）', async () => {
    attachTeam();
    await vi.waitFor(() => {
      expect(chat.team.slices.h1?.conversations.some((row) => row.id === 'c1')).toBe(true);
    });
    pushTeamEvent('conversation.updated', {
      conversation: teamConversation('dm_2', 'dm'),
    });
    await tick();
    // Bot 消息（无提及）→ 未读 +1，无 toast。
    pushTeamEvent('message.created', {
      conversationId: 'dm_2',
      message: teamMessage({ id: 't3', conversationId: 'dm_2', seq: 6, mentions: [] }),
    });
    // 其他成员（人类 sender）@ 我 → 未读 +1、提及 +1、提醒。
    pushTeamEvent('message.created', {
      conversationId: 'dm_2',
      message: teamMessage({
        id: 't4',
        conversationId: 'dm_2',
        seq: 7,
        senderType: 'user',
        senderPrincipalId: 'mbr_peer',
        mentions: ['principal:mbr_self'],
      }),
    });
    await vi.waitFor(() => {
      const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'dm_2');
      expect(row?.mentionCount).toBe(1);
      expect(row?.unreadCount).toBe(2);
    });
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    // 自己消息的 @ 回声 → 静默（未读 / 提及 / toast 都不动）。
    pushTeamEvent('message.created', {
      conversationId: 'dm_2',
      message: teamMessage({
        id: 't5',
        conversationId: 'dm_2',
        seq: 8,
        senderType: 'user',
        senderPrincipalId: 'mbr_self',
        mentions: ['principal:mbr_self'],
      }),
    });
    await tick();
    const row = chat.team.slices.h1?.conversations.find((entry) => entry.id === 'dm_2');
    expect(row?.mentionCount).toBe(1);
    expect(row?.unreadCount).toBe(2);
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('断开占位：切片清空、不伪造数据', async () => {
    attachTeam();
    await chat.select({ source: 'team:h1', id: 'c1' });
    expect(chat.team.slices.h1?.conversations.length).toBeGreaterThan(0);
    await rpc.connections.requestDisconnect('h1');
    await rpc.connections.get('team:h1').markOffline(false);
    // markDisconnected 由刷新路径触发；这里直接验证离线后的团队切片表现。
    const status = rpc.connections.get('team:h1').status;
    expect(status === 'offline' || status === 'reconnecting').toBe(true);
    chat.team.markDisconnected('h1');
    expect(chat.team.slices.h1?.conversations).toEqual([]);
  });
});

describe('审批按来源路由', () => {
  it('团队会话的审批列表经团队连接拉取；决定经团队连接裁决', async () => {
    attachTeam();
    h.teamHandlers['approvals.list'] = () => ({
      approvals: [
        {
          id: 'apv_1',
          conversationId: 'c1',
          botId: 'team_bot_1',
          kind: 'mcp_tool',
          payload: {},
          status: 'pending',
          createdAt: 1,
          decidedBy: null,
          decidedAt: null,
        },
      ],
    });
    await chat.select({ source: 'team:h1', id: 'c1' });
    expect(permissions.pendingOf('c1')).toHaveLength(1);
    expect(h.teamCalls).toContain('approvals.list');
    h.teamHandlers['approvals.decide'] = () => ({
      approval: {
        id: 'apv_1',
        conversationId: 'c1',
        status: 'approved',
        decidedBy: { id: 'mbr_self', name: '我' },
      },
    });
    await permissions.decide('apv_1', true);
    expect(h.teamCalls).toContain('approvals.decide');
    expect(h.localCalls).toEqual([]);
  });
});
