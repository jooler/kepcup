/**
 * Shared types for the KepCup MCP sub-registry Worker (design 29 §11.4 / §15.2).
 *
 * The Worker is written against these minimal structural interfaces rather than
 * the Cloudflare ambient types so that tests can swap in an in-memory SQLite
 * adapter (D1Like) and a Map-backed cache (CacheLike).
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

/** The subset of the Workers Cache API used for GET read-through. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  DB: D1Like;
  /** Base URL of the upstream registry; default https://registry.modelcontextprotocol.io */
  UPSTREAM_REGISTRY_URL?: string;
  /** Max upstream pages per cron run (default 8, fits the Workers Free subrequest limit). */
  SYNC_MAX_PAGES?: string;
  /** Reported by GET /v0.1/version. */
  BUILD_VERSION?: string;
  BUILD_COMMIT?: string;
  BUILD_TIME?: string;
}

export type ServerStatus = 'active' | 'deprecated' | 'deleted';
export type ReviewTier = 'verified' | 'community';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** server.json as stored; only the fields this Worker reads are typed. */
export interface ServerJson {
  name: string;
  version: string;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RegistryExtensions {
  status: ServerStatus;
  statusChangedAt: string;
  statusMessage?: string;
  publishedAt: string;
  updatedAt: string;
  isLatest: boolean;
}

export interface ServerResponse {
  server: ServerJson;
  _meta: Record<string, unknown>;
}

export interface ServerListResponse {
  servers: ServerResponse[];
  metadata: { nextCursor?: string; count: number };
}

export const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
export const PUBLISHER_META_KEY = 'io.modelcontextprotocol.registry/publisher-provided';
export const CONNECTOR_META_KEY = 'app.kepcup/connector';
export const REVIEW_META_KEY = 'app.kepcup/review';
