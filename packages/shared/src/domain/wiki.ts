import { z } from 'zod';

/**
 * Owner of a wiki (D92 T1b, docs/design/41-project-team.md §8): a bot's
 * private wiki (`bots/{id}/wiki`) or a project team's shared wiki
 * (`projects/{id}/wiki`). The project id is the root conversation id
 * (`conv_…`), not a ULID of its own.
 */
export const wikiOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bot'), id: z.string().min(1) }),
  z.object({ kind: z.literal('project'), id: z.string().min(1) }),
]);
export type WikiOwner = z.infer<typeof wikiOwnerSchema>;

/**
 * Stable string form of a wiki owner: the maintenance mutex key and the job
 * dedupe-key segment share this (docs/design/41-project-team.md §8.4).
 */
export function wikiOwnerKey(owner: WikiOwner): string {
  return `${owner.kind}:${owner.id}`;
}
