import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMember } from '@kepcup/shared';

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
    /** team.* 方法的响应桩（T5 dm 用例）。 */
    teamResponder: null as null | ((method: string, input: unknown) => unknown),
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
    callTeam: async (method: string, input?: unknown) => {
      state.calls.push(method);
      if (state.teamResponder === null) throw new Error('no team responder');
      return state.teamResponder(method, input);
    },
  },
}));

const { contacts } = await import('./contacts.svelte');
const { chat } = await import('./chat.svelte');
const { teamContext } = await import('$lib/features/team/team-context.svelte');

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
  state.teamResponder = null;
  contacts.bots = [];
  contacts.conversations = [];
  chat.conversations = [];
  // 团队上下文回休眠（其余用例不依赖它）。
  teamContext.active = false;
  teamContext.member = null;
  teamContext.members = [];
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

  it('ignores a card conversation update', () => {
    contacts.start();
    handlers.get('conversation.updated')?.({
      conversation: {
        ...directConversation('conv_card', 'bot_a'),
        type: 'card',
        parentProjectId: 'conv_p',
        cardTodoId: 'todo_1',
      },
    });
    expect(contacts.conversations.map((conversation) => conversation.id)).not.toContain('conv_card');
  });

  it('ignores a bot_direct exchange conversation update（v2.3）', () => {
    contacts.start();
    handlers.get('conversation.updated')?.({
      conversation: {
        ...directConversation('conv_ex', 'bot_a'),
        type: 'bot_direct',
        fromBotId: 'bot_a',
        toBotId: 'bot_b',
      },
    });
    expect(contacts.conversations.map((conversation) => conversation.id)).not.toContain('conv_ex');
  });

  it('归档事件即时更新名册', async () => {
    contacts.start();
    handlers.get('conversation.updated')?.({
      conversation: projectConversation('conv_p1', '项目组一', 789),
    });
    expect(contacts.projects[0]?.archivedAt).toBe(789);
  });
});

/**
 * 团队成员名册（T5）：非团队上下文恒空数组（休眠铁律）；团队上下文下
 * contacts 暴露 teamContext 的名册与 self（数据源在 team-context 统一拉取），
 * openDm 走 team.dm.open 打开（自我会话发空对象帧——birpc 零参在服务端收到
 * undefined，strictObject 会拒，见 2026-11 修复）。
 */
describe('团队成员名册（T5）', () => {
  const SELF: TeamMember = { id: 'mbr_self', displayName: '甲', state: 'online' };
  const PEER: TeamMember = { id: 'mbr_peer', displayName: '乙', state: 'offline' };

  it('非团队上下文：members / self 恒空（即使团队上下文里有残留数据）', () => {
    teamContext.members = [PEER];
    expect(contacts.members).toEqual([]);
    expect(contacts.self).toBeNull();
  });

  it('团队上下文：members 与 self 透传 teamContext', () => {
    teamContext.active = true;
    teamContext.member = SELF;
    teamContext.members = [SELF, PEER];
    expect(contacts.members.map((m) => m.id)).toEqual(['mbr_self', 'mbr_peer']);
    expect(contacts.self?.id).toBe('mbr_self');
    teamContext.active = false;
  });

  it('openDm：对端成员带 targetMemberId 调 team.dm.open', async () => {
    teamContext.active = true;
    state.teamResponder = (method, input) => {
      expect(method).toBe('team.dm.open');
      expect(input).toEqual({ targetMemberId: 'mbr_peer' });
      return { conversation: { id: 'conv_dm1', type: 'dm' } };
    };
    await expect(contacts.openDm('mbr_peer')).resolves.toBe('conv_dm1');
  });

  it('openDm：无目标（自我会话）发空对象帧（零参会被服务端 strictObject 拒）', async () => {
    teamContext.active = true;
    state.teamResponder = (method, input) => {
      expect(method).toBe('team.dm.open');
      expect(input).toEqual({});
      return { conversation: { id: 'conv_self', type: 'dm' } };
    };
    await expect(contacts.openDm()).resolves.toBe('conv_self');
  });

  it('非团队上下文 openDm 不发请求直接返回 null', async () => {
    await expect(contacts.openDm('mbr_peer')).resolves.toBeNull();
    expect(state.calls).not.toContain('team.dm.open');
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

  it('does not put a card conversation in the sidebar', () => {
    chat.start();
    handlers.get('conversation.updated')?.({
      conversation: {
        ...projectConversation('conv_card', '卡片'),
        type: 'card',
        directBotId: 'bot_a',
        leadBotId: null,
        parentProjectId: 'conv_p',
        cardTodoId: 'todo_1',
      },
    });
    expect(chat.conversations.map((conversation) => conversation.id)).not.toContain('conv_card');
  });

  it('恢复事件把会话放回左栏', () => {
    chat.start();
    handlers.get('conversation.updated')?.({
      conversation: projectConversation('conv_p1', '项目组一', null),
    });
    expect(chat.conversations.map((c) => c.id)).toContain('conv_p1');
  });
});
