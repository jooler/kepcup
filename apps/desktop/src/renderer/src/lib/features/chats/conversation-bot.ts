import type { Bot, Conversation } from '@kepcup/shared';

/**
 * `conversation.updated` 事件携带的是裸 domain Conversation——`bot` 视图字段
 * 只有 RPC 的列表/详情（conversationView）才附加。左栏对直聊要靠 `bot` 区分
 * 活跃 / 已删除：缺卡时先查通讯录（bot.updated 事件在维护它，管家提议创建
 * 的 Bot 卡先于会话事件到达）；通讯录里还没有（删除 Bot 后的只读推送、事件
 * 早于通讯录的极端时序）时由调用方回源 conversations.get 拿完整视图再判，
 * 不能把活跃 Bot 的新会话当已删除丢弃（D70：管家提议创建的 Bot 只经事件进
 * 左栏）。
 */
export function resolveConversationBot(
  conversation: Conversation,
  knownBots: readonly Bot[],
): { conversation: Conversation; refetch: boolean } {
  if (
    conversation.type !== 'direct' ||
    conversation.bot != null ||
    conversation.directBotId === null
  ) {
    return { conversation, refetch: false };
  }
  const known = knownBots.find((bot) => bot.id === conversation.directBotId);
  if (known !== undefined) return { conversation: { ...conversation, bot: known }, refetch: false };
  return { conversation, refetch: true };
}
