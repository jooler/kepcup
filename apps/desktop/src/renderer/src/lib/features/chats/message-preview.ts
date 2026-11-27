import type { Message } from '@kepcup/shared';
import { EPHEMERAL_APPROVAL_CARD_TYPES } from '@kepcup/shared';

/** System-event kinds that still carry a user-facing sidebar preview line. */
const PREVIEWABLE_SYSTEM_EVENTS = new Set(['mail_status', 'watch_status', 'workdir']);

/** Mirrors the Core conversations.list preview candidate filter. */
export function isPreviewableMessage(message: Message): boolean {
  if (message.status === 'recalled' || message.ownerBotId != null) return false;
  if (message.kind === 'text') {
    return (
      'text' in message.content &&
      message.content.text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '').length > 0 &&
      (!('interim' in message.content) || message.content.interim !== true)
    );
  }
  if (message.kind === 'system_event') {
    // Legacy mail / watch status cards and workdir change notices stay the live
    // sidebar preview (they already had one before the shared preview filter).
    const content = message.content as { event?: unknown; text?: unknown };
    if (typeof content.event !== 'string' || !PREVIEWABLE_SYSTEM_EVENTS.has(content.event)) {
      return false;
    }
    if (typeof content.text !== 'string') return false;
    return content.text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '').length > 0;
  }
  if (message.kind !== 'card' || !('cardType' in message.content)) return false;
  const cardType = message.content.cardType;
  return (
    cardType !== 'run_changes' &&
    !(EPHEMERAL_APPROVAL_CARD_TYPES as readonly string[]).includes(cardType)
  );
}

/** Latest previewable row in a loaded message window, independent of later system events. */
export function latestPreviewMessage(messages: readonly Message[]): Message | null {
  let latest: Message | null = null;
  for (const message of messages) {
    if (!isPreviewableMessage(message)) continue;
    if (latest === null || message.seq > latest.seq) latest = message;
  }
  return latest;
}
