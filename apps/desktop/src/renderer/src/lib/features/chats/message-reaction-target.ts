import type { Message } from '@kepcup/shared';
import { chat } from '$lib/stores/chat.svelte';
import type { ChatSession } from '$lib/stores/chat-session.svelte';
import type { ReactionTarget } from './message-reactions.svelte';

/**
 * 从会话视图构造 reaction / 举报目标（todo §6.5）：scope 与 reports.submit
 * 的 source 都由 session.source 映射；团队快照所需的会话类型、消息窗口与
 * Bot 显示名从这里切片。视图不是当前会话时 view 为 null（本机举报不受影
 * 响——core 从本地 DB 重读；团队举报会被 core 以 rejected 静默拒绝）。
 *
 * 独立成模块而不放进 message-reactions.svelte.ts：它依赖 chat store（重量
 * 级组件图），而 store 模块保持轻依赖以便单测直跑。
 */
export function reactionTargetOf(session: ChatSession, message: Message): ReactionTarget {
  const view = session.view;
  const targetView =
    view !== null && view.conversation.id === message.conversationId
      ? {
          conversationType: view.conversation.type,
          messages: view.messages,
          botName:
            message.senderBotId !== null
              ? (chat.botName(message.senderBotId) || null)
              : null,
        }
      : null;
  return { source: session.source, message, view: targetView };
}
