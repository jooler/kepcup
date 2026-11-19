import { z } from 'zod';
import { botProfileSchema, botSchema, conversationSchema } from '../domain/types.js';
import {
  teamBootstrapSchema,
  teamMemberSchema,
  teamSettingsSchema,
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

// --- P2 resolution view (placeholder; the full resolution schema lands in T9) --

/**
 * Minimal resolution view for the `team.resolutions.*` contracts (62.09).
 * T9 freezes the full schema — only additive changes from here.
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
  /** Content version; approvals bind to it (signatures clear on update). */
  version: z.number().int().min(1),
  /** The caller's signature on the CURRENT content version; null = not signed. */
  myApprovalVersion: z.number().int().nullable(),
  createdAt: z.number(),
  passedAt: z.number().nullable().optional(),
  withdrawnAt: z.number().nullable().optional(),
  /** Earlier resolution this one supersedes (display-only relation, 62.09 §2). */
  supersedesResolutionId: z.string().nullable().optional(),
});
export type TeamResolutionView = z.infer<typeof teamResolutionViewSchema>;

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

  // --- P1 (implemented in T6) -------------------------------------------------

  /** Away state toggle (62.06 离开态): `away: false` returns the member to derived presence. */
  'team.presence.setAway': {
    input: z.strictObject({ away: z.boolean() }),
    output: okOutput,
  },

  /** Profile seeding upload (62.05 §5): `{items:[{category,content}]}`, ≤100 per call, additive merge for the caller only. */
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
    output: okOutput,
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

  /** The caller's own usage (P1 direct-chat full attribution, 62.03 D137). */
  'team.usage.mine': { input: emptyInput, output: teamUsageSummarySchema },

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

  /** Withdraw an open resolution (executive lead bot or project lead); passed ones are locked. */
  'team.resolutions.withdraw': {
    input: z.strictObject({ resolutionId: z.string().min(1) }),
    output: teamResolutionViewSchema,
  },
} satisfies Record<TeamRpcMethodName, TeamRpcIo>;
