import type { ConversationView } from '$lib/stores/chat.svelte';

/** 管家（D70）的私聊：侧栏固定置顶；删除其聊天记录后需重开一个空私聊。 */
export function isButlerConversation(conversation: ConversationView | undefined): boolean {
  return conversation?.type === 'direct' && conversation.bot?.systemRole === 'butler';
}
