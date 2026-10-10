/**
 * Worker entry: `fetch` serves the read-only registry API, `scheduled` runs the
 * upstream sync (cron trigger in wrangler.jsonc).
 */

import { handleRequest } from './worker';
import { DEFAULT_UPSTREAM, runSync } from './sync';
import type { Env } from './types';

export async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return handleRequest(request, {
    db: env.DB,
    cache: caches.default,
    waitUntil: (p) => ctx.waitUntil(p),
    buildInfo: { version: env.BUILD_VERSION, commit: env.BUILD_COMMIT, time: env.BUILD_TIME },
  });
}

export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const parsed = Number.parseInt(env.SYNC_MAX_PAGES ?? '', 10);
  const maxPages = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined;
  ctx.waitUntil(
    runSync({
      db: env.DB,
      upstream: env.UPSTREAM_REGISTRY_URL ?? DEFAULT_UPSTREAM,
      ...(maxPages ? { maxPages } : {}),
    }).then((r) => {
      if (!r.ok) console.error('registry sync failed', r.error);
    }),
  );
}

export { getServerForReview, revokeReview, submitReview } from './reviews';
export default { fetch, scheduled };
