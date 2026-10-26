import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, Settings } from '@kepcup/shared';

/**
 * Characterization of the chat session as it behaves today (P2 A1). Later
 * ChatSession refactors must keep this file passing without edits.
 *
 * `select` loads via `conversations.get`, `messages.list`, two `runs.list`
 * calls, `tasks.loadActive` (`tasks.active`), then `permissions.loadForConversation`
 * (`approvals.list` + `grants.list`). It does not call `permissions.reloadApprovals`.
 */

const handlers = new Map<string, (payload: unknown) => void>();
const emit = (event: string, payload: unknown): void => handlers.get(event)?.(payload);

const state = {
  model: '',
  agentId: '',
  lastReadSeq: 0,
  messages: [] as Message[],
  earlier: [] as Message[],
  calls: [] as Array<{ method: string; params: unknown }>,
};

function textMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'conversationId' | 'seq'>): Message {
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

function runOf(
  overrides: Partial<Run> & Pick<Run, 'id' | 'status' | 'conversationId'>,
): Run {
  return {
    botId: 'bot_c1',
    loopType: 'turn',
    failureDismissed: false,
    setup: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    ...overrides,
  } as Run;
}

const conversation = (id: string) => ({
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
  lastSeq: state.messages.at(-1)?.seq ?? 0,
  lastReadSeq: state.lastReadSeq,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: 1,
  bot: {
    id: `bot_${id}`,
    name: id,
    status: 'active',
    avatar: null,
    setupState: null,
    profile: {
      runtime: {
        model: state.model,
        agent: { id: state.agentId },
      },
    },
  },
});

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    coreStatus: null,
    onEvent: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    call: async (method: string, params?: unknown) => {
      state.calls.push({ method, params });
      switch (method) {
        case 'conversations.get':
          return {
            conversation: conversation((params as { id?: string } | undefined)?.id ?? ''),
          };
        case 'messages.list': {
          const beforeSeq = (params as { beforeSeq?: number } | undefined)?.beforeSeq;
          return { messages: beforeSeq === undefined ? state.messages : state.earlier };
        }
        case 'runs.list':
          return { runs: [] };
        case 'tasks.active':
          return { tasks: [] };
        case 'approvals.list':
          return { approvals: [] };
        case 'grants.list':
          return { grants: [] };
        case 'conversations.markRead':
          state.lastReadSeq = (params as { seq: number }).seq;
          return {};
        default:
          return {};
      }
    },
  },
}));

const { chat } = await import('./chat.svelte');
const { settingsStore } = await import('./settings.svelte');
const { agentsStore } = await import('./agents.svelte');
const { shell } = await import('./shell.svelte');

beforeEach(() => {
  shell.mainView = 'chats';
  state.model = '';
  state.agentId = '';
  state.lastReadSeq = 0;
  state.messages = [];
  state.earlier = [];
  state.calls = [];
  settingsStore.settings = null;
  agentsStore.loaded = true;
  agentsStore.agents = [];
  chat.start();
});

describe('chat.select load sequence', () => {
  it('loads the conversation, its messages and runs, active tasks, and approvals', async () => {
    await chat.select('c1');
    expect(state.calls.map((call) => call.method)).toEqual([
      'conversations.get',
      'messages.list',
      'runs.list',
      'runs.list',
      'tasks.active',
      'approvals.list',
      'grants.list',
    ]);
    expect(state.calls[0]?.params).toEqual({ id: 'c1' });
    expect(state.calls[1]?.params).toEqual({ conversationId: 'c1', limit: 60 });
    expect(state.calls[2]?.params).toEqual({ conversationId: 'c1', limit: 30 });
    expect(state.calls[3]?.params).toEqual({ conversationId: 'c1', active: true });
    expect(state.calls[4]?.params).toEqual({ conversationId: 'c1' });
    expect(state.calls[5]?.params).toEqual({ conversationId: 'c1' });
    expect(state.calls[6]?.params).toEqual({ conversationId: 'c1' });
    expect(chat.currentId).toBe('c1');
    expect(chat.current?.conversation.id).toBe('c1');
  });
});

