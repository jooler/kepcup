import { AppError } from '@kepcup/shared';
import type { JobsService } from '../domain/jobs.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { MemoryService } from './service.js';

export interface VecRebuildJobDeps {
  memory: MemoryService;
  jobs: JobsService;
  logger: CoreLogger;
  clock: Clock;
}

/** Sentinel: the runner defers the job instead of consuming an attempt. */
export class DeferredJobError extends Error {}

/**
 * memory_vec_rebuild: recompute every bot's memory_vec after the embedding
 * source/model changed (docs/dev/phases/P07-memory.md 任务 2). While the
 * embedder is not ready the job throws DeferredJobError — the runner pushes
 * it one minute ahead without consuming attempts.
 */
export async function runVecRebuildJob(deps: VecRebuildJobDeps): Promise<void> {
  try {
    const result = await deps.memory.rebuildAllVectors();
    deps.logger.info({ ...result }, 'memory_vec rebuilt');
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROVIDER_UNAVAILABLE') {
      deps.logger.warn('memory_vec rebuild deferred (embedder not ready)');
      throw new DeferredJobError('embedding not ready');
    }
    throw error;
  }
}
