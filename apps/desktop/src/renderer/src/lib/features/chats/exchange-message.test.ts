import { describe, expect, it } from 'vitest';
import { exchangeMessageShape } from './exchange-message';
import type { Conversation, Message } from '@kepcup/shared';

/**
 * 委派交换会话的消息形态（v2.3，docs/design/27 §3.2）：发起方 A 相当于对话
 * 里的「用户」（右侧用户样式气泡），执行方 B 在左侧（Bot 气泡）；非交换会
 * 话与卡片 / 系统消息不参与，返回 null 走普通形态。
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
