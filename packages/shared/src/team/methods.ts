import { z } from 'zod';
import { conversationSchema } from '../domain/types.js';
import {
  teamBootstrapSchema,
  teamBotPatchSchema,
  teamBotProfilePatchSchema,
  teamBotViewSchema,
  teamFriendRequestViewSchema,
  teamFriendsListSchema,
  teamMemberSchema,
  teamModelOptionSchema,
  teamSettingsSchema,
  teamUsageRangeSchema,
  teamUsageSummarySchema,
  teamWorkdirOptionSchema,
} from './domain.js';

/**
 * Team-layer RPC methods (README fixed contract — names must not change).
 * These live OUTSIDE `APP_RPC_METHODS` / `rpcMethodSchemas`: core never
 * implements them; the team server (`apps/team-server`) does. Every name here
 * is served by the team layer's method table; anything not classified is
 * rejected with `FORBIDDEN` (62.03 §4, "未归类即拒绝").
 *
 * Schemas for P1 / P2 methods are frozen in T3 together with the P0 ones;
 * implementation lands in the corresponding phase (T4 P0, T6 P1, T9 P2).
 * Shapes are the minimal reasonable inference from the README and the 62
 * design docs — later phases may only ADD optional fields.
 *
 * 2026-11 契约修订（D128 修订版）：成员自建私有 Bot（`team.bots.*Private`，
 * T6 P1）整体下线——服务端 Bot 全部由管理员在 console 创建并初始化，Bot 的
 * 私有化改由可见性控制（白名单单人 = 该成员的私有 Bot）。三个方法名从固定
 * 契约移除（客户端与服务端同版本发布，旧名打到新服务端按「未归类即拒绝」
 * 返回 FORBIDDEN）。
 *
 * 2026-11（B 方案 member-bots，B1）：恢复成员侧 Bot 生命周期——新增
 * `team.bots.*` 8 方法（create / update / delete / transfer / list /
 * workdirOptions / workdirMkdir / modelOptions，todo/member-bots README
 * 「固定契约」）。与 D128v2 下线的 `team.bots.*Private` 旧名无关：旧名仍按
 * 未归类拒绝；私有 / 公共 Bot 落在既有可见性行上（B-5），配额（B-6）与工作
 * 路径边界（B-10）由服务端策略执行（实现 B2 落地）。
 */

/**
 * Strict empty input that tolerates an absent params frame: the transports
 * call with `undefined` when a client sends no params (same semantics as
 * rpc/methods.ts `voidInput`).
 */
const emptyInput = z.strictObject({}).default({});

const okOutput = z.strictObject({ ok: z.literal(true) });

/**
 * Fixed method-name list (literal tuple → literal union). `teamRpcMethodSchemas`
 * below is checked against this record, so a name without io or an io without
 * a name is a compile-time error.
 */
export const TEAM_RPC_METHODS = [
  // P0 (T4)
  'team.bootstrap',
  'team.members.list',
  'team.dm.open',
  'team.projects.addMembers',
  'team.projects.removeMember',
  'team.projects.roster',
  // P1 (T6)
  'team.presence.setAway',
  'team.profile.push',
  'team.projects.transferLead',
  'team.settings.get',
  'team.settings.update',
  'team.usage.mine',
  // 成员自助资料（2026-11 web 端个人资料：显示名 / 头像的写入口——成员侧
  // settings.update 是 admin plane 被拒，identity 只能落在成员行上）
  'team.member.updateSelf',
  // P1.5 (D129v2 通讯录好友层；私聊准入 = 仅好友)
  'team.members.search',
  'team.friends.request',
  'team.friends.accept',
  'team.friends.decline',
  'team.friends.cancel',
  'team.friends.remove',
  'team.friends.block',
  'team.friends.unblock',
  'team.friends.list',
  // P2 (T9)
  'team.memory.share',
  'team.resolutions.list',
  'team.resolutions.approve',
  'team.resolutions.revoke',
  'team.resolutions.withdraw',
  // 成员侧 Bot 面（B 方案 member-bots B1；实现 B2）
  'team.bots.create',
  'team.bots.update',
  'team.bots.delete',
  'team.bots.transfer',
  'team.bots.list',
  'team.bots.workdirOptions',
  'team.bots.workdirMkdir',
  'team.bots.modelOptions',
] as const satisfies readonly string[];
export type TeamRpcMethodName = (typeof TEAM_RPC_METHODS)[number];

