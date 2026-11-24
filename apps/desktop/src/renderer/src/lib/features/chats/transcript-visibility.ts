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
 * `display` 是「对话信息展示设置」的勾选状态（设置 → 通用，renderer 本地）：
 * 用户关掉的类目（邮件卡、系统通知等）从这里一并滤掉；缺省 null = 不过滤
 * （纯逻辑单测与旧调用方保持原行为）。
 */
export function isVisibleInTranscript(
  message: Message,
  approvals: Readonly<Record<string, Approval | undefined>> = {},
  display: ChatDisplayPrefs | null = null,
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
  // 对话信息展示设置：用户关掉的可开关类目（锁定类消息不受影响）。
  if (display !== null && !isVisibleWithChatDisplay(message, display)) return false;
  return true;
}
