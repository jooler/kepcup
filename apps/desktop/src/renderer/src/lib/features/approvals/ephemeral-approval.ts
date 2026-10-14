import { isApprovalRecordCard, isHiddenApprovalCard, type Approval, type Message } from '@kepcup/shared';

/**
 * Mid-turn permission popups (access, command, MCP, …) that leave no transcript
 * trace: the dock above the composer is their only user-facing surface. Cards
 * flagged `record` (decided automatically, egress / taint-flagged) stay as a
 * folded one-line record; import / install / handover cards always stay.
 */
export function isEphemeralApprovalCard(message: Message): boolean {
  if (message.kind !== 'card') return false;
  return isHiddenApprovalCard(message.content as { cardType?: unknown; record?: unknown });
}

/**
 * Transcript filter: hidden popups never show; a record card shows only once
 * its approval is resolved (while pending the dock is the popup — no duplicate
 * line in the message flow). Unknown approval (not loaded yet) = not shown.
 */
export function hiddenFromTranscript(
  message: Message,
  approvals: Readonly<Record<string, Approval | undefined>>,
): boolean {
  if (message.kind !== 'card') return false;
  const content = message.content as { cardType?: unknown; record?: unknown; approvalId?: unknown };
  if (isHiddenApprovalCard(content)) return true;
  if (!isApprovalRecordCard(content)) return false;
  const approval = typeof content.approvalId === 'string' ? approvals[content.approvalId] : undefined;
  return approval === undefined || approval.status === 'pending';
}
