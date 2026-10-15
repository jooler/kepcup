import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 工作台主视图的收口不变式（D90 §5.1）：只有 `chat.select()` 把 `shell.mainView` 置回
 * 'chats'；打开工作台只改 mainView、不清 currentId。真实的 chat / shell store
 * （desktop-svelte 项目），core 用最小替身。
 */

const conversation = (id: string) => ({
  id,
  type: 'direct',
  title: null,
  directBotId: `bot_${id}`,
  projectId: null,
  readOnly: false,
  summary: null,
  summaryUptoSeq: 0,
  lastSeq: 0,
  lastReadSeq: 0,
  lastMessageAt: null,
  createdAt: 1,
  bot: null,
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: () => () => undefined,
    call: async (method: string, params?: { id?: string }) => {
      switch (method) {
        case 'conversations.get':
          return { conversation: params?.id === 'missing' ? null : conversation(params?.id ?? '') };
        case 'messages.list':
          return { messages: [] };
        case 'runs.list':
          return { runs: [] };
        case 'tasks.active':
          return { tasks: [] };
        case 'approvals.list':
          return { approvals: [] };
        case 'grants.list':
          return { grants: [] };
        default:
          return {};
      }
    },
  },
}));

const { chat } = await import('./chat.svelte');
const { shell } = await import('./shell.svelte');

beforeEach(() => {
  shell.mainView = 'chats';
  chat.cancelGroupCompose();
});

describe('shell.mainView 与 chat.select', () => {
  it('默认是对话；openWorkbench 只改 mainView，不清当前会话', async () => {
    expect(shell.mainView).toBe('chats');
    await chat.select('c1');
    shell.openWorkbench();
    expect(shell.mainView).toBe('workbench');
    expect(chat.currentId).toBe('c1');
    expect(chat.current?.conversation.id).toBe('c1');
  });

  it('chat.select 把 mainView 收回对话（含重新选当前会话）', async () => {
    await chat.select('c1');
    shell.openWorkbench();
    await chat.select('c1');
    expect(shell.mainView).toBe('chats');
    shell.openWorkbench();
    await chat.select('c2');
    expect(shell.mainView).toBe('chats');
    expect(chat.currentId).toBe('c2');
  });

  it('选不存在的会话时不动 mainView', async () => {
    shell.openWorkbench();
    await chat.select('missing');
    expect(shell.mainView).toBe('workbench');
  });

  it('新建群聊的组群输入在对话区里，会先回到对话视图', () => {
    shell.openWorkbench();
    chat.beginGroupCompose();
    expect(shell.mainView).toBe('chats');
    expect(chat.composingGroup).toBe(true);
  });
});
