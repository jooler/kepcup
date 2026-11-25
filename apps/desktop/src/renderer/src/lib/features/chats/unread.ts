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

/** 消息到达判定（静默 / 提及）的共享结果形状（DEV-146 两条渲染路径统一）。 */
export interface MessageArrivalVerdict {
  /** 自己消息的回声（发送 principal = 自己的成员 id）：静默且不提醒。 */
  isOwnEcho: boolean;
  /** 到达时不计未读。 */
  silent: boolean;
  /** @ 我（`principal:<自己>`）：计提及角标并提醒。 */
  mentioned: boolean;
}

/**
 * 团队语境（多人类会话，知道「自己是谁」）的到达判定（DEV-146 两条渲染路径
 * 统一口径，62.04 §4「人类 @ = 通知」）：
 * - 静默：仅自己的消息回声（senderType 'user' 且 senderPrincipalId 等于自己的
 *   成员 id）——其他成员的人类消息计未读；工作台回执卡规则照搬（system_event
 *   + workbench origin，发送方必非 user）。
 * - 提及：不看发送方是人还是 Bot，只排除自己的回声（自己 @ 自己的回声也不提醒）。
 *
 * `selfMemberId` 为 null（主体上下文缺失，回声无法认定）时保留团队切片的原
 * 退化行为：人类消息计未读、不计提及。单用户本机路径（消息无主体字段）由调用
 * 方先行回退 `isSilentOnArrival` 单主体口径——本机所有 user 消息都是本人回执，
 * 静默不变（DEV-146 安全缺省）。
 */
export function teamMessageArrival(
  message: {
    senderType: string;
    senderPrincipalId?: string | null;
    mentions: readonly string[];
    kind: string;
    content: unknown;
  },
  selfMemberId: string | null,
): MessageArrivalVerdict {
  const isOwnEcho =
    selfMemberId !== null &&
    message.senderType === 'user' &&
    message.senderPrincipalId != null &&
    message.senderPrincipalId === selfMemberId;
  return {
    isOwnEcho,
    silent: isOwnEcho || (message.senderType !== 'user' && isSilentOnArrival(message)),
    mentioned:
      !isOwnEcho &&
      selfMemberId !== null &&
      message.mentions.some((token) => token === `principal:${selfMemberId}`),
  };
}
