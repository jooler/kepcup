import { z } from 'zod';
import { conversationSchema, permissionModeSchema } from '../domain/types.js';

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
 * The member's own usage view (`team.usage.mine`, P1): direct-chat
 * consumption is fully attributed to the member; project-share attribution is
 * a P2 admin-side report and not part of the member view. Totals follow the
 * core `usage_ledger` cost unit.
 */
export const teamUsageSummarySchema = z.strictObject({
  /** Total direct-chat cost attributed to this member. */
  directTotal: z.number(),
  /** Optional per-UTC-day breakdown (`dayStart` = UTC midnight, ms). */
  byDay: z.array(z.strictObject({ dayStart: z.number(), total: z.number() })).optional(),
  /** Optional per-bot breakdown. */
  byBot: z.array(z.strictObject({ botId: z.string(), total: z.number() })).optional(),
});
export type TeamUsageSummary = z.infer<typeof teamUsageSummarySchema>;

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
});
export type TeamBootstrap = z.infer<typeof teamBootstrapSchema>;
