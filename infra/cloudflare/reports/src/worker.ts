/**
 * Public request pipeline (todo/ai-content-reporting.md §7.4). Order is load-bearing:
 *
 *   1. method/path          other methods 405, unknown paths 404 (JSON)
 *   2. Content-Type         application/json only, else 415
 *   3. body                 streamed, hard cap 128 KiB — never trust Content-Length, else 413
 *   4. JSON.parse           else 400
 *   5. validate             shape/enum/length/control chars, else 400 + issues (no values echoed)
 *   6. recompute hashes     WebCrypto sha256 over canonical JSON, mismatch 400
 *   6.5 proof-of-work       HMAC-signed challenge, single-use, IP-bound (task 5A);
 *                           400 missing_proof / challenge_invalid / challenge_expired /
 *                           challenge_ip_mismatch / proof_invalid / challenge_reused
 *                           (skipped when difficulty=0 or REPORT_POW_SECRET unset)
 *   7. idempotency          reportId already stored -> 200 duplicate/report_id
 *   8. dedupe precheck      server-clock buckets -> 200 duplicate/content|payload
 *   9. IP rate limit        HMAC(ip) fixed 1h window -> 429 (skipped without salt; deploy MUST set it)
 *   10. client rate limit   conditional upsert (§7.5 verbatim SQL), changes==0 -> 429 + Retry-After
 *   10.5 daily cap          global per-UTC-day counter -> 429 + Retry-After to next UTC midnight
 *   11. INSERT OR IGNORE    changes==0 -> 200 duplicate (concurrency backstop), else 201 accepted
 *
 * Dedupe BEFORE rate limiting (§7.4 order note): repeated clicks on the same message
 * are answered as duplicates and never consume the 1/min slot — nor the daily cap
 * (steps 7-8 short-circuit before 10.5). PoW BEFORE idempotency: a request failing
 * 6.5 never touches D1 reads, so a spent-challenge replay cannot harvest duplicates.
 * Logs are JSON with either {reportId,status,httpStatus} or {path,method,status} —
 * never payload, body text, clientId, IP, token or any challenge/solution (§8).
 */

import { handleAdminRequest } from './admin';
import {
  bucketOf,
  computeContentHash,
  computePayloadHash,
  contentSource,
  utcDayOf,
} from './dedupe';
import {
  bumpDailyCount,
  findById,
  findContentDuplicate,
  findPayloadDuplicate,
  getClientRate,
  getIpRate,
  getPowUsed,
  insertPowUsed,
  insertReport,
  upsertClientRate,
  upsertIpRate,
} from './db';
import { HttpError, jsonResponse } from './http';
import { POW_ALGORITHM, isUsableProof, issueChallenge, verifyProof } from './pow';
import type { D1Like, Env, ReportPayload, WorkerConfig } from './types';
import { validateReportPayload } from './validate';

/** Hard body cap (§5.3 REPORT_PAYLOAD_MAX_BYTES / §7.4 step 3). */
export const MAX_BODY_BYTES = 128 * 1024;

