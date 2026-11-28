import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, Settings, TaskView } from '@kepcup/shared';
import { ChatSession, type ChatSessionHost } from './chat-session.svelte';
import { messageVisibility } from './message-visibility.svelte';
import { composerDrafts } from '../features/chats/composer-drafts.svelte';
import { EMPTY_COMPOSER_DOC } from '../features/chats/composer-draft-persist';

/**
 * Two ChatSession instances share the event bus and keep their own views.
 * `chat.main` is wired in a later step; this file talks to the class directly.
 */

const handlers = new Map<string, Array<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};

const bridge = vi.hoisted(() => ({
  memberSnapshot: (): { mainView: string; openTaskId: string | null } => ({
    mainView: 'chats',
    openTaskId: null,
  }),
}));

const state = {
  model: '',
  agentId: '',
  messages: [] as Message[],
  calls: [] as Array<{ method: string; params: unknown }>,
  membersSnapshot: null as { mainView: string; openTaskId: string | null } | null,
  conversationMetadata: {} as Record<string, { lastSeq?: number }>,
};

function textMessage(
  overrides: Partial<Message> & Pick<Message, 'id' | 'conversationId' | 'seq'>,
): Message {
  return {
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    status: 'normal',
    runId: null,
    replyTo: null,
    attachments: [],
    content: { text: `text ${overrides.seq}` },
    createdAt: overrides.seq,
    ...overrides,
  } as Message;
}

function runOf(overrides: Partial<Run> & Pick<Run, 'id' | 'status' | 'conversationId'>): Run {
  return {
    botId: 'bot_1',
    loopType: 'turn',
    failureDismissed: false,
    setup: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    ...overrides,
  } as Run;
}

function conversation(id: string) {
  const project = id.startsWith('proj');
  return {
    id,
    type: (project ? 'project' : 'direct') as 'project' | 'direct',
    title: project ? '项目组' : null,
    directBotId: project ? null : `bot_${id}`,
    leadBotId: project ? 'bot_lead' : null,
    parentProjectId: null,
    cardTodoId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: state.conversationMetadata[id]?.lastSeq ?? 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 1,
    bot: {
      id: `bot_${id}`,
      name: id,
      status: 'active',
      avatar: null,
      setupState: null,
      profile: { runtime: { model: state.model, agent: { id: state.agentId } } },
    },
  };
}

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(
          event,
          current.filter((item) => item !== handler),
        );
      };
    },
    call: async (method: string, params?: unknown) => {
      state.calls.push({ method, params });
      switch (method) {
        case 'conversations.get':
          return { conversation: conversation((params as { id: string }).id) };
        case 'messages.list':
          return { messages: state.messages };
        case 'runs.list':
          return { runs: [] };
        case 'tasks.active':
          return { tasks: [] };
        case 'approvals.list':
          return { approvals: [] };
        case 'grants.list': {
          const conversationId =
            (params as { conversationId?: string } | undefined)?.conversationId ?? '';
          return {
            grants: [
              {
                id: `grant_${conversationId}`,
                conversationId,
                botId: 'bot_1',
                path: '/tmp',
                access: 'read',
                duration: 'conversation',
                runId: null,
                approvalId: null,
                createdAt: 1,
                revokedAt: null,
              },
            ],
          };
        }
        case 'conversations.members':
          state.membersSnapshot = bridge.memberSnapshot();
          return { members: [] };
        default:
          return {};
      }
    },
  },
}));

const { settingsStore } = await import('./settings.svelte');
const { agentsStore } = await import('./agents.svelte');
const { shell } = await import('./shell.svelte');
const { chat } = await import('./chat.svelte');
const { tasks } = await import('./tasks.svelte');
const { permissions } = await import('./permissions.svelte');
bridge.memberSnapshot = () => ({ mainView: shell.mainView, openTaskId: tasks.openTaskId });

beforeEach(() => {
  shell.mainView = 'chats';
  state.model = '';
  state.agentId = '';
  state.messages = [];
  state.calls = [];
  state.membersSnapshot = null;
  state.conversationMetadata = {};
  // Hidden-overlay state is process-global: clear every conversation these tests
  // touch so an early assertion failure cannot leak a mask into later tests.
  for (const conversationId of [
    'visibility-test',
    'preview-system-test',
    'preview-recall-edit-test',
    'preview-partial-test',
    'visibility-reply-test',
  ]) {
    messageVisibility.forget('local', conversationId);
  }
  settingsStore.settings = null;
  agentsStore.loaded = true;
  agentsStore.agents = [];
});

