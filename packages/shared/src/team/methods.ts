import { z } from 'zod';
import { botProfileSchema, botSchema, conversationSchema } from '../domain/types.js';
import {
  teamBootstrapSchema,
  teamMemberSchema,
  teamSettingsSchema,
  teamUsageRangeSchema,
  teamUsageSummarySchema,
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
  'team.bots.createPrivate',
  'team.bots.updatePrivate',
  'team.bots.deletePrivate',
  'team.settings.get',
  'team.settings.update',
  'team.usage.mine',
  // P2 (T9)
  'team.memory.share',
  'team.resolutions.list',
  'team.resolutions.approve',
  'team.resolutions.revoke',
  'team.resolutions.withdraw',
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
   */
  'team.presence.setAway': {
    input: z.strictObject({
      away: z.boolean(),
      /** Free-form away note (dm header / roster display; T7 consumes). */
      note: z.string().max(200).optional(),
      /** Digital-avatar flag (62.06 §2 thin contract): only the bot NAME lives here. */
      avatar: z.strictObject({ botName: z.string().min(1).max(120) }).optional(),
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

  /** Private bots are self-served (62.03 D128): T6 routes to core bots.create with visibility=private + owner. */
  'team.bots.createPrivate': {
    input: z.strictObject({ profile: botProfileSchema }),
    output: z.strictObject({ bot: botSchema }),
  },
  'team.bots.updatePrivate': {
    input: z.strictObject({ id: z.string().min(1), profile: botProfileSchema }),
    output: z.strictObject({ bot: botSchema }),
  },
  'team.bots.deletePrivate': {
    input: z.strictObject({ id: z.string().min(1) }),
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
} satisfies Record<TeamRpcMethodName, TeamRpcIo>;
