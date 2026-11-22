import { z } from 'zod';
import { teamFriendRequestViewSchema, teamMemberStateSchema } from './domain.js';

/**
 * Team-layer events (README fixed contract — names must not change). Pushed by
 * the team server's team event bus alongside the core `RPC_EVENT_NAMES`
 * stream; per-connection delivery is filtered by the team layer's event
 * classification (unclassified = not delivered, 62.03 §4).
 */

/** Fixed event-name list (literal tuple → literal union). */
export const TEAM_EVENT_NAMES = [
  'member.presenceChanged',
  'member.updated',
  'member.disabled',
  'team.avatarRevoked',
  // D129v2 好友层（仅投递给相关成员——event-policy 按载荷成员过滤）。
  'friend.requested',
  'friend.accepted',
  'friend.declined',
  'friend.removed',
  // 拉黑 / 解除拉黑（2026-11）：只投递给操作者本人会话（多标签页同步），
  // 被拉黑方收不到任何帧（不泄「被拉黑」语义）。
  'friend.blocked',
  'friend.unblocked',
] as const satisfies readonly string[];
export type TeamEventName = (typeof TEAM_EVENT_NAMES)[number];

export const teamEventSchemas = {
  /**
   * Presence state of a member changed (P0: derived from the connection table
   * on connect/disconnect; `away` from P1). `avatar` / `note` (T6, additive):
   * the away-state avatar flag (bot NAME only, 62.06 §2 thin contract) and the
   * member's free-form away note — present only while the member is away.
   */
  'member.presenceChanged': z.strictObject({
    memberId: z.string().min(1),
    state: teamMemberStateSchema,
    lastSeenAt: z.number().optional(),
    avatar: z.strictObject({ botName: z.string().min(1) }).optional(),
    note: z.string().optional(),
  }),
  /**
   * A member's profile changed (display name / avatar). Deliberately minimal:
   * receivers just refetch the address book; T6 may add fields only.
   */
  'member.updated': z.strictObject({ memberId: z.string().min(1) }),
  /** A member was disabled (connections dropped, address book refresh, 62.03 §2). */
  'member.disabled': z.strictObject({ memberId: z.string().min(1) }),
  /**
   * P2 离开态分身 (62.06): the member's avatar bot was revoked (member came
   * back or an admin disabled it); `botId` absent when no bot was ever spawned.
   *
   * `targetClientId`（T10，可选附加字段）表达「连接级定向」：携带时该事件只投递
   * 给该成员上绑定此 clientId 的那条连接（被撤销的前一运行端）——hub 的广播
   * 路径对它走连接级例外，其余连接（含同成员其它连接）不下发；缺省时按普通
   * 团队事件向全部成员扇出（兼容既有广播语义）。
   */
  'team.avatarRevoked': z.strictObject({
    memberId: z.string().min(1),
    botId: z.string().min(1).optional(),
    targetClientId: z.string().min(1).optional(),
  }),

  // --- D129v2 好友层（载荷即完整申请视图；投递按载荷成员定向过滤，不全员扇出）------

  /** 有人向我发来好友申请（只投递给接收人）。 */
  'friend.requested': z.strictObject({ request: teamFriendRequestViewSchema }),
  /** 我发出的申请被同意（投递给双方——同意方的其它客户端也要刷新好友栏）。 */
  'friend.accepted': z.strictObject({ request: teamFriendRequestViewSchema }),
  /** 我发出的申请被拒绝（只投递给发起人；申请视图带 declined 状态）。 */
  'friend.declined': z.strictObject({ request: teamFriendRequestViewSchema }),
  /**
   * 好友被删除（投递给双方）。`a` / `b` 为规范序（a < b）的两个成员 id——客户端
   * 取非自身一侧从好友列表移除；既有 dm 会话保留为历史。
   */
  'friend.removed': z.strictObject({ a: z.string().min(1), b: z.string().min(1) }),
  /**
   * 拉黑 / 解除拉黑（2026-11，只投递给操作者本人——多标签页同步拉黑名单）。
   * `by` 是操作者（event-gate 按它定向），`memberId` 是被拉黑的目标；被拉黑方
   * 收不到该事件（服务端不暴露「被拉黑」语义）。
   */
  'friend.blocked': z.strictObject({ by: z.string().min(1), memberId: z.string().min(1) }),
  'friend.unblocked': z.strictObject({ by: z.string().min(1), memberId: z.string().min(1) }),
} satisfies Record<TeamEventName, z.ZodTypeAny>;
