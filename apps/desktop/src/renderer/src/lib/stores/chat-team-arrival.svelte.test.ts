import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@kepcup/shared';

/**
 * DEV-146 口径统一：本机列表路径（`chat.svelte.ts`，T5 web 同源模式经它渲染
 * 团队会话）的到达判定与 T7 团队切片（chat-team）一致——
 * - 团队上下文（teamContext.member 就绪）：仅自己回声静默；其他成员的人类
 *   消息计未读；`principal:<自己>` 计提及并提醒（62.04 §4「人类 @ = 通知」，
 *   不看发送方是人还是 Bot，只排除自己的回声）；
 * - 无主体上下文（单用户本机）：「senderType='user' 一律静默」现行为不变，
 *   提及不计数、不提醒（安全缺省）。
 *
 * 团队切片路径的到达判定已有 chat-session-source.svelte.test.ts 覆盖；共享
 * 判定函数 teamMessageArrival 的纯函数面在 unread.test.ts。
 */

const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: toastMock }));

const h = vi.hoisted(() => ({
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
  teamHandlers: new Map<string, Set<(payload: unknown) => void>>(),
  conversations: [] as unknown[],
  localMessages: [] as unknown[],
  bootstrap: null as unknown,
}));

function emit(event: string, payload: unknown): void {
  for (const handler of h.handlers.get(event) ?? []) handler(payload);
}

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      let set = h.handlers.get(name);
      if (!set) {
        set = new Set();
        h.handlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onTeamEvent: (name: string, handler: (payload: unknown) => void) => {
      let set = h.teamHandlers.get(name);
      if (!set) {
        set = new Set();
        h.teamHandlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    onConnected: () => () => undefined,
    call: async (method: string) => {
      if (method === 'conversations.list') return { conversations: h.conversations };
      if (method === 'conversations.get') return { conversation: h.conversations[0] ?? null };
      if (method === 'messages.list') return { messages: h.localMessages };
      if (method === 'runs.list') return { runs: [] };
      if (method === 'tasks.active') return { tasks: [] };
      if (method === 'approvals.list') return { approvals: [] };
      if (method === 'grants.list') return { grants: [] };
      if (method === 'conversations.members') return { members: [] };
      return { ok: true };
    },
    callTeam: async (method: string) => {
      if (method === 'team.bootstrap') {
        if (h.bootstrap === null) throw new Error('no team context in this test');
        return h.bootstrap;
      }
      if (method === 'team.members.list') return { members: [] };
      throw new Error(`unexpected team call: ${method}`);
    },
  },
}));

const { chat } = await import('./chat.svelte');
const { teamContext } = await import('../features/team/team-context.svelte');
const { messageVisibility } = await import('./message-visibility.svelte');
const { voiceMode } = await import('../features/chats/voice-mode.svelte');

function conversationRow(id: string): Record<string, unknown> {
  return {
    id,
    type: 'project',
    title: '团队项目',
    directBotId: null,
    workdirId: null,
    workdirName: null,
    parentProjectId: null,
    cardTodoId: null,
    readOnly: false,
    archivedAt: null,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
    unreadCount: 0,
    runningBotIds: [],
  };
}

function teamMessage(overrides: Record<string, unknown>): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    senderType: 'bot',
    senderBotId: 'bot_1',
    kind: 'text',
    content: { text: '你好' },
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 模拟 T5 web 团队端点：登录响应带 member → teamContext.begin() 拉 bootstrap。 */
async function beginTeamContext(): Promise<void> {
  h.bootstrap = {
    member: { id: 'mbr_self', displayName: '我', state: 'online' },
    server: { name: '团队服务器', version: '0.0.0' },
    surfaces: { hidden: [] },
    conversations: [],
    permissionCeiling: 'manual',
  };
  teamContext.begin();
  await vi.waitFor(() => expect(teamContext.active).toBe(true));
}

async function seedList(): Promise<void> {
  h.conversations = [conversationRow('c1')];
  await chat.refresh();
}

beforeEach(() => {
  h.conversations = [];
  h.localMessages = [];
  h.bootstrap = null;
  toastMock.info.mockClear();
  teamContext.reset();
  // Hidden-overlay state is process-global; clear ids used by these tests so a
  // failed assertion cannot leak a mask into the next test.
  for (const conversationId of ['c1', 'pending-bootstrap']) {
    messageVisibility.forget('local', conversationId);
  }
  chat.conversations = [];
  chat.mentionCounts = {};
  chat.start();
});

