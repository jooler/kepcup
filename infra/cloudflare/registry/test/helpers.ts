/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies / schema nodes are untyped in tests */
/**
 * Test helpers: an in-memory SQLite D1Like adapter (node:sqlite, no native deps),
 * a Map-backed Cache API stand-in, fixtures, and a tiny JSON-schema validator that
 * understands exactly the keywords used by the OpenAPI subset.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { CacheLike, D1Like, D1PreparedStatementLike, D1ResultLike } from '../src/types';
import { handleRequest, type HandlerDeps } from '../src/worker';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// ------------------------------------------------------------------ D1 adapter

export class SqliteStatement implements D1PreparedStatementLike {
  constructor(
    readonly db: DatabaseSync,
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
    readonly onExec?: (sql: string) => void,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    const params = values.map((v) => (v === undefined ? null : v) as SQLInputValue);
    // Real D1 rejects LIKE/GLOB patterns over 50 bytes; emulate so a regression is a test failure.
    if (/\b(LIKE|GLOB)\b/i.test(this.sql)) {
      for (const p of params) {
        if (typeof p === 'string' && new TextEncoder().encode(p).length > 50) {
          throw new Error('LIKE or GLOB pattern too complex');
        }
      }
    }
    return new SqliteStatement(this.db, this.sql, params, this.onExec);
  }

  async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
    this.onExec?.(this.sql);
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows.map((r) => ({ ...r })), success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    this.onExec?.(this.sql);
    const row = this.db.prepare(this.sql).get(...this.params) as T | undefined;
    return row ? { ...row } : null;
  }

  async run(): Promise<D1ResultLike<never>> {
    this.onExec?.(this.sql);
    const info = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }
}

export class SqliteD1 implements D1Like {
  readonly db: DatabaseSync;
  /** Every executed SQL statement (used to assert cache hits avoid the database). */
  readonly executed: string[] = [];

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(`${HERE}../schema.sql`, 'utf8'));
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(this.db, sql, [], (s) => this.executed.push(s));
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
    const out: unknown[] = [];
    this.db.exec('BEGIN');
    try {
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return out;
  }

  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
}

// ------------------------------------------------------------------ cache

export class MapCache implements CacheLike {
  readonly store = new Map<string, Response>();
  matches = 0;
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    const hit = this.store.get(request.url);
    if (hit) this.matches++;
    return hit?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts++;
    this.store.set(request.url, response.clone());
  }
}

// ------------------------------------------------------------------ fixtures

export const BASE = 'https://registry.test';
export const SCHEMA_URI =
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

export interface SeedOptions {
  name: string;
  version?: string;
  title?: string;
  description?: string;
  isLatest?: boolean;
  status?: 'active' | 'deprecated' | 'deleted';
  updatedAt?: string;
  publishedAt?: string;
  statusMessage?: string;
  extra?: Record<string, unknown>;
}