/** Per-method zod io pair, mirroring rpcMethodSchemas' { input, output } shape. */
export interface TeamRpcIo {
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
}

// --- P2 resolution view (T9: full schema frozen here; 62.09 §2 / §3) -----------

/**
 * One snapshot member of a resolution view (T9): the propose-time human roster
 * entry with the content version they signed. `approvedVersion` below the
 * view's `version` = a stale signature (「待重签」); null = not signed.
 */
export const teamResolutionSnapshotMemberSchema = z.strictObject({
  memberId: z.string().min(1),
  /** Propose-time display name snapshot (deleted members stay identifiable). */
  name: z.string(),
  approvedVersion: z.number().int().min(1).nullable(),
});
export type TeamResolutionSnapshotMember = z.infer<typeof teamResolutionSnapshotMemberSchema>;

/**
 * Resolution view for the `team.resolutions.*` contracts (62.09). The card
 * message in the project timeline renders from the same server row; this view
 * is the list / re-hydration read for the team surface (snapshot signature
 * details included — the renderer pairs them with member cards).
 */
export const teamResolutionViewSchema = z.strictObject({
  /** Resolution id (`res_*`). */
  id: z.string().min(1),
  /** Project conversation the resolution belongs to. */
  conversationId: z.string().min(1),
  /** The executive-lead bot that issued the card. */
  issuedByBotId: z.string().min(1),
  /** Lifecycle state (62.09 §3); passed resolutions are locked forever. */
  state: z.enum(['open', 'passed', 'withdrawn']),
  title: z.string(),
  /** Structured body (目标 / 范围 / 执行要点) — same text as the card. */
  body: z.string(),
  /** Content version; approvals bind to it (signatures clear on update). */
  version: z.number().int().min(1),
  /** The caller's signature on the CURRENT content version; null = not signed. */
  myApprovalVersion: z.number().int().nullable(),
  /** Propose-time human snapshot with per-member signature versions. */
  snapshot: z.array(teamResolutionSnapshotMemberSchema),
  /** The `kind='card'` message carrying the resolution card (62.09 §3). */
  cardMessageId: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  passedAt: z.number().nullable().optional(),
  withdrawnAt: z.number().nullable().optional(),
  /** Who withdrew: the member id (project lead RPC) or bot id (executive tool). */
  withdrawnBy: z.string().nullable().optional(),
  /** Earlier resolution this one supersedes (display-only relation, 62.09 §2). */
  supersedesResolutionId: z.string().nullable().optional(),
});
export type TeamResolutionView = z.infer<typeof teamResolutionViewSchema>;

// --- T7 roster increment（C15 名册行的唯一读出口） -----------------------------

/**
 * One human member of a project conversation (`team.projects.roster`, T7):
 * the `team.members.list` card shape (presence included) plus the roster role.
 * LEFT members are not listed — the server keeps their rows for usage-split
 * history, the panel shows the ACTIVE roster only.
 */
export const teamProjectRosterMemberSchema = teamMemberSchema.extend({
  role: z.enum(['lead', 'member']),
});
export type TeamProjectRosterMember = z.infer<typeof teamProjectRosterMemberSchema>;

