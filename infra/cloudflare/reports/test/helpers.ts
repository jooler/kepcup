/**
 * Test helpers: an in-memory SQLite D1Like adapter (node:sqlite, no native deps),
 * request constructors, the shared report fixture loader, and a pinned server clock.
 * Mirrors infra/cloudflare/registry/test/helpers.ts; no wrangler / miniflare / network.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { computeContentHash, computePayloadHash } from '../src/dedupe';
import { handleRequest, type HandlerDeps } from '../src/worker';
import type {
  D1Like,
  D1PreparedStatementLike,
  ReportPayload,
  WorkerConfig,
} from '../src/types';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// ------------------------------------------------------------------ D1 adapter

export class SqliteStatement implements D1PreparedStatementLike {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const params = values.map((v) => (v === undefined ? null : v) as SQLInputValue);
    return new SqliteStatement(this.db, this.sql, params);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows.map((r) => ({ ...r })), success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as T | undefined;
    return row ? { ...row } : null;
  }

  async run(): Promise<{ results: never[]; success: boolean; meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }
}

export class SqliteD1 implements D1Like {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(`${HERE}../schema.sql`, 'utf8'));
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  /** Atomically runs the statements (D1: one implicit transaction). */
  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Direct row access for assertions (bypasses the D1Like surface). */
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
}

// ------------------------------------------------------------------ fixture
//
// fixture 所有权在 packages/shared（契约 1A 落地处）；这里只读复用，禁止另存副本。

export const FIXTURE_URL = new URL(
  '../../../../packages/shared/test/fixtures/report-v1.json',
  import.meta.url,
);

export function loadFixture(): ReportPayload {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as ReportPayload;
}

/** Deep clone via JSON (fixtures are plain JSON) so tests can mutate freely. */
export function cloneFixture(): ReportPayload {
  return JSON.parse(JSON.stringify(loadFixture())) as ReportPayload;
}

/** Recomputes both hashes over the (possibly mutated) payload — the client-side finalize. */
export async function finalize(payload: ReportPayload): Promise<ReportPayload> {
  const clone = JSON.parse(JSON.stringify(payload)) as ReportPayload;
  clone.hashes = {
    content: await computeContentHash(clone.message),
    payload: await computePayloadHash(clone),
  };
  return clone;
}

let variantCounter = 0;

/** A fresh, valid-to-finalize payload: new reportId, tweaked text (=> new content hash). */
export function makeVariant(
  base: ReportPayload,
  opts: { clientId?: string; reportId?: string; keepText?: boolean } = {},
): ReportPayload {
  variantCounter += 1;
  const clone = JSON.parse(JSON.stringify(base)) as ReportPayload;
  clone.reportId = opts.reportId ?? `rep_TESTVAR${String(variantCounter).padStart(14, '0')}`;
  clone.createdAt = (clone.createdAt ?? 0) + variantCounter;
  if (opts.keepText !== true) {
    clone.message.text = `${clone.message.text}（变体 ${variantCounter}）`;
  }
  if (opts.clientId !== undefined) clone.client.id = opts.clientId;
  return clone;
}

// ------------------------------------------------------------------ deps + clock

export const BASE = 'https://reports.test';
/** 固定服务端时钟；advance() 推进它来模拟时间桶 / 限流窗口翻转。 */
export const NOW = 1_764_220_000_000;

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    rateLimitMs: 60_000,
    ipLimit: 100,
    ipWindowMs: 3_600_000,
    contentDedupeMs: 86_400_000,
    payloadDedupeMs: 7_776_000_000,
    retentionDays: 365,
    buildVersion: 'test-1.0.0',
    ...overrides,
  };
}

export interface TestRig {
  d1: SqliteD1;
  deps: HandlerDeps;
  /** Current pinned server time (readable in assertions). */
  now(): number;
  /** Advances the pinned server clock by `ms`. */
  advance(ms: number): void;
}

export function makeDeps(
  opts: { config?: Partial<WorkerConfig>; now?: number } = {},
): TestRig {
  const d1 = new SqliteD1();
  const config = testConfig(opts.config ?? {});
  let current = opts.now ?? NOW;
  const deps: HandlerDeps = {
    db: d1,
    config,
    now: () => current,
  };
  return {
    d1,
    deps,
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

// ------------------------------------------------------------------ request helpers

export interface Res {
  res: Response;
  body: unknown;
}

async function toRes(res: Response): Promise<Res> {
  const text = await res.text();
  return { res, body: text ? (JSON.parse(text) as unknown) : undefined };
}

/** POST a JSON body (object or pre-serialized string) to the Worker. */
export async function post(
  deps: HandlerDeps,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await handleRequest(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps,
  );
  return toRes(res);
}

export async function get(
  deps: HandlerDeps,
  path: string,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await handleRequest(new Request(`${BASE}${path}`, { headers }), deps);
  return toRes(res);
}

export async function send(
  deps: HandlerDeps,
  path: string,
  init: RequestInit,
): Promise<Res> {
  const res = await handleRequest(new Request(`${BASE}${path}`, init), deps);
  return toRes(res);
}

/** POST a (finalized) report payload; pass `ip` to emulate CF-Connecting-IP. */
export async function postReport(
  deps: HandlerDeps,
  payload: ReportPayload,
  opts: { ip?: string } = {},
): Promise<Res> {
  return post(deps, '/v1/reports', payload, opts.ip ? { 'cf-connecting-ip': opts.ip } : {});
}

/** Admin bearer headers; call without args for "no Authorization header". */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ------------------------------------------------------------------ direct seeding
//
// admin / cron 测试直接插行，避免为凑数据状态走完整 POST 管线。

export interface SeedReport {
  id: string;
  clientId: string;
  receivedAt: number;
  status?: string;
  botName?: string | null;
  messageText?: string;
  payloadJson?: string;
}

export function seedReport(d1: SqliteD1, spec: SeedReport): void {
  d1.db
    .prepare(
      `INSERT INTO reports (
         id, client_id, content_hash, content_bucket, payload_hash, payload_bucket,
         status, bot_id, bot_name, model_provider, model_id, message_kind, message_text,
         app_version, platform, source_kind, received_at, ip_hash, payload_json, note, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot_x', ?, 'openai', 'gpt-5.1', 'text', ?,
                 '0.6.2', 'win32', 'local', ?, NULL, ?, NULL, NULL)`,
    )
    .run(
      spec.id,
      spec.clientId,
      `c${spec.id}`,
      0,
      `p${spec.id}`,
      0,
      spec.status ?? 'new',
      spec.botName ?? '小助手',
      spec.messageText ?? `message of ${spec.id}`,
      spec.receivedAt,
      spec.payloadJson ?? `{"id":"${spec.id}"}`,
    );
}

export function seedRate(d1: SqliteD1, clientId: string, lastAt: number): void {
  d1.db
    .prepare('INSERT INTO report_rate (client_id, last_at) VALUES (?, ?)')
    .run(clientId, lastAt);
}

export function seedIpRate(d1: SqliteD1, ipHash: string, windowStart: number, count = 1): void {
  d1.db
    .prepare('INSERT INTO report_ip_rate (ip_hash, window_start, count) VALUES (?, ?, ?)')
    .run(ipHash, windowStart, count);
}
