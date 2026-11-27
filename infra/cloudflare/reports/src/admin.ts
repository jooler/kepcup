/**
 * Admin API + console (todo/ai-content-reporting.md §7.6; Web UI is task 5B):
 * /v1/admin/* list / detail / patch / delete-client / stats over the stored
 * reports, plus the same-origin embedded single-page console under /admin*
 * (assets live in admin-ui.ts).
 *
 * Auth — two interchangeable sources for /v1/admin/* (§7.6 semantics kept):
 *   1. `Authorization: Bearer <REPORT_ADMIN_TOKEN>` — the CLI channel
 *      (scripts/report-triage.mjs), unchanged;
 *   2. the session cookie issued by POST /admin/session — the browser console.
 * With the secret unset the whole /v1/admin + /admin* surface answers 404
 * (hidden entry). The comparison hashes both sides with sha256 first and then
 * diffs byte by byte — no length or prefix early-exit.
 *
 * Session cookie: `__Host-kepcup_reports_session=<exp>.<sig>` — HttpOnly,
 * Secure, SameSite=Strict, Path=/, Max-Age=12h. sig = HMAC-SHA256(key =
 * REPORT_ADMIN_TOKEN, "reports-session:<exp>") hex; sessions are stateless
 * (nothing stored server-side) and rotating the token invalidates all of them
 * at once. Verification failure is indistinguishable from "not authenticated"
 * and lands on the existing 401 / 404 paths.
 *
 * CSRF: SameSite=Strict is the first line; when a write (PATCH / DELETE) is
 * cookie-authenticated AND an Origin header is present and not this origin, the
 * request is 403. Bearer requests skip the Origin check (CLI clients have
 * none). Login failures return 401 with only the generic {path,method,status}
 * log line — the token is 32-byte-hex entropy, so online guessing is
 * impractical and no rate limit is added here (README「管理端 Web UI」).
 *
 * Admin responses carry the standard no-store trio (jsonResponse / HttpError in
 * http.ts) and never include CORS headers; page/asset responses additionally
 * carry the strict ADMIN_CSP.
 */

import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from './admin-ui';
import {
  deleteClientData,
  findById,
  listReports,
  stats,
  updateReport,
} from './db';
import { sha256Hex } from './dedupe';
import { HttpError, jsonResponse } from './http';
import type { HandlerDeps } from './worker';

