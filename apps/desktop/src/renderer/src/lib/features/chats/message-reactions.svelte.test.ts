import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGE_REACTION_EMOJIS,
  MESSAGE_REACTION_SCOPE_PATTERN,
  REPORT_EXCLUDED_MESSAGE_IDS_MAX,
  reportSourceSchema,
  reportTeamSnapshotSchema,
  type Message,
} from '@kepcup/shared';

/**
 * reaction store 的纯逻辑单测（AI 内容举报 todo §4 / §6.5 / §10.3）：scope /
 * source 映射、emoji 集合切片、toggle 语义（同 emoji 取消、换 emoji 替换、
 * 👎 再点 = react null + reports.cancel）、reports.submit 的 local / team 分支、
 * 团队快照构建（形状过 shared schema；非法输入降级）与 i18n key 齐全。组件
 * 行为靠 e2e。
 */

const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
let reactResponse: { reactions: unknown[] } = { reactions: [] };
let reportResponse: { status: string; reason?: string } = { status: 'queued' };
let cancelResponse: { status: string; reason?: string } = { status: 'cancelled' };
let reactionsPrefetchResponse: { reactions: unknown[] } = { reactions: [] };
let reactShouldFail = false;
let reportShouldFail = false;
let cancelShouldFail = false;
let prefetchShouldFail = false;

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      if (method === 'messages.react') {
        if (reactShouldFail) throw new Error('core unavailable');
        return reactResponse;
      }
      if (method === 'reports.submit') {
        if (reportShouldFail) throw new Error('core unavailable');
        return reportResponse;
      }
      if (method === 'reports.cancel') {
        if (cancelShouldFail) throw new Error('core unavailable');
        return cancelResponse;
      }
      if (method === 'messages.reactions') {
        if (prefetchShouldFail) throw new Error('core unavailable');
        return reactionsPrefetchResponse;
      }
      return {};
    },
  },
}));

// clientIdentity 在模块加载时读 localStorage（缺 = 生成随机 id）：桩一份固定
// 值让断言确定。必须在动态 import 之前就位。
const storage = new Map<string, string>([['kepcup.collab.clientId', 'client-fixed']]);
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const {
  messageReactions,
  reactionScopeOf,
  reportSourceOf,
  buildTeamSnapshot,
  messageTextOf,
  QUICK_REACTION_EMOJIS,
  MORE_REACTION_EMOJIS,
  REPORT_EMOJI,
} = await import('./message-reactions.svelte');
const { messageVisibility } = await import('$lib/stores/message-visibility.svelte');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** store 是模块级单例（跨测试持久）：每个用例拿全新的 (conversation, message) 键。 */
let fixtureSeq = 0;

function messageFixture(overrides: Partial<Message> = {}): Message {
  fixtureSeq += 1;
  return {
    id: `msg_bot_${fixtureSeq}`,
    conversationId: `conv_${fixtureSeq}`,
    seq: 10,
    senderType: 'bot',
    senderBotId: 'bot_1',
    kind: 'text',
    content: { text: '回复正文' },
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: 1_700_000_000_000,
    attachments: [],
    ownerBotId: null,
    taskId: null,
    ...overrides,
  };
}

function targetOf(
  message: Message,
  source: 'local' | `team:${string}` = 'local',
  view: Parameters<typeof buildTeamSnapshot>[1] = null,
) {
  return { source, message, view };
}

const applyReact = (reactions: unknown[]): void => {
  reactResponse = { reactions };
};

beforeEach(() => {
  calls.length = 0;
  reactResponse = { reactions: [] };
  reportResponse = { status: 'queued' };
  cancelResponse = { status: 'cancelled' };
  reactionsPrefetchResponse = { reactions: [] };
  reactShouldFail = false;
  reportShouldFail = false;
  cancelShouldFail = false;
  prefetchShouldFail = false;
});

