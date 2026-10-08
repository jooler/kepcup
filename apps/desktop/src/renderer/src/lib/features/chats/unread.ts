/**
 * 左栏未读数的合并规则（D75 W1-B 交接）：未读数只认服务端的计数——它只数
 * 用户可见的行（`countVisibleAfter`）。`lastSeq - lastReadSeq` 会把 Bot 的
 * 私有任务条目（task_event）与内部事务也算进去，因此不再作为回退：事件里
 * 没带计数时沿用已有条目的计数（之后由 message.created 逐条累加、打开会话
 * 时清零）；从未见过的会话先记 0，再向服务端取一次准确值。
 */
export function mergeUnreadCount(
  incoming: { unreadCount?: number | undefined; lastSeq: number; lastReadSeq: number },
  existing: { unreadCount?: number | undefined } | undefined,
): { count: number; refetch: boolean } {
  if (incoming.unreadCount !== undefined) return { count: incoming.unreadCount, refetch: false };
  if (incoming.lastSeq <= incoming.lastReadSeq) return { count: 0, refetch: false };
  if (existing !== undefined) return { count: existing.unreadCount ?? 0, refetch: false };
  return { count: 0, refetch: true };
}
