import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { chatTabBadge } from './project-chat-badge';

/** 沟通 tab 徽标的全部口径（WP6 步骤 2）。 */

type MsgInit = Partial<Omit<Message, 'content'>> &
  Pick<Message, 'id' | 'senderType'> & { content?: unknown };

function msg(partial: MsgInit): Message {
  return {
    conversationId: 'c1',
    seq: 10,
    kind: 'text',
    content: { text: 'hi' },
    status: 'normal',
    createdAt: 1,
    runId: null,
    senderBotId: null,
    batchId: null,
    replyToMessageId: null,
    ...partial,
  } as Message;
}

describe('chatTabBadge unread', () => {
  it('用户自己的消息不计', () => {
    const badge = chatTabBadge({
      messages: [msg({ id: 'm1', senderType: 'user' }), msg({ id: 'm2', senderType: 'bot' })],
      seenSeq: 0,
      pendingApprovals: 0,
    });
    expect(badge.unread).toBe(1);
  });

  it('撤回不计', () => {
    const badge = chatTabBadge({
      messages: [msg({ id: 'm1', senderType: 'bot', status: 'recalled' })],
      seenSeq: 0,
      pendingApprovals: 0,
    });
    expect(badge.unread).toBe(0);
  });

  it('任务进度 interim / run_changes 卡 / 权限弹窗卡不计（非会话内容）', () => {
    const badge = chatTabBadge({
      messages: [
        msg({
          id: 'm1',
          senderType: 'bot',
          content: { text: '…', interim: true },
        }),
        msg({
          id: 'm2',
          senderType: 'bot',
          kind: 'card',
          content: { cardType: 'run_changes' },
        }),
        msg({
          id: 'm3',
          senderType: 'bot',
          kind: 'card',
          content: { cardType: 'access', approvalId: 'apr_1' },
        }),
      ],
      seenSeq: 0,
      pendingApprovals: 0,
    });
    expect(badge.unread).toBe(0);
  });

  it('内部系统事件不经过这里（core 可见读路径已过滤），可见的系统事件照常计', () => {
    const badge = chatTabBadge({
      messages: [
        msg({
          id: 'm1',
          senderType: 'system',
          kind: 'system_event',
          content: { event: 'project_member_joined' },
        }),
      ],
      seenSeq: 0,
      pendingApprovals: 0,
    });
    expect(badge.unread).toBe(1);
  });

  it('seq ≤ seenSeq 不计（已看过的）', () => {
    const badge = chatTabBadge({
      messages: [msg({ id: 'm1', senderType: 'bot', seq: 10 }), msg({ id: 'm2', senderType: 'bot', seq: 11 })],
      seenSeq: 10,
      pendingApprovals: 0,
    });
    expect(badge.unread).toBe(1);
  });
});

describe('chatTabBadge pending', () => {
  it('pending 取 pendingApprovals > 0', () => {
    expect(chatTabBadge({ messages: [], seenSeq: 0, pendingApprovals: 0 }).pending).toBe(false);
    expect(chatTabBadge({ messages: [], seenSeq: 0, pendingApprovals: 2 }).pending).toBe(true);
  });
});