/** Defaults mirror wrangler.jsonc vars and packages/shared REPORT_* constants (§5.5). */
export function parseConfig(env: Env): WorkerConfig {
  const powSecret = env.REPORT_POW_SECRET;
  const powDifficulty = nonNegativeInt(env.REPORT_POW_DIFFICULTY, 20);
  return {
    rateLimitMs: positiveInt(env.REPORT_RATE_LIMIT_MS, 60_000),
    ipLimit: positiveInt(env.REPORT_IP_LIMIT, 100),
    ipWindowMs: positiveInt(env.REPORT_IP_WINDOW_MS, 3_600_000),
    contentDedupeMs: nonNegativeInt(env.REPORT_CONTENT_DEDUPE_MS, 86_400_000),
    payloadDedupeMs: nonNegativeInt(env.REPORT_PAYLOAD_DEDUPE_MS, 7_776_000_000),
    retentionDays: positiveInt(env.REPORT_RETENTION_DAYS, 365),
    adminToken: env.REPORT_ADMIN_TOKEN,
    ipHashSalt: env.IP_HASH_SALT,
    // Escape hatch: difficulty 0 disables the challenge; a missing secret cannot
    // sign or verify tokens, so it disables enforcement too (deploy MUST set it).
    powEnabled: powDifficulty > 0 && powSecret !== undefined && powSecret !== '',
    powSecret,
    powDifficulty,
    powTtlMs: positiveInt(env.REPORT_POW_TTL_MS, 600_000),
    dailyLimit: positiveInt(env.REPORT_DAILY_LIMIT, 2000),
    buildVersion: env.BUILD_VERSION ?? 'dev',
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Dedupe windows allow 0 = permanent dedupe (bucket always 0, §5.5). */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface HandlerDeps {
  db: D1Like;
  config: WorkerConfig;
  /** Injectable server clock (ms epoch); tests pin it. */
  now: () => number;
}

// ------------------------------------------------------------------ entry point

export async function handleRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  let response: Response;
  let reportLog: Record<string, unknown> | undefined;
  try {
    const outcome = await routeRequest(request, deps);
    response = outcome.response;
    reportLog = outcome.reportLog;
  } catch (error) {
    response = errorResponse(error);
  }
  // §7.4 step 12 / §8: JSON logs only — report outcomes carry {reportId,status,httpStatus},
  // everything else a route-level line. Nothing about content / client / IP / token.
  const log = reportLog ?? {
    path: logPath(new URL(request.url).pathname),
    method: request.method,
    status: response.status,
  };
  console.log(JSON.stringify(log));
  return response;
}

/**
 * Route-shape path for logs. Admin resource segments (the report id in a detail
 * path, the clientId in `DELETE /v1/admin/clients/:id`) are collapsed away so a
 * raw id never reaches the console (§8: no clientId in logs).
 */
function logPath(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments[0] === 'v1' && segments[1] === 'admin' && segments.length > 2) {
    return `/v1/admin/${segments[2]}`;
  }
  return pathname;
}

async function routeRequest(
  request: Request,
  deps: HandlerDeps,
): Promise<{ response: Response; reportLog?: Record<string, unknown> }> {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz') {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    return { response: jsonResponse(200, { ok: true, version: deps.config.buildVersion }) };
  }
  if (pathname === '/v1/reports') {
    if (request.method !== 'POST') throw methodNotAllowed('POST');
    return submitReport(request, deps);
  }
  if (pathname === '/v1/challenge') {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    // 200 {challenge, difficulty, expiresAt, algorithm} — or the disabled shape
    // {enabled:false, difficulty:0, …} when PoW is off (escape hatch). Log falls
    // through to the generic route line: no token content ever (§8).
    return { response: await challengeResponse(request, deps) };
  }
  if (pathname === '/v1/admin' || pathname.startsWith('/v1/admin/')) {
    return { response: await handleAdminRequest(request, deps) };
  }
  throw new HttpError(404, { error: 'not_found' });
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, { error: 'method_not_allowed' }, { allow });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return jsonResponse(error.status, error.body, error.headers);
  console.error('reports: unhandled error', error instanceof Error ? error.message : 'unknown');
  return jsonResponse(500, { error: 'internal_error' });
}

// ------------------------------------------------------------------ GET /v1/challenge

/**
 * Issues a fresh PoW challenge (task 5A, protocol v1). ip_hash binds the token to
 * the requester (empty string without header/salt — the client compares against
 * the same value at submit time, so unset salt never mismatches). Disabled mode
 * answers `{enabled:false, difficulty:0, …}` and the client then posts without a
 * proof.
 */
async function challengeResponse(request: Request, deps: HandlerDeps): Promise<Response> {
  const { config } = deps;
  const now = deps.now();
  if (!config.powEnabled) {
    return jsonResponse(200, {
      enabled: false,
      difficulty: 0,
      expiresAt: now + config.powTtlMs,
      algorithm: POW_ALGORITHM,
    });
  }
  const ipHeader = request.headers.get('cf-connecting-ip');
  const ipf =
    ipHeader !== null && config.ipHashSalt !== undefined
      ? await hmacSha256Hex(config.ipHashSalt, ipHeader)
      : '';
  const issued = await issueChallenge({
    secret: config.powSecret!,
    difficulty: config.powDifficulty,
    ttlMs: config.powTtlMs,
    now,
    ipf,
  });
  return jsonResponse(200, issued);
}

