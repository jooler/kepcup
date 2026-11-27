/**
 * Shared types for the KepCup AI content-reporting Worker (Store 11.16,
 * todo/ai-content-reporting.md §7). The Worker is written against these minimal
 * structural interfaces rather than the Cloudflare ambient types so tests can
 * swap in an in-memory SQLite adapter (D1Like, node:sqlite).
 */

export interface D1ResultLike<T> {
  results: T[];
  success?: boolean;
  meta?: { changes?: number };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1ResultLike<never>>;
}

/** The subset of Cloudflare's `D1Database` this Worker uses. */
export interface D1Like {
  prepare(query: string): D1PreparedStatementLike;
  /** Runs the statements atomically (D1: one implicit transaction). */
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

// ------------------------------------------------------------------ env / config

export interface Env {
  DB: D1Like;
  /** Admin API bearer (random 32-byte hex). Unset => every /v1/admin path is 404. */
  REPORT_ADMIN_TOKEN?: string;
  /** HMAC salt for hashing CF-Connecting-IP. Unset => IP rate limiting is skipped (deploy MUST set it). */
  IP_HASH_SALT?: string;
  REPORT_RATE_LIMIT_MS?: string;
  REPORT_IP_LIMIT?: string;
  REPORT_IP_WINDOW_MS?: string;
  REPORT_CONTENT_DEDUPE_MS?: string;
  REPORT_PAYLOAD_DEDUPE_MS?: string;
  REPORT_RETENTION_DAYS?: string;
  /** PoW HMAC key (random 32-byte hex). Unset => PoW is not enforced (deploy MUST set it). */
  REPORT_POW_SECRET?: string;
  /** Leading zero bits required of the solution; 0 disables the challenge (escape hatch). */
  REPORT_POW_DIFFICULTY?: string;
  /** Challenge TTL in ms (default 10 min). */
  REPORT_POW_TTL_MS?: string;
  /** Global per-UTC-day accept cap (default 2000); 429 + Retry-After until next UTC midnight. */
  REPORT_DAILY_LIMIT?: string;
  /** Reported by GET /healthz. */
  BUILD_VERSION?: string;
}

/** Parsed, defaulted view of the env vars (see parseConfig in worker.ts). */
export interface WorkerConfig {
  rateLimitMs: number;
  ipLimit: number;
  ipWindowMs: number;
  contentDedupeMs: number;
  payloadDedupeMs: number;
  retentionDays: number;
  adminToken?: string;
  ipHashSalt?: string;
  /** PoW enforced only when difficulty > 0 AND the secret is configured. */
  powEnabled: boolean;
  powSecret?: string;
  powDifficulty: number;
  powTtlMs: number;
  dailyLimit: number;
  buildVersion: string;
}

// ------------------------------------------------------------------ payload
//
// Hand-written mirror of packages/shared/src/domain/report.ts (reportPayloadSchema,
// §5.1). The Worker deliberately does NOT import @kepcup/shared: it is an independent
// deployment unit with no workspace dependencies. The two definitions are kept in sync
// manually and pinned together by the fixed vectors in
// packages/shared/test/fixtures/report-v1.json (asserted in test/dedupe.test.ts and
// test/contract.test.ts). Any shape change is a schema-version bump on both sides.

export interface ReportClient {
  id: string;
  surface: string;
  appVersion: string;
  platform: string;
  arch: string;
  osVersion: string;
  locale: string;
}

export type ReportSource = { kind: 'local' } | { kind: 'team'; serverHash: string };

export interface ReportBotRuntime {
  model: string;
  lightModel: string;
  backgroundModel: string;
  agent: { id: string; model: string; effort: string };
}

export interface ReportBot {
  id: string;
  name: string;
  systemRole: string | null;
  runtime: ReportBotRuntime;
  /** Trimmed profile JSON (≤8KB by core truncation); shape is core-owned. */
  profile?: unknown;
}

export interface ReportAttachment {
  fileName: string;
  mime: string;
  size: number;
}

export interface ReportMessage {
  id: string;
  seq: number | null;
  kind: 'text' | 'card';
  status: string;
  createdAt: number;
  editedAt: number | null;
  runId: string | null;
  text: string;
  content: unknown;
  truncated: boolean;
  attachments: ReportAttachment[];
}

export interface ReportReplyTo {
  messageId: string;
  text: string;
}

export interface ReportContextItem {
  messageId: string;
  senderType: string;
  kind: string;
  text: string;
  createdAt: number;
}

export interface ReportUsageItem {
  provider: string;
  model: string;
  loopType: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReportToolItem {
  name: string;
  calls: number;
}

export interface ReportProviderItem {
  id: string;
  name: string;
  vendor: string;
  api: string;
}

export interface ReportHashes {
  content: string;
  payload: string;
}

/**
 * Transport-only sibling field for the PoW protocol (task 5A): present on the
 * POST body, NEVER part of the payload hash — dedupePayload strips it alongside
 * reportId/createdAt/hashes, and the shared reportPayloadSchema deliberately does
 * not know about it.
 */
export interface ReportProof {
  challenge: string;
  solution: string;
}

export interface ReportPayload {
  schemaVersion: number;
  reportId: string;
  createdAt: number;
  reason: string;
  client: ReportClient;
  source: ReportSource;
  conversation: { id: string; type: string };
  bot: ReportBot;
  message: ReportMessage;
  replyTo: ReportReplyTo | null;
  context: ReportContextItem[];
  usage: ReportUsageItem[];
  tools: ReportToolItem[];
  providers: ReportProviderItem[];
  hashes: ReportHashes;
  /** PoW proof (transport-only); stripped before the payload hash. */
  proof?: ReportProof;
}

// ------------------------------------------------------------------ rows

/** `reports` row as stored; only the fields the Worker reads are typed. */
export interface ReportRow {
  id: string;
  client_id: string;
  content_hash: string;
  content_bucket: number;
  payload_hash: string;
  payload_bucket: number;
  status: string;
  bot_id: string | null;
  bot_name: string | null;
  model_provider: string | null;
  model_id: string | null;
  message_kind: string;
  message_text: string;
  app_version: string | null;
  platform: string | null;
  source_kind: string;
  received_at: number;
  ip_hash: string | null;
  payload_json: string;
  note: string | null;
  updated_at: number | null;
}

export interface ClientRateRow {
  client_id: string;
  last_at: number;
}

export interface IpRateRow {
  ip_hash: string;
  window_start: number;
  count: number;
}

/** `report_pow_used` row: one consumed challenge (single-use PoW, task 5A). */
export interface PowUsedRow {
  challenge_id: string;
  report_id: string;
  used_at: number;
}

/** `report_daily` row: per-UTC-day accept counter (global daily cap). */
export interface DailyRow {
  day: string;
  count: number;
}