describe('scope / source 映射（§5.6）', () => {
  it('本机 → local；团队 source（team:<serverHash>）即 scope 形状，直通', () => {
    expect(reactionScopeOf('local')).toBe('local');
    expect(reactionScopeOf('team:0123456789abcdef')).toBe('team:0123456789abcdef');
    expect(reactionScopeOf('team:0123456789abcdef')).toMatch(MESSAGE_REACTION_SCOPE_PATTERN);
    expect(reactionScopeOf('local')).toMatch(MESSAGE_REACTION_SCOPE_PATTERN);
  });

  it('reports.submit 的 source：local 无其他字段；团队只带 serverHash，永不上传 URL', () => {
    expect(reportSourceOf('local')).toEqual({ kind: 'local' });
    const team = reportSourceOf('team:0123456789abcdef');
    expect(team).toEqual({ kind: 'team', serverHash: '0123456789abcdef' });
    expect(reportSourceSchema.parse(team)).toEqual(team);
    expect(JSON.stringify(team)).not.toContain('http');
  });
});

describe('emoji 集合只从 shared 切片（§5.6）', () => {
  it('快捷 5 个 + 展开 7 个 = shared 固定集合，顺序一致且不复制', () => {
    expect(QUICK_REACTION_EMOJIS).toHaveLength(5);
    expect(MORE_REACTION_EMOJIS).toHaveLength(7);
    expect([...QUICK_REACTION_EMOJIS, ...MORE_REACTION_EMOJIS]).toEqual([
      ...MESSAGE_REACTION_EMOJIS,
    ]);
    // 👎 在快捷行里（举报入口一眼可见）。
    expect(QUICK_REACTION_EMOJIS).toContain(REPORT_EMOJI);
    expect(REPORT_EMOJI).toBe('👎');
  });
});

