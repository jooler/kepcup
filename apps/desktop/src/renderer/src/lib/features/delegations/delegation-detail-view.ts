/**
 * 委派详情视图的正文状态（D113，docs/design/27-butler-and-delegation.md §3.2）：
 * 纯函数——委派行缺失 / 交换会话丢失 → 不可用文案；会话还在拉 → 加载占位；
 * 免打扰 parked 的委派尚未投递（0 条消息）→ 空态；其余正常渲染消息列表。
 */
export type DelegationDetailViewState =
  | 'unavailable'
  | 'loading'
  | 'empty'
  | 'messages';

export function detailViewState(input: {
  /** 委派行是否已读到（药丸懒加载可能还没回来）。 */
  hasDelegation: boolean;
  /** 委派行上的交换会话 id（v1 存量行没有）。 */
  exchangeConversationId: string | null;
  /** 详情视图对该会话的 open 是否已返回（成功或失败）。 */
  openSettled: boolean;
  /** open 返回 false：会话已不存在（被清理）。 */
  openFailed: boolean;
  /** 会话当前消息数。 */
  messageCount: number;
}): DelegationDetailViewState {
  if (!input.hasDelegation || input.exchangeConversationId === null || input.openFailed) {
    return 'unavailable';
  }
  if (!input.openSettled) return 'loading';
  return input.messageCount > 0 ? 'messages' : 'empty';
}
