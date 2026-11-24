import { z } from 'zod';
import {
  botBehaviorSchema,
  botIdentitySchema,
  botPersonaSchema,
  botRoleSchema,
  botRuntimeSchema,
  conversationSchema,
  permissionModeSchema,
} from '../domain/types.js';

/**
 * Team-layer contracts (62-team-server): the member-facing view the team server
 * serves on top of an embedded core. These are OPEN SOURCE contract schemas —
 * the implementation lives in the commercial team layer (`apps/team-server`),
 * so this directory must never import from core.
 *
 * All new contracts use `z.strictObject` (repo convention); implementation
 * phases may only ADD optional fields, never change existing semantics.
 */

// --- Members -----------------------------------------------------------------

/** Presence state of a team member (P0: online/offline derived from the connection table; `away` from P1). */
export const teamMemberStateSchema = z.enum(['online', 'away', 'offline']);
export type TeamMemberState = z.infer<typeof teamMemberStateSchema>;

/**
 * A team member as seen by clients (README fixed contract; ids are `mbr_*`).
 * This is a TEAM-layer contract, so the word "member" is the fixed name here.
 */
export const teamMemberSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string(),
  /**
   * 登录用户名（D129v2 好友层起在 `team.members.search` 结果中携带——它是加好友
   * 的句柄，不是凭据；通讯录名册 / bootstrap 卡仍不带，避免不必要的暴露面）。
   */
  username: z.string().optional(),
  /** Avatar (data URL / uploaded path); absent = unset, null = explicitly cleared. */
  avatar: z.string().nullable().optional(),
  state: teamMemberStateSchema,
  /** UTC ms of the last activity; absent = never seen. */
  lastSeenAt: z.number().optional(),
  /** P2 离开态分身 (62.06): name of the bot acting on behalf of this member while away. */
  avatarBotName: z.string().optional(),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

// --- Bot visibility ----------------------------------------------------------

/**
 * Bot visibility tiers (62.03 D128). Default for a bot without a visibility
 * row: `restricted` with an empty allowlist (invisible to every member until
 * an admin opens it up).
 */
export const teamVisibilityModeSchema = z.enum(['all', 'restricted', 'private']);
export type TeamVisibilityMode = z.infer<typeof teamVisibilityModeSchema>;

// --- Surfaces ----------------------------------------------------------------

/**
 * Ids of renderer entries the team server can hide on a team endpoint
 * (`team.bootstrap.surfaces.hidden`). Value domain = renderer
 * `SettingsSectionId` ∪ shared `EndpointCapabilityId` ∪ team-only surfaces.
 *
 * SYNC OBLIGATION: keep this list in sync with
 * - `SettingsSectionId` in apps/desktop/src/renderer/src/lib/features/settings/sections.ts
 * - `EndpointCapabilityId` in packages/shared/src/domain/host-capabilities.ts
 * The renderer treats unknown ids as "not shown" and renders the *absence* of
 * an id it knows as "visible", so a stale list only degrades the experience
 * layer (never security — method policy is the boundary, 62.03 §3).
 */
export const TEAM_SURFACE_IDS = [
  // Renderer SettingsSectionId values (sections.ts). `computer-use` is listed
  // once here although both unions contain it.
  'general',
  'hardware',
  'models',
  'search',
  'browser',
  'computer-use',
  'agents',
  'profile',
  'contacts',
  'unattended',
  'remote',
  'environment',
  'usage',
  'diagnostics',
  // Legacy deep-link section ids (open the extension center; kept for parity).
  'mcp',
  'developer',
  'plugins',
  // Shared EndpointCapabilityId values (host-capabilities.ts; desktop-only actions).
  'local-file-dialog',
  'open-external',
  'reveal-in-file-manager',
  'desktop-notification',
  'install-update',
  'shutdown-app',
  'launch-at-login',
  'sandbox-wizard',
  // Team-only surfaces (no SettingsSectionId / EndpointCapabilityId equivalent).
  'extension-center',
  'bot-create',
  'bot-edit',
  'workdir-pick',
] as const;
export type TeamSurfaceId = (typeof TEAM_SURFACE_IDS)[number];