describe('reaction store：toggle 语义（§4.2）', () => {
  it('非 👎 首次点选：messages.react 带 emoji，无 reports.submit；响应整体更新聚合', async () => {
    const msg = messageFixture();
    applyReact([
      { messageId: msg.id, emoji: '👍', count: 2, mine: true },
      { messageId: msg.id, emoji: '❤️', count: 1, mine: false },
    ]);
    messageReactions.handleReact(targetOf(msg), '👍');
    await flush();
    const react = calls.find((call) => call.method === 'messages.react');
    expect(react?.payload).toEqual({
      scope: 'local',
      conversationId: msg.conversationId,
      messageId: msg.id,
      clientId: 'client-fixed',
      emoji: '👍',
    });
    expect(calls.some((call) => call.method === 'reports.submit')).toBe(false);
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBe('👍');
    expect(messageReactions.summariesOf('local', msg.conversationId, msg.id)).toEqual([
      { messageId: msg.id, emoji: '👍', count: 2, mine: true },
      { messageId: msg.id, emoji: '❤️', count: 1, mine: false },
    ]);
  });

  it('再点同一个 emoji = 取消（react null）；点别的 emoji = 替换', async () => {
    const msg = messageFixture();
    const target = targetOf(msg);
    // 先落一份 mine=👍 的状态，再验证后续点击的语义。
    applyReact([{ messageId: msg.id, emoji: '👍', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👍');
    await flush();
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBe('👍');

    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '👍', count: 0, mine: false }]);
    messageReactions.handleReact(target, '👍');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('messages.react');
    expect(calls[0]?.payload['emoji']).toBeNull();
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBeNull();

    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '❤️', count: 1, mine: true }]);
    messageReactions.handleReact(target, '❤️');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload['emoji']).toBe('❤️');
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBe('❤️');
  });

  it('👎 首次点击：messages.react(👎) 与 reports.submit 都发、互不等待；local 无 snapshot；状态入 store', async () => {
    const msg = messageFixture();
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(targetOf(msg), '👎');
    await flush();
    const react = calls.find((call) => call.method === 'messages.react');
    const report = calls.find((call) => call.method === 'reports.submit');
    expect(react?.payload['emoji']).toBe('👎');
    expect(report).toBeDefined();
    expect(report?.payload).toMatchObject({
      clientId: 'client-fixed',
      source: { kind: 'local' },
      messageId: msg.id,
      conversationId: msg.conversationId,
      surface: 'desktop',
    });
    // local 来源不带 snapshot（core 自己重读 DB）。
    expect(report?.payload['snapshot']).toBeUndefined();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');
  });

  it('local reports pass hidden row ids so Core can omit reply/context content', async () => {
    const msg = messageFixture({ replyTo: 'msg_hidden_outside_window' });
    const hidden = messageFixture({ id: 'msg_hidden', seq: 9 });
    const view = {
      conversationType: 'dm' as const,
      botName: '小艾',
      messages: [{ ...hidden, hidden: true }, msg],
    };
    messageVisibility.forget('local', msg.conversationId);
    messageVisibility.setHidden('local', msg.conversationId, 'msg_hidden_outside_window', true);
    try {
      messageReactions.handleReact(targetOf(msg, 'local', view), '👎');
      await flush();
      const report = calls.find((call) => call.method === 'reports.submit');
      expect(report?.payload['excludedMessageIds']).toEqual([
        'msg_hidden',
        'msg_hidden_outside_window',
      ]);
      expect(report?.payload['snapshot']).toBeUndefined();
    } finally {
      messageVisibility.forget('local', msg.conversationId);
    }
  });

  it('caps excluded ids at the schema limit without dropping the replied-to row', async () => {
    const msg = messageFixture({ replyTo: 'msg_hidden_reply' });
    const view = {
      conversationType: 'dm' as const,
      botName: '小艾',
      messages: Array.from({ length: REPORT_EXCLUDED_MESSAGE_IDS_MAX + 5 }, (_, index) => ({
        ...messageFixture({ id: `msg_hidden_${index}`, seq: index + 1 }),
        hidden: true,
      })),
    };
    messageVisibility.forget('local', msg.conversationId);
    messageVisibility.setHidden('local', msg.conversationId, 'msg_hidden_reply', true);
    try {
      messageReactions.handleReact(targetOf(msg, 'local', view), '👎');
      await flush();
      const report = calls.find((call) => call.method === 'reports.submit');
      const ids = report?.payload['excludedMessageIds'] as string[];
      expect(ids).toHaveLength(REPORT_EXCLUDED_MESSAGE_IDS_MAX);
      expect(ids).toContain('msg_hidden_reply');
    } finally {
      messageVisibility.forget('local', msg.conversationId);
    }
  });

  it('再点 👎 = 切换关闭：react(null) 与 reports.cancel 并发、互不等待；cancelled 清内部状态，再点走首次路径', async () => {
    const msg = messageFixture();
    const target = targetOf(msg);
    // 首次点击：react 👎 + reports.submit，内部状态 queued。
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');
    expect(calls.filter((call) => call.method === 'reports.submit')).toHaveLength(1);

    // 再点 👎：两个 RPC 并发发出——emoji 移除 + 举报撤回。
    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '👎', count: 0, mine: false }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    const react = calls.find((call) => call.method === 'messages.react');
    const cancel = calls.find((call) => call.method === 'reports.cancel');
    expect(react?.payload).toMatchObject({
      scope: 'local',
      messageId: msg.id,
      clientId: 'client-fixed',
      emoji: null,
    });
    expect(cancel?.payload).toEqual({ clientId: 'client-fixed', messageId: msg.id });
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBeNull();
    // cancelled → 内部举报状态清除。
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBeNull();

    // 第三次点 👎：内部状态已清 → 走首次路径（新的 react 👎 + 新的 submit）。
    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    expect(calls.find((call) => call.method === 'messages.react')?.payload['emoji']).toBe('👎');
    expect(calls.filter((call) => call.method === 'reports.submit')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'reports.cancel')).toBe(false);
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');
  });

  it('再点 👎 且 cancel 返回 not_revocable：emoji 仍被移除，内部举报状态保留', async () => {
    const msg = messageFixture();
    const target = targetOf(msg);
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');

    cancelResponse = { status: 'not_revocable', reason: 'sent' };
    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '👎', count: 0, mine: false }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    expect(calls.some((call) => call.method === 'reports.cancel')).toBe(true);
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBeNull();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');
  });

  it('再点 👎 且 cancel RPC 异常：不外抛、内部状态保留（无 toast，错误只进日志）', async () => {
    const msg = messageFixture();
    const target = targetOf(msg);
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    cancelShouldFail = true;
    expect(() => messageReactions.handleReact(target, '👎')).not.toThrow();
    await flush();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('queued');
  });

  it('已 👎 时点其他 emoji：替换 reaction 行（举报记录不受影响），不再 submit', async () => {
    const msg = messageFixture();
    const target = targetOf(msg);
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(target, '👎');
    await flush();
    calls.length = 0;
    applyReact([{ messageId: msg.id, emoji: '❤️', count: 1, mine: true }]);
    messageReactions.handleReact(target, '❤️');
    await flush();
    expect(calls.filter((call) => call.method === 'messages.react')).toHaveLength(1);
    expect(calls.at(-1)?.payload['emoji']).toBe('❤️');
    expect(calls.some((call) => call.method === 'reports.submit')).toBe(false);
  });

  it('reports.submit 的 queued / duplicate / failed 都只进内部状态，RPC 异常不外抛', async () => {
    const msg = messageFixture();
    reportResponse = { status: 'duplicate' };
    messageReactions.handleReact(targetOf(msg), '👎');
    await flush();
    expect(messageReactions.reportStatusOf('local', msg.conversationId, msg.id)).toBe('duplicate');

    const second = messageFixture();
    reportShouldFail = true;
    expect(() => messageReactions.handleReact(targetOf(second), '👎')).not.toThrow();
    await flush();
    expect(messageReactions.reportStatusOf('local', second.conversationId, second.id)).toBe(
      'failed',
    );
  });

  it('messages.react 失败：本地状态不动、错误只进日志，不外抛', async () => {
    const msg = messageFixture();
    reactShouldFail = true;
    expect(() => messageReactions.handleReact(targetOf(msg), '👍')).not.toThrow();
    await flush();
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBeNull();
  });
});

