import { z } from 'zod';
import { teamMemberStateSchema } from './domain.js';

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
] as const satisfies readonly string[];
export type TeamEventName = (typeof TEAM_EVENT_NAMES)[number];

export const teamEventSchemas = {
  /**
   * Presence state of a member changed (P0: derived from the connection table
   * on connect/disconnect; `away` from P1).
   */
  'member.presenceChanged': z.strictObject({
    memberId: z.string().min(1),
    state: teamMemberStateSchema,
    lastSeenAt: z.number().optional(),
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
   */
  'team.avatarRevoked': z.strictObject({ memberId: z.string().min(1), botId: z.string().min(1).optional() }),
} satisfies Record<TeamEventName, z.ZodTypeAny>;
