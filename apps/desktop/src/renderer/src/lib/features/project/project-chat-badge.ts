import type { Message } from '@kepcup/shared';
// 相对导入：本模块被纯逻辑单测（desktop 项目）直接引入，那边没有 $lib 别名。
import {
  chatDisplayCategory,
  isChatDisplayKeyEnabled,
  isNoticeFresh,
  type ChatDisplayPrefs,
} from '../chats/chat-display';
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
 *
 * 对话信息展示设置：未勾选类目的未读条目（30 天窗口内）打开会话就会显示，
 * 照常计入未读；超 30 天的未读不再显示，也不计。勾选了的类目常驻显示，不受
 * 窗口影响照常计——`prefs` 缺省空表（各项按默认勾选状态解释）。
 */
export function chatTabBadge(input: {
  messages: readonly Message[];
  seenSeq: number;
  pendingApprovals: number;
  /** 对话信息展示设置的勾选状态（与消息列表同参）；缺省按各项默认值。 */
  prefs?: ChatDisplayPrefs;
  /** 当前时刻（UTC 毫秒），30 天保留窗口判定用；缺省 Date.now()。 */
  now?: number;
}): ChatTabBadge {
  const now = input.now ?? Date.now();
  let unread = 0;
  for (const message of input.messages) {
    if (message.seq <= input.seenSeq) continue;
    if (message.senderType === 'user') continue;
    if (message.status === 'recalled') continue;
    // 30 天窗口只约束未勾选类目（勾选了的常驻显示，照常计）。
    const category = chatDisplayCategory(message);
    if (
      category !== null &&
      !isChatDisplayKeyEnabled(input.prefs ?? {}, category) &&
      !isNoticeFresh(message, now)
    ) {
      continue;
    }
    if (!isVisibleInTranscript(message)) continue;
    unread += 1;
  }
  return { unread, pending: input.pendingApprovals > 0 };
}