// ------------------------------------------------------------------ POST /v1/reports

type SubmitOutcome = { response: Response; reportLog: Record<string, unknown> };

async function submitReport(request: Request, deps: HandlerDeps): Promise<SubmitOutcome> {
  // 2. Content-Type (tolerate parameters like "application/json; charset=utf-8").
  const mime = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mime !== 'application/json') throw new HttpError(415, { error: 'unsupported_media_type' });

  // 3. Streamed body with a hard byte cap (Content-Length is never trusted).
  let body: string | null;
  try {
    body = await readBodyWithLimit(request.body?.getReader() ?? null, MAX_BODY_BYTES);
  } catch {
    throw new HttpError(400, { error: 'bad_json' }); // invalid UTF-8
  }
  if (body === null) throw new HttpError(413, { error: 'payload_too_large' });

  // 4. JSON.parse (a RangeError from pathological nesting lands here too).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, { error: 'bad_json' });
  }

  // 5. Shape/enum/length/control-character validation.
  const issues = validateReportPayload(parsed);
  if (issues.length > 0) throw new HttpError(400, { error: 'invalid_payload', issues });
  const payload = parsed as ReportPayload;

  // 6. Recompute both hashes (§5.4); a client cannot send hashes and be believed.
  //    The proof sibling field is transport-only: dedupePayload strips it, so a
  //    proofed and an unproofed submission hash identically (task 5A).
  const [contentHash, payloadHash] = await Promise.all([
    computeContentHash(payload.message),
    computePayloadHash(payload),
  ]);
  if (contentHash !== payload.hashes.content || payloadHash !== payload.hashes.payload) {
    throw new HttpError(400, { error: 'hash_mismatch' });
  }

  const now = deps.now();
  const { db, config } = deps;

  // ipf for the PoW ip-binding (task 5A) and step 9 share one HMAC computation:
  // '' when the header or the IP_HASH_SALT secret is missing (same skip semantics).
  const ipHeader = request.headers.get('cf-connecting-ip');
  const ipf =
    ipHeader !== null && config.ipHashSalt !== undefined
      ? await hmacSha256Hex(config.ipHashSalt, ipHeader)
      : '';

  // 6.5 Proof-of-work (task 5A). Enforced only when difficulty > 0 and the secret
  // is configured (escape hatch: REPORT_POW_DIFFICULTY=0). Order matters: PoW
  // runs BEFORE the reportId idempotency read, so a failed proof costs no D1
  // read and a spent challenge cannot be replayed even against a stored reportId.
  if (config.powEnabled) {
    const rawProof: unknown = (payload as unknown as { proof?: unknown }).proof;
    if (!isUsableProof(rawProof)) throw new HttpError(400, { error: 'missing_proof' });
    const verified = await verifyProof(rawProof, { secret: config.powSecret!, now, ipf });
    if (!verified.ok) throw new HttpError(400, { error: verified.reason });
    // Single use, bound to the reportId (crash-resend idempotency): the first
    // submission of (challenge, reportId) wins; the exact same pair passes (its
    // 200 duplicate comes from step 7), any other reportId is a pre-solved-pool
    // replay -> challenge_reused. All challenge failures are bare 400s — never
    // Retry-After (the client solves a fresh challenge instead of sleeping).
    const changes = await insertPowUsed(db, verified.challengeId, payload.reportId, now);
    if (changes === 0) {
      const spent = await getPowUsed(db, verified.challengeId);
      if ((spent?.report_id ?? null) !== payload.reportId) {
        throw new HttpError(400, { error: 'challenge_reused' });
      }
    }
  }

  // 7. Idempotency by reportId (retries after crash/network loss must not re-store).
  if (await findById(db, payload.reportId)) return duplicate(payload.reportId, 'report_id');

  // 8. Dedupe precheck in server-clock time buckets (§5.5); client clock is untrusted.
  const contentBucket = bucketOf(now, config.contentDedupeMs);
  const payloadBucket = bucketOf(now, config.payloadDedupeMs);
  if (await findContentDuplicate(db, payload.client.id, contentHash, contentBucket)) {
    return duplicate(payload.reportId, 'content');
  }
  if (await findPayloadDuplicate(db, payload.client.id, payloadHash, payloadBucket)) {
    return duplicate(payload.reportId, 'payload');
  }

  // 9. Coarse IP limit on HMAC(ip), fixed 1h window. Skipped when the header or the
  // IP_HASH_SALT secret is missing — production deploys MUST set the secret (§7.1).
  let ipHash: string | null = null;
  if (ipf !== '') {
    ipHash = ipf;
    const windowStart = Math.floor(now / config.ipWindowMs) * config.ipWindowMs;
    await upsertIpRate(db, ipHash, windowStart);
    const row = await getIpRate(db, ipHash);
    if (row !== null && row.count > config.ipLimit) {
      throw rateLimited(Math.max(0, windowStart + config.ipWindowMs - now));
    }
  }

  // 10. Client rate limit: §7.5 conditional upsert, changes===0 means throttled.
  const rateChanges = await upsertClientRate(db, payload.client.id, now, config.rateLimitMs);
  if (rateChanges === 0) {
    const row = await getClientRate(db, payload.client.id);
    const retryAfterMs = Math.max(0, (row?.last_at ?? now) + config.rateLimitMs - now);
    throw rateLimited(retryAfterMs);
  }

  // 10.5 Global daily cap (task 5A): counts accepted submissions per UTC day,
  // AFTER dedupe so duplicates and replays never consume quota. Over the limit
  // -> 429 with Retry-After pointing at the next UTC midnight.
  const day = utcDayOf(now);
  const dayCount = await bumpDailyCount(db, day);
  if (dayCount > config.dailyLimit) {
    const midnight = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1,
    );
    throw rateLimited(Math.max(0, midnight - now));
  }

  // 11. INSERT OR IGNORE: the two UNIQUE indexes are the concurrent-request backstop.
  const model = splitModelRef(payload.bot.runtime.model);
  const inserted = await insertReport(db, {
    id: payload.reportId,
    clientId: payload.client.id,
    contentHash,
    contentBucket,
    payloadHash,
    payloadBucket,
    botId: payload.bot.id,
    botName: payload.bot.name,
    modelProvider: model.provider,
    modelId: model.id,
    messageKind: payload.message.kind,
    messageText: contentSource(payload.message),
    appVersion: payload.client.appVersion,
    platform: payload.client.platform,
    sourceKind: payload.source.kind,
    receivedAt: now,
    ipHash,
    payloadJson: JSON.stringify(payload),
  });
  if (inserted === 0) return duplicate(payload.reportId, 'concurrent');

  return {
    response: jsonResponse(201, { status: 'accepted', id: payload.reportId }),
    reportLog: { reportId: payload.reportId, status: 'accepted', httpStatus: 201 },
  };
}