/** Statuses a report can be filtered by (all stored states). */
const FILTER_STATUSES = ['new', 'triaged', 'actioned', 'dismissed'];
/** Statuses an admin may set — 'new' is the system-only initial state (§7.6). */
const PATCH_STATUSES = ['triaged', 'actioned', 'dismissed'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const NOTE_MAX_CHARS = 2000;
/** List responses carry a preview, never the full message text nor payload_json (§7.6). */
const PREVIEW_CHARS = 200;
/** Login body cap: the token is ≤64 chars; anything larger is junk by definition. */
const LOGIN_BODY_MAX_BYTES = 4096;

// ------------------------------------------------------------------ session

/**
 * Session cookie name. The `__Host-` prefix makes browsers reject any Domain
 * attribute and require Secure + Path=/ — exactly the attributes we set.
 */
export const SESSION_COOKIE_NAME = '__Host-kepcup_reports_session';
/** Session lifetime: 12 h — the cookie Max-Age and the signed exp share it. */
export const SESSION_TTL_MS = 12 * 3_600_000;
/** HMAC message prefix binding the signature to this one purpose. */
const SESSION_MSG_PREFIX = 'reports-session:';

/**
 * Strict CSP for the console page and its same-origin assets (task 5B): no
 * inline script/style, no third-party anything, no framing, no base/form
 * hijacking. script/style/connect are covered by 'self' via default-src 'none'.
 */
export const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** `<exp>.<sig>` — the signed session cookie value (exp is a ms epoch). */
export async function sessionCookieValue(exp: number, token: string): Promise<string> {
  return `${exp}.${await hmacSha256Hex(token, `${SESSION_MSG_PREFIX}${exp}`)}`;
}

/** exp is fresh and the signature verifies (constant time against the HMAC). */
async function verifySessionValue(value: string, token: string, now: number): Promise<boolean> {
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const expRaw = value.slice(0, dot);
  if (!/^\d{1,15}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (exp <= now) return false;
  const expectedSig = await hmacSha256Hex(token, `${SESSION_MSG_PREFIX}${exp}`);
  return timingSafeEqual(value.slice(dot + 1), expectedSig);
}

/** Value of the session cookie from a Cookie header, or null. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === SESSION_COOKIE_NAME) return pair.slice(eq + 1);
  }
  return null;
}

/** HMAC-SHA256(key, msg) as lowercase hex (WebCrypto; mirrors worker.ts helper). */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
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

function sessionSetCookie(value: string, maxAgeSeconds: number): string {
  return (
    `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; ` +
    `Max-Age=${maxAgeSeconds}`
  );
}

// ------------------------------------------------------------------ auth

/**
 * Auth source abstraction for /v1/admin/*: bearer first (CLI channel, exactly
 * the old behavior), then the session cookie. Throws 401 like before when
 * neither verifies.
 */
async function authorizeAdmin(
  request: Request,
  deps: HandlerDeps,
  expected: string,
): Promise<void> {
  const header = request.headers.get('authorization');
  if (header !== null && header.startsWith('Bearer ')) {
    if (!(await timingSafeEqual(header.slice(7), expected))) {
      throw new HttpError(401, { error: 'unauthorized' });
    }
    return; // Bearer path: no Origin check — CLI clients have none (§7.6 unchanged).
  }
  const cookie = readSessionCookie(request.headers.get('cookie'));
  if (cookie !== null && (await verifySessionValue(cookie, expected, deps.now()))) {
    assertTrustedOrigin(request);
    return;
  }
  throw new HttpError(401, { error: 'unauthorized' });
}

/**
 * CSRF line behind SameSite=Strict: cookie-authenticated writes (PATCH/DELETE)
 * must not carry a cross-origin Origin header. A missing Origin passes (many
 * same-origin requests omit it; its absence cannot be forged from a browser
 * that would send one). Bearer requests never reach here.
 */
function assertTrustedOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method !== 'PATCH' && method !== 'DELETE') return;
  const origin = request.headers.get('origin');
  if (origin === null) return;
  if (origin !== new URL(request.url).origin) {
    throw new HttpError(403, { error: 'cross_origin_forbidden' });
  }
}

export async function handleAdminRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  const expected = deps.config.adminToken;
  // No token configured -> 404 for the whole subtree: the entry point does not exist.
  if (expected === undefined) throw new HttpError(404, { error: 'not_found' });
  await authorizeAdmin(request, deps, expected);

  const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0);
  // segments: ['v1', 'admin', ...]; percent-decoding per path segment.
  const rest = segments.slice(2).map((s) => safeDecode(s));
  if (rest[0] !== 'reports' && rest[0] !== 'clients' && rest[0] !== 'stats') {
    throw new HttpError(404, { error: 'not_found' });
  }

  if (rest[0] === 'stats') {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    const counts = await stats(deps.db, deps.now() - 7 * 86_400_000);
    return jsonResponse(200, {
      byStatus: counts.byStatus,
      last7Days: counts.last7Days,
      generatedAt: deps.now(),
    });
  }

  if (rest[0] === 'reports') {
    if (rest.length === 1) {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return listHandler(request, deps);
    }
    if (rest.length === 2 && rest[1] !== '') {
      const id = rest[1] as string;
      if (request.method === 'GET') return detailHandler(deps, id);
      if (request.method === 'PATCH') return patchHandler(request, deps, id);
      throw methodNotAllowed('GET, PATCH');
    }
    throw new HttpError(404, { error: 'not_found' });
  }

  // clients
  if (rest.length === 2 && rest[1] !== '') {
    if (request.method !== 'DELETE') throw methodNotAllowed('DELETE');
    const clientId = rest[1] as string;
    if (clientId.length > 128) throw new HttpError(400, { error: 'invalid_client' });
    const deleted = await deleteClientData(deps.db, clientId);
    return jsonResponse(200, { status: 'deleted', clientId, ...deleted });
  }
  throw new HttpError(404, { error: 'not_found' });
}

// ------------------------------------------------------------------ /admin* console

