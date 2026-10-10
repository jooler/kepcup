/**
 * The ONLY write path into `reviews`. The developer portal never gets a database
 * handle: it calls these two functions through a narrow RPC on the registry Worker
 * (a thin `WorkerEntrypoint` over this module, added with the portal, D4), so every
 * invariant lives here:
 *
 *  - a review can only be attached to a (name, version) the sync already holds
 *    (reviews are LEFT-JOINed from `servers`; a review for an unknown server would be
 *    invisible and meaningless);
 *  - `reviewed_at` is server-generated, ISO-ms, and strictly increasing per row, on
 *    approval AND on revocation (so a revocation bumps the entry's effective
 *    updated_at and reaches `updated_since` pullers);
 *  - an approval records `sha256(servers.server_json)` as read here, never as supplied
 *    by the caller: if the sync later changes that row's content the tier disappears
 *    until the entry is re-approved;
 *  - an approval needs a `toolContractHash`.
 */

import type { D1Like, ReviewStatus, ReviewTier } from './types';

export interface SubmitReviewInput {
  name: string;
  version: string;
  tier: ReviewTier;
  status: ReviewStatus;
  notes?: string | null;
  /** Required when status = 'approved'. */
  toolContractHash?: string | null;
  /**
   * sha256 of the server.json the reviewer actually examined (from {@link getServerForReview}).
   * When given, the write is refused with `stale` if the registry's current content differs,
   * so an approval can never attach to content nobody looked at.
   */
  expectedSha256?: string;
  now?: () => Date;
}

export interface ReviewResult {
  ok: boolean;
  /** 'not_found' | 'invalid' when ok = false. */
  error?: 'not_found' | 'invalid' | 'stale';
  message?: string;
  reviewedAt?: string;
}

const TIERS: readonly string[] = ['verified', 'community'];
const STATUSES: readonly string[] = ['pending', 'approved', 'rejected'];
const MAX_NOTES = 2000;
const MAX_HASH = 128;

export async function submitReview(db: D1Like, input: SubmitReviewInput): Promise<ReviewResult> {
  if (!TIERS.includes(input.tier) || !STATUSES.includes(input.status)) {
    return { ok: false, error: 'invalid', message: 'unknown tier or status' };
  }
  if (input.status === 'approved' && !input.toolContractHash) {
    return { ok: false, error: 'invalid', message: 'toolContractHash is required to approve' };
  }
  if ((input.toolContractHash ?? '').length > MAX_HASH || (input.notes ?? '').length > MAX_NOTES) {
    return { ok: false, error: 'invalid', message: 'notes or toolContractHash too long' };
  }

  const server = await db
    .prepare('SELECT server_json_sha256 AS sha FROM servers WHERE name = ? AND version = ?')
    .bind(input.name, input.version)
    .first<{ sha: string }>();
  if (!server) {
    return { ok: false, error: 'not_found', message: 'server version is not in the registry' };
  }
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== server.sha) {
    return {
      ok: false,
      error: 'stale',
      message: 'server.json changed since it was fetched for review',
    };
  }
  const existing = await db
    .prepare('SELECT reviewed_at FROM reviews WHERE name = ? AND version = ?')
    .bind(input.name, input.version)
    .first<{ reviewed_at: string }>();

  // Strictly after both "now" and the previous review of this row.
  let at = (input.now ?? (() => new Date()))().getTime();
  if (existing) at = Math.max(at, Date.parse(existing.reviewed_at) + 1);
  const reviewedAt = new Date(at).toISOString();

  // Conditional upsert: a concurrent writer that got a later timestamp wins.
  await db
    .prepare(
      `INSERT INTO reviews (name, version, tier, review_status, reviewed_at, notes,
         tool_contract_hash, server_json_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name, version) DO UPDATE SET
         tier = excluded.tier,
         review_status = excluded.review_status,
         reviewed_at = excluded.reviewed_at,
         notes = excluded.notes,
         tool_contract_hash = excluded.tool_contract_hash,
         server_json_sha256 = excluded.server_json_sha256
       WHERE excluded.reviewed_at > reviews.reviewed_at`,
    )
    .bind(
      input.name,
      input.version,
      input.tier,
      input.status,
      reviewedAt,
      input.notes ?? null,
      input.toolContractHash ?? null,
      server.sha,
    )
    .run();
  return { ok: true, reviewedAt };
}

/**
 * What the portal reviews: the registry's own stored (sanitized) server.json for a synced
 * (name, version) and its sha256 - the portal never fetches a submitter-supplied URL for it.
 */
export async function getServerForReview(
  db: D1Like,
  name: string,
  version: string,
): Promise<{ serverJson: string; sha256: string; status: string } | null> {
  const row = await db
    .prepare(
      'SELECT server_json AS serverJson, server_json_sha256 AS sha256, status FROM servers WHERE name = ? AND version = ?',
    )
    .bind(name, version)
    .first<{ serverJson: string; sha256: string; status: string }>();
  return row ?? null;
}

/** Revocation = a 'rejected' review (the row is kept for audit; nothing is exposed). */
export async function revokeReview(
  db: D1Like,
  input: { name: string; version: string; notes?: string | null; now?: () => Date },
): Promise<ReviewResult> {
  const existing = await db
    .prepare('SELECT tier FROM reviews WHERE name = ? AND version = ?')
    .bind(input.name, input.version)
    .first<{ tier: ReviewTier }>();
  return submitReview(db, {
    name: input.name,
    version: input.version,
    tier: existing?.tier ?? 'community',
    status: 'rejected',
    notes: input.notes ?? null,
    ...(input.now ? { now: input.now } : {}),
  });
}
