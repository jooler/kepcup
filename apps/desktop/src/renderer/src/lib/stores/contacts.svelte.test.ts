import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 通讯录名册与「从对话列表移除」（归档）：
 * - 通讯录里能看到项目组（含已归档的），Bot 的直聊被移除过时能看出状态；
 * - 归档事件把会话从左栏摘掉，恢复事件把它放回去。
 */

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  state: {
    bots: [] as unknown[],
    conversations: [] as unknown[],
    calls: [] as string[],
  },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    call: async (method: string) => {
      state.calls.push(method);
      if (method === 'bots.list') return { bots: state.bots };
      if (method === 'conversations.all') return { conversations: state.conversations };
      if (method === 'conversations.list') return { conversations: state.conversations };
      return { ok: true };
    },
  },
}));

const { contacts } = await import('./contacts.svelte');
const { chat } = await import('./chat.svelte');

function directConversation(id: string, botId: string, archivedAt: number | null = null) {
  return {
    id,
    type: 'direct',
    title: null,
    directBotId: botId,
    workdirId: null,
    readOnly: false,
    archivedAt,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
  };
}

function projectConversation(id: string, title: string, archivedAt: number | null = null) {
  return {
    id,
    type: 'project',
    title,
    goal: null,
    directBotId: null,
    leadBotId: 'bot_a',
    workdirId: null,
    readOnly: false,
    archivedAt,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 2,
    memberPreviews: [{ id: 'bot_a', name: '甲', avatar: null }],
  };
}

beforeEach(() => {
  state.bots = [];
  state.conversations = [];
  state.calls = [];
  contacts.bots = [];
  contacts.conversations = [];
  chat.conversations = [];
});

describe('通讯录名册', () => {
  it('列出项目组（含已归档的）', async () => {
    state.conversations = [
      projectConversation('conv_p1', '项目组一'),
      projectConversation('conv_p2', '项目组二', 123),
    ];
    await contacts.refresh();
    expect(contacts.projects.map((p) => p.id)).toEqual(['conv_p1', 'conv_p2']);
    expect(contacts.projects[1]?.archivedAt).toBe(123);
  });

  it('标出直聊已被移除的 Bot', async () => {
    state.bots = [{ id: 'bot_a', name: '甲', status: 'active' }];
    state.conversations = [directConversation('conv_a', 'bot_a', 456)];
    await contacts.refresh();
    expect(contacts.isChatArchived('bot_a')).toBe(true);
    expect(contacts.archivedChatOf('bot_a')?.id).toBe('conv_a');
    expect(contacts.isChatArchived('bot_b')).toBe(false);
  });

  it('归档事件即时更新名册', async () => {
    contacts.start();
    handlers.get('conversation.updated')?.({
      conversation: projectConversation('conv_p1', '项目组一', 789),
    });
    expect(contacts.projects[0]?.archivedAt).toBe(789);
  });
});

describe('左栏的归档与恢复', () => {
  it('归档事件把会话从左栏摘掉', () => {
    chat.start();
    chat.conversations = [projectConversation('conv_p1', '项目组一') as never];
    handlers.get('conversation.updated')?.({
      conversation: projectConversation('conv_p1', '项目组一', 999),
    });
    expect(chat.conversations.map((c) => c.id)).not.toContain('conv_p1');
  });

  it('恢复事件把会话放回左栏', () => {
    chat.start();
    handlers.get('conversation.updated')?.({
      conversation: projectConversation('conv_p1', '项目组一', null),
    });
    expect(chat.conversations.map((c) => c.id)).toContain('conv_p1');
  });
});
