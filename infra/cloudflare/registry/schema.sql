-- KepCup MCP sub-registry (design 29 §11.4 / §15.2). Cloudflare D1 (SQLite).
-- Apply with: npx wrangler d1 execute kepcup-registry --remote --file=./schema.sql
-- Idempotent for a FRESH database. Existing databases created from an earlier revision
-- need the migration in README.md ("Migrating an existing database").

-- One row per (server name, version): the official server.json as TEXT plus the
-- registry-managed lifecycle fields mirrored from the upstream registry.
CREATE TABLE IF NOT EXISTS servers (
  name              TEXT    NOT NULL,
  version           TEXT    NOT NULL,
  is_latest         INTEGER NOT NULL DEFAULT 0 CHECK (is_latest IN (0, 1)),
  server_json       TEXT    NOT NULL,
  -- sha256(server_json) computed at sync time; a review is only honoured while it
  -- still matches (re-synced changed content drops the tier until re-approved).
  server_json_sha256 TEXT   NOT NULL CHECK (length(server_json_sha256) = 64),
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'deleted')),
  status_changed_at TEXT    NOT NULL,
  status_message    TEXT,
  published_at      TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  -- When this registry first saw the row: stands in for timestamps upstream omitted.
  first_seen_at     TEXT    NOT NULL,
  PRIMARY KEY (name, version)
);

-- Deliberately NO secondary indexes: the primary key (name, version) serves the keyset
-- pagination, the versions list and the reviews join as index SEARCHes (asserted by a
-- test). The catalogue is thousands of rows, so the occasional updated_since /
-- search / version=latest filter is a cheap scan, and `updated_since` filters on
-- max(servers.updated_at, reviews.reviewed_at), which no single-column index could
-- serve anyway. Add one only with an EXPLAIN QUERY PLAN that proves a win.

-- KepCup review results. Written ONLY through reviews.ts (submitReview / revokeReview,
-- exposed to the developer portal as a narrow RPC) - NEVER by the upstream sync.
-- Only review_status = 'approved' AND a matching server_json_sha256 is exposed.
CREATE TABLE IF NOT EXISTS reviews (
  name               TEXT NOT NULL,
  version            TEXT NOT NULL,
  tier               TEXT NOT NULL CHECK (tier IN ('verified', 'community')),
  review_status      TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
  -- Required on EVERY status change (revocation included) so the change bumps the
  -- entry's effective updated_at and shows up in `updated_since` pulls. ISO-8601 with
  -- milliseconds, UTC: lexicographic order == chronological order.
  reviewed_at        TEXT NOT NULL CHECK (
    reviewed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  notes              TEXT,
  tool_contract_hash TEXT,
  -- sha256 of servers.server_json at approval time (hex, 64 chars); required to approve.
  server_json_sha256 TEXT CHECK (server_json_sha256 IS NULL OR length(server_json_sha256) = 64),
  PRIMARY KEY (name, version),
  CHECK (review_status <> 'approved' OR (reviewed_at IS NOT NULL AND server_json_sha256 IS NOT NULL))
);

-- Sync bookkeeping: watermark, in-progress run cursor, skip counters, last error.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
