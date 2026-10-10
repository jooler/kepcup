/**
 * Read-only implementation of the official MCP Registry OpenAPI v0.1 for the KepCup
 * sub-registry (design 29 §11.4 / §15.2).
 *
 *   GET /v0.1/servers                                   list (cursor, limit, updated_since, search, version, include_deleted)
 *   GET /v0.1/servers/{serverName}/versions             all versions of one server
 *   GET /v0.1/servers/{serverName}/versions/{version}   one version ('latest' supported)
 *   GET /v0.1/health | /v0.1/ping | /v0.1/version       liveness / build info
 *
 * `/v0/...` is accepted as an alias (the official service serves both with the same
 * schemas). GET and HEAD are served, OPTIONS answers the CORS preflight (204), every
 * other method is 405: publishing and status edits are NOT implemented here; the data
 * arrives via the cron sync (sync.ts) and KepCup reviews are written through
 * reviews.ts (the developer portal's narrow RPC).
 *
 * Response conventions mirror the live service: errors are RFC 9457 problem
 * documents (`application/problem+json` with title/status/detail[/errors]); a
 * parameter violation is HTTP 422 (what the official huma-based service returns for
 * e.g. limit=500), unknown server/version is 404, wrong method is 405.
 */

import {
  CONNECTOR_META_KEY,
  OFFICIAL_META_KEY,
  REVIEW_META_KEY,
  type CacheLike,
  type D1Like,
  type ReviewStatus,
  type ReviewTier,
  type ServerJson,
  type ServerListResponse,
  type ServerResponse,
  type ServerStatus,
} from './types';
import { asciiLower, sanitizeServerMeta, utf8Length } from './util';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
/** Rows per page of the versions endpoint (more => `metadata.nextCursor`, never silent truncation). */
export const VERSIONS_PAGE_SIZE = 1000;
/** UTF-8 bytes. `search` is matched with instr(), so there is no LIKE-pattern limit to hit. */
export const MAX_SEARCH_BYTES = 200;
const MAX_VERSION_LENGTH = 255;

/**
 * Client-facing freshness: browsers always revalidate (cheap ETag/304); the shared edge
 * cache may serve for 5 minutes. The Cache API copy is stored with an explicit
 * `max-age=EDGE_TTL_SECONDS` (it does not honour stale-while-revalidate and its handling
 * of s-maxage is not something we rely on), then re-labelled on the way out.
 *
 * Visibility latency of a review change or revocation: up to EDGE_TTL_SECONDS (5 min)
 * per Cloudflare colo; upstream data additionally waits for the next hourly cron.
 */
export const EDGE_TTL_SECONDS = 300;
export const CACHE_CONTROL = `public, max-age=0, s-maxage=${EDGE_TTL_SECONDS}`;

export interface HandlerDeps {
  db: D1Like;
  /** Cache API read-through for GET list/detail responses; omitted = no caching. */
  cache?: CacheLike;
  /** `ctx.waitUntil`: lets the cache write finish after the response is returned. */
  waitUntil?: (promise: Promise<unknown>) => void;
  buildInfo?: { version?: string; commit?: string; time?: string };
  /** Test hook: versions endpoint page size (default {@link VERSIONS_PAGE_SIZE}). */
  versionsPageSize?: number;
}

export interface ServerRow {
  name: string;
  version: string;
  is_latest: number;
  server_json: string;
  status: ServerStatus;
  status_changed_at: string;
  status_message: string | null;
  published_at: string;
  updated_at: string;
  effective_updated_at: string;
  tier: ReviewTier | null;
  review_status: ReviewStatus | null;
  reviewed_at: string | null;
  tool_contract_hash: string | null;
  notes: string | null;
  /** 1 when the review's stored sha256 equals the row's current server_json_sha256. */
  review_valid: number;
}

interface ProblemDetail {
  message: string;
  location?: string;
  value?: unknown;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly errors?: ProblemDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super(detail);
  }
}

const ALLOW = 'GET, HEAD, OPTIONS';

// ------------------------------------------------------------------ entry point

