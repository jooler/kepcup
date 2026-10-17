import type { Message } from '@kepcup/shared';
// 相对导入：本模块被纯逻辑单测（desktop 项目）直接引入，那边没有 $lib 别名。
import { isVisibleInTranscript } from '../chats/transcript-visibility';

/** 项目组沟通 tab 的徽标数据（WP6 §4 步骤 4）。 */
export interface ChatTabBadge {
  unread: number;
  pending: boolean;
}

/**
 * 未读 = seq > seenSeq、非用户本人发出、未撤回、且在会话记录里可见的消息条数
 * （可见性复用 isVisibleInTranscript——与消息列表同一组条件，不另立口径）。
 * 内部系统事件不会出现在渲染层消息里（core 的可见读路径已过滤），无需在此判断。
 * pending = 该会话有待确认审批（琥珀色圆点）。
 */
export function chatTabBadge(input: {
  messages: readonly Message[];
  seenSeq: number;
  pendingApprovals: number;
}): ChatTabBadge {
  let unread = 0;
  for (const message of input.messages) {
    if (message.seq <= input.seenSeq) continue;
    if (message.senderType === 'user') continue;
    if (message.status === 'recalled') continue;
    if (!isVisibleInTranscript(message)) continue;
    unread += 1;
  }
  return { unread, pending: input.pendingApprovals > 0 };
}