describe('reaction store：会话预取（§6.6，无事件订阅）', () => {
  it('同一 (scope, conversationId) 只发一次 messages.reactions；聚合按 messageId 分组', async () => {
    const conversationId = `conv_pre_${(fixtureSeq += 1)}`;
    reactionsPrefetchResponse = {
      reactions: [
        { messageId: 'msg_a', emoji: '👍', count: 1, mine: true },
        { messageId: 'msg_a', emoji: '😂', count: 2, mine: false },
        { messageId: 'msg_b', emoji: '🎉', count: 1, mine: false },
      ],
    };
    await messageReactions.prefetch('local', conversationId);
    await messageReactions.prefetch('local', conversationId);
    const prefetches = calls.filter((call) => call.method === 'messages.reactions');
    expect(prefetches).toHaveLength(1);
    expect(prefetches[0]?.payload).toEqual({
      scope: 'local',
      conversationId,
      clientId: 'client-fixed',
    });
    expect(messageReactions.summariesOf('local', conversationId, 'msg_a')).toEqual([
      { messageId: 'msg_a', emoji: '👍', count: 1, mine: true },
      { messageId: 'msg_a', emoji: '😂', count: 2, mine: false },
    ]);
    expect(messageReactions.summariesOf('local', conversationId, 'msg_b')).toEqual([
      { messageId: 'msg_b', emoji: '🎉', count: 1, mine: false },
    ]);
    expect(messageReactions.summariesOf('local', conversationId, 'msg_missing')).toEqual([]);
  });

  it('预取失败：允许下次进入会话重试', async () => {
    const conversationId = `conv_retry_${(fixtureSeq += 1)}`;
    prefetchShouldFail = true;
    await messageReactions.prefetch('local', conversationId);
    expect(calls.filter((call) => call.method === 'messages.reactions')).toHaveLength(1);
    prefetchShouldFail = false;
    await messageReactions.prefetch('local', conversationId);
    expect(calls.filter((call) => call.method === 'messages.reactions')).toHaveLength(2);
  });

  it('团队 scope 与本机 scope 的缓存互不串扰', async () => {
    const msg = messageFixture();
    applyReact([{ messageId: msg.id, emoji: '👍', count: 1, mine: true }]);
    messageReactions.handleReact(targetOf(msg, 'team:0123456789abcdef'), '👍');
    await flush();
    expect(calls[0]?.payload['scope']).toBe('team:0123456789abcdef');
    expect(messageReactions.mineEmojiOf('team:0123456789abcdef', msg.conversationId, msg.id)).toBe(
      '👍',
    );
    expect(messageReactions.mineEmojiOf('local', msg.conversationId, msg.id)).toBeNull();
  });
});