export function serverJson(opts: SeedOptions): Record<string, unknown> {
  return {
    $schema: SCHEMA_URI,
    name: opts.name,
    description: opts.description ?? `Description of ${opts.name}`,
    ...(opts.title === undefined ? {} : { title: opts.title }),
    version: opts.version ?? '1.0.0',
    remotes: [
      { type: 'streamable-http', url: `https://mcp.example.com/${opts.name.split('/')[1]}` },
    ],
    ...opts.extra,
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function seed(d1: SqliteD1, opts: SeedOptions): void {
  const version = opts.version ?? '1.0.0';
  const updatedAt = opts.updatedAt ?? '2026-10-01T00:00:00.000Z';
  const json = JSON.stringify(serverJson({ ...opts, version }));
  d1.db
    .prepare(
      `INSERT INTO servers (name, version, is_latest, server_json, server_json_sha256, status,
         status_changed_at, status_message, published_at, updated_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.name,
      version,
      opts.isLatest === false ? 0 : 1,
      json,
      sha256(json),
      opts.status ?? 'active',
      updatedAt,
      opts.statusMessage ?? null,
      opts.publishedAt ?? updatedAt,
      updatedAt,
      updatedAt,
    );
}

export function review(
  d1: SqliteD1,
  r: {
    name: string;
    version?: string;
    tier?: 'verified' | 'community';
    status?: 'pending' | 'approved' | 'rejected';
    reviewedAt?: string;
    notes?: string | null;
    hash?: string | null;
    /** Defaults to the CURRENT sha256 of the stored server_json (a fresh approval). */
    sha?: string | null;
  },
): void {
  const version = r.version ?? '1.0.0';
  const current = d1.db
    .prepare('SELECT server_json_sha256 AS sha FROM servers WHERE name = ? AND version = ?')
    .get(r.name, version) as { sha: string } | undefined;
  d1.db
    .prepare(
      `INSERT OR REPLACE INTO reviews (name, version, tier, review_status, reviewed_at, notes,
         tool_contract_hash, server_json_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.name,
      version,
      r.tier ?? 'community',
      r.status ?? 'approved',
      r.reviewedAt ?? '2026-10-05T00:00:00.000Z',
      r.notes ?? null,
      r.hash === undefined ? 'sha256:abc' : r.hash,
      r.sha === undefined ? (current?.sha ?? null) : r.sha,
    );
}

// ------------------------------------------------------------------ request helper

export async function get(
  path: string,
  deps: HandlerDeps,
  init: RequestInit = {},
): Promise<{ res: Response; body: any }> {
  const res = await handleRequest(new Request(`${BASE}${path}`, init), deps);
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : undefined };
}

// ------------------------------------------------------------------ JSON-schema subset

export interface OpenApiSubset {
  paths: Record<string, Record<string, { parameters?: any[]; responses: Record<string, any> }>>;
  components: { schemas: Record<string, any> };
}

export function loadSubset(): OpenApiSubset {
  return JSON.parse(readFileSync(`${HERE}openapi-v0.1.subset.json`, 'utf8')) as OpenApiSubset;
}

/**
 * Validates `value` against `schema`; returns the list of violations (empty = valid).
 * Supports: $ref (#/components/schemas/*), type (string | string[]), enum, pattern,
 * min/maxLength, minimum/maximum, format date-time|uri, properties, required,
 * additionalProperties (false | schema), items. Pure annotations are ignored; ANY other
 * keyword (oneOf, allOf, const, minItems, ...) throws so a schema can never pass vacuously.
 */
/** Keywords the validator implements. */
const SUPPORTED = new Set([
  '$ref',
  'type',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'format',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);
/** Pure annotations: no effect on validity. */
const ANNOTATIONS = new Set(['description', 'examples', 'default', 'title', '$comment', 'example']);
const SUPPORTED_FORMATS = new Set(['date-time', 'uri', 'int64']);

/** Statically walks a schema tree and throws on any keyword `validate` would not enforce. */
export function assertSupportedKeywords(node: any, at = '#'): void {
  if (!isObject(node) || Array.isArray(node)) return;
  const schema: any = node;
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`unsupported JSON-schema keyword "${keyword}" at ${at}`);
    }
  }
  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    throw new Error(`unsupported format "${schema.format}" at ${at}`);
  }
  for (const [key, child] of Object.entries<any>(schema.properties ?? {})) {
    assertSupportedKeywords(child, `${at}.properties.${key}`);
  }
  assertSupportedKeywords(schema.items, `${at}.items`);
  assertSupportedKeywords(schema.additionalProperties, `${at}.additionalProperties`);
}

export function validate(subset: OpenApiSubset, schema: any, value: unknown, at = '$'): string[] {
  // An unsupported keyword would make a schema pass vacuously: refuse loudly instead.
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`validate(): unsupported JSON-schema keyword "${keyword}" at ${at}`);
    }
  }
  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    throw new Error(`validate(): unsupported format "${schema.format}" at ${at}`);
  }
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/components/schemas/', '');
    const target = subset.components.schemas[name];
    if (!target) return [`${at}: unresolved $ref ${schema.$ref}`];
    return validate(subset, target, value, at);
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      return [`${at}: expected ${types.join('|')}, got ${describe(value)}`];
    }
  }
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${at}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern`);
    if (
      schema.format === 'date-time' &&
      !/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/.test(value)
    ) {
      errors.push(`${at}: date-time`);
    }
    if (schema.format === 'uri' && !URL.canParse(value)) errors.push(`${at}: uri`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: < minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: > maximum`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(subset, schema.items, item, `${at}[${i}]`)));
  }
  if (isObject(value) && !Array.isArray(value)) {
    const props: Record<string, any> = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(subset, props[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${at}: unexpected property "${key}"`);
      else if (isObject(schema.additionalProperties)) {
        errors.push(...validate(subset, schema.additionalProperties, v, `${at}.${key}`));
      }
    }
  }
  return errors;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v) && !Array.isArray(v);
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return false;
  }
}

function describe(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
