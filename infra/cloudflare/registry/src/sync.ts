/**
 * Scheduled sync: pulls the official MCP Registry incrementally into D1.
 *
 * Contract (see test/sync.test.ts):
 *  - idempotent upserts keyed by (name, version); re-running a page changes nothing;
 *  - `is_latest` follows upstream, is unique per name, and is recomputed from the
 *    remaining live versions when the flagged one disappears or is deleted;
 *  - the `reviews` table is never read or written here (KepCup review results survive);
 *  - the incremental watermark is the START time of the completed run minus an overlap,
 *    never "max updatedAt seen": an entry that changes mid-run behind the page cursor is
 *    then still inside the next run's window;
 *  - bounded work per run (`maxPages`); an unfinished backfill resumes from the saved
 *    cursor on the next run;
 *  - one bad upstream entry can never wedge the cursor: entries are validated and
 *    sanitized, rejected ones are counted, and a failing batch falls back to per-entry
 *    statements;
 *  - never throws: network/format failures are recorded in `sync_state` and reported in
 *    the returned SyncResult.
 */

import type { D1Like, D1PreparedStatementLike, ServerStatus } from './types';
import { OFFICIAL_META_KEY } from './types';
import { sanitizeServerMeta, sha256Hex, toIso, utf8Length } from './util';

export const DEFAULT_UPSTREAM = 'https://registry.modelcontextprotocol.io';
const PAGE_LIMIT = 100;
/**
 * Workers Free allows 50 subrequests per invocation (fetch + D1 calls count); each page
 * costs 1 fetch + 2 D1 calls, plus a handful of fixed ones, so 8 pages stay well under.
 * Raise via the SYNC_MAX_PAGES variable on Workers Paid (1000 subrequests).
 */
export const DEFAULT_MAX_PAGES = 8;
const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * The next run asks for `updated_since = (previous run start) - OVERLAP`. Generous on
 * purpose: it also absorbs clock skew between this Worker and the upstream service.
 * Re-delivered entries are harmless (idempotent upserts).
 */
export const OVERLAP_MS = 5 * 60_000;

// Entry limits (a D1 row is capped at 2 MB; stay far below it).
export const MAX_NAME_LENGTH = 200;
export const MAX_VERSION_LENGTH = 128;
export const MAX_STATUS_MESSAGE = 500;
export const MAX_SERVER_JSON_BYTES = 512 * 1024;
const NAME_RE = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const LOOPBACK_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

export interface SyncDeps {
  db: D1Like;
  upstream?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  maxPages?: number;
  pageLimit?: number;
  /** Test hook; default {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
}

export interface SyncResult {
  ok: boolean;
  /** True when the whole delta was consumed (watermark advanced). */
  complete: boolean;
  pages: number;
  upserted: number;
  skipped: number;
  error?: string;
}

const STATUSES: readonly string[] = ['active', 'deprecated', 'deleted'];

interface Parsed {
  name: string;
  version: string;
  isLatest: boolean;
  serverJson: string;
  sha256: string;
  status: ServerStatus;
  statusChangedAt: string | null;
  statusMessage: string | null;
  publishedAt: string | null;
  /** null = upstream did not say; first-seen time / content change decide (see SQL). */
  updatedAt: string | null;
}

type EntryOutcome = { parsed: Parsed } | { reason: string };

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date());
  const result: SyncResult = { ok: true, complete: false, pages: 0, upserted: 0, skipped: 0 };
  try {
    await syncInner(deps, now, result);
    await setState(deps.db, 'last_success_at', now().toISOString());
    await deps.db.prepare(`DELETE FROM sync_state WHERE key = 'last_error'`).run();
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    try {
      await setState(deps.db, 'last_error', `${now().toISOString()} ${result.error}`.slice(0, 500));
    } catch {
      // The database itself is unreachable: nothing more we can record.
    }
  }
  return result;
}

