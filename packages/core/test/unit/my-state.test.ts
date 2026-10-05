import { describe, expect, it } from 'vitest';

import { buildMyState, first30, formatMyState } from '../../src/memory/my-state.js';
import type { MemoryStore } from '../../src/memory/store.js';
import type { Conversation, MemoryItem, Message, Run } from '@kepcup/shared';

function commitment(id: string, dueAt: number | null): Partial<MemoryItem> {
  return { id, kind: 'commitment', content: `承诺 ${id}`, dueAt, status: 'active' };
}

function makeStore(commitments: MemoryItem[]): MemoryStore {
  return { commitments: () => commitments } as unknown as MemoryStore;
}

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01 12:00 UTC
const DAY = 24 * 60 * 60 * 1000;

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: 'conv_1',
    type: 'direct',
    title: null,
    directBotId: 'bot_1',
    projectId: null,
    readOnly: false,
    summary: null,
    summaryUptoSeq: 0,
    lastSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    createdAt: 0,
    ...overrides,
  };
}

function run(overrides: Partial<Run> & { id: string }): Run {
  return {
    botId: 'bot_1',
    conversationId: 'conv_2',
    loopType: 'response',
    status: 'running',
    triggerReason: 'direct',
    triggerMessageIds: ['msg_t1'],
    provider: null,
    model: null,
    outputMessageIds: [],
    summary: null,
    error: null,
    chainId: null,
    chainDepth: null,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function message(text: string): Message {
  return {
    id: 'msg_t1',
    conversationId: 'conv_2',
    seq: 1,
    senderType: 'user',
    senderBotId: null,
    kind: 'text',
    content: { text },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 0,
    attachments: [],
  };
}

describe('my-state assembly (P07 任务 10)', () => {
  it('includes commitments due within 7 days, sorted by due date', () => {
    const lines = buildMyState({
      botId: 'bot_1',
      currentConversationId: 'conv_1',
      now: NOW,
      store: makeStore([
        commitment('mem_late', NOW + 6 * DAY) as MemoryItem,
        commitment('mem_soon', NOW + DAY) as MemoryItem,
        commitment('mem_far', NOW + 20 * DAY) as MemoryItem,
        commitment('mem_past', NOW - DAY) as MemoryItem,
        commitment('mem_open', null) as MemoryItem,
      ]),
      activeRuns: [],
      getConversation: () => null,
      getMessage: () => null,
    });
    expect(lines.map((line) => line)).toHaveLength(2);
    expect(lines[0]).toContain('mem_soon');
    expect(lines[1]).toContain('mem_late');
  });

  it('shows running/waiting runs in OTHER conversations with a 30-char preview', () => {
    const long = '这是一条超过三十个字符的触发消息，用来验证截断逻辑是否只保留前三十个字符并附加省略号';
    const lines = buildMyState({
      botId: 'bot_1',
      currentConversationId: 'conv_1',
      now: NOW,
      store: makeStore([]),
      activeRuns: [
        run({ id: 'run_1', conversationId: 'conv_2', status: 'running' }),
        run({ id: 'run_2', conversationId: 'conv_1', status: 'running' }), // same conv: excluded
        run({ id: 'run_3', conversationId: 'conv_3', status: 'completed' }), // not active
        run({ id: 'run_4', conversationId: 'conv_4', status: 'waiting_lease', botId: 'bot_2' }),
      ],
      getConversation: (id) =>
        conversation({ id, type: 'group', title: '项目群' }),
      getMessage: () => message(long),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('项目群');
    expect(lines[0]).toContain(first30(long));
    expect(lines[0]).not.toContain(long); // 只保留前 30 字，不出现全文
  });

  it('formats the section with the my_state tag and omits it when empty', () => {
    expect(formatMyState([])).toBe('');
    expect(formatMyState(['- 承诺'])).toBe('<my_state>\n- 承诺\n</my_state>');
  });

  it('first30 truncates with an ellipsis', () => {
    expect(first30('短文本')).toBe('短文本');
    expect(first30('a'.repeat(31))).toBe(`${'a'.repeat(30)}…`);
  });
});
