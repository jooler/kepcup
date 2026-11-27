/**
 * Admin API (todo/ai-content-reporting.md §7.6): list / detail / patch / delete-client /
 * stats over the stored reports, consumed by scripts/report-triage.mjs (stage 2).
 *
 * Auth: every /v1/admin path requires `Authorization: Bearer <REPORT_ADMIN_TOKEN>`.
 * With the secret unset the whole subtree answers 404 (hidden entry). The comparison
 * hashes both sides with sha256 first and then diffs byte by byte — no length or
 * prefix early-exit. Admin responses carry the standard no-store trio (they come from
 * jsonResponse / HttpError in http.ts) and never include CORS headers.
 */

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

export async function handleAdminRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  const expected = deps.config.adminToken;
  // No token configured -> 404 for the whole subtree: the entry point does not exist.
  if (expected === undefined) throw new HttpError(404, { error: 'not_found' });

  const header = request.headers.get('authorization');
  const provided = header !== null && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (provided === null || !(await timingSafeEqual(provided, expected))) {
    throw new HttpError(401, { error: 'unauthorized' });
  }

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
