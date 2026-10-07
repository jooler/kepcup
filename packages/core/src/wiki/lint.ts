import { AppError } from '@kepcup/shared';

import type { JobsService, JobRow } from '../domain/jobs.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { Clock } from '../infra/clock.js';
import { initWiki } from './init.js';
import { runWikiMaintenance, type WikiMaintenanceDeps } from './maintenance.js';

export interface WikiLintJobDeps extends WikiMaintenanceDeps {
  sandbox: SandboxBackend;
  jobs: JobsService;
  /** Core event bus (BR-P09-012: lint completions drive the UI refresh). */
  publish: (event: string, payload: unknown) => void;
  clock: Clock;
  job: JobRow;
}

/**
 * Wiki lint job (任务 4): the maintenance loop in lint mode — contradictions,
 * outdated content, orphan pages, missing references (raw files gone),
 * personal information. Fixable problems are fixed directly in the pages, the
 * rest is appended to log.md; one commit closes the job. Weekly schedule.
 */
export async function runWikiLintJob(deps: WikiLintJobDeps): Promise<void> {
  const { job } = deps;
  if (job.bot_id === null) {
    throw new AppError('INVALID_INPUT', 'wiki lint requires a bot');
  }
  const botId = job.bot_id;
  const bot = deps.bots.get(botId);
  if (bot === null || bot.status !== 'active') return; // deleted mid-queue
  // D72 P4：没有内置模型（只用外部 Agent）时跳过本周巡检，不产生失败 run。
  if ((bot.profile.runtime.model || deps.settings.get().defaultMainModel).length === 0) {
    deps.logger.info({ botId }, 'wiki lint skipped: no built-in model');
    return;
  }

  await deps.wiki.runExclusively(botId, async () => {
    initWiki(deps.paths, botId, deps.logger);
    const maintenance = await runWikiMaintenance(deps, {
      kind: 'lint',
      input: {
        botId,
        conversationId: job.conversation_id,
      },
    });
    // BR-P09-012: lint changes pages too — the open Wiki tab must refresh
    // (the renderer listens for `wiki_changed`; ingest publishes the same).
    deps.publish('wiki_changed', { botId });
    deps.logger.info(
      { botId, jobId: job.id, changed: maintenance.changedPages.length },
      'wiki lint job finished',
    );
  });
}