describe('团队快照构建（§5.2 / §6.5）', () => {
  /** 固定会话视图：夹 system_event / task_event，共 6 条候选 context。 */
  function teamView() {
    const mk = (overrides: Partial<Message>): Message => {
      const base: Message = { ...messageFixture(overrides), senderType: 'user', senderBotId: null };
      return { ...base, ...overrides };
    };
    return {
      conversationType: 'dm' as const,
      botName: '小艾',
      messages: [
        mk({ id: 'ctx_1', seq: 1, content: { text: '最早一句' } }),
        mk({
          id: 'ctx_skip_1',
          seq: 2,
          kind: 'system_event',
          senderType: 'system',
          content: { event: 'x', text: '系统事件' },
        }),
        mk({
          id: 'ctx_skip_2',
          seq: 3,
          kind: 'task_event',
          senderType: 'system',
          content: { taskId: 't', phase: 'result', text: '任务事件' },
        }),
        mk({ id: 'ctx_2', seq: 4, content: { text: '中间一句' } }),
        mk({
          id: 'ctx_3',
          seq: 5,
          kind: 'card',
          senderType: 'bot',
          senderBotId: 'bot_1',
          content: { cardType: 'present', approvalId: '' },
        }),
        mk({ id: 'ctx_4', seq: 6, content: { text: '最近一句' } }),
        mk({ id: 'ctx_5', seq: 7, content: { text: '更新的下一句' } }),
        mk({ id: 'reply_target', seq: 8, content: { text: '被引用的原文' } }),
        mk({ id: 'ctx_after', seq: 11, content: { text: '目标之后不算' } }),
      ],
    };
  }

  it('固定视图 → 形状正确且过 shared reportTeamSnapshotSchema.parse', () => {
    const target = messageFixture({
      kind: 'text',
      replyTo: 'reply_target',
      attachments: [
        {
          id: 'att_1',
          conversationId: 'conv_1',
          messageId: 'msg_target',
          fileName: 'chart.png',
          mime: 'image/png',
          size: 123,
          sha256: 'ab',
          relPath: 'x',
          createdAt: 1,
        },
      ],
    });
    const snapshot = buildTeamSnapshot(target, teamView());
    expect(snapshot).not.toBeNull();
    expect(() => reportTeamSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot?.message).toMatchObject({
      id: target.id,
      seq: 10,
      kind: 'text',
      status: 'normal',
      text: '回复正文',
      truncated: false,
      runId: null,
    });
    expect(snapshot?.message.attachments).toEqual([
      { fileName: 'chart.png', mime: 'image/png', size: 123 },
    ]);
    expect(snapshot?.replyTo).toEqual({ messageId: 'reply_target', text: '被引用的原文' });
    // context：目标之前最近的可见消息，跳过 system_event / task_event，升序，
    // 最多 4 条（候选 6 条可见 → 取最后 4 条，被引用消息也在其中——与 core
    // #contextOf 同口径）；目标之后的消息不算。
    expect(snapshot?.context.map((item) => item.messageId)).toEqual([
      'ctx_3',
      'ctx_4',
      'ctx_5',
      'reply_target',
    ]);
    expect(snapshot?.context[0]).toEqual({
      messageId: 'ctx_3',
      senderType: 'bot',
      kind: 'card',
      text: '',
      createdAt: 1_700_000_000_000,
    });
    expect(snapshot?.bot).toEqual({ id: 'bot_1', name: '小艾' });
    expect(snapshot?.conversation).toEqual({ type: 'dm' });
  });

  it('filters hidden reply targets and hidden context before building a team snapshot', () => {
    const target = messageFixture({ replyTo: 'reply_target' });
    const base = teamView();
    const view = {
      ...base,
      messages: base.messages.map((item) =>
        item.id === 'reply_target' || item.id === 'ctx_5'
          ? { ...item, hidden: true, content: { text: 'HIDDEN_TEAM_CONTENT' } }
          : item,
      ),
    };
    const snapshot = buildTeamSnapshot(target, view);
    expect(snapshot?.replyTo).toBeNull();
    expect(snapshot?.context.map((item) => item.messageId)).not.toContain('reply_target');
    expect(snapshot?.context.map((item) => item.messageId)).not.toContain('ctx_5');
    expect(JSON.stringify(snapshot)).not.toContain('HIDDEN_TEAM_CONTENT');
  });

  it('卡片消息：text 取空串、content 原样携带（截断由 core 做）', () => {
    const card = messageFixture({
      kind: 'card',
      content: {
        cardType: 'present',
        approvalId: '',
        present: { kind: 'line', title: '', data: null },
      },
    });
    const snapshot = buildTeamSnapshot(card, teamView());
    expect(snapshot?.message.text).toBe('');
    expect(snapshot?.message.content).toEqual({
      cardType: 'present',
      approvalId: '',
      present: { kind: 'line', title: '', data: null },
    });
    expect(messageTextOf(card)).toBe('');
  });

  it('replyTo 目标不在窗口 / view 缺失 / 非 text|card / 字段非法 → 降级 null', () => {
    const view = teamView();
    expect(
      buildTeamSnapshot(messageFixture({ replyTo: 'msg_gone' }), view)?.replyTo ?? null,
    ).toBeNull();
    expect(buildTeamSnapshot(messageFixture(), null)).toBeNull();
    expect(buildTeamSnapshot(messageFixture({ kind: 'task_event' }), view)).toBeNull();
    // 非法输入：attachment size 不是数字 → safeParse 失败 → null（不抛）。
    const broken = messageFixture({
      attachments: [
        {
          id: 'att_bad',
          conversationId: 'conv_1',
          messageId: 'msg_target',
          fileName: 'x.png',
          mime: 'image/png',
          size: Number.NaN,
          sha256: 'ab',
          relPath: 'x',
          createdAt: 1,
        },
      ],
    });
    expect(() => buildTeamSnapshot(broken, view)).not.toThrow();
    expect(buildTeamSnapshot(broken, view)).toBeNull();
  });
});