describe('DEV-146：web 团队上下文（本机列表路径）的到达口径', () => {
  it('其他成员的人类消息计未读（不再「user 一律静默」）', async () => {
    await beginTeamContext();
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm1',
        seq: 2,
        senderType: 'user',
        senderPrincipalId: 'mbr_peer',
        senderName: '同事',
      }),
    });
    await vi.waitFor(() => {
      const row = chat.conversations.find((c) => c.id === 'c1');
      expect(row?.unreadCount).toBe(1);
    });
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('自己的回声静默：不计未读、不计提及、不提醒（自己 @ 自己的回声也不提醒）', async () => {
    await beginTeamContext();
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm2',
        seq: 2,
        senderType: 'user',
        senderPrincipalId: 'mbr_self',
        mentions: ['principal:mbr_self'],
      }),
    });
    await tick();
    const row = chat.conversations.find((c) => c.id === 'c1');
    expect(row?.unreadCount ?? 0).toBe(0);
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('人类 @ 计提及并提醒；Bot 消息 @ 同样计（不看发送方，只排除自己的回声）', async () => {
    await beginTeamContext();
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm3',
        seq: 2,
        senderType: 'user',
        senderPrincipalId: 'mbr_peer',
        mentions: ['principal:mbr_self'],
      }),
    });
    await vi.waitFor(() => expect(chat.mentionCounts['c1']).toBe(1));
    const row = chat.conversations.find((c) => c.id === 'c1');
    expect(row?.unreadCount).toBe(1);
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    // Bot 消息里的 @ 同样计提及并提醒（与 chat-team 口径一致）。
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm4',
        seq: 3,
        senderType: 'bot',
        mentions: ['principal:mbr_self'],
      }),
    });
    await vi.waitFor(() => expect(chat.mentionCounts['c1']).toBe(2));
    expect(chat.conversations.find((c) => c.id === 'c1')?.unreadCount).toBe(2);
    expect(toastMock.info).toHaveBeenCalledTimes(2);
  });

  it('hidden mentioned messages update unread state without a toast or leaked preview', async () => {
    await beginTeamContext();
    await seedList();
    const message = teamMessage({
      id: 'hidden-mentioned',
      seq: 2,
      mentions: ['principal:mbr_self'],
      content: { text: 'HIDDEN_MENTION_TEXT' },
    });
    messageVisibility.forget('local', 'c1');
    messageVisibility.setHidden('local', 'c1', message.id, true);
    emit('message.created', { conversationId: 'c1', message });
    await vi.waitFor(() =>
      expect(chat.conversations.find((c) => c.id === 'c1')?.unreadCount).toBe(1),
    );
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(chat.lastMessageText['c1']).toBe('该消息已被您隐藏');
    expect(chat.lastMessageText['c1']).not.toContain('HIDDEN_MENTION_TEXT');
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'hidden-preview-system',
        seq: 3,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      }),
    });
    await tick();
    expect(chat.conversations.find((c) => c.id === 'c1')?.lastPreviewSeq).toBe(2);
    expect(chat.lastMessageText['c1']).toBe('该消息已被您隐藏');
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'hidden-preview-visible', seq: 4, content: { text: 'visible' } }),
    });
    await vi.waitFor(() => {
      expect(chat.conversations.find((c) => c.id === 'c1')?.lastPreviewSeq).toBe(4);
      expect(chat.lastMessageText['c1']).toBe('visible');
    });
    messageVisibility.forget('local', 'c1');
  });

  it('clears a stale hidden preview mask when a refreshed list has a newer preview', async () => {
    await beginTeamContext();
    await seedList();
    messageVisibility.setPreviewHidden('local', 'c1', true, 1, 'old-hidden');
    h.conversations = [
      { ...conversationRow('c1'), lastPreviewSeq: 2, lastMessageText: 'newer preview' },
    ];
    await chat.refresh();
    expect(messageVisibility.previewHidden('local', 'c1')).toBe(false);
    expect(chat.lastMessageText['c1']).toBe('newer preview');
  });

  it('mail/watch/workdir system events preview their text without leaking hidden content', async () => {
    await beginTeamContext();
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'status-notice',
        seq: 2,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'mail_status', text: '3 封新邮件' },
      }),
    });
    await vi.waitFor(() => {
      expect(chat.conversations.find((c) => c.id === 'c1')?.lastPreviewSeq).toBe(2);
      expect(chat.lastMessageText['c1']).toContain('3 封新邮件');
    });

    const hiddenNotice = teamMessage({
      id: 'status-hidden',
      seq: 3,
      senderType: 'system',
      senderBotId: null,
      kind: 'system_event',
      content: { event: 'workdir', text: 'SECRET_WORKDIR_NOTICE' },
    });
    messageVisibility.setHidden('local', 'c1', hiddenNotice.id, true);
    emit('message.created', { conversationId: 'c1', message: hiddenNotice });
    await vi.waitFor(() => {
      expect(chat.conversations.find((c) => c.id === 'c1')?.lastPreviewSeq).toBe(3);
      expect(chat.lastMessageText['c1']).toBe('该消息已被您隐藏');
    });
    expect(chat.lastMessageText['c1']).not.toContain('SECRET_WORKDIR_NOTICE');
  });

  it('别人的消息 @ 别人：只计未读不计提及', async () => {
    await beginTeamContext();
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm5',
        seq: 2,
        senderType: 'user',
        senderPrincipalId: 'mbr_peer',
        mentions: ['principal:mbr_other'],
      }),
    });
    await vi.waitFor(() => {
      const row = chat.conversations.find((c) => c.id === 'c1');
      expect(row?.unreadCount).toBe(1);
    });
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
  });
});

