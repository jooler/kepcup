import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, Settings } from '@kepcup/shared';
import { ChatSession } from './chat-session.svelte';

/**
 * Two ChatSession instances share the event bus and keep their own views.
 * `chat.main` is wired in a later step; this file talks to the class directly.
 */

const handlers = new Map<string, Array<(payload: unknown) => void>>();
const emit = (event: string, payload: unknown): void => {
  for (const handler of handlers.get(event) ?? []) handler(payload);
};

const state = {
  model: '',
  agentId: '',
  messages: [] as Message[],
  calls: [] as Array<{ method: string; params: unknown }>,
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
  return {
    id,
    type: 'direct' as const,
    title: null,
    directBotId: `bot_${id}`,
    parentProjectId: null,
    cardTodoId: null,
    workdirId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
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
        case 'grants.list':
          return { grants: [] };
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

beforeEach(() => {
  handlers.clear();
  shell.mainView = 'chats';
  state.model = '';
  state.agentId = '';
  state.messages = [];
  state.calls = [];
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
      experimental: { externalAgents: true },
      agents: {},
    } as Settings;
    expect(session.gateForSend()).toBe(true);
    expect(session.setupRequirement).toEqual({ kind: 'main-model' });
    expect(other.gateForSend()).toBe(false);
    expect(other.setupRequirement).toBeNull();
    session.dispose();
    other.dispose();
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
});