/**
 * The embedded single-page console: static page + same-origin assets + the two
 * session endpoints. No token configured -> 404 like /v1/admin/*. Page and
 * assets are served without auth — they contain no secret (auth happens per
 * API call, in the browser via the session cookie); unknown paths 404.
 */
export async function handleAdminConsoleRequest(
  request: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (deps.config.adminToken === undefined) throw new HttpError(404, { error: 'not_found' });
  const { pathname } = new URL(request.url);
  if (pathname === '/admin') {
    // Canonical /admin/: the slash matters for relative asset URLs; 308 keeps
    // the method. Log stays the generic route line (no ids involved).
    return new Response(null, {
      status: 308,
      headers: {
        location: '/admin/',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (pathname === '/admin/' || pathname === '/admin/app.js' || pathname === '/admin/app.css') {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    if (pathname === '/admin/') return assetResponse(request, ADMIN_HTML, 'text/html; charset=utf-8');
    if (pathname === '/admin/app.js') {
      return assetResponse(request, ADMIN_JS, 'text/javascript; charset=utf-8');
    }
    return assetResponse(request, ADMIN_CSS, 'text/css; charset=utf-8');
  }
  if (pathname === '/admin/session') {
    if (request.method === 'POST') return loginHandler(request, deps);
    if (request.method === 'DELETE') return logoutHandler();
    throw methodNotAllowed('POST, DELETE');
  }
  throw new HttpError(404, { error: 'not_found' });
}

/**
 * Page/asset response: strict CSP + no-store + nosniff + an ETag (content
 * sha256, first 16 hex) with a simple If-None-Match 304 path.
 */
async function assetResponse(
  request: Request,
  body: string,
  contentType: string,
): Promise<Response> {
  const etag = `"${(await sha256Hex(body)).slice(0, 16)}"`;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': ADMIN_CSP,
    etag,
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

/**
 * POST /admin/session — verify the token (constant time), set the signed
 * cookie. Malformed/oversized bodies are just a failed login (401): no signal
 * about token validity, no error echo, and the generic route log only (§8).
 * The body is read with a streamed byte cap (this endpoint is unauthenticated —
 * an uncapped request.text() would let anyone buffer an arbitrary body in the
 * isolate). No rate limit beyond that: REPORT_ADMIN_TOKEN is 32-byte hex
 * entropy, online guessing is impractical (Workers has no sleep for failure
 * delays anyway).
 */
async function loginHandler(request: Request, deps: HandlerDeps): Promise<Response> {
  const expected = deps.config.adminToken;
  if (expected === undefined) throw new HttpError(404, { error: 'not_found' }); // gated above
  let parsed: unknown;
  try {
    const raw = await readBodyCapped(request, LOGIN_BODY_MAX_BYTES);
    if (raw === null) throw new Error('too large');
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(401, { error: 'unauthorized' });
  }
  const token =
    typeof parsed === 'object' && parsed !== null ? (parsed as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || !(await timingSafeEqual(token, expected))) {
    throw new HttpError(401, { error: 'unauthorized' });
  }
  const expiresAt = deps.now() + SESSION_TTL_MS;
  const value = await sessionCookieValue(expiresAt, expected);
  return jsonResponse(200, { ok: true, expiresAt }, {
    'set-cookie': sessionSetCookie(value, SESSION_TTL_MS / 1000),
  });
}

/** DELETE /admin/session — clear the cookie (Max-Age=0); idempotent, no auth needed. */
function logoutHandler(): Response {
  return jsonResponse(200, { ok: true }, {
    'set-cookie': sessionSetCookie('', 0),
  });
}

// ------------------------------------------------------------------ handlers

async function listHandler(request: Request, deps: HandlerDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const status = params.get('status') ?? 'new';
  if (!(FILTER_STATUSES as string[]).includes(status)) {
    throw new HttpError(400, { error: 'invalid_status' });
  }
  const limit = parseBoundedInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT, 'invalid_limit');
  const before = params.has('before')
    ? parseBefore(params.get('before') as string)
    : null;

  const clientRaw = params.get('client');
  if (clientRaw !== null && clientRaw.length > 128) {
    throw new HttpError(400, { error: 'invalid_client' });
  }

  const rows = await listReports(deps.db, {
    status,
    limit,
    before,
    clientId: clientRaw !== null && clientRaw !== '' ? clientRaw : null,
  });
  const page = rows.slice(0, limit);
  const reports = page.map((row) => ({
    id: row.id,
    status: row.status,
    botId: row.bot_id,
    botName: row.bot_name,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    messageKind: row.message_kind,
    messagePreview: row.message_text.slice(0, PREVIEW_CHARS),
    appVersion: row.app_version,
    platform: row.platform,
    sourceKind: row.source_kind,
    receivedAt: row.received_at,
  }));
  const body: Record<string, unknown> = { reports };
  if (rows.length > limit && page.length > 0) {
    // Keyset cursor: strictly older than the page's last row (received_at, id tiebreak).
    const last = page[page.length - 1] as (typeof page)[number];
    body.nextBefore = `${last.received_at}:${encodeURIComponent(last.id)}`;
  }
  return jsonResponse(200, body);
}

async function detailHandler(deps: HandlerDeps, id: string): Promise<Response> {
  const row = await findById(deps.db, id);
  if (row === null) throw new HttpError(404, { error: 'not_found' });
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null; // never observed: payload_json is written by this Worker only
  }
  return jsonResponse(200, {
    report: {
      id: row.id,
      status: row.status,
      clientId: row.client_id,
      contentHash: row.content_hash,
      contentBucket: row.content_bucket,
      payloadHash: row.payload_hash,
      payloadBucket: row.payload_bucket,
      botId: row.bot_id,
      botName: row.bot_name,
      modelProvider: row.model_provider,
      modelId: row.model_id,
      messageKind: row.message_kind,
      messageText: row.message_text,
      appVersion: row.app_version,
      platform: row.platform,
      sourceKind: row.source_kind,
      receivedAt: row.received_at,
      ipHash: row.ip_hash,
      note: row.note,
      updatedAt: row.updated_at,
      payload,
    },
  });
}

async function patchHandler(
  request: Request,
  deps: HandlerDeps,
  id: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new HttpError(400, { error: 'bad_json' });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, { error: 'invalid_patch' });
  }
  const patch = body as { status?: unknown; note?: unknown };
  if (typeof patch.status !== 'string' || !(PATCH_STATUSES as string[]).includes(patch.status)) {
    throw new HttpError(400, { error: 'invalid_status' });
  }
  if (
    patch.note !== undefined &&
    patch.note !== null &&
    (typeof patch.note !== 'string' || patch.note.length > NOTE_MAX_CHARS)
  ) {
    throw new HttpError(400, { error: 'invalid_note' });
  }
  const now = deps.now();
  const changes = await updateReport(
    deps.db,
    id,
    patch.status,
    patch.note as string | null | undefined,
    now,
  );
  if (changes === 0) throw new HttpError(404, { error: 'not_found' });
  return jsonResponse(200, { id, status: patch.status, updatedAt: now });
}

// ------------------------------------------------------------------ helpers

/**
 * Reads the request body with a hard byte cap; null once over it. Same counting
 * rule as worker.ts's readBodyWithLimit, kept local so the worker -> admin
 * import graph stays one-way. Invalid UTF-8 throws (the caller maps it to 401).
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader() ?? null;
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
  return new TextDecoder('utf-8', { fatal: true }).decode(full);
}

/**
 * Constant-time comparison (§7.6): hash both sides first so lengths and prefixes
 * leak nothing, then XOR every byte and only look at the total.
 */
async function timingSafeEqual(provided: string, expected: string): Promise<boolean> {
  const a = await sha256Hex(provided);
  const b = await sha256Hex(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, { error: 'method_not_allowed' }, { allow });
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseBoundedInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  if (raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, { error: code });
  }
  return parsed;
}

/** Cursor "<receivedAt>:<id>" (a bare receivedAt is also accepted, id then null). */
function parseBefore(raw: string): { receivedAt: number; id: string | null } {
  const colon = raw.indexOf(':');
  const seconds = colon === -1 ? raw : raw.slice(0, colon);
  const parsed = Number.parseInt(seconds, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new HttpError(400, { error: 'invalid_before' });
  const id = colon === -1 ? null : raw.slice(colon + 1);
  return { receivedAt: parsed, id: id !== '' ? id : null };
}