describe('same-origin team identity bootstrap', () => {
  it('keeps content, previews, replies, and voice fail-closed until the member is known', async () => {
    let resolveBootstrap!: (value: unknown) => void;
    h.bootstrap = new Promise((resolve) => {
      resolveBootstrap = resolve;
    });
    teamContext.begin();
    expect(teamContext.endpointIsTeam).toBe(true);
    expect(teamContext.member).toBeNull();

    const conversationId = 'pending-bootstrap';
    const bot = teamMessage({
      id: 'pending-bot',
      conversationId,
      seq: 1,
      content: { text: 'pending bot content' },
    });
    h.conversations = [conversationRow(conversationId)];
    h.localMessages = [bot];
    messageVisibility.forget('local', conversationId);
    await chat.refresh();
    await chat.select(conversationId);
    expect(chat.currentId).toBe(conversationId);
    expect(chat.main.messages[0]?.hidden).toBe(true);
    expect(chat.lastMessageText[conversationId]).toBe('该消息已被您隐藏');
    chat.main.startReply(chat.main.messages[0]!);
    expect(chat.main.replyTo).toBeNull();
    expect(chat.main.setMessageHidden(bot.id, false)).toBe(false);
    expect(chat.main.messages[0]?.hidden).toBe(true);

    voiceMode.enter(conversationId);
    const forwarded: string[] = [];
    const stop = chat.main.onIncomingMessage((_id, message) => forwarded.push(message.id));
    try {
      emit('message.created', {
        conversationId,
        message: teamMessage({
          id: 'pending-incoming',
          conversationId,
          seq: 2,
          content: { text: 'must not be voiced yet' },
        }),
      });
      expect(forwarded).toEqual([]);

      resolveBootstrap({
        member: { id: 'mbr_self', displayName: '我', state: 'online' },
        server: { name: '团队服务器', version: '0.0.0' },
        surfaces: { hidden: [] },
        conversations: [],
        permissionCeiling: 'manual',
      });
      await vi.waitFor(() => expect(teamContext.active).toBe(true));
      expect(chat.currentId).toBe(conversationId);
      expect(chat.main.messages[0]?.hidden).toBeUndefined();
      expect(chat.lastMessageText[conversationId]).toBe('must not be voiced yet');
      chat.main.startReply(chat.main.messages[0]!);
      expect(chat.main.replyTo?.id).toBe(bot.id);

      emit('message.created', {
        conversationId,
        message: teamMessage({
          id: 'known-incoming',
          conversationId,
          seq: 3,
          content: { text: 'safe to voice' },
        }),
      });
      expect(forwarded).toEqual(['known-incoming']);

      h.conversations = [];
      teamContext.member = { id: 'mbr_other', displayName: '其他成员', state: 'online' };
      expect(chat.current).toBeNull();
      expect(voiceMode.active).toBe(false);
      await vi.waitFor(() => expect(chat.conversations).toEqual([]));
    } finally {
      stop();
      voiceMode.exit();
      messageVisibility.forget('local', conversationId);
    }
  });
});

describe('DEV-146：无主体上下文（单用户本机）口径不变', () => {
  it('user 消息一律静默（现有行为）；Bot 消息照常计未读', async () => {
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'm6', seq: 2, senderType: 'user' }),
    });
    await tick();
    const row = chat.conversations.find((c) => c.id === 'c1');
    expect(row?.unreadCount ?? 0).toBe(0);
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({ id: 'm7', seq: 3, senderType: 'bot' }),
    });
    await vi.waitFor(() => {
      const row = chat.conversations.find((c) => c.id === 'c1');
      expect(row?.unreadCount).toBe(1);
    });
  });

  it('user 消息即使带 principal 提及也不计提及、不提醒（无「自己是谁」可判）', async () => {
    await seedList();
    emit('message.created', {
      conversationId: 'c1',
      message: teamMessage({
        id: 'm8',
        seq: 2,
        senderType: 'user',
        mentions: ['principal:mbr_self'],
      }),
    });
    await tick();
    const row = chat.conversations.find((c) => c.id === 'c1');
    expect(row?.unreadCount ?? 0).toBe(0);
    expect(chat.mentionCounts['c1']).toBeUndefined();
    expect(toastMock.info).not.toHaveBeenCalled();
  });
});
