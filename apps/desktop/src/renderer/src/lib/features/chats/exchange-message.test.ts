import { describe, expect, it } from 'vitest';
import { avatarOriginBotName, exchangeMessageShape, teamMessageSide } from './exchange-message';
import type { Conversation, Message } from '@kepcup/shared';

/**
 * 委派交换会话的消息形态（v2.3，docs/design/27 §3.2）：发起方 A 相当于对话
 * 里的「用户」（右侧用户样式气泡），执行方 B 在左侧（Bot 气泡）；非交换会
 * 话与卡片 / 系统消息不参与，返回 null 走普通形态。
 * 团队上下文（T5）：用户消息按 senderPrincipalId 分侧，休眠时恒 null。
 */

const exchange = {
  id: 'conv_ex',
  type: 'bot_direct',
  title: null,
  directBotId: null,
  fromBotId: 'bot_a',
  toBotId: 'bot_b',
  workdirId: null,
  readOnly: false,
  archivedAt: null,
  summary: null,
  summaryUptoSeq: 0,
  lastSeq: 0,
  lastReadSeq: 0,
  lastMessageAt: null,
  createdAt: 1,
} as unknown as Conversation;

const direct = {
  ...exchange,
  type: 'direct',
  fromBotId: null,
  directBotId: 'bot_a',
} as unknown as Conversation;

function botText(botId: string): Message {
  return {
    id: `msg_${botId}`,
    conversationId: exchange.id,
    senderType: 'bot',
    senderBotId: botId,
    kind: 'text',
    status: 'sent',
    seq: 1,
    runId: null,
    replyTo: null,
    batchId: null,
    taskId: null,
    mentions: [],
    attachments: [],
    createdAt: 1,
    content: { text: '你好' },
  } as unknown as Message;
}

describe('exchangeMessageShape（v2.3 交换会话消息形态）', () => {
  it('发起方 A → issuer（右侧用户样式）；执行方 B → executor（左侧 Bot 样式）', () => {
    expect(exchangeMessageShape(exchange, botText('bot_a'))).toEqual({ side: 'issuer' });
    expect(exchangeMessageShape(exchange, botText('bot_b'))).toEqual({ side: 'executor' });
  });

  it('普通会话返回 null：用户 / Bot 消息形态不受影响', () => {
    expect(exchangeMessageShape(direct, botText('bot_a'))).toBeNull();
    expect(exchangeMessageShape(null, botText('bot_a'))).toBeNull();
    expect(exchangeMessageShape(undefined, botText('bot_b'))).toBeNull();
  });

  it('卡片 / 系统消息不参与左右形态（由 MessageBubble 专属分支渲染）', () => {
    const card = {
      ...botText('bot_b'),
      senderType: 'system',
      kind: 'card',
      senderBotId: null,
      content: { cardType: 'task' },
    } as unknown as Message;
    expect(exchangeMessageShape(exchange, card)).toBeNull();
  });
});

/** 用户消息（团队上下文分侧与分身徽标用例的数据）。 */
function userMessage(content: Record<string, unknown>, senderPrincipalId?: string | null): Message {
  return {
    id: 'msg_u1',
    conversationId: exchange.id,
    senderType: 'user',
    senderBotId: null,
    senderPrincipalId: senderPrincipalId ?? null,
    senderName: senderPrincipalId != null ? '甲' : null,
    kind: 'text',
    status: 'sent',
    seq: 1,
    runId: null,
    replyTo: null,
    batchId: null,
    taskId: null,
    mentions: [],
    attachments: [],
    createdAt: 1,
    content,
  } as unknown as Message;
}

describe('teamMessageSide（T5 团队上下文分侧）', () => {
  it('自己（senderPrincipalId = selfMemberId）→ self；对端 → peer 并带发送人快照', () => {
    expect(teamMessageSide(true, 'mbr_self', userMessage({ text: 'hi' }, 'mbr_self'))).toEqual({
      side: 'self',
      principalId: 'mbr_self',
      senderName: '甲',
    });
    expect(teamMessageSide(true, 'mbr_self', userMessage({ text: 'hi' }, 'mbr_peer'))).toEqual({
      side: 'peer',
      principalId: 'mbr_peer',
      senderName: '甲',
    });
  });

  it('休眠（非团队上下文）恒 null——调用方保持既有 senderType 判定', () => {
    const message = userMessage({ text: 'hi' }, 'mbr_peer');
    expect(teamMessageSide(false, 'mbr_self', message)).toBeNull();
    expect(teamMessageSide(false, null, message)).toBeNull();
  });

  it('Bot 消息不参与分侧；缺主体 id 的用户消息按自己处理', () => {
    expect(teamMessageSide(true, 'mbr_self', botText('bot_a'))).toBeNull();
    expect(teamMessageSide(true, 'mbr_self', userMessage({ text: 'hi' }))).toEqual({
      side: 'self',
      principalId: null,
      senderName: null,
    });
  });
});

describe('avatarOriginBotName（T10 预留的分身徽标）', () => {
  it("origin='avatar' 带代回 Bot 名；其余消息为 null", () => {
    expect(avatarOriginBotName(userMessage({ text: '在忙', origin: 'avatar', avatar: { botName: '小甲' } }, 'mbr_self'))).toBe('小甲');
    expect(avatarOriginBotName(userMessage({ text: 'hi' }, 'mbr_self'))).toBeNull();
    expect(avatarOriginBotName(userMessage({ origin: 'delegation', delegatedBy: 'bot_x' }, 'mbr_self'))).toBeNull();
    // bot 消息永远不参与
    expect(avatarOriginBotName(botText('bot_a'))).toBeNull();
  });
});
