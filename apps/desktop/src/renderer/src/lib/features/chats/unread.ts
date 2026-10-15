/**
 * 左栏未读数的合并规则（D75 W1-B 交接）：未读数只认服务端的计数——它只数
 * 用户可见的行（`countVisibleAfter`）。`lastSeq - lastReadSeq` 会把 Bot 的
 * 私有任务条目（task_event）与内部事务也算进去，因此不再作为回退：事件里
 * 没带计数时沿用已有条目的计数（之后由 message.created 逐条累加、打开会话
 * 时清零）；从未见过的会话先记 0，再向服务端取一次准确值。
 */
/**
 * 到达时不计未读的消息：工作台排期的回执卡（`schedule_created` 且 `schedule.origin === 'workbench'`）——
 * 它是用户（或管家，管家对话里已有说明）自己在工作台的操作产生的。与 core 的 `countVisibleAfter` 同一口径。
 */
export function isSilentOnArrival(message: {
  senderType: string;
  kind: string;
  content: unknown;
}): boolean {
  if (message.senderType === 'user') return true;
  if (message.kind !== 'system_event') return false;
  const content = message.content as { event?: unknown; schedule?: { origin?: unknown } };
  return content.event === 'schedule_created' && content.schedule?.origin === 'workbench';
}

export function mergeUnreadCount(
  incoming: { unreadCount?: number | undefined; lastSeq: number; lastReadSeq: number },
  existing: { unreadCount?: number | undefined } | undefined,
): { count: number; refetch: boolean } {
  if (incoming.unreadCount !== undefined) return { count: incoming.unreadCount, refetch: false };
  if (incoming.lastSeq <= incoming.lastReadSeq) return { count: 0, refetch: false };
  if (existing !== undefined) return { count: existing.unreadCount ?? 0, refetch: false };
  return { count: 0, refetch: true };
}