async function syncInner(deps: SyncDeps, now: () => Date, result: SyncResult): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const base = (deps.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '');
  if (!base.startsWith('https://') && !LOOPBACK_HTTP_RE.test(base)) {
    throw new Error(`refusing non-https upstream: ${base}`);
  }
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const pageLimit = deps.pageLimit ?? PAGE_LIMIT;
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  const state = await loadState(deps.db);
  let cursor = state.get('run_cursor') ?? null;
  let since: string | null;
  let startedAt: string;
  if (cursor) {
    // Resume an unfinished run with ITS window and start time.
    since = state.get('run_since') ?? null;
    startedAt = state.get('run_started_at') ?? now().toISOString();
  } else {
    // Fresh run: the first ever run (no watermark) is a full backfill without a filter.
    since = state.get('watermark') ?? null;
    startedAt = now().toISOString();
    await beginRun(deps.db, startedAt, since);
  }
  const seenCursors = new Set<string>(cursor ? [cursor] : []);

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${base}/v0.1/servers`);
    url.searchParams.set('limit', String(pageLimit));
    if (since) url.searchParams.set('updated_since', since);
    if (cursor) url.searchParams.set('cursor', cursor);

    const body = await fetchPage(doFetch, url.toString(), maxBody);
    const entries = Array.isArray(body.servers) ? body.servers : [];
    await storeEntries(deps.db, entries, now(), result);
    result.pages++;

    const next = body.metadata?.nextCursor;
    if (typeof next !== 'string' || next === '' || entries.length === 0) {
      // Whole delta consumed: commit the watermark (run START - overlap) and clear the run.
      const candidate = new Date(Date.parse(startedAt) - OVERLAP_MS).toISOString();
      const old = state.get('watermark');
      await setState(deps.db, 'watermark', old && old > candidate ? old : candidate);
      await clearRun(deps.db);
      result.complete = true;
      return;
    }
    if (seenCursors.has(next)) {
      // A cursor that does not advance (or loops) would spin forever; refuse to persist it.
      throw new Error(`upstream cursor did not advance (${next.slice(0, 64)})`);
    }
    seenCursors.add(next);
    cursor = next;
    // Persist progress after every page so a crash/timeout resumes instead of restarting.
    await setState(deps.db, 'run_cursor', cursor);
  }
  // Page budget exhausted: leave run_* state in place; the next cron tick continues.
}

async function fetchPage(
  doFetch: typeof fetch,
  url: string,
  maxBytes: number,
): Promise<{ servers?: unknown[] | null; metadata?: { nextCursor?: unknown } }> {
  const response = await doFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'kepcup-registry-sync/1' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // Never follow redirects: the upstream is a fixed https origin.
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`upstream redirect refused (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`upstream HTTP ${response.status} for ${url}`);
  const text = await readLimited(response, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('upstream returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('upstream returned a non-object');
  return parsed as { servers?: unknown[] | null; metadata?: { nextCursor?: unknown } };
}

/** Reads at most `maxBytes` BYTES (declared length first, then while streaming). */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('upstream response too large');
  }
  if (!response.body) {
    const text = await response.text();
    if (utf8Length(text) > maxBytes) throw new Error('upstream response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('upstream response too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

// ------------------------------------------------------------------ entries

async function parseEntry(entry: unknown): Promise<EntryOutcome> {
  if (!entry || typeof entry !== 'object') return { reason: 'entry is not an object' };
  const { server, _meta } = entry as { server?: unknown; _meta?: unknown };
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    return { reason: 'missing server object' };
  }
  const s = server as Record<string, unknown>;
  if (typeof s.name !== 'string' || s.name.length > MAX_NAME_LENGTH || !NAME_RE.test(s.name)) {
    return { reason: 'invalid name' };
  }
  const v = s.version;
  if (
    typeof v !== 'string' ||
    v.length === 0 ||
    v.length > MAX_VERSION_LENGTH ||
    v === 'latest' ||
    CONTROL_RE.test(v)
  ) {
    return { reason: `invalid version for ${s.name}` };
  }

  const official =
    _meta && typeof _meta === 'object'
      ? ((_meta as Record<string, unknown>)[OFFICIAL_META_KEY] as
          Record<string, unknown> | undefined)
      : undefined;
  const status = official?.status ?? 'active';
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    return { reason: `invalid status for ${s.name}@${v}` };
  }

  sanitizeServerMeta(s);
  const serverJson = JSON.stringify(s);
  if (utf8Length(serverJson) > MAX_SERVER_JSON_BYTES) {
    return { reason: `server.json too large for ${s.name}@${v}` };
  }
  const message = typeof official?.statusMessage === 'string' ? official.statusMessage : null;
  return {
    parsed: {
      name: s.name,
      version: v,
      isLatest: official?.isLatest === true,
      serverJson,
      sha256: await sha256Hex(serverJson),
      status: status as ServerStatus,
      statusChangedAt: toIso(official?.statusChangedAt),
      statusMessage: message === null ? null : message.slice(0, MAX_STATUS_MESSAGE),
      publishedAt: toIso(official?.publishedAt),
      updatedAt: toIso(official?.updatedAt) ?? toIso(official?.statusChangedAt),
    },
  };
}

async function storeEntries(
  db: D1Like,
  entries: unknown[],
  now: Date,
  result: SyncResult,
): Promise<void> {
  const nowIso = now.toISOString();
  const groups: { label: string; stmts: D1PreparedStatementLike[] }[] = [];
  const names = new Set<string>();
  let lastReason: string | null = null;
  let skippedHere = 0;

  for (const entry of entries) {
    const outcome = await parseEntry(entry);
    if ('reason' in outcome) {
      skippedHere++;
      lastReason = outcome.reason;
      continue;
    }
    const p = outcome.parsed;
    groups.push({ label: `${p.name}@${p.version}`, stmts: upsertStatements(db, p, nowIso) });
    names.add(p.name);
  }
  const fixupsByName = [...names].map((name) => latestFixups(db, name));
  const fixups = fixupsByName.flat();

  if (groups.length > 0) {
    try {
      await db.batch([...groups.flatMap((g) => g.stmts), ...fixups]);
      result.upserted += groups.length;
    } catch {
      // One bad row must not wedge the cursor: retry entry by entry, skip the culprits.
      for (const g of groups) {
        try {
          await db.batch(g.stmts);
          result.upserted++;
        } catch (error) {
          skippedHere++;
          lastReason = `db error for ${g.label}: ${error instanceof Error ? error.message : error}`;
        }
      }
      for (const f of fixupsByName) {
        try {
          await db.batch(f);
        } catch {
          // the name's own upsert failed above and is already counted as skipped
        }
      }
    }
  }

  result.skipped += skippedHere;
  if (skippedHere > 0) {
    const total = Number((await getState(db, 'skipped_count')) ?? '0') + skippedHere;
    await db.batch([
      setStateStatement(db, 'skipped_count', String(total)),
      setStateStatement(db, 'last_skip_reason', (lastReason ?? '').slice(0, 300)),
    ]);
  }
}

