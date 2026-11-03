import type { Conversation, Message } from '@kepcup/shared';

/**
 * 委派交换会话（`bot_direct`）的消息形态（v2.3，docs/design/27 §3.2 / §3.7）：
 * 发起方 A 相当于这条「对话里的用户」——消息居右、用户样式气泡；执行方 B
 * 居左、Bot 样式气泡；两侧都带 Bot 头像（同一 Bot 连续消息只有第一条带头
 * 像，由 MessageList 的 merge.above 断开）。双方与用户的对话互不受影响——
 * 本模块只对交换会话返回形态，其余会话返回 null（走普通用户 / Bot 形态）。
 */
export interface ExchangeMessageShape {
  /** issuer = 发起方 A（右侧用户样式）；executor = 执行方 B（左侧 Bot 样式）。 */
  side: 'issuer' | 'executor';
}

export function exchangeMessageShape(
  conversation: Pick<Conversation, 'type' | 'fromBotId'> | null | undefined,
  message: Message,
): ExchangeMessageShape | null {
  if (conversation?.type !== 'bot_direct') return null;
  // 只有文本气泡参与左右形态；任务卡等居中卡片与系统 pill 由 MessageBubble
  // 的专属分支渲染，不进 ChatMessageRow。
  if (message.senderType !== 'bot' || message.kind !== 'text') return null;
  if (message.senderBotId !== null && message.senderBotId === (conversation.fromBotId ?? '')) {
    return { side: 'issuer' };
  }
  return { side: 'executor' };
}
