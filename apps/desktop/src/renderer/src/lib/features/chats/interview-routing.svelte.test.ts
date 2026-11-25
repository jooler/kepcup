import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@kepcup/shared';

/**
 * 访谈调用的来源路由（member-bots B4 子域 A）：
 * - `bots.interview.{start,answer,answerPath}` 按会话所属 SourceId 分流——
 *   local 走本机 core（现行为），team 走该来源连接；
 * - 团队来源的 start 预检：会话里已有未作答的 setup 问题（问题卡 / 目录卡）
 *   时不重发（B2 服务端对成员访谈会话的重复 start 拒 INVALID_INPUT）。
 */

const h = vi.hoisted(() => {
  return {
    calls: [] as Array<{ source: string; method: string; input: unknown }>,
  };
});

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => ['local'],
    onSourcesChanged: () => () => undefined,
    get: (source: string) => ({
      status: 'connected',
      memberId: source === 'local' ? null : 'mbr_me',
      onConnected: () => () => undefined,
      onEvent: () => () => undefined,
      call: async (method: string, input?: unknown) => {
        h.calls.push({ source, method, input });
        return {};
      },
      callTeam: async (method: string, input?: unknown) => {
        h.calls.push({ source, method, input });
        return {};
      },
    }),
  },
}));

const {
  answerSetupInterview,
  answerSetupPath,
  hasUnansweredSetupQuestion,
  startSetupInterview,
} = await import('./interview-routing');

function message(overrides: Record<string, unknown>): Message {
  return {
    id: 'msg',
    conversationId: 'conv_1',
    seq: 1,
    senderType: 'system',
    senderBotId: null,
    kind: 'system_event',
    content: { event: 'bot_setup_question' },
    replyTo: null,
    mentions: [],
    attachments: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 0,
    ownerBotId: null,
    taskId: null,
    senderPrincipalId: null,
    senderName: null,
    ...overrides,
  } as unknown as Message;
}

beforeEach(() => {
  h.calls = [];
});

describe('来源分流', () => {
  it('answer：local 与 team 各走各的连接（payload 同构）', async () => {
    await answerSetupInterview('local', 'conv_1', '写代码');
    await answerSetupInterview('team:h1', 'conv_1', '写代码');
    expect(h.calls).toEqual([
      { source: 'local', method: 'bots.interview.answer', input: { conversationId: 'conv_1', text: '写代码' } },
      { source: 'team:h1', method: 'bots.interview.answer', input: { conversationId: 'conv_1', text: '写代码' } },
    ]);
  });

  it('answerPath：path null（暂不设置）与具体路径都按来源路由', async () => {
    await answerSetupPath('local', 'conv_1', null);
    await answerSetupPath('team:h1', 'conv_1', '/srv/projects');
    expect(h.calls).toEqual([
      { source: 'local', method: 'bots.interview.answerPath', input: { conversationId: 'conv_1', path: null } },
      { source: 'team:h1', method: 'bots.interview.answerPath', input: { conversationId: 'conv_1', path: '/srv/projects' } },
    ]);
  });

  it('start：local 恒发；team 无进行中问题时也发（转交后重开等场景）', async () => {
    await startSetupInterview('local', 'bot_1', []);
    await startSetupInterview('team:h1', 'bot_1', []);
    expect(h.calls).toEqual([
      { source: 'local', method: 'bots.interview.start', input: { id: 'bot_1' } },
      { source: 'team:h1', method: 'bots.interview.start', input: { id: 'bot_1' } },
    ]);
  });

  it('start（team）：已有未作答问题时不重发（服务端拒重复 start）', async () => {
    await startSetupInterview(
      'team:h1',
      'bot_1',
      [message({ seq: 3, content: { event: 'bot_setup_question', text: '你做什么？' } })],
    );
    expect(h.calls).toHaveLength(0);
  });
});

describe('hasUnansweredSetupQuestion（start 预检）', () => {
  it('未作答的问题卡 / 目录卡 → true', () => {
    expect(
      hasUnansweredSetupQuestion([message({ seq: 1, content: { event: 'bot_setup_question' } })]),
    ).toBe(true);
    expect(
      hasUnansweredSetupQuestion([message({ seq: 1, content: { event: 'bot_setup_path_question' } })]),
    ).toBe(true);
  });

  it('问题之后的用户文本回答（setupAnswer 标记 / 自由输入）→ false', () => {
    const messages = [
      message({ seq: 1, content: { event: 'bot_setup_question' } }),
      message({ seq: 2, senderType: 'user', kind: 'text', content: { text: '数据分析' }, status: 'normal' }),
    ];
    expect(hasUnansweredSetupQuestion(messages)).toBe(false);
  });

  it('回答被撤回：问题回到未答态（recalled 不算回答）', () => {
    const messages = [
      message({ seq: 1, content: { event: 'bot_setup_question' } }),
      message({ seq: 2, senderType: 'user', kind: 'text', content: { text: '作废' }, status: 'recalled' }),
    ];
    expect(hasUnansweredSetupQuestion(messages)).toBe(true);
  });

  it('多轮：最后一问已答、前面的问题不再置起；无问题时 → false', () => {
    const messages = [
      message({ seq: 1, content: { event: 'bot_setup_question' } }),
      message({ seq: 2, senderType: 'user', kind: 'text', content: { text: 'A' }, status: 'normal' }),
      message({ seq: 3, content: { event: 'bot_setup_path_question' } }),
      message({ seq: 4, senderType: 'user', kind: 'text', content: { text: '/srv' }, status: 'normal' }),
    ];
    expect(hasUnansweredSetupQuestion(messages)).toBe(false);
    expect(hasUnansweredSetupQuestion([])).toBe(false);
  });

  it('非访谈系统事件（task_question 等）不置起', () => {
    expect(
      hasUnansweredSetupQuestion([message({ seq: 1, content: { event: 'task_question' } })]),
    ).toBe(false);
  });
});
