import type { Bot, Settings } from '@kepcup/shared';

/** Profile `runtime.message_transport` for the auto-managed InkCop system Bot. */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

export function isInkcopLocalBot(bot: Bot | null | undefined): boolean {
  return bot?.profile?.runtime?.message_transport === INKCOP_LOCAL_TRANSPORT;
}

export function inkcopCollabEnabled(settings: Settings | null | undefined): boolean {
  return settings?.inkcopLocalCollab?.enabled === true;
}

export function inkcopSystemBotId(settings: Settings | null | undefined): string {
  return settings?.inkcopLocalCollab?.systemBotId?.trim() ?? '';
}

/** 关闭协作时侧栏应隐藏该会话（系统 InkCop Bot 的私聊）。 */
export function isHiddenInkcopConversation(
  conversation: { type?: string; directBotId?: string | null; bot?: Bot | null },
  settings: Settings | null | undefined,
): boolean {
  if (inkcopCollabEnabled(settings)) return false;
  if (conversation.type === 'project') return false;
  const systemId = inkcopSystemBotId(settings);
  if (systemId.length > 0 && conversation.directBotId === systemId) return true;
  if (conversation.bot && isInkcopLocalBot(conversation.bot)) return true;
  return false;
}

/** 关闭协作时「开始对话」列表也隐藏 InkCop 系统 Bot。 */
export function isHiddenInkcopBot(bot: Bot, settings: Settings | null | undefined): boolean {
  if (inkcopCollabEnabled(settings)) return false;
  const systemId = inkcopSystemBotId(settings);
  if (systemId.length > 0 && bot.id === systemId) return true;
  return isInkcopLocalBot(bot);
}
