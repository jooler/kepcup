import type { Approval, Message } from '@kepcup/shared';
// 相对导入：本模块被纯逻辑单测（desktop 项目）直接引入，那边没有 $lib 别名。
import { hiddenFromTranscript } from '../approvals/ephemeral-approval';
import { isVisibleWithChatDisplay, type ChatDisplayPrefs } from './chat-display';
import { isInterimMessage } from './run-status-mute';

/**
 * 会话记录可见性：消息列表（MessageList）与项目组沟通 tab 的未读徽标
 * （project-chat-badge）共用的同一组过滤条件，抽出来共享以免两边口径漂移
 * （WP6 §8）。可见 = 会渲染成会话内容的消息；状态遮罩（任务进度）与只属于
 * 输入坞上审批卡的弹窗不属于会话内容。
 *
 * `approvals` 缺省为空表：徽标场景没有审批快照，待审批的回执卡由琥珀色圆点
 * （pending）负责提示，不计入未读数。
 *
 * `display` 是「对话信息展示设置」的过滤上下文（设置 → 通用，renderer 本地）：
 * 勾选的类目常驻，未勾选类目按通知已读游标放行未读条目（`readThrough`）、
 * 超过 30 天窗口的不再显示（`now` 供纯函数判新鲜度），并保持本次查看已显示的
 * 条目（`keepIds`）；除 `prefs` / `now` 外与 `NoticeDisplayState` 同形（结构化
 * 直传）。缺省 null = 不过滤（纯逻辑单测与旧调用方保持原行为）。徽标场景恒传
 * null——未勾选类目的未读条目打开会话就会显示，应照常计入未读。
 */
export interface ChatDisplayFilter {
  prefs: ChatDisplayPrefs;
  /** 该会话的通知已读游标（与 `NoticeDisplayState.readThrough` 同义）。 */
  readThrough: number;
  /** 当前时刻（UTC 毫秒）：30 天保留窗口的新鲜度判定用。 */
  now: number;
  keepIds?: ReadonlySet<string>;
}

export function isVisibleInTranscript(
  message: Message,
  approvals: Readonly<Record<string, Approval | undefined>> = {},
  display: ChatDisplayFilter | null = null,
): boolean {
  // 初始化问询的用户回答（setupAnswer）不渲染气泡——回答由问题卡片的已答行
  // 展示；消息本身仍在（上下文/引用/记忆证据都用得到）。
  if (
    message.kind === 'text' &&
    'setupAnswer' in message.content &&
    message.content.setupAnswer === true
  ) {
    return false;
  }
  // Task interim is a single status overlay (task card / status line), not bubbles.
  if (isInterimMessage(message)) return false;
  // Retired: local change summary / diff / revert cards are not shown or kept in view.
  if (
    message.kind === 'card' &&
    'cardType' in message.content &&
    message.content.cardType === 'run_changes'
  ) {
    return false;
  }
  // Mid-turn permission popups: the dock is the only user-facing surface;
  // auto-decided and egress / taint records show folded once resolved.
  if (hiddenFromTranscript(message, approvals)) return false;
  // 对话信息展示设置：锁定类不受影响；未勾选类目按未读 / keep 放行。
  if (display !== null && !isVisibleWithChatDisplay(message, display.prefs, display, display.now)) {
    return false;
  }
  return true;
}
