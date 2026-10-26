/** Board tab badge. Same shape of decision as the chat tab: a count, plus pending. */
export interface BoardTabBadge {
  count: number;
  pending: boolean;
}

/**
 * Unread messages, pending approvals, and cards waiting for acceptance.
 * `pending` is the amber state: an approval is waiting, which the count
 * already includes.
 */
export function boardTabBadge(input: {
  unread: number;
  pendingApprovals: number;
  delivered: number;
}): BoardTabBadge {
  const unread = Math.max(0, input.unread);
  const pendingApprovals = Math.max(0, input.pendingApprovals);
  const delivered = Math.max(0, input.delivered);
  return {
    count: unread + pendingApprovals + delivered,
    pending: pendingApprovals > 0,
  };
}
