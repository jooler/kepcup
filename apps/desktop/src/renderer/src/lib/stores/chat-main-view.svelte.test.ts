import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 工作台主视图的收口不变式（D90 §5.1）：只有 `chat.select()` 把 `shell.mainView` 置回
 * 'chats'；打开工作台只改 mainView、不清 currentId。真实的 chat / shell store
 * （desktop-svelte 项目），core 用最小替身。
 */

const handlers = new Map<string, (payload: unknown) => void>();
const emit = (event: string, payload: unknown): void => handlers.get(event)?.(payload);
const state = {
  lastSeq: 0,
  lastReadSeq: 0,
  messages: [] as unknown[],
  markReadCalls: [] as number[],
  gate: null as Promise<void> | null,
};

const conversation = (id: string) => ({
  id,
  type: 'direct',
  title: null,
  directBotId: `bot_${id}`,
  projectId: null,
  readOnly: false,
  summary: null,
  summaryUptoSeq: 0,
  lastSeq: state.lastSeq,
  lastReadSeq: state.lastReadSeq,
  unreadCount: Math.max(0, state.lastSeq - state.lastReadSeq),
  lastMessageAt: null,
  createdAt: 1,
  bot: { id: `bot_${id}`, name: id, status: 'active', avatar: null },
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => undefined;
    },
    call: async (method: string, params?: { id?: string }) => {
      switch (method) {
        case 'conversations.get':
          return { conversation: params?.id === 'missing' ? null : conversation(params?.id ?? '') };
        case 'messages.list':
          if (state.gate !== null) await state.gate;
          return { messages: state.messages };
        case 'conversations.markRead': {
          const seq = (params as unknown as { seq: number }).seq;
          state.markReadCalls.push(seq);
          state.lastReadSeq = seq;
          return {};
        }
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

/**
 * 工作台期间的已读（D90）：工作台盖住对话区时当前会话不算「在看」——员工的交付回复要在侧栏
 * 记未读、不调 markRead；回到对话（含重新选同一个会话）后才补标已读并清零。
 */
describe('工作台期间的未读与已读', () => {
  const botMessage = (seq: number) => ({
    id: `m${seq}`,
    conversationId: 'cu',
    seq,
    senderType: 'bot',
    senderBotId: 'bot_cu',
    kind: 'text',
    status: 'sent',
    runId: null,
    replyTo: null,
    attachments: [],
    content: { text: `reply ${seq}` },
    createdAt: seq,
  });

  beforeEach(() => {
    shell.mainView = 'chats';
    state.lastSeq = 0;
    state.lastReadSeq = 0;
    state.messages = [];
    state.markReadCalls.length = 0;
    chat.start();
  });

  it('工作台期间到达的回复：记未读、不标已读；回到同一会话后补标已读并清零', async () => {
    await chat.select('cu');
    shell.openWorkbench();

    state.lastSeq = 1;
    state.messages = [botMessage(1)];
    emit('message.created', { conversationId: 'cu', message: botMessage(1) });

    expect(chat.conversations.find((c) => c.id === 'cu')?.unreadCount).toBe(1);
    expect(chat.isViewing('cu')).toBe(false);
    await chat.markRead();
    expect(state.markReadCalls).toEqual([]);

    // select 同一个 currentId 不会提前返回：重新载入并补标已读。
    await chat.select('cu');
    expect(shell.mainView).toBe('chats');
    expect(state.markReadCalls).toEqual([1]);
    expect(chat.conversations.find((c) => c.id === 'cu')?.unreadCount).toBe(0);
    expect(chat.isViewing('cu')).toBe(true);
  });

  it('对话视图里当前会话到达的回复不记未读（行为不变）', async () => {
    await chat.select('cu');
    state.lastSeq = 1;
    emit('message.created', { conversationId: 'cu', message: botMessage(1) });
    expect(chat.conversations.find((c) => c.id === 'cu')?.unreadCount ?? 0).toBe(0);
  });

  it('窄屏没有工作台：mainView 残留 workbench 也照常算在看', async () => {
    const { narrowLayout } = await import('$lib/features/shell/narrow-layout.svelte');
    await chat.select('cu');
    shell.openWorkbench();
    narrowLayout.windowWidth = 375;
    flushSync();
    expect(chat.isViewing('cu')).toBe(true);
    narrowLayout.windowWidth = 1280;
    flushSync();
  });
});

describe('慢 select 与用户主动打开工作台', () => {
  it('select 进行期间用户打开了工作台：结算时不把视图拉回对话', async () => {
    let release: () => void = () => undefined;
    state.gate = new Promise<void>((resolve) => (release = resolve));
    shell.mainView = 'chats';
    const pending = chat.select('slow');
    shell.openWorkbench();
    release();
    await pending;
    state.gate = null;
    expect(shell.mainView).toBe('workbench');
    // 会话本身照常切过去（再回到对话时看到的就是它）。
    expect(chat.currentId).toBe('slow');
  });

  it('之后用户主动点对话行（新的 select）照常回到对话', async () => {
    shell.openWorkbench();
    await chat.select('another');
    expect(shell.mainView).toBe('chats');
  });
});
