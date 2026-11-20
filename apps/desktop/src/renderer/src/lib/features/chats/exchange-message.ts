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

/**
 * 团队上下文的用户消息分侧（T5 步骤 4，62.04 §3/§7）：dm / 项目组里
 * `senderType==='user'` 的消息按发送主体（`senderPrincipalId`）判左右——
 * 自己在右（普通用户气泡），其他成员在左（带发送人名与成员头像）。
 *
 * 休眠语义：`teamActive` 为 false（未连接团队服务器）时恒返回 null，调用方
 * 保持既有 `senderType` 判定，行为逐字节不变。分身代回（origin='avatar'）的
 * 消息 senderPrincipalId 是成员本人，天然落在自己的右侧。
 */
export interface TeamMessageSide {
  side: 'self' | 'peer';
  /** 发送主体 id（`senderPrincipalId`；缺失时按自己处理）。 */
  principalId: string | null;
  /** 发送人显示名快照（senderName；缺失回落名册 / 主体 id，由调用方决定）。 */
  senderName: string | null;
}

export function teamMessageSide(
  teamActive: boolean,
  selfMemberId: string | null | undefined,
  message: Message,
): TeamMessageSide | null {
  if (!teamActive || message.senderType !== 'user') return null;
  const principalId = message.senderPrincipalId ?? null;
  if (principalId === null || (selfMemberId !== null && principalId === selfMemberId)) {
    return { side: 'self', principalId, senderName: message.senderName ?? null };
  }
  return { side: 'peer', principalId, senderName: message.senderName ?? null };
}

/**
 * 分身徽标的数据（T5 只渲染，为 T10 离开态分身预留，62.06）：`origin==='avatar'`
 * 的用户消息带代回 Bot 名，气泡下方标「分身 · {botName}」。非分身消息返回 null。
 */
export function avatarOriginBotName(message: Message): string | null {
  if (message.senderType !== 'user') return null;
  const content = message.content as { origin?: string; avatar?: { botName?: unknown } };
  if (content.origin !== 'avatar') return null;
  const botName = content.avatar?.botName;
  return typeof botName === 'string' && botName.length > 0 ? botName : null;
}