function duplicate(reportId: string, reason: string): SubmitOutcome {
  return {
    response: jsonResponse(200, { status: 'duplicate', reason }),
    reportLog: { reportId, status: 'duplicate', httpStatus: 200 },
  };
}

function rateLimited(retryAfterMs: number): HttpError {
  return new HttpError(429, { error: 'rate_limited', retryAfterMs }, {
    'retry-after': String(Math.ceil(retryAfterMs / 1000)),
  });
}

// ------------------------------------------------------------------ body / helpers

/**
 * Reads the request body stream chunk by chunk, counting BYTES; returns null once
 * the cap is exceeded (stream cancelled, response is 413). Content-Length is never
 * consulted — a lying header must not bypass the cap (§7.4 step 3).
 */
export async function readBodyWithLimit(
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (reader === null) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const full = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    full.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // fatal: invalid UTF-8 is a client error, not garbage-in-DB.
  return new TextDecoder('utf-8', { fatal: true }).decode(full);
}

/** HMAC-SHA256(key=salt, msg=ip) as lowercase hex — only the digest is stored (§8). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  let hex = '';
  for (const byte of new Uint8Array(mac)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** "openai/gpt-5.1" -> { provider: "openai", id: "gpt-5.1" }; plain ids keep provider "". */
export function splitModelRef(model: string): { provider: string; id: string } {
  const slash = model.indexOf('/');
  if (slash === -1) return { provider: '', id: model };
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