export const teamSurfaceIdSchema = z.enum(TEAM_SURFACE_IDS);

// --- Member-domain settings (P1, 62.03 §5) ------------------------------------

/**
 * Quiet-hours window (免打扰). Minutes are client-local; member timezones are
 * P3, so the server treats them as opaque bounds.
 */
export const teamQuietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  /** Window start, minutes since midnight (0–1439). */
  startMinute: z.number().int().min(0).max(1439),
  /** Window end, minutes since midnight (0–1439); may wrap past midnight. */
  endMinute: z.number().int().min(0).max(1439),
});

/**
 * Member-domain settings held by the team server (62.03 §5: the open source
 * settings catalog is NOT extended with a member scope). P1 (T6) implements
 * it; the P0 contract freeze carries this minimal shape.
 */
export const teamSettingsSchema = z.strictObject({
  quietHours: teamQuietHoursSchema.optional(),
});
export type TeamSettings = z.infer<typeof teamSettingsSchema>;

// --- Usage (P1, 62.03 D137) ---------------------------------------------------

/**
 * UTC-ms query window for `team.usage.mine` (additive, T6): `[from, to)` —
 * `from` inclusive, `to` exclusive.
 */
export const teamUsageRangeSchema = z
  .strictObject({
    from: z.number().int().min(0),
    to: z.number().int().min(0),
  })
  .refine((range) => range.to > range.from, { message: 'range.to must be after range.from' });
export type TeamUsageRange = z.infer<typeof teamUsageRangeSchema>;

/**
 * The member's own usage view (`team.usage.mine`). P1 shipped the direct-chat
 * full attribution; T9 (62.03 D137) upgrades the summary to the full ledger —
 * every `usage_ledger` row lands in exactly one `usage_allocations` bucket
 * (direct owner / project time-roster share / explicit principal / platform),
 * so the member view adds the project share, other attributable consumption
 * and a note of what stayed on the platform. Totals follow the core
 * `usage_ledger` cost unit.
 */
export const teamUsageSummarySchema = z.strictObject({
  /** Total direct-chat cost attributed to this member. */
  directTotal: z.number(),
  /** Optional per-UTC-day breakdown (`dayStart` = UTC midnight, ms). T9: full attribution (all buckets). */
  byDay: z.array(z.strictObject({ dayStart: z.number(), total: z.number() })).optional(),
  /** Optional per-bot breakdown (T9: from the allocation rows' bot_id — DEV-140). */
  byBot: z.array(z.strictObject({ botId: z.string(), total: z.number() })).optional(),
  /**
   * T9 全口径（additive, optional）：项目组均摊份额——usage_allocations 里
   * project_conversation_id 非空的行按 share 加权后的 cost 之和。
   */
  projectShareTotal: z.number().optional(),
  /** T9：其它可明确归属到本人的消耗（非直聊、非项目组的 allocation 行）。 */
  otherTotal: z.number().optional(),
  /**
   * T9：同窗口内记为平台消耗的总额（member_id NULL 的行）——不归属任何成员，
   * 这里只作「平台说明」展示，不计入本人的任何合计。
   */
  platformTotal: z.number().optional(),
});
export type TeamUsageSummary = z.infer<typeof teamUsageSummarySchema>;

// --- Friends（D129v2 通讯录好友层）----------------------------------------------

/**
 * 好友申请状态机：`request → accepted | declined`（接收人处理）或
 * `request → cancelled`（发起人撤回）；删除好友不走申请（直接移除）。
 */
export const teamFriendRequestStateSchema = z.enum(['pending', 'accepted', 'declined', 'cancelled']);
export type TeamFriendRequestState = z.infer<typeof teamFriendRequestStateSchema>;

/**
 * 好友申请视图（发起人与接收人各持一份成员卡，双方客户端都能直接渲染）。
 * 成员卡不带任何凭据（同 team.members.list 口径）。
 */
