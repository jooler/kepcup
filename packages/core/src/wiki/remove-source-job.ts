import { AppError, wikiOwnerSchema, type WikiOwner } from '@kepcup/shared';

import type { JobRow } from '../domain/jobs.js';
import type { CoreLogger } from '../infra/logger.js';
import type { WikiActorRole, WikiService } from './service.js';

export interface WikiRemoveSourceJobDeps {
  wiki: WikiService;
  logger: CoreLogger;
  job: JobRow;
}

interface RemoveSourcePayload {
  owner: WikiOwner;
  sourceId: string;
  actor: { role: WikiActorRole; botId?: string };
}

function parsePayload(payloadJson: string): RemoveSourcePayload {
  const raw = JSON.parse(payloadJson) as {
    owner?: unknown;
    sourceId?: unknown;
    actor?: { role?: unknown; botId?: unknown } | undefined;
  };
  const owner = wikiOwnerSchema.safeParse(raw.owner);
  if (!owner.success) {
    throw new AppError('INVALID_INPUT', 'wiki_remove_source payload 缺少有效的 owner');
  }
  if (typeof raw.sourceId !== 'string' || raw.sourceId.length === 0) {
    throw new AppError('INVALID_INPUT', 'wiki_remove_source payload 缺少有效的 sourceId');
  }
  const role = raw.actor?.role;
  if (role !== 'user' && role !== 'lead' && role !== 'member') {
    throw new AppError('INVALID_INPUT', 'wiki_remove_source payload 缺少有效的 actor');
  }
  const botId = raw.actor?.botId;
  return {
    owner: owner.data,
    sourceId: raw.sourceId,
    actor: { role, ...(typeof botId === 'string' && botId.length > 0 ? { botId } : {}) },
  };
}

/**
 * AppError codes that never heal on retry (D92 T1b WP10): an ACL rejection or
 * a missing source stays that way — retrying three times would only delay the
 * terminal failure and spam the log.
 */
const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_INPUT', // the ACL rejection (no FORBIDDEN code exists, WP9 choice)
  'NOT_FOUND',
  'NOT_SUPPORTED',
]);

/**
 * Executes one queued `wiki_remove_source` (D92 T1b WP10): the deletion itself
 * runs in {@link WikiService.removeSource} under the project wiki's maintenance
 * mutex — the job exists only so tools / RPC never block on that lock. Calls no
 * model; the job row's `bot_id` (the project lead) is attribution only.
 */
export async function runWikiRemoveSourceJob(deps: WikiRemoveSourceJobDeps): Promise<void> {
  const payload = parsePayload(deps.job.payload_json);
  try {
    await deps.wiki.removeSource({
      owner: payload.owner,
      sourceId: payload.sourceId,
      actor: payload.actor,
    });
  } catch (error) {
    if (error instanceof AppError && TERMINAL_ERROR_CODES.has(error.code)) {
      // Settled without effect: the source vanished or the actor's rights
      // changed between enqueue and execution. Log and finish as done.
      deps.logger.info(
        {
          jobId: deps.job.id,
          owner: `${payload.owner.kind}:${payload.owner.id}`,
          sourceId: payload.sourceId,
          code: error.code,
          reason: error.message,
        },
        'wiki source removal settled without effect (no retry)',
      );
      return;
    }
    throw error;
  }
  deps.logger.info(
    { jobId: deps.job.id, owner: `${payload.owner.kind}:${payload.owner.id}`, sourceId: payload.sourceId },
    'wiki source removed by queued job',
  );
}
