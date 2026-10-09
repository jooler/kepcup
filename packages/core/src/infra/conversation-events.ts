import type { Bot, Conversation } from '@kepcup/shared';
import type { EventBus } from './events.js';

type ConversationEvents = { 'conversation.updated': { conversation: Conversation } };

/**
 * `conversation.updated` 出核前补上单聊的 `bot` 视图字段。
 *
 * 各发布点（butler 建团队、delegation、openDirect、groups…）发的是原始
 * domain 行，没有 `bot`；renderer 把「单聊无 bot」当作 Bot 已删除而不加入
 * 侧栏——新 Bot 的单聊要刷新后（conversations.list 走 view）才出现。
 * 在总线上统一补，所有发布点与订阅者（RPC 桥、测试）看到的都是同一形状。
 * 已带 `bot`（含显式 null）的负载原样放行；查询失败（库已关闭）也原样放行。
 */
export function withDirectConversationBots<M extends ConversationEvents>(
  bus: EventBus<M>,
  lookupBot: () => ((botId: string) => Bot | null) | null,
): EventBus<M> {
  const emit = bus.emit.bind(bus);
  return {
    ...bus,
    on: bus.on.bind(bus),
    clear: bus.clear.bind(bus),
    emit(event, payload) {
      if (event !== 'conversation.updated') {
        emit(event, payload);
        return;
      }
      const { conversation } = payload as M['conversation.updated'];
      if (conversation.directBotId === null || conversation.bot !== undefined) {
        emit(event, payload);
        return;
      }
      let bot: Bot | null | undefined;
      try {
        bot = lookupBot()?.(conversation.directBotId);
      } catch {
        bot = undefined;
      }
      if (bot === undefined) {
        emit(event, payload);
        return;
      }
      emit(event, { ...payload, conversation: { ...conversation, bot } });
    },
  };
}
