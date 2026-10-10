/**
 * Minimal Cloudflare Workers ambient types, declared locally so the Worker can be
 * type-checked without installing @cloudflare/workers-types (offline build).
 * The real package can replace this file: add `"types": ["@cloudflare/workers-types"]`
 * to tsconfig.json and delete it.
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry?(): void;
}

/** `caches.default` is the Workers-only default cache (absent from the DOM lib). */
interface CacheStorage {
  readonly default: Cache;
}
