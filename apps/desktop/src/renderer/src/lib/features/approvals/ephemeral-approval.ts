import { isEphemeralApprovalCardType, type Message } from '@kepcup/shared';

/**
 * Mid-turn permission popups (access, command, MCP, …). The dock above the
 * composer is the only user-facing surface. Import / install / handover cards
 * stay in the transcript, including their failure records.
 */
export function isEphemeralApprovalCard(message: Message): boolean {
  if (message.kind !== 'card') return false;
  const cardType = (message.content as { cardType?: unknown }).cardType;
  return typeof cardType === 'string' && isEphemeralApprovalCardType(cardType);
}
