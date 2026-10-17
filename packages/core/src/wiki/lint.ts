import { AppError, wikiOwnerSchema, type WikiOwner } from '@kepcup/shared';

import type { JobsService, JobRow } from '../domain/jobs.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { Clock } from '../infra/clock.js';
import { initWiki } from './init.js';
import { runWikiMaintenance, type WikiMaintenanceDeps } from './maintenance.js';
import { routeFor } from '../agent/llm-router.js';

export interface WikiLintJobDeps extends WikiMaintenanceDeps {
  sandbox: SandboxBackend;
  jobs: JobsService;
  /** Core event bus (BR-P09-012: lint completions drive the UI refresh). */
  publish: (event: string, payload: unknown) => void;
  clock: Clock;
  job: JobRow;
}

/**
 * Wiki lint job (任务 4; owner-generalized in D92 T1b WP9): the maintenance
 * loop in lint mode — contradictions, outdated content, orphan pages, missing
 * references (raw files gone), personal information; for a project wiki also
 * dangling `raw/_assets` citations and pages without any source. Fixable
 * problems are fixed directly in the pages, the rest is appended to log.md;
 * one commit closes the job. Weekly schedule; the project wiki's lint runs as
 * its lead bot (executor-pays).
 */
export async function runWikiLintJob(deps: WikiLintJobDeps): Promise<void> {
  const { job } = deps;
  if (job.bot_id === null) {
    throw new AppError('INVALID_INPUT', 'wiki lint requires a bot');
  }
  const botId = job.bot_id; // the executor (project lead for a project wiki)
  const bot = deps.bots.get(botId);
  if (bot === null || bot.status !== 'active') return; // deleted mid-queue

  const raw = JSON.parse(job.payload_json) as { owner?: unknown; trigger?: unknown };
  const owner = wikiOwnerSchema.safeParse(raw.owner);
  if (!owner.success) {
    throw new AppError('INVALID_INPUT', 'wiki lint payload 缺少有效的 owner');
  }
  const wikiOwner: WikiOwner = owner.data;

  // D72 P4 / P6：没有内置模型时改走后台 Agent；也没有（或已关闭）时跳过本周
  // 巡检，不产生失败 run。
  if (routeFor(deps, 'wiki_maintenance', botId) === null) {
    deps.logger.info({ botId }, 'wiki lint skipped: no model for background calls');
    return;
  }

  await deps.wiki.runExclusively(wikiOwner, async () => {
    initWiki(deps.paths, wikiOwner, deps.logger);
    const maintenance = await runWikiMaintenance(deps, {
      kind: 'lint',
      input: {
        owner: wikiOwner,
        botId,
        conversationId: job.conversation_id,
      },
    });
    // BR-P09-012: lint changes pages too — the open Wiki tab must refresh
    // (the renderer listens for `wiki_changed`; ingest publishes the same).
    deps.publish('wiki_changed', { owner: wikiOwner });
    deps.logger.info(
      {
        owner: `${wikiOwner.kind}:${wikiOwner.id}`,
        botId,
        jobId: job.id,
        trigger: raw.trigger ?? 'weekly',
        changed: maintenance.changedPages.length,
      },
      'wiki lint job finished',
    );
  });
}