describe('message and run events stay on the current conversation', () => {
  it('merges message.created and message.updated only into the open conversation', async () => {
    state.messages = [textMessage({ id: 'm1', conversationId: 'c1', seq: 1, content: { text: 'one' } })];
    await chat.select('c1');

    emit('message.created', {
      conversationId: 'c2',
      message: textMessage({ id: 'm-other', conversationId: 'c2', seq: 1 }),
    });
    expect(chat.current?.messages.map((message) => message.id)).toEqual(['m1']);

    emit('message.created', {
      conversationId: 'c1',
      message: textMessage({ id: 'm2', conversationId: 'c1', seq: 2, content: { text: 'two' } }),
    });
    expect(chat.current?.messages.map((message) => message.id)).toEqual(['m1', 'm2']);

    emit('message.updated', {
      conversationId: 'c2',
      message: textMessage({ id: 'm1', conversationId: 'c2', seq: 1, content: { text: 'nope' } }),
    });
    expect(chat.current?.messages[0]?.content).toEqual({ text: 'one' });

    emit('message.updated', {
      conversationId: 'c1',
      message: textMessage({ id: 'm1', conversationId: 'c1', seq: 1, content: { text: 'edited' } }),
    });
    expect(chat.current?.messages[0]?.content).toEqual({ text: 'edited' });
    expect(chat.current?.messages[1]?.content).toEqual({ text: 'two' });
  });

  it('updates activeRuns and failedRun from run.status and run.progress for the open conversation', async () => {
    await chat.select('c1');
    emit('run.status', {
      run: runOf({ id: 'run-other', status: 'running', conversationId: 'c2' }),
    });
    expect(chat.current?.activeRuns).toEqual([]);
    expect(chat.current?.failedRun).toBeNull();

    emit('run.status', {
      run: runOf({ id: 'run-1', status: 'running', conversationId: 'c1' }),
    });
    expect(chat.current?.activeRuns.map((entry) => entry.run.id)).toEqual(['run-1']);
    expect(chat.current?.activeRuns[0]?.progress).toBe('');

    emit('run.progress', { runId: 'run-1', text: 'working' });
    expect(chat.current?.activeRuns[0]?.progress).toBe('working');
    emit('run.progress', { runId: 'run-1', toolName: 'bash' });
    expect(chat.current?.activeRuns[0]?.toolName).toBe('bash');
    expect(chat.current?.activeRuns[0]?.progress).toBe('');

    emit('run.progress', { runId: 'run-other', text: 'ignore' });
    expect(chat.current?.activeRuns[0]?.progress).toBe('');

    emit('run.status', {
      run: runOf({ id: 'run-1', status: 'failed', conversationId: 'c1', error: 'boom' }),
    });
    expect(chat.current?.activeRuns).toEqual([]);
    expect(chat.current?.failedRun?.id).toBe('run-1');
  });
});

describe('markRead, loadEarlier, gateForSend, and replyTo', () => {
  it('marks the open conversation read up to the latest message', async () => {
    state.messages = [textMessage({ id: 'm4', conversationId: 'c1', seq: 4 })];
    await chat.select('c1');
    const reads = state.calls.filter((call) => call.method === 'conversations.markRead');
    expect(reads).toEqual([{ method: 'conversations.markRead', params: { conversationId: 'c1', seq: 4 } }]);
    expect(chat.current?.conversation.lastReadSeq).toBe(4);

    state.calls = [];
    await chat.markRead();
    expect(state.calls.filter((call) => call.method === 'conversations.markRead')).toEqual([]);
  });

  it('prepends an earlier page and asks for messages before the oldest seq', async () => {
    state.messages = [textMessage({ id: 'm5', conversationId: 'c1', seq: 5 })];
    await chat.select('c1');
    expect(chat.current?.hasEarlier).toBe(false);
    state.calls = [];
    state.earlier = [textMessage({ id: 'm2', conversationId: 'c1', seq: 2 })];
    await chat.loadEarlier();
    expect(state.calls).toEqual([
      {
        method: 'messages.list',
        params: { conversationId: 'c1', beforeSeq: 5, limit: 60 },
      },
    ]);
    expect(chat.current?.messages.map((message) => message.id)).toEqual(['m2', 'm5']);
    expect(chat.current?.hasEarlier).toBe(false);
  });

  it('gateForSend allows, blocks on a missing main model, or blocks on the agent', async () => {
    await chat.select('c1');
    expect(chat.gateForSend()).toBe(false);
    expect(chat.setupRequirement).toBeNull();

    settingsStore.settings = {
      defaultMainModel: '',
      experimental: { externalAgents: true },
      agents: {},
    } as Settings;
    expect(chat.gateForSend()).toBe(true);
    expect(chat.setupRequirement).toEqual({ kind: 'main-model' });

    state.model = 'provider/model';
    await chat.select('c1');
    expect(chat.gateForSend()).toBe(false);
    expect(chat.setupRequirement).toBeNull();

    state.model = '';
    state.agentId = 'codex';
    settingsStore.settings = {
      defaultMainModel: 'provider/model',
      experimental: { externalAgents: false },
      agents: {},
    } as Settings;
    await chat.select('c1');
    expect(chat.gateForSend()).toBe(true);
    expect(chat.setupRequirement).toEqual({
      kind: 'agent',
      agentId: 'codex',
      reason: 'experimental_off',
    });
  });

  it('clears replyTo when switching conversations', async () => {
    state.messages = [textMessage({ id: 'm1', conversationId: 'c1', seq: 1 })];
    await chat.select('c1');
    chat.startReply(state.messages[0]!);
    expect(chat.replyTo?.id).toBe('m1');
    await chat.select('c2');
    expect(chat.replyTo).toBeNull();
    expect(chat.currentId).toBe('c2');
  });
});
