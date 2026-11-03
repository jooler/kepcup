import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 侧栏会话缓存的事件路径（v2.3）：bot_direct 委派交换会话只经药丸详情的
 * dialog session 呈现——conversation.updated 推送不得把它插进左栏（启动拉
 * 取的列表 core 侧已排除 bot_direct，这里是事件路径的对应过滤）。
 */

const { handlers, state } = vi.hoisted(() => ({
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
  state: { calls: [] as string[] },
}));

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (name: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
      return () => set.delete(handler);
    },
    call: async (method: string) => {
      state.calls.push(method);
      return { conversations: [], conversation: null, messages: [], ok: true };
    },
  },
}));

const { chat } = await import('./chat.svelte');

function conversationRow(type: string, id: string): Record<string, unknown> {
  return {
    id,
    type,
    title: null,
    directBotId: type === 'direct' ? 'bot_a' : null,
    workdirId: null,
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
    ...(type === 'direct' ? { bot: { id: 'bot_a', name: '甲', status: 'active' } } : {}),
  };
}

const emit = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};

beforeEach(() => {
  state.calls.length = 0;
  chat.conversations = [];
  chat.start();
});

describe('侧栏事件路径（v2.3）', () => {
  it('bot_direct 交换会话的更新不进左栏', () => {
    emit('conversation.updated', { conversation: conversationRow('bot_direct', 'conv_ex') });
    expect(chat.conversations.map((c) => c.id)).not.toContain('conv_ex');
  });

  it('普通直聊的更新照常进左栏（对照）', () => {
    emit('conversation.updated', { conversation: conversationRow('direct', 'conv_a') });
    expect(chat.conversations.map((c) => c.id)).toContain('conv_a');
  });
});
