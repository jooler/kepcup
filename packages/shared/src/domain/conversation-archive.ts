import type { Conversation } from './types.js';

/**
 * 会话是否已从对话列表移除（归档）：数据、消息、wiki 全留，会话仍在通讯录里，
 * 可随时恢复。`archivedAt` 为空 = 在对话列表里。
 */
export function isArchivedConversation(
  conversation: Pick<Conversation, 'archivedAt'> | null | undefined,
): boolean {
  return conversation?.archivedAt !== null && conversation?.archivedAt !== undefined;
}