describe('ChatSession', () => {
  it('open loads the conversation, messages, runs, active tasks, and approvals', async () => {
    const session = new ChatSession();
    await session.open('c1');
    expect(state.calls.map((call) => call.method)).toEqual([
      'conversations.get',
      'messages.list',
      'runs.list',
      'runs.list',
      'tasks.active',
      'approvals.list',
      'grants.list',
      'permissions.mode.get',
    ]);
    expect(session.conversationId).toBe('c1');
    session.dispose();
  });

  it('two sessions merge only their own message and run events', async () => {
    const left = new ChatSession();
    const right = new ChatSession();
    await left.open('left');
    await right.open('right');

    emit('message.created', {
      conversationId: 'left',
      message: textMessage({ id: 'ml', conversationId: 'left', seq: 1 }),
    });
    emit('message.created', {
      conversationId: 'right',
      message: textMessage({ id: 'mr', conversationId: 'right', seq: 1 }),
    });
    expect(left.messages.map((message) => message.id)).toEqual(['ml']);
    expect(right.messages.map((message) => message.id)).toEqual(['mr']);

    emit('message.updated', {
      conversationId: 'left',
      message: textMessage({
        id: 'ml',
        conversationId: 'left',
        seq: 1,
        content: { text: 'edited' },
      }),
    });
    expect(left.messages[0]?.content).toEqual({ text: 'edited' });
    expect(right.messages[0]?.content).toEqual({ text: 'text 1' });

    emit('run.status', { run: runOf({ id: 'run-l', status: 'running', conversationId: 'left' }) });
    emit('run.progress', { runId: 'run-l', text: 'left-only' });
    expect(left.activeRuns.map((entry) => entry.progress)).toEqual(['left-only']);
    expect(right.activeRuns).toEqual([]);

    left.dispose();
    right.dispose();
  });

  it('dispose stops later events', async () => {
    const session = new ChatSession();
    await session.open('c1');
    session.dispose();
    emit('message.created', {
      conversationId: 'c1',
      message: textMessage({ id: 'm', conversationId: 'c1', seq: 1 }),
    });
    expect(session.messages).toEqual([]);
    expect(session.conversationId).toBeNull();
  });

  it('onIncomingMessage 透传 message.created（滤 interim），取消订阅后停收（53 号播报订阅口）', async () => {
    const session = new ChatSession();
    await session.open('c1');
    const received: Array<[string, string]> = [];
    const unsubscribe = session.onIncomingMessage((conversationId, message) => {
      received.push([conversationId, message.id]);
    });
    emit('message.created', {
      conversationId: 'c1',
      message: textMessage({ id: 'normal', conversationId: 'c1', seq: 1 }),
    });
    // interim（task 状态遮罩）在 #ingestMessage 前排就被滤掉，不透传。
    emit('message.created', {
      conversationId: 'c1',
      message: textMessage({
        id: 'interim',
        conversationId: 'c1',
        seq: 2,
        content: { text: '处理中', interim: true },
      }),
    });
    // 其它会话的消息照常透传（订阅方按 conversationId 自筛）。
    emit('message.created', {
      conversationId: 'c2',
      message: textMessage({ id: 'other', conversationId: 'c2', seq: 1 }),
    });
    expect(received).toEqual([
      ['c1', 'normal'],
      ['c2', 'other'],
    ]);

    unsubscribe();
    emit('message.created', {
      conversationId: 'c1',
      message: textMessage({ id: 'after', conversationId: 'c1', seq: 3 }),
    });
    expect(received).toEqual([
      ['c1', 'normal'],
      ['c2', 'other'],
    ]);
    session.dispose();
  });

  it('订阅方抛错不影响其他订阅方与 ingest 主流程（异常隔离，warn 留痕）', async () => {
    const session = new ChatSession();
    await session.open('c1');
    session.onIncomingMessage(() => {
      throw new Error('listener boom');
    });
    const received: string[] = [];
    session.onIncomingMessage((_conversationId, message) => {
      received.push(message.id);
    });
    // svelte-client 环境里 vi.spyOn(console) 拦不到模块侧调用，用 stubGlobal 换
    // console 来捕获 warn（错误不静默的留痕断言）。
    const warns: unknown[][] = [];
    vi.stubGlobal('console', { ...console, warn: (...args: unknown[]) => warns.push(args) });
    try {
      emit('message.created', {
        conversationId: 'c1',
        message: textMessage({ id: 'm1', conversationId: 'c1', seq: 1 }),
      });
    } finally {
      // emit 抛错也不能让打补丁的 console 泄漏到后续用例（vitest 未开 unstubGlobals）。
      vi.unstubAllGlobals();
    }
    // 抛错的订阅方之后：另一个订阅方照收，消息照常进视图（主流程不断）。
    expect(received).toEqual(['m1']);
    expect(session.view?.messages.some((message) => message.id === 'm1')).toBe(true);
    expect(warns).toEqual([
      [
        '[kepcup] incoming-message listener failed',
        { conversationId: 'c1', messageId: 'm1', error: new Error('listener boom') },
      ],
    ]);
    session.dispose();
  });

  it('open switches the view and clears replyTo', async () => {
    const session = new ChatSession();
    state.messages = [textMessage({ id: 'm1', conversationId: 'c1', seq: 1 })];
    await session.open('c1');
    session.startReply(state.messages[0]!);
    expect(session.replyTo?.id).toBe('m1');
    state.messages = [];
    await session.open('c2');
    expect(session.conversationId).toBe('c2');
    expect(session.replyTo).toBeNull();
    emit('message.created', {
      conversationId: 'c2',
      message: textMessage({ id: 'once', conversationId: 'c2', seq: 1 }),
    });
    expect(session.messages.map((message) => message.id)).toEqual(['once']);
    session.dispose();
  });

  it('send voiceMode（53 号修订 v2 V2-1）：voiceMode: true 透传 messages.send；文字直发不带该键', async () => {
    const session = new ChatSession();
    const ok = await session.send('c1', '明天有什么安排', { voiceMode: true });
    expect(ok).toEqual({ ok: true });
    expect(state.calls.filter((call) => call.method === 'messages.send')).toEqual([
      {
        method: 'messages.send',
        params: { conversationId: 'c1', text: '明天有什么安排', voiceMode: true },
      },
    ]);

    state.calls = [];
    await session.send('c1', '普通文字');
    const [plain] = state.calls.filter((call) => call.method === 'messages.send');
    expect(plain).toEqual({
      method: 'messages.send',
      params: { conversationId: 'c1', text: '普通文字' },
    });
    session.dispose();
  });

  it('gateForSend and markRead are per session', async () => {
    const session = new ChatSession();
    const other = new ChatSession();
    state.messages = [textMessage({ id: 'm4', conversationId: 'c1', seq: 4 })];
    await session.open('c1');
    expect(state.calls.filter((call) => call.method === 'conversations.markRead')).toEqual([
      { method: 'conversations.markRead', params: { conversationId: 'c1', seq: 4 } },
    ]);
    expect(session.conversation?.lastReadSeq).toBe(4);

    settingsStore.settings = {
      defaultMainModel: '',
      agents: {},
    } as Settings;
    expect(session.gateForSend()).toBe(true);
    expect(session.setupRequirement).toEqual({ kind: 'main-model' });
    expect(other.gateForSend()).toBe(false);
    expect(other.setupRequirement).toBeNull();
    session.dispose();
    other.dispose();
  });

  it('通知已读游标：keep 随本次查看建立、切换会话丢弃、重开不再收进', async () => {
    // 会话 id 本测试专用（通知游标单例跨用例共享）。
    const convA = 'notice-keep-a';
    const mailCard = (id: string, seq: number): Message => ({
      ...textMessage({ id, conversationId: convA, seq }),
      senderType: 'bot',
      kind: 'card',
      createdAt: Date.now(),
      content: { cardType: 'mail' },
    } as Message);
    const messagesOfA = (): Message[] => [
      textMessage({ id: 't1', conversationId: convA, seq: 1 }),
      mailCard('mail1', 2),
    ];
    state.messages = messagesOfA();
    const session = new ChatSession();
    await session.open(convA);
    // 打开即 markRead：未勾选类目的未读邮件进 keep（保持可见直到切换）。
    expect(session.view?.noticeKeepIds).toEqual(new Set(['mail1']));

    // 切到别的会话：视图被替换，新视图 keep 为空。
    state.messages = [textMessage({ id: 'tb', conversationId: 'notice-keep-b', seq: 1 })];
    await session.open('notice-keep-b');
    expect(session.view?.noticeKeepIds ?? new Set()).toEqual(new Set());

    // 回到 A：游标已推进（≥ mail1.seq），mail 不再进 keep——已读条目收起。
    state.messages = messagesOfA();
    await session.open(convA);
    expect(session.view?.noticeKeepIds ?? new Set()).toEqual(new Set());
    session.dispose();
  });

  it('通知已读游标：无变化不写 keep——重复 markRead 不重建 Set（防 effect 自激死循环）', async () => {
    // MessageList 的 $effect 会同步触发 markRead，且该 effect 经 display 派生
    // 读取 noticeKeepIds：若 markRead 无条件赋新 Set 引用，写会重新触发读，
    // 形成 effect_update_depth_exceeded 死循环（回归防护）。
    const convId = 'notice-keep-idempotent';
    const mailCard = (id: string, seq: number): Message => ({
      ...textMessage({ id, conversationId: convId, seq }),
      senderType: 'bot',
      kind: 'card',
      createdAt: Date.now(),
      content: { cardType: 'mail' },
    } as Message);
    state.messages = [
      textMessage({ id: 't1', conversationId: convId, seq: 1 }),
      mailCard('mail1', 2),
    ];
    const session = new ChatSession();
    await session.open(convId);
    const keep = session.view?.noticeKeepIds;
    expect(keep).toEqual(new Set(['mail1']));

    await session.markRead();
    await session.markRead();
    expect(session.view?.noticeKeepIds).toBe(keep);
    session.dispose();
  });

  it('chat.main.open switches the main view and resets replyTo', async () => {
    chat.start();
    state.messages = [textMessage({ id: 'main-m', conversationId: 'main-a', seq: 1 })];
    expect(await chat.main.open('main-a')).toBe(true);
    chat.main.startReply(state.messages[0]!);
    expect(chat.replyTo?.id).toBe('main-m');
    state.messages = [];
    expect(await chat.main.open('main-b')).toBe(true);
    expect(chat.main.conversationId).toBe('main-b');
    expect(chat.currentId).toBe('main-b');
    expect(chat.replyTo).toBeNull();
  });

  it('shows the chat before loading project members', async () => {
    chat.start();
    shell.openWorkbench();
    await chat.select('proj1');
    expect(state.membersSnapshot).toEqual({ mainView: 'chats', openTaskId: null });
    expect(chat.currentId).toBe('proj1');
    expect(tasks.openTaskId).toBeNull();
  });

  it('keeps each conversation on the task page it was left on', async () => {
    chat.start();
    await chat.select('bot-a');
    chat.main.openTask('task_a');
    expect(tasks.openTaskId).toBe('task_a');

    await chat.select('bot-b');
    expect(tasks.openTaskId).toBeNull();

    await chat.select('bot-a');
    expect(tasks.openTaskId).toBe('task_a');

    // An explicit back forgets the page: the next visit shows the message list.
    tasks.closeDetail();
    await chat.select('bot-b');
    await chat.select('bot-a');
    expect(tasks.openTaskId).toBeNull();
    chat.close();
  });

  it('leaves the task page in memory when returning to the narrow list', async () => {
    chat.start();
    await chat.select('bot-narrow');
    chat.main.openTask('task_narrow');
    chat.leaveCurrent();
    expect(tasks.openTaskId).toBeNull();
    await chat.select('bot-narrow');
    expect(tasks.openTaskId).toBe('task_narrow');
    tasks.closeDetail();
    chat.leaveCurrent();
  });

  it('forgets the task page when the conversation closes', async () => {
    chat.start();
    await chat.select('bot-gone');
    chat.main.openTask('task_gone');
    expect(tasks.openTaskId).toBe('task_gone');
    chat.close();
    expect(tasks.openTaskId).toBeNull();
    await chat.select('bot-gone');
    expect(tasks.openTaskId).toBeNull();
    chat.close();
  });

  it('keeps the merged unread count on the open conversation when the event omits it', async () => {
    chat.start();
    await chat.select('c1');
    const current = chat.current;
    expect(current).not.toBeNull();
    chat.conversations = chat.conversations.map((conversation) =>
      conversation.id === 'c1'
        ? { ...conversation, unreadCount: 4, lastSeq: 5, lastReadSeq: 1 }
        : conversation,
    );
    current!.conversation = {
      ...current!.conversation,
      unreadCount: 4,
      lastSeq: 5,
      lastReadSeq: 1,
    };
    const bot = current!.conversation.bot;
    emit('conversation.updated', {
      conversation: {
        id: 'c1',
        type: 'direct',
        title: 'renamed',
        directBotId: 'bot_c1',
        leadBotId: null,
        parentProjectId: null,
        cardTodoId: null,
        workdirId: null,
        readOnly: false,
        summary: null,
        summaryUptoSeq: 0,
        lastSeq: 5,
        lastReadSeq: 1,
        lastMessageAt: null,
        createdAt: 1,
        bot,
      },
    });
    expect(chat.current?.conversation.title).toBe('renamed');
    expect(chat.current?.conversation.unreadCount).toBe(4);
    expect(chat.current?.conversation.bot?.id).toBe('bot_c1');
    expect(chat.conversations.find((conversation) => conversation.id === 'c1')?.unreadCount).toBe(
      4,
    );
  });

  it('a second session does not take the main grants list, task page, or settled tasks', async () => {
    chat.start();
    await chat.select('main-a');
    const settled = {
      taskId: 'done_main',
      botId: 'bot_1',
      conversationId: 'main-a',
      title: 'done',
      state: 'completed' as const,
      status: 'completed' as const,
      writes: false,
      writeDomains: null,
      claims: [],
      cwdKind: 'workspace' as const,
      queueReason: null,
      awaitingInput: false,
      questionMessageId: null,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      error: null,
      cancelReason: null,
      injects: [],
      lastProgress: null,
      changes: null,
      setup: null,
      continuesTaskId: null,
      continuedByTaskId: null,
      capabilities: [],
    };
    tasks.byId = { done_main: settled as TaskView };
    tasks.openDetail('task_main');
    expect(permissions.grants.map((grant) => grant.id)).toEqual(['grant_main-a']);

    const other = new ChatSession();
    await other.open('other');
    expect(permissions.grants.map((grant) => grant.id)).toEqual(['grant_main-a']);
    expect(permissions.grantsOf('other').map((grant) => grant.id)).toEqual(['grant_other']);
    expect(tasks.openTaskId).toBe('task_main');
    other.openTask('task_other');
    expect(tasks.openTaskId).toBe('task_main');
    expect(tasks.byId['done_main']).toEqual(settled);

    other.dispose();
    expect(permissions.grants.map((grant) => grant.id)).toEqual(['grant_main-a']);
    expect(tasks.byId['done_main']).toEqual(settled);
    expect(tasks.openTaskId).toBe('task_main');
    tasks.closeDetail();
  });

  it('applies hidden overlays on open and message updates, and refuses hidden replies', async () => {
    const conversationId = 'visibility-test';
    const original = textMessage({
      id: 'hidden-open',
      conversationId,
      seq: 1,
      senderType: 'bot',
      senderBotId: 'bot_1',
      content: { text: 'original' },
    });
    messageVisibility.forget('local', conversationId);
    messageVisibility.setHidden('local', conversationId, original.id, true);
    state.messages = [original];
    const session = new ChatSession();
    await session.open(conversationId);
    expect(session.messages[0]?.hidden).toBe(true);
    session.startReply(session.messages[0]!);
    expect(session.replyTo).toBeNull();

    emit('message.updated', {
      conversationId,
      message: { ...original, content: { text: 'edited original' } },
    });
    expect(session.messages[0]?.hidden).toBe(true);
    expect(session.messages[0]?.content).toEqual({ text: 'edited original' });

    const incoming = textMessage({
      id: 'hidden-incoming',
      conversationId,
      seq: 2,
      senderType: 'bot',
      senderBotId: 'bot_1',
    });
    messageVisibility.setHidden('local', conversationId, incoming.id, true);
    const received: string[] = [];
    session.onIncomingMessage((_id, message) => received.push(message.id));
    emit('message.created', { conversationId, message: incoming });
    expect(session.messages[1]?.hidden).toBe(true);
    expect(received).toEqual([]);

    expect(session.setMessageHidden(original.id, false)).toBe(true);
    expect(session.messages[0]?.hidden).toBe(false);
    session.startReply(session.messages[0]!);
    expect(session.replyTo?.id).toBe(original.id);
    session.dispose();
    messageVisibility.forget('local', conversationId);
  });

  it('tracks the latest previewable row independently of later system events', async () => {
    const conversationId = 'preview-system-test';
    const bot = textMessage({
      id: 'preview-bot',
      conversationId,
      seq: 1,
      senderType: 'bot',
      senderBotId: 'bot_1',
      content: { text: 'hidden preview' },
    });
    const system = (seq: number) =>
      textMessage({
        id: `preview-system-${seq}`,
        conversationId,
        seq,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      });
    messageVisibility.forget('local', conversationId);
    messageVisibility.setHidden('local', conversationId, bot.id, true);
    messageVisibility.setPreviewHidden('local', conversationId, true, 1, bot.id);
    state.conversationMetadata[conversationId] = { lastSeq: 2 };
    state.messages = [bot, system(2)];
    const session = new ChatSession();
    await session.open(conversationId);
    expect(session.conversation?.lastPreviewSeq).toBe(1);
    expect(messageVisibility.previewHidden('local', conversationId, 1)).toBe(true);

    session.setMessageHidden(bot.id, false);
    expect(messageVisibility.previewHidden('local', conversationId, 1)).toBe(false);
    session.setMessageHidden(bot.id, true);
    expect(messageVisibility.previewHidden('local', conversationId, 1)).toBe(true);
    emit('message.updated', {
      conversationId,
      message: { ...bot, content: { text: '   ' } },
    });
    expect(session.conversation?.lastPreviewSeq).toBeUndefined();
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(false);

    const visible = textMessage({
      id: 'preview-visible',
      conversationId,
      seq: 3,
      content: { text: 'new visible preview' },
    });
    emit('message.created', { conversationId, message: visible });
    expect(session.conversation?.lastPreviewSeq).toBe(3);
    expect(messageVisibility.previewHidden('local', conversationId, 3)).toBe(false);
    emit('message.created', { conversationId, message: system(4) });
    expect(session.conversation?.lastPreviewSeq).toBe(3);
    expect(messageVisibility.previewHidden('local', conversationId, 3)).toBe(false);
    session.dispose();
    messageVisibility.forget('local', conversationId);
  });

  it('falls back to the previous preview after recall and adopts edited text on the local path', async () => {
    const conversationId = 'preview-recall-edit-test';
    const previous = textMessage({
      id: 'previous-preview',
      conversationId,
      seq: 1,
      content: { text: 'previous preview' },
    });
    const latest = textMessage({
      id: 'latest-preview',
      conversationId,
      seq: 2,
      content: { text: 'latest preview' },
    });
    const applyMessagePreview = vi.fn();
    const host: ChatSessionHost = {
      syncReadCursor: () => undefined,
      syncMemberPreviews: () => undefined,
      noteIncoming: () => undefined,
      applyMessageVisibility: () => undefined,
      applyMessagePreview,
      applyRunning: () => undefined,
      applyBot: () => undefined,
      applyConversation: () => false,
    };
    state.messages = [previous, latest];
    const session = new ChatSession(host);
    await session.open(conversationId);

    emit('message.updated', {
      conversationId,
      message: { ...latest, status: 'recalled' },
    });
    expect(session.conversation?.lastPreviewSeq).toBe(1);
    expect(applyMessagePreview).toHaveBeenLastCalledWith('local', conversationId, previous);

    const edited = { ...previous, status: 'edited' as const, content: { text: 'edited preview' } };
    emit('message.updated', { conversationId, message: edited });
    expect(session.conversation?.lastPreviewSeq).toBe(1);
    expect(applyMessagePreview).toHaveBeenLastCalledWith('local', conversationId, edited);
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(false);
    session.dispose();
  });

  it('keeps lastPreviewSeq when conversation.updated omits preview metadata', async () => {
    const conversationId = 'preview-merge-test';
    const latest = textMessage({
      id: 'merge-latest',
      conversationId,
      seq: 2,
      content: { text: 'latest' },
    });
    state.messages = [latest];
    const session = new ChatSession();
    await session.open(conversationId);
    expect(session.conversation?.lastPreviewSeq).toBe(2);

    emit('conversation.updated', { conversation: conversation(conversationId) });
    expect(session.conversation?.lastPreviewSeq).toBe(2);
    session.dispose();
  });

  it('keeps preview masks fail-closed outside the loaded window and clears only full-history no-preview', async () => {
    const conversationId = 'preview-partial-test';
    const hiddenId = 'preview-outside-window';
    const systems = Array.from({ length: 60 }, (_, index) =>
      textMessage({
        id: `preview-system-${index + 2}`,
        conversationId,
        seq: index + 2,
        senderType: 'system',
        senderBotId: null,
        kind: 'system_event',
        content: { event: 'run_done', text: 'done' },
      }),
    );
    messageVisibility.forget('local', conversationId);
    messageVisibility.setHidden('local', conversationId, hiddenId, true);
    messageVisibility.setPreviewHidden('local', conversationId, true, 1, hiddenId);
    state.conversationMetadata[conversationId] = { lastSeq: 61 };
    state.messages = systems;
    const applyMessagePreview = vi.fn();
    const host: ChatSessionHost = {
      syncReadCursor: () => undefined,
      syncMemberPreviews: () => undefined,
      noteIncoming: () => undefined,
      applyMessageVisibility: () => undefined,
      applyMessagePreview,
      applyRunning: () => undefined,
      applyBot: () => undefined,
      applyConversation: () => false,
    };
    const partial = new ChatSession(host);
    await partial.open(conversationId);
    expect(partial.hasEarlier).toBe(true);
    // conversations.get does not carry preview metadata; a partial window that
    // has no previewable row cannot derive it, so the row stays conservative
    // (no seq) and the persisted fail-closed mask is kept.
    expect(partial.conversation?.lastPreviewSeq).toBeUndefined();
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(true);
    expect(applyMessagePreview).not.toHaveBeenCalled();
    emit('message.updated', {
      conversationId,
      message: { ...systems[0]!, content: { event: 'run_done', text: 'edited' } },
    });
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(true);
    expect(applyMessagePreview).not.toHaveBeenCalled();
    partial.dispose();

    state.conversationMetadata[conversationId] = { lastSeq: 61 };
    const oldCache = new ChatSession(host);
    await oldCache.open(conversationId);
    expect(oldCache.conversation?.lastPreviewSeq).toBeUndefined();
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(true);
    oldCache.dispose();

    state.conversationMetadata[conversationId] = { lastSeq: 2 };
    state.messages = [systems[0]!];
    const complete = new ChatSession(host);
    await complete.open(conversationId);
    expect(complete.hasEarlier).toBe(false);
    expect(complete.conversation?.lastPreviewSeq).toBeUndefined();
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(false);
    expect(applyMessagePreview).toHaveBeenLastCalledWith('local', conversationId, null);
    complete.dispose();
    messageVisibility.forget('local', conversationId);
  });

  it('hiding clears active and persisted reply snapshots and refreshes only the latest preview', async () => {
    const conversationId = 'visibility-reply-test';
    const older = textMessage({
      id: 'older-bot',
      conversationId,
      seq: 1,
      senderType: 'bot',
      senderBotId: 'bot_1',
    });
    const latest = textMessage({
      id: 'latest-bot',
      conversationId,
      seq: 2,
      senderType: 'bot',
      senderBotId: 'bot_1',
    });
    const applyMessageVisibility = vi.fn();
    const host: ChatSessionHost = {
      syncReadCursor: () => undefined,
      syncMemberPreviews: () => undefined,
      noteIncoming: () => undefined,
      applyMessageVisibility,
      applyMessagePreview: () => undefined,
      applyRunning: () => undefined,
      applyBot: () => undefined,
      applyConversation: () => false,
    };
    messageVisibility.forget('local', conversationId);
    state.messages = [older, latest];
    const session = new ChatSession(host);
    await session.open(conversationId);
    session.startReply(older);
    composerDrafts.setRpcSource('local');
    composerDrafts.saveComposerDoc(conversationId, EMPTY_COMPOSER_DOC, [], session.replyTo);
    expect(composerDrafts.loadDraft(conversationId).reply?.id).toBe(older.id);

    expect(session.setMessageHidden(older.id, true)).toBe(true);
    expect(session.replyTo).toBeNull();
    expect(composerDrafts.loadDraft(conversationId).reply).toBeNull();
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(false);
    expect(applyMessageVisibility).toHaveBeenLastCalledWith(
      'local',
      conversationId,
      expect.objectContaining({ id: older.id, hidden: true }),
      true,
      false,
    );

    expect(session.setMessageHidden(latest.id, true)).toBe(true);
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(true);
    expect(applyMessageVisibility).toHaveBeenLastCalledWith(
      'local',
      conversationId,
      expect.objectContaining({ id: latest.id, hidden: true }),
      true,
      true,
    );
    session.setMessageHidden(latest.id, false);
    expect(messageVisibility.previewHidden('local', conversationId)).toBe(false);
    session.dispose();
    messageVisibility.forget('local', conversationId);
  });
});