export const teamRpcMethodSchemas = {
  // --- P0 (implemented in T4) -------------------------------------------------

  /** Member connection bootstrap: identity, server info, hidden surfaces, conversation view, ceiling. */
  'team.bootstrap': { input: emptyInput, output: teamBootstrapSchema },

  /** Address book: all members visible to the caller with their presence state. */
  'team.members.list': {
    input: emptyInput,
    output: z.strictObject({ members: z.array(teamMemberSchema) }),
  },

  /**
   * Open (or re-open) a dm conversation with another member. Optional in the
   * fixed contract: P0 client flows always pass a target; omitting it is
   * reserved for the renderer's dm list entry (T4/T6 decides, fields additive).
   */
  'team.dm.open': {
    input: z.strictObject({ targetMemberId: z.string().min(1).optional() }),
    output: z.strictObject({ conversation: conversationSchema }),
  },

  /** Add human members to a project conversation (caller must be in the group; T4 guards). */
  'team.projects.addMembers': {
    input: z.strictObject({
      conversationId: z.string().min(1),
      memberIds: z.array(z.string().min(1)).min(1),
    }),
    output: okOutput,
  },

  /** Remove a human member from a project conversation (project lead only, 62.09 §1). */
  'team.projects.removeMember': {
    input: z.strictObject({
      conversationId: z.string().min(1),
      memberId: z.string().min(1),
    }),
    output: okOutput,
  },

  /**
   * Project human roster read (T7 increment): the C15 roster rows
   * (`conversation_principals`) were not exposed by any earlier team method —
   * `conversations.members` lists Bot members only, so the desktop member panel
   * had to derive the roster from message senders (wrong for a fresh project
   * where nobody has spoken, or for a member added moments ago). Caller must be
   * an enrolled member (NOT_FOUND otherwise — same no-existence-leak answer as
   * the sibling `team.projects.*` writes).
   */
  'team.projects.roster': {
    input: z.strictObject({ conversationId: z.string().min(1) }),
    output: z.strictObject({
      /** ACTIVE human principals with their card + roster role (lead first). */
      members: z.array(teamProjectRosterMemberSchema),
      /** The human project lead's member id; null = no lead designated. */
      leadMemberId: z.string().nullable(),
    }),
  },

  // --- P1 (implemented in T6) -------------------------------------------------

  /**
   * Away state toggle (62.06 离开态): `away: false` returns the member to
   * derived presence and clears the note / avatar flag. The server records the
   * setting connection (T10's single avatar runtime); the avatar itself only
   * stores `botName` and rides the `member.presenceChanged` broadcast.
   *
   * `client`（T10，可选附加字段，D121 同款）：带上后服务端把该连接绑定的
   * clientId 记为分身运行端（avatarSetBy）——T10 的单一运行端判定（接管撤销、
   * origin='avatar' 代发校验）以它为准；不带时 avatarSetBy 为该连接当下已绑
   * 定的 clientId（可能为 null，运行端判定随之退化为「未知」）。
   */
  'team.presence.setAway': {
    input: z.strictObject({
      away: z.boolean(),
      /** Free-form away note (dm header / roster display; T7 consumes). */
      note: z.string().max(200).optional(),
      /** Digital-avatar flag (62.06 §2 thin contract): only the bot NAME lives here. */
      avatar: z.strictObject({ botName: z.string().min(1).max(120) }).optional(),
      /** Caller's client identity (D119/D121 shape); binds the avatar runtime end. */
      client: z.object({ id: z.string().min(1), name: z.string().optional() }).optional(),
    }),
    output: okOutput,
  },

  /**
   * Profile seeding upload (62.05 §5): `{items:[{category,content}]}`, ≤100 per
   * call, additive merge for the caller only (只增不改 / 只补不删). Server-side
   * hard rate limit: one call per member per minute → RATE_LIMITED.
   */
  'team.profile.push': {
    input: z.strictObject({
      items: z
        .array(
          z.strictObject({
            /** Profile category key (same taxonomy as the local `profile.list`). */
            category: z.string().min(1),
            /** Conclusion text (no evidence — the server cannot resolve local message ids). */
            content: z.string().min(1),
          }),
        )
        .max(100),
    }),
    output: z.strictObject({
      /** Items inserted (deduped by (category, normalized content) against the caller's domain). */
      added: z.number().int().min(0),
      /** Items skipped as duplicates (server entries are never retracted by a push). */
      skipped: z.number().int().min(0),
    }),
  },

  /** Transfer the project lead role (human lead, 62.09 §1) to another member. */
  'team.projects.transferLead': {
    input: z.strictObject({
      conversationId: z.string().min(1),
      memberId: z.string().min(1),
    }),
    output: okOutput,
  },

  /** Member-domain settings (62.03 §5): read / replace the caller's own settings object. */
  'team.settings.get': { input: emptyInput, output: z.strictObject({ settings: teamSettingsSchema }) },
  'team.settings.update': {
    input: z.strictObject({ settings: teamSettingsSchema }),
    output: z.strictObject({ settings: teamSettingsSchema }),
  },

  /**
   * The caller's own usage (P1 direct-chat full attribution, 62.03 D137).
   * `range` optional (additive, T6): UTC-ms `[from, to)` window; absent = the
   * last 30 days. The `.default({})` tolerates an absent params frame (same
   * semantics as `emptyInput` above).
   */
  'team.usage.mine': {
    input: z.strictObject({ range: teamUsageRangeSchema.optional() }).default({}),
    output: teamUsageSummarySchema,
  },

  /**
   * 成员自助资料（web 端个人资料分区的写入口）：更新 CALLER 自己的显示名 / 头像
   * （两者至少给一个）。校验口径与 console 的成员编辑一致（trim 后 1..120、无
   * 控制字符；avatar 为 data URL 或 null 清除，≤200_000 字符）。成功后广播
   * `member.updated`（名册各方重拉），审计记 member.update-self。
   */
  'team.member.updateSelf': {
    input: z.strictObject({
      displayName: z.string().min(1).max(120).optional(),
      avatar: z.string().min(1).max(200_000).nullable().optional(),
    }),
    output: z.strictObject({ member: teamMemberSchema }),
  },

  // --- P1.5 好友层（D129v2；dm 准入随之收窄为仅好友）-----------------------------

  /**
   * 按用户名 / 显示名搜索成员（加好友入口）。大小写不敏感的子串匹配；结果
   * 不含凭据，disabled 成员不出（同 team.members.list 口径）。项目组加人等
   * 「找成员」场景也走这里，通讯录好友栏不再陈列全员。
   */
  'team.members.search': {
    input: z.strictObject({
      query: z.string().min(1).max(100),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    output: z.strictObject({ members: z.array(teamMemberSchema) }),
  },

  /**
   * 发好友申请（按用户名；未知 / disabled 用户名同 dm 口径 NOT_FOUND，不泄
   * 存在性）。重复申请幂等返回既有 pending；已是好友 → ALREADY_FRIENDS；
   * 目标已拉黑申请方 → FRIEND_REQUEST_DECLINED（不暴露「被拉黑」语义）。
   */
  'team.friends.request': {
    input: z.strictObject({
      username: z.string().min(1).max(100),
      message: z.string().max(200).optional(),
    }),
    output: z.strictObject({ request: teamFriendRequestViewSchema }),
  },
  /** 同意好友申请（仅接收人）；成功即建 friendship，双方进彼此通讯录。 */
  'team.friends.accept': {
    input: z.strictObject({ requestId: z.string().min(1) }),
    output: okOutput,
  },
  /** 拒绝好友申请（仅接收人；申请落 declined，发起人收到通知事件）。 */
  'team.friends.decline': {
    input: z.strictObject({ requestId: z.string().min(1) }),
    output: okOutput,
  },
  /** 撤回自己的待处理申请（仅发起人）。 */
  'team.friends.cancel': {
    input: z.strictObject({ requestId: z.string().min(1) }),
    output: okOutput,
  },
  /** 删除好友（双向解除；既有 dm 会话保留为历史，自隐藏语义不变）。 */
  'team.friends.remove': {
    input: z.strictObject({ memberId: z.string().min(1) }),
    output: okOutput,
  },
  /**
   * 拉黑成员（2026-11）：既有的好友关系一并解除（双方收 friend.removed），
   * 两人间待处理申请一并终态；被拉黑方再申请 → FRIEND_REQUEST_DECLINED。
   * 重复拉黑 → ALREADY_BLOCKED。
   */
  'team.friends.block': {
    input: z.strictObject({ memberId: z.string().min(1) }),
    output: okOutput,
  },
  /** 解除拉黑（未拉黑 → NOT_BLOCKED）。 */
  'team.friends.unblock': {
    input: z.strictObject({ memberId: z.string().min(1) }),
    output: okOutput,
  },
  /** 通讯录好友栏数据源：好友（带 presence）+ 待处理申请（incoming / outgoing）+ 已拉黑。 */
  'team.friends.list': { input: emptyInput, output: teamFriendsListSchema },

  // --- P2 (implemented in T9) -------------------------------------------------

  /** Share one of the caller's own memory items with the team (62.05 §3; audited, source member only). */
  'team.memory.share': {
    input: z.strictObject({ botId: z.string().min(1), memoryId: z.string().min(1) }),
    output: okOutput,
  },

  /** List resolutions; absent conversationId = across the caller's projects. */
  'team.resolutions.list': {
    input: z.strictObject({ conversationId: z.string().min(1).optional() }),
    output: z.strictObject({ resolutions: z.array(teamResolutionViewSchema) }),
  },

  /** Sign the resolution's CURRENT version; version mismatch → RESOLUTION_STALE (62.09 §2). */
  'team.resolutions.approve': {
    input: z.strictObject({ resolutionId: z.string().min(1), version: z.number().int().min(1) }),
    output: teamResolutionViewSchema,
  },

  /** Revoke the caller's own signature (allowed until the resolution passes). */
  'team.resolutions.revoke': {
    input: z.strictObject({ resolutionId: z.string().min(1) }),
    output: teamResolutionViewSchema,
  },

  /**
   * Withdraw an open resolution (executive lead bot tool or project lead RPC);
   * passed ones are locked (RESOLUTION_LOCKED). `reason` (additive, T9) lands
   * in the audit system message (62.09 §2 作废留痕).
   */
  'team.resolutions.withdraw': {
    input: z.strictObject({ resolutionId: z.string().min(1), reason: z.string().max(500).optional() }),
    output: teamResolutionViewSchema,
  },

  // --- 成员侧 Bot 面（B 方案 member-bots，B1 契约冻结；实现 B2）----------------

  /**
   * Create a bot in the member plane (README fixed contract). `mode:'private'`
   * counts against the caller's private-bot quota → BOT_LIMIT_REACHED when
   * full (B-6); `mode:'public'` requires the caller's group permission →
   * FORBIDDEN otherwise (B-1). `workdirPath` must come from the caller's
   * option set → WORKDIR_NOT_ALLOWED otherwise (B-10; omitted = the
   * auto-allocated `members/<mbrId>/bots/<botId>` directory). `interview`
   * defaults to true: the server starts the core creation interview and the
   * client completes it via the member-guarded `bots.interview.*` (B-11).
   */
  'team.bots.create': {
    input: z.strictObject({
      mode: z.enum(['private', 'public']),
      /** Pre-seeded display name (the interview may still refine it). */
      name: z.string().min(1).max(120).optional(),
      workdirPath: z.string().min(1).optional(),
      /** Start the creation interview after create (default true, B-11). */
      interview: z.boolean().optional().default(true),
      /** Profile seed = the teamBotPatch profile sub-fields (B-2). */
      profile: teamBotProfilePatchSchema.optional(),
    }),
    output: z.strictObject({ bot: teamBotViewSchema }),
  },

  /**
   * Update a member-plane bot's parameters (B-2 全量参数): only canEdit
   * callers (owner / public creator / console admin, B-1). Patch fields are
   * applied shallowly per sub-structure; `workdirPath` re-validated against
   * the caller's option set.
   */
  'team.bots.update': {
    input: z.strictObject({
      botId: z.string().min(1),
      patch: teamBotPatchSchema,
    }),
    output: z.strictObject({ bot: teamBotViewSchema }),
  },

  /** Delete a member-plane bot (canDelete callers only); NOT_FOUND when absent to the caller. */
  'team.bots.delete': {
    input: z.strictObject({ botId: z.string().min(1) }),
    output: z.strictObject({ deleted: z.literal(true) }),
  },

  /**
   * Transfer a PRIVATE bot to another active member (B-7: private only, any
   * active member, directory / memory stay in place; the old owner loses
   * visibility immediately). The target's quota is checked first →
   * BOT_LIMIT_REACHED.
   */
  'team.bots.transfer': {
    input: z.strictObject({
      botId: z.string().min(1),
      toMemberId: z.string().min(1),
    }),
    output: z.strictObject({ bot: teamBotViewSchema }),
  },

  /**
   * Bots visible to the caller in the member plane (own private bots, public
   * bots, admin-shared restricted bots) with per-caller canEdit / canDelete.
   */
  'team.bots.list': {
    input: emptyInput,
    output: z.strictObject({ bots: z.array(teamBotViewSchema) }),
  },

  /** The caller's selectable work paths (B-10: admin roots ∪ own workdirs subtree). */
  'team.bots.workdirOptions': {
    input: emptyInput,
    output: z.strictObject({ options: z.array(teamWorkdirOptionSchema) }),
  },

  /**
   * Create a directory inside the caller's own workdirs subtree (B-10: the
   * only member mkdir path; `parentPath` defaults to the subtree root).
   * Outside the subtree → WORKDIR_NOT_ALLOWED.
   */
  'team.bots.workdirMkdir': {
    input: z.strictObject({
      name: z.string().min(1).max(80),
      parentPath: z.string().min(1).optional(),
    }),
    output: z.strictObject({ path: z.string() }),
  },

  /** Models the server enables for member bots (B-2: `runtime.model` values). */
  'team.bots.modelOptions': {
    input: emptyInput,
    output: z.strictObject({ models: z.array(teamModelOptionSchema) }),
  },
} satisfies Record<TeamRpcMethodName, TeamRpcIo>;