export async function handleRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  try {
    if (request.method === 'OPTIONS') return preflight();
    if (request.method === 'HEAD') {
      // GET semantics without a body.
      const get = await handleRequest(
        new Request(request.url, { method: 'GET', headers: request.headers }),
        deps,
      );
      return new Response(null, { status: get.status, headers: get.headers });
    }
    if (request.method !== 'GET') {
      throw new HttpProblem(405, 'Method Not Allowed', 'This registry is read-only', undefined, {
        allow: ALLOW,
      });
    }
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);
    if (!route) {
      throw new HttpProblem(
        404,
        'Not Found',
        'Endpoint not found. See /docs for the API documentation.',
      );
    }
    if (route.kind === 'health') return json({ status: 'ok' }, 'no-store');
    if (route.kind === 'ping') return json({ pong: true }, 'no-store');
    if (route.kind === 'build-info') {
      return json(
        {
          version: deps.buildInfo?.version ?? 'dev',
          git_commit: deps.buildInfo?.commit ?? 'unknown',
          build_time: deps.buildInfo?.time ?? 'unknown',
        },
        'no-store',
      );
    }
    const plan = planRequest(route, url.searchParams, deps);
    return await cached(request, plan.key, deps, plan.run);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * CORS: `access-control-allow-origin: *` is deliberate. The API is public, read-only,
 * cookie-less and credential-less, so there is nothing for a cross-origin page to abuse
 * that a plain `curl` could not already do.
 */
function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      allow: ALLOW,
      'access-control-allow-methods': 'GET, HEAD',
      'access-control-allow-headers': 'if-none-match',
      'access-control-max-age': '86400',
    },
  });
}

type Route =
  | { kind: 'health' }
  | { kind: 'ping' }
  | { kind: 'build-info' }
  | { kind: 'list' }
  | { kind: 'versions'; name: string }
  | { kind: 'version-detail'; name: string; version: string };

type DataRoute = Extract<Route, { kind: 'list' | 'versions' | 'version-detail' }>;