describe('store 的团队举报分支带 snapshot（§6.5）', () => {
  it('team source 点击 👎：reports.submit 带 source{kind:team} 与可解析的 snapshot', async () => {
    const msg = messageFixture();
    const view = {
      conversationType: 'dm' as const,
      botName: '小艾',
      messages: [msg],
    };
    applyReact([{ messageId: msg.id, emoji: '👎', count: 1, mine: true }]);
    messageReactions.handleReact(targetOf(msg, 'team:0123456789abcdef', view), '👎');
    await flush();
    const report = calls.find((call) => call.method === 'reports.submit');
    expect(report?.payload['source']).toEqual({ kind: 'team', serverHash: '0123456789abcdef' });
    const snapshot = report?.payload['snapshot'];
    expect(snapshot).toBeDefined();
    expect(() => reportTeamSnapshotSchema.parse(snapshot)).not.toThrow();
    // 快照 message 直取现有文本（截断由 core 做）。
    expect((snapshot as { message: { text: string } }).message.text).toBe('回复正文');
  });

  it('team source 但 view 不可得：无 snapshot 照发（core 以 rejected 静默拒绝），状态入 store', async () => {
    const msg = messageFixture();
    reportResponse = { status: 'rejected', reason: 'snapshot missing' };
    messageReactions.handleReact(targetOf(msg, 'team:0123456789abcdef'), '👎');
    await flush();
    const report = calls.find((call) => call.method === 'reports.submit');
    expect(report).toBeDefined();
    expect(report?.payload['snapshot']).toBeUndefined();
    expect(
      messageReactions.reportStatusOf('team:0123456789abcdef', msg.conversationId, msg.id),
    ).toBe('rejected');
  });
});

describe('i18n：reaction key 中英文齐全（§10.3）', () => {
  it('12 个 emoji + 面板 / chips 文案两份词典都有，占位符一致', async () => {
    const { zhCN } = await import('$lib/i18n/locales/zh-CN');
    const { enUS } = await import('$lib/i18n/locales/en-US');
    const keys = [
      'messages.reactions.add',
      'messages.reactions.more',
      'messages.reactions.report',
      'messages.reactions.chipAria',
      ...MESSAGE_REACTION_EMOJIS.map((emoji) => `messages.reactions.emoji.${emoji}`),
    ];
    for (const key of keys) {
      expect(zhCN[key as keyof typeof zhCN], `zh: ${key}`).toBeTruthy();
      expect(enUS[key as keyof typeof enUS], `en: ${key}`).toBeTruthy();
    }
    expect(zhCN['messages.reactions.chipAria']).toContain('{emoji}');
    expect(zhCN['messages.reactions.chipAria']).toContain('{count}');
    expect(enUS['messages.reactions.chipAria']).toContain('{emoji}');
    expect(enUS['messages.reactions.chipAria']).toContain('{count}');
    // 👎 的可达性文案写明举报语义（§4.6）。
    expect(zhCN['messages.reactions.emoji.👎']).toContain('举报');
    expect(enUS['messages.reactions.emoji.👎']).toContain('report');
  });
});
