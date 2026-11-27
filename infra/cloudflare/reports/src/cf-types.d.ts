/**
 * Minimal Cloudflare Workers ambient types, declared locally so the Worker can be
 * type-checked without installing @cloudflare/workers-types (offline build).
 * Mirrors infra/cloudflare/registry/src/cf-types.d.ts. The real package can replace
 * this file: add `"types": ["@cloudflare/workers-types"]` to tsconfig.json and delete it.
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** Cron trigger payload (`triggers.crons` in wrangler.jsonc). */
interface ScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry?(): void;
}

/** The shape of this module's default export (`export default { fetch, scheduled }`). */
interface ExportedHandler<E = unknown> {
  fetch?(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(event: ScheduledEvent, env: E, ctx: ExecutionContext): void | Promise<void>;
}