/** Pure path routing; returns null for anything outside the API surface. */
export function matchRoute(pathname: string): Route | null {
  const m = /^\/v0(?:\.1)?(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const rest = m[1] ?? '';
  if (rest === '/health') return { kind: 'health' };
  if (rest === '/ping') return { kind: 'ping' };
  if (rest === '/version') return { kind: 'build-info' };
  if (rest === '/servers' || rest === '/servers/') return { kind: 'list' };
  if (!rest.startsWith('/servers/')) return null;

  let segments: string[];
  try {
    segments = rest
      .slice('/servers/'.length)
      .split('/')
      .map((s) => decodeURIComponent(s));
  } catch {
    throw new HttpProblem(400, 'Bad Request', 'Malformed percent-encoding in path');
  }
  // Official form: the name is ONE percent-encoded segment (com.example%2Fmy-server).
  // Tolerated: the unencoded `namespace/name` spelling (two segments).
  let name = segments[0] ?? '';
  let tail = segments.slice(1);
  if (!name.includes('/') && tail.length > 0 && tail[0] !== 'versions') {
    name = `${name}/${tail[0]}`;
    tail = tail.slice(1);
  }
  if (!name || tail[0] !== 'versions') return null;
  if (tail.length === 1) return { kind: 'versions', name };
  if (tail.length === 2 && tail[1]) return { kind: 'version-detail', name, version: tail[1] };
  return null;
}

/**
 * Parses the query once and returns both the canonical cache key and the producer.
 * The key is built ONLY from the parsed, whitelisted, first-value-wins parameters the
 * handler actually uses (unknown parameters, duplicates, empty values, `search` case /
 * whitespace and equivalent spellings all collapse), so a client cannot mint unbounded
 * distinct cache entries or make two different queries share one entry.
 */
function planRequest(
  route: DataRoute,
  params: URLSearchParams,
  deps: HandlerDeps,
): { key: URL; run: () => Promise<Response> } {
  const key = new URL('https://registry.kepcup.invalid');
  const put = (k: string, v: string | null) => {
    if (v) key.searchParams.set(k, v);
  };

  if (route.kind === 'list') {
    const p = parseListParams(params);
    key.pathname = '/v0.1/servers';
    put('cursor', p.cursor ? encodeCursor(p.cursor.name, p.cursor.version) : null);
    put('include_deleted', p.includeDeleted ? 'true' : null);
    put('limit', p.limit === DEFAULT_LIMIT ? null : String(p.limit));
    put('search', p.search);
    put('updated_since', p.updatedSince);
    put('version', p.version);
    return {
      key,
      run: async () => json(await listServers(deps.db, p), CACHE_CONTROL),
    };
  }

  const includeDeleted = parseBool(params, 'include_deleted') ?? false;
  put('include_deleted', includeDeleted ? 'true' : null);
  if (route.kind === 'versions') {
    const cursor = parseCursor(params);
    key.pathname = `/v0.1/servers/${encodeURIComponent(route.name)}/versions`;
    put('cursor', cursor ? encodeCursor(cursor.name, cursor.version) : null);
    return {
      key,
      run: async () => {
        const pageSize = deps.versionsPageSize ?? VERSIONS_PAGE_SIZE;
        const rows = await queryVersions(deps.db, route.name, includeDeleted, cursor, pageSize);
        if (rows.length === 0 && !cursor) throw notFound('Server not found');
        const page = rows.slice(0, pageSize);
        const last = page[page.length - 1];
        const metadata: ServerListResponse['metadata'] = { count: page.length };
        if (rows.length > pageSize && last) {
          metadata.nextCursor = encodeCursor(last.published_at, last.version);
        }
        return json({ servers: page.map(toServerResponse), metadata }, CACHE_CONTROL);
      },
    };
  }

  key.pathname = `/v0.1/servers/${encodeURIComponent(route.name)}/versions/${encodeURIComponent(route.version)}`;
  return {
    key,
    run: async () => {
      const row = await queryVersion(deps.db, route.name, route.version, includeDeleted);
      if (!row) throw notFound('Server not found');
      return json(toServerResponse(row), CACHE_CONTROL);
    },
  };
}

// ------------------------------------------------------------------ list

export interface ListParams {
  limit: number;
  cursor: { name: string; version: string } | null;
  updatedSince: string | null;
  search: string | null;
  version: string | null;
  includeDeleted: boolean;
}

function parseListParams(params: URLSearchParams): ListParams {
  const updatedSince = parseUpdatedSince(params);
  return {
    limit: parseLimit(params),
    cursor: parseCursor(params),
    updatedSince,
    search: parseSearch(params),
    version: parseText(params, 'version', MAX_VERSION_LENGTH),
    // Official rule: deleted entries are hidden unless asked for, but always included
    // for incremental (updated_since) pulls so mirrors learn about deletions.
    includeDeleted: (parseBool(params, 'include_deleted') ?? false) || updatedSince !== null,
  };
}

/** Builds the list SQL; exported so a test can EXPLAIN QUERY PLAN the real statement. */
export function buildListQuery(p: ListParams): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (!p.includeDeleted) where.push(`s.status <> 'deleted'`);
  if (p.updatedSince !== null) {
    where.push(`${EFFECTIVE_UPDATED_AT} > ?`);
    binds.push(p.updatedSince);
  }
  if (p.search) {
    // instr() on lowercased text: no LIKE pattern (D1 caps LIKE patterns at 50 bytes),
    // no wildcard escaping; `search` is already trimmed and ASCII-lowercased (as lower()).
    where.push(
      `(instr(lower(s.name), ?) > 0 OR instr(lower(json_extract(s.server_json, '$.title')), ?) > 0 ` +
        `OR instr(lower(json_extract(s.server_json, '$.description')), ?) > 0)`,
    );
    binds.push(p.search, p.search, p.search);
  }
  if (p.version === 'latest') where.push('s.is_latest = 1');
  else if (p.version) {
    where.push('s.version = ?');
    binds.push(p.version);
  }
  if (p.cursor) {
    // `name >= ?` is the sargable lower bound (index SEARCH on the primary key); the
    // second conjunct trims the rows that share the cursor's name. Equivalent to the
    // row value (name, version) > (?, ?), without relying on row-value support.
    where.push('(s.name >= ? AND (s.name > ? OR s.version > ?))');
    binds.push(p.cursor.name, p.cursor.name, p.cursor.version);
  }
  const sql =
    `${SELECT_ROWS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
    `ORDER BY s.name, s.version LIMIT ?`;
  binds.push(p.limit + 1);
  return { sql, binds };
}

async function listServers(db: D1Like, p: ListParams): Promise<ServerListResponse> {
  const { sql, binds } = buildListQuery(p);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ServerRow>();

  const page = results.slice(0, p.limit);
  const servers = page.map(toServerResponse);
  const last = page[page.length - 1];
  const metadata: ServerListResponse['metadata'] = { count: servers.length };
  if (results.length > p.limit && last) {
    metadata.nextCursor = encodeCursor(last.name, last.version);
  }
  return { servers, metadata };
}

const EFFECTIVE_UPDATED_AT = `max(s.updated_at, COALESCE(r.reviewed_at, ''))`;

const SELECT_ROWS = `SELECT s.name, s.version, s.is_latest, s.server_json, s.status,
  s.status_changed_at, s.status_message, s.published_at, s.updated_at,
  ${EFFECTIVE_UPDATED_AT} AS effective_updated_at,
  r.tier, r.review_status, r.reviewed_at, r.notes, r.tool_contract_hash,
  CASE WHEN r.server_json_sha256 IS NOT NULL AND r.server_json_sha256 = s.server_json_sha256
       THEN 1 ELSE 0 END AS review_valid
  FROM servers s LEFT JOIN reviews r ON r.name = s.name AND r.version = s.version`;

async function queryVersions(
  db: D1Like,
  name: string,
  includeDeleted: boolean,
  cursor: { name: string; version: string } | null,
  pageSize: number,
) {
  // Newest published first. The cursor carries (published_at, version) of the last row.
  const where = ['s.name = ?'];
  const binds: unknown[] = [name];
  if (!includeDeleted) where.push(`s.status <> 'deleted'`);
  if (cursor) {
    where.push('(s.published_at < ? OR (s.published_at = ? AND s.version < ?))');
    binds.push(cursor.name, cursor.name, cursor.version);
  }
  const { results } = await db
    .prepare(
      `${SELECT_ROWS} WHERE ${where.join(' AND ')} ` +
        `ORDER BY s.published_at DESC, s.version DESC LIMIT ?`,
    )
    .bind(...binds, pageSize + 1)
    .all<ServerRow>();
  return results;
}

async function queryVersion(
  db: D1Like,
  name: string,
  version: string,
  includeDeleted: boolean,
): Promise<ServerRow | null> {
  const notDeleted = includeDeleted ? '' : `AND s.status <> 'deleted'`;
  if (version !== 'latest') {
    return db
      .prepare(`${SELECT_ROWS} WHERE s.name = ? AND s.version = ? ${notDeleted}`)
      .bind(name, version)
      .first<ServerRow>();
  }
  const flagged = await db
    .prepare(`${SELECT_ROWS} WHERE s.name = ? AND s.is_latest = 1 ${notDeleted} LIMIT 1`)
    .bind(name)
    .first<ServerRow>();
  if (flagged) return flagged;
  // No row carries the flag (e.g. the flagged version was deleted): newest live version.
  return db
    .prepare(
      `${SELECT_ROWS} WHERE s.name = ? AND s.status <> 'deleted' ` +
        `ORDER BY s.published_at DESC, s.version DESC LIMIT 1`,
    )
    .bind(name)
    .first<ServerRow>();
}

// ------------------------------------------------------------------ row -> response

/**
 * Builds one registry entry. Review merge rules:
 *  - only an `approved` review whose recorded server_json sha256 still equals the
 *    current row's is exposed; pending / rejected / stale / missing => no tier at all;
 *  - the tier is authoritative from the reviews table only: every registry-owned key a
 *    publisher put inside server.json `_meta` is removed (see sanitizeServerMeta),
 *    otherwise a submitter could self-label `verified` / `builtin`.
 */
export function toServerResponse(row: ServerRow): ServerResponse {
  const server = JSON.parse(row.server_json) as ServerJson;
  sanitizeServerMeta(server);

  const official: Record<string, unknown> = {
    status: row.status,
    statusChangedAt: row.status_changed_at,
    publishedAt: row.published_at,
    updatedAt: row.effective_updated_at || row.updated_at,
    isLatest: row.is_latest === 1,
  };
  if (row.status_message) official.statusMessage = row.status_message;

  const meta: Record<string, unknown> = { [OFFICIAL_META_KEY]: official };
  if (row.review_status === 'approved' && row.review_valid === 1 && row.tier && row.reviewed_at) {
    meta[CONNECTOR_META_KEY] = { tier: row.tier };
    const review: Record<string, unknown> = {
      tier: row.tier,
      status: 'approved',
      reviewedAt: row.reviewed_at,
      toolContractHash: row.tool_contract_hash ?? null,
    };
    if (row.notes) review.notes = row.notes;
    meta[REVIEW_META_KEY] = review;
  }
  return { server, _meta: meta };
}

// ------------------------------------------------------------------ query parsing

function invalid(param: string, message: string, value: unknown): HttpProblem {
  return new HttpProblem(422, 'Unprocessable Entity', 'validation failed', [
    { message, location: `query.${param}`, value },
  ]);
}

// All parsers read the FIRST value of a parameter (URLSearchParams.get), exactly what
// the cache key is built from.

function parseLimit(params: URLSearchParams): number {
  const raw = params.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^-?\d+$/.test(raw)) throw invalid('limit', 'expected integer', raw);
  const n = Number(raw);
  if (n > MAX_LIMIT) throw invalid('limit', `expected number <= ${MAX_LIMIT}`, n);
  if (n < 1) throw invalid('limit', 'expected number >= 1', n);
  return n;
}

function parseBool(params: URLSearchParams, name: string): boolean | null {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw invalid(name, 'expected boolean', raw);
}

function parseText(params: URLSearchParams, name: string, max: number): string | null {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  if (raw.length > max) throw invalid(name, `expected length <= ${max}`, raw.slice(0, 32));
  return raw;
}

/** Trimmed, ASCII-lowercased (as SQLite's lower()), at most MAX_SEARCH_BYTES UTF-8 bytes. */
function parseSearch(params: URLSearchParams): string | null {
  const raw = params.get('search')?.trim();
  if (!raw) return null;
  if (utf8Length(raw) > MAX_SEARCH_BYTES) {
    throw invalid('search', `expected at most ${MAX_SEARCH_BYTES} UTF-8 bytes`, raw.slice(0, 32));
  }
  return asciiLower(raw);
}

/** RFC 3339 date-time -> normalized `YYYY-MM-DDTHH:MM:SS.sssZ` (the stored format). */
function parseUpdatedSince(params: URLSearchParams): string | null {
  const raw = params.get('updated_since');
  if (raw === null || raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) throw invalid('updated_since', 'expected RFC 3339', raw);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw invalid('updated_since', 'expected RFC 3339', raw);
  return new Date(ms).toISOString();
}

function parseCursor(params: URLSearchParams): { name: string; version: string } | null {
  const raw = params.get('cursor');
  if (raw === null || raw === '') return null;
  const decoded = decodeCursor(raw);
  if (!decoded) throw invalid('cursor', 'invalid cursor', raw.slice(0, 64));
  return decoded;
}

// ------------------------------------------------------------------ cursor

/** Opaque keyset cursor: base64url(JSON [a, b]) (list: name, version; versions: published_at, version). */
export function encodeCursor(name: string, version: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([name, version]));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): { name: string; version: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024) return null;
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { name: parsed[0], version: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

// ------------------------------------------------------------------ HTTP plumbing

const BASE_HEADERS = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

function json(body: unknown, cacheControl: string): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

function notFound(detail: string): HttpProblem {
  return new HttpProblem(404, 'Not Found', detail);
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpProblem) {
    const body: Record<string, unknown> = {
      title: error.title,
      status: error.status,
      detail: error.detail,
    };
    if (error.errors) body.errors = error.errors;
    return new Response(JSON.stringify(body), {
      status: error.status,
      headers: {
        ...BASE_HEADERS,
        ...error.headers,
        'content-type': 'application/problem+json',
        'cache-control': 'no-store',
      },
    });
  }
  console.error('registry: unhandled error', error);
  return new Response(
    JSON.stringify({ title: 'Internal Server Error', status: 500, detail: 'internal error' }),
    {
      status: 500,
      headers: {
        ...BASE_HEADERS,
        'content-type': 'application/problem+json',
        'cache-control': 'no-store',
      },
    },
  );
}

async function etagOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const b of new Uint8Array(digest).subarray(0, 16)) hex += b.toString(16).padStart(2, '0');
  return `"${hex}"`;
}

/** True when `If-None-Match` matches `etag` (weak comparison, `*` and lists allowed). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (v: string) => v.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => strip(candidate) === strip(etag));
}

/**
 * Read-through: serve from the cache when present, otherwise compute, stamp an
 * ETag, store (200 only) and answer. Conditional requests (If-None-Match) get a
 * bodyless 304 in both paths.
 */
async function cached(
  request: Request,
  keyUrl: URL,
  deps: HandlerDeps,
  compute: () => Promise<Response>,
): Promise<Response> {
  const ifNoneMatch = request.headers.get('if-none-match');
  const key = new Request(keyUrl.toString(), { method: 'GET' });

  if (deps.cache) {
    const hit = await deps.cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('cache-control', CACHE_CONTROL); // client-facing label (stored copy is max-age)
      return conditional(new Response(hit.body, { status: hit.status, headers }), ifNoneMatch);
    }
  }

  const fresh = await compute();
  const text = await fresh.text();
  const etag = await etagOf(text);
  const headers = new Headers(fresh.headers);
  headers.set('etag', etag);
  const full = new Response(text, { status: fresh.status, headers });

  if (deps.cache && fresh.status === 200) {
    const stored = new Headers(headers);
    stored.set('cache-control', `public, max-age=${EDGE_TTL_SECONDS}`);
    const write = deps.cache.put(key, new Response(text, { status: 200, headers: stored }));
    if (deps.waitUntil) deps.waitUntil(write);
    else await write;
  }
  return conditional(full, ifNoneMatch);
}

function conditional(response: Response, ifNoneMatch: string | null): Response {
  const etag = response.headers.get('etag');
  if (etag && etagMatches(ifNoneMatch, etag)) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }
  return response;
}