export const teamFriendRequestViewSchema = z.strictObject({
  id: z.string().min(1),
  /** 发起人。 */
  from: teamMemberSchema,
  /** 接收人。 */
  to: teamMemberSchema,
  /** 申请附言（可空，加好友时可选填写）。 */
  message: z.string().optional(),
  state: teamFriendRequestStateSchema,
  createdAt: z.number(),
  handledAt: z.number().nullable().optional(),
});
export type TeamFriendRequestView = z.infer<typeof teamFriendRequestViewSchema>;

/**
 * `team.friends.list` 的输出——通讯录「好友栏」的数据源。好友带 presence 卡；
 * incoming / outgoing 是待处理的申请（含对方成员卡）；blocked 是我拉黑的成员
 *（presence 卡，仅拉黑方可见——被拉黑方对「被拉黑」无感知）。
 */
export const teamFriendsListSchema = z.strictObject({
  friends: z.array(teamMemberSchema),
  incoming: z.array(teamFriendRequestViewSchema),
  outgoing: z.array(teamFriendRequestViewSchema),
  blocked: z.array(teamMemberSchema),
});
export type TeamFriendsList = z.infer<typeof teamFriendsListSchema>;

// --- Member-side bots（B 方案 member-bots，B1 契约冻结）-------------------------

/**
 * Member-visible bot kind (B 方案 member-bots): a member-created `private` bot
 * (owner-only editable), a member-created `public` bot (everyone can message,
 * creator can edit/delete) or an admin-shared `restricted` bot. These are the
 * visibility-row modes of B-5 as the member plane reports them.
 */
export const teamBotModeSchema = z.enum(['private', 'public', 'restricted']);
export type TeamBotMode = z.infer<typeof teamBotModeSchema>;

/** Setup lifecycle of a member-plane bot: still in the creation interview, or ready. */
export const teamBotSetupStateSchema = z.enum(['interviewing', 'ready']);
export type TeamBotSetupState = z.infer<typeof teamBotSetupStateSchema>;

/**
 * A bot as `team.bots.*` serves it to members (README fixed contract). Edit /
 * delete rights are pre-computed per caller (B-1: creator for public, owner
 * for private; console admins always both). Non-owner members never receive
 * private-bot profile bodies — the view carries identity-level facts only.
 */
export const teamBotViewSchema = z.strictObject({
  /** Bot id (`bot_*`, core ULID). */
  id: z.string().min(1),
  /** Display name (identity.name). */
  name: z.string(),
  mode: teamBotModeSchema,
  /** Owning member (`mbr_*`); absent for admin-created shared bots. */
  ownerMemberId: z.string().min(1).optional(),
  /** Caller may edit parameters (owner / public creator / console admin). */
  canEdit: z.boolean(),
  /** Caller may delete (same rule as edit, B-1). */
  canDelete: z.boolean(),
  /**
   * Bound default work path (2026-11 工作 paths 重构)：opaque option key +
   * display name only — host paths never leave the server (B-10). `workdirKey`
   * follows the `teamWorkdirOptionSchema` key grammar (admin:/member:/bot:)
   * and can be sent back to `team.bots.update` verbatim.
   */
  workdirKey: z.string().min(1).optional(),
  workdirName: z.string().min(1).optional(),
  setupState: teamBotSetupStateSchema.optional(),
});
export type TeamBotView = z.infer<typeof teamBotViewSchema>;

/**
 * Profile part of a member-bot write (B-2 全量参数受服务器约束): the core
 * botProfile sub-schemas reused verbatim, all optional, strict outer shell.
 * The server validates the values against its enabled model / network /
 * plugin lists (B2); `runtime.model` etc. constrain to server options.
 */
export const teamBotProfilePatchSchema = z.strictObject({
  identity: botIdentitySchema.optional(),
  persona: botPersonaSchema.optional(),
  role: botRoleSchema.optional(),
  /** Same shape as botProfileSchema.boundaries. */
  boundaries: z.array(z.string().max(500)).optional(),
  behavior: botBehaviorSchema.optional(),
  runtime: botRuntimeSchema.optional(),
});
export type TeamBotProfilePatch = z.infer<typeof teamBotProfilePatchSchema>;

