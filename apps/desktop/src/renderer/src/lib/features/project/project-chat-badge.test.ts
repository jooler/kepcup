import { describe, expect, it } from 'vitest';
import type { Message } from '@kepcup/shared';
import { NOTICE_UNREAD_MAX_AGE_MS } from '../chats/chat-display';
import { chatTabBadge } from './project-chat-badge';

/** 沟通 tab 徽标的全部口径（WP6 步骤 2）。 */

/** 固定「现在」与 30 天保留窗口的内外时间点，避免依赖真实时钟。 */
const NOW = 1_800_000_000_000;
const FRESH = NOW - 60_000;
const STALE = NOW - NOTICE_UNREAD_MAX_AGE_MS - 60_000;

type MsgInit = Partial<Omit<Message, 'content'>> &
  Pick<Message, 'id' | 'senderType'> & { content?: unknown };

function msg(partial: MsgInit): Message {
  return {
    conversationId: 'c1',
    seq: 10,
    kind: 'text',
    content: { text: 'hi' },
    status: 'normal',
    createdAt: FRESH,
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

  it('未勾选类目的未读通知照常计（打开会话就会显示）；超 30 天未读不再显示也不计', () => {
    const mail = (id: string, createdAt: number) =>
      msg({ id, senderType: 'bot', kind: 'card', content: { cardType: 'mail' }, createdAt });
    // 邮件卡未勾选：窗口内的未读打开会话会显示 → 计。
    expect(
      chatTabBadge({ messages: [mail('m1', FRESH)], seenSeq: 0, pendingApprovals: 0, now: NOW })
        .unread,
    ).toBe(1);
    // 超 30 天的未读通知不再显示 → 不计。
    expect(
      chatTabBadge({ messages: [mail('m1', STALE)], seenSeq: 0, pendingApprovals: 0, now: NOW })
        .unread,
    ).toBe(0);
    // 锁定类（Bot 文本）不受 30 天窗口影响，照常计。
    expect(
      chatTabBadge({
        messages: [msg({ id: 'm2', senderType: 'bot', createdAt: STALE })],
        seenSeq: 0,
        pendingApprovals: 0,
        now: NOW,
      }).unread,
    ).toBe(1);
  });

  it('30 天窗口只约束未勾选类目：勾选了的类目超期未读照常计', () => {
    const staleCard = (cardType: string): Message =>
      msg({
        id: 'm1',
        senderType: 'bot',
        kind: 'card',
        content: { cardType },
        createdAt: STALE,
      });
    // 任务卡默认勾选（常驻显示）：超期未读照常计。
    expect(
      chatTabBadge({
        messages: [staleCard('task')],
        seenSeq: 0,
        pendingApprovals: 0,
        now: NOW,
      }).unread,
    ).toBe(1);
    // 显式勾选的邮件卡同理。
    expect(
      chatTabBadge({
        messages: [staleCard('mail')],
        seenSeq: 0,
        pendingApprovals: 0,
        prefs: { mailCards: true },
        now: NOW,
      }).unread,
    ).toBe(1);
    // 同一条邮件卡在未勾选时不计。
    expect(
      chatTabBadge({
        messages: [staleCard('mail')],
        seenSeq: 0,
        pendingApprovals: 0,
        prefs: { mailCards: false },
        now: NOW,
      }).unread,
    ).toBe(0);
  });
});

describe('chatTabBadge pending', () => {
  it('pending 取 pendingApprovals > 0', () => {
    expect(chatTabBadge({ messages: [], seenSeq: 0, pendingApprovals: 0 }).pending).toBe(false);
    expect(chatTabBadge({ messages: [], seenSeq: 0, pendingApprovals: 2 }).pending).toBe(true);
  });
});
