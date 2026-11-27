/**
 * Worker entry (mirrors infra/cloudflare/registry/src/index.ts): `fetch` serves the
 * reporting + admin API, `scheduled` runs the daily retention cleanup (cron trigger
 * `23 4 * * *` in wrangler.jsonc).
 */

import { runCleanup } from './db';
import type { Env } from './types';
import { handleRequest, parseConfig } from './worker';

export async function fetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return handleRequest(request, { db: env.DB, config: parseConfig(env), now: Date.now });
}

export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const config = parseConfig(env);
  ctx.waitUntil(
    runCleanup(env.DB, config, Date.now())
      .then((counts) => {
        // Route-shaped log only (§8): never any content, ids or IPs.
        console.log(
          JSON.stringify({ path: '/cron/cleanup', method: 'CRON', status: 'ok' }),
        );
        if (
          counts.reports +
            counts.clientRate +
            counts.ipRate +
            counts.powUsed +
            counts.daily ===
          0
        ) {
          return;
        }
        console.error(
          `reports cleanup removed ${counts.reports} reports, ` +
            `${counts.clientRate} rate rows, ${counts.ipRate} ip rows, ` +
            `${counts.powUsed} pow rows, ${counts.daily} daily rows`,
        );
      })
      .catch((error: unknown) => {
        console.error('reports cleanup failed', error instanceof Error ? error.message : 'unknown');
      }),
  );
}

export default { fetch, scheduled } satisfies ExportedHandler<Env>;