/**
 * Patch for `team.bots.update` and the profile seed for `team.bots.create`:
 * the profile sub-fields plus the default work path. `workdirKey` must be in
 * the caller's option set (`team.bots.workdirOptions`, opaque key — host
 * paths never travel the member plane; WORKDIR_NOT_ALLOWED otherwise, B-10).
 */
export const teamBotPatchSchema = teamBotProfilePatchSchema.extend({
  workdirKey: z.string().min(1).optional(),
});
export type TeamBotPatch = z.infer<typeof teamBotPatchSchema>;

/**
 * One selectable work path (`team.bots.workdirOptions`, B-10). OPAQUE KEYS +
 * display names only — server host paths never leave the server (2026-11 工作
 * 路径重构：成员面不向普通成员暴露服务器目录结构). `key` is sent back verbatim
 * in `team.bots.update` / `create` / `workdirMkdir` / `answerSetupPath`:
 * - `admin:<wrtId>` — an enabled registered preset root (directly selectable);
 * - `member:<rel>` — a directory under the caller's own subtree
 *   (`<userRoot>/<memberId>/<rel>`); `member:` alone is the subtree root.
 */
export const teamWorkdirOptionSchema = z.strictObject({
  key: z.string().min(1),
  /** Display label (preset root name / directory name). */
  name: z.string(),
  source: z.enum(['admin', 'member']),
  /**
   * Member-tree parent key (`null` = top level under the caller's own root);
   * absent for admin presets. Drives the renderer's tree browser.
   */
  parentKey: z.string().nullable().optional(),
});
export type TeamWorkdirOption = z.infer<typeof teamWorkdirOptionSchema>;

/** One selectable model (`team.bots.modelOptions`, B-2 server-enabled list). */
export const teamModelOptionSchema = z.strictObject({
  /** Model ref as used in `runtime.model`. */
  id: z.string(),
  /** Display label. */
  label: z.string(),
});
export type TeamModelOption = z.infer<typeof teamModelOptionSchema>;

// --- Bootstrap ----------------------------------------------------------------

/**
 * First call on a member connection (README fixed contract): who am I, which
 * server, which renderer entries to hide, my conversation view and the
 * authorization ceiling (C14) enforced by the server.
 */
export const teamBootstrapSchema = z.strictObject({
  /**
   * The connected member in the FULL presence-carrying variant: bootstrap runs
   * after the auth handshake on an established connection, so the server can
   * always derive the state (the connection itself just came online).
   */
  member: teamMemberSchema,
  server: z.strictObject({
    /** Display name of the team server. */
    name: z.string(),
    /** Server (team-server package) version string. */
    version: z.string(),
  }),
  /** Renderer entries hidden on this endpoint (experience layer only, 62.03 §5). */
  surfaces: z.strictObject({ hidden: z.array(teamSurfaceIdSchema) }),
  /** The member's conversation view (core conversation schema incl. 62.11 C3 fields). */
  conversations: z.array(conversationSchema),
  /** Authorization ceiling (C14): the highest permission mode members may set. */
  permissionCeiling: permissionModeSchema,
  /**
   * Member bot capabilities (B 方案 member-bots, additive B1): whether the
   * caller's groups allow creating public bots (B-1) and the caller's
   * private-bot quota usage against `max-private-bots` (B-6). Absent on team
   * servers predating the member bot plane (additive field, old payloads keep
   * parsing; clients treat absence as "no member bot surface").
   */
  botCapabilities: z
    .strictObject({
      canCreatePublicBot: z.boolean(),
      /** Private bots currently owned by the caller. */
      privateBotsUsed: z.number().int().min(0),
      /** Server setting `max-private-bots` (default 10); 0 = creation closed. */
      privateBotsLimit: z.number().int().min(0),
    })
    .optional(),
});
export type TeamBootstrap = z.infer<typeof teamBootstrapSchema>;