function upsertStatements(db: D1Like, p: Parsed, nowIso: string): D1PreparedStatementLike[] {
  // ?9 (updatedAt) / ?7 (statusChangedAt) / ?10 (publishedAt) may be NULL when upstream
  // omitted them. Then the row's first-seen time (?11) is used on insert, and on update
  // the old value is kept unless the content or status changed (then "now"): a missing
  // upstream timestamp must not turn into a fresh now() on every run.
  const upsert = db
    .prepare(
      `INSERT INTO servers (name, version, is_latest, server_json, server_json_sha256, status,
         status_changed_at, status_message, published_at, updated_at, first_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, ?9, ?11), ?8, COALESCE(?10, ?9, ?11),
         COALESCE(?9, ?11), ?11)
       ON CONFLICT (name, version) DO UPDATE SET
         is_latest = excluded.is_latest,
         server_json = excluded.server_json,
         server_json_sha256 = excluded.server_json_sha256,
         status = excluded.status,
         status_changed_at = COALESCE(?7, CASE WHEN servers.status <> excluded.status
                                               THEN ?11 ELSE servers.status_changed_at END),
         status_message = excluded.status_message,
         published_at = COALESCE(?10, servers.published_at),
         updated_at = COALESCE(?9, CASE WHEN servers.server_json_sha256 <> excluded.server_json_sha256
                                         OR servers.status <> excluded.status
                                        THEN ?11 ELSE servers.updated_at END)
       WHERE ?9 IS NULL OR excluded.updated_at >= servers.updated_at`,
    )
    .bind(
      p.name,
      p.version,
      p.isLatest ? 1 : 0,
      p.serverJson,
      p.sha256,
      p.status,
      p.statusChangedAt,
      p.statusMessage,
      p.updatedAt,
      p.publishedAt,
      nowIso,
    );
  const out = [upsert];
  if (p.isLatest) {
    // At most one latest per name; only demote others if this row really is the latest now.
    out.push(
      db
        .prepare(
          `UPDATE servers SET is_latest = 0
           WHERE name = ?1 AND version <> ?2 AND is_latest = 1
             AND EXISTS (SELECT 1 FROM servers WHERE name = ?1 AND version = ?2 AND is_latest = 1)`,
        )
        .bind(p.name, p.version),
    );
  }
  return out;
}

/**
 * After a page: a deleted row never stays "latest", and a name left without any live
 * latest gets the newest live version (active preferred over deprecated) flagged.
 */
function latestFixups(db: D1Like, name: string): D1PreparedStatementLike[] {
  return [
    db
      .prepare(
        `UPDATE servers SET is_latest = 0 WHERE name = ? AND status = 'deleted' AND is_latest = 1`,
      )
      .bind(name),
    db
      .prepare(
        `UPDATE servers SET is_latest = 1
         WHERE name = ?1
           AND version = (SELECT version FROM servers WHERE name = ?1 AND status <> 'deleted'
                          ORDER BY (status = 'active') DESC, published_at DESC, version DESC LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM servers WHERE name = ?1 AND is_latest = 1
                           AND status <> 'deleted')`,
      )
      .bind(name),
  ];
}

// ------------------------------------------------------------------ sync_state

async function loadState(db: D1Like): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM sync_state')
    .all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

async function getState(db: D1Like, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM sync_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

function setStateStatement(db: D1Like, key: string, value: string): D1PreparedStatementLike {
  return db
    .prepare(
      'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, value);
}

async function setState(db: D1Like, key: string, value: string): Promise<void> {
  await setStateStatement(db, key, value).run();
}

async function beginRun(db: D1Like, startedAt: string, since: string | null): Promise<void> {
  await db.batch([
    setStateStatement(db, 'run_started_at', startedAt),
    since
      ? setStateStatement(db, 'run_since', since)
      : db.prepare(`DELETE FROM sync_state WHERE key = 'run_since'`),
  ]);
}

async function clearRun(db: D1Like): Promise<void> {
  await db
    .prepare(`DELETE FROM sync_state WHERE key IN ('run_started_at', 'run_since', 'run_cursor')`)
    .run();
}
