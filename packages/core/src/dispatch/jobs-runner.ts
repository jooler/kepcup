import type { Orchestrator } from '../dispatch/orchestrator.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { JobRow, JobsService } from '../domain/jobs.js';
import type { SettingsService } from '../domain/settings.js';
import { runConversationSummaryJob } from '../agent/loops/conversation-summary.js';
import type { AgentEngine } from '../agent/types.js';
import type { LlmPurpose, LlmRouter } from '../agent/llm-router.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { UsageService } from '../domain/usage.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import { runReflectionJob } from '../memory/reflection.js';
import { runProfileCurationJob } from '../memory/profile-curation.js';
import { runConsolidationJob } from '../memory/consolidation.js';
import { runVecRebuildJob } from '../memory/vec-rebuild.js';
import type { MemoryService } from '../memory/service.js';
import type { BudgetService } from '../usage/budget.js';
import { runSkillAuthoringJob } from '../skills/authoring.js';
import type { SkillsService } from '../skills/registry.js';
import { runWikiIngestJob } from '../wiki/ingest.js';
import { runWikiLintJob } from '../wiki/lint.js';
import type { WikiService } from '../wiki/service.js';
import type { ScheduleService } from '../schedule/service.js';
import type { WatchService } from '../watch/service.js';
import type { ToolGateway } from '../gateway/index.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { AppPaths } from '../infra/paths.js';
import { JOB_RETENTION_MS } from '@kepcup/shared';

const POLL_INTERVAL_MS = 500;

import { DeferredJobError } from '../memory/vec-rebuild.js';

/** Re-purges terminal jobs once a day while the runner is up (BR-P10-008). */
const JOB_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface JobsRunnerDeps {
  engine: AgentEngine;
  /**
   * D72 P6 后台路由：无内置模型时后台 loop 改走外部 Agent。缺省 = 只用内置
   * 模型（无内置模型的 loop 照旧跳过）。
   */
  router?: LlmRouter | undefined;
  scheduler: Scheduler;
  jobs: JobsService;
  settings: SettingsService;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  usage: UsageService;
  runs: RunsService;
  /** Secret redaction for background-loop run steps (BR-P09-001). */
  secrets: SecretsService;
  orchestrator: Orchestrator;
  logger: CoreLogger;
  memory: MemoryService;
  /** P07 per-bot daily background budget (0 = unlimited). */
  budget: BudgetService;
  /** P08 skills domain (skill_authoring / skill_suggestion consumers). */
  skills?: SkillsService | undefined;
  /** P09 wiki domain (wiki_ingest / wiki_lint / wiki_suggestion consumers). */
  wiki?: WikiService | undefined;
  /** P10 schedule domain (schedule_fire consumer). */
  schedules?: ScheduleService | undefined;
  /** W7 watch domain (watch_alert consumer). */
  watches?: WatchService | undefined;
  /** Sandbox backend for the skill generation loop (P08). */
  sandbox?: SandboxBackend | undefined;
  paths?: AppPaths | undefined;
  /** Core event bus (P08: message.created for authoring notifications). */
  publish?: ((event: string, payload: unknown) => void) | undefined;
  /** Gateway (P09 wiki file sources: copy only within the accessible range). */
  gateway?: ToolGateway | undefined;
  /** Attachments (P09 wiki attachment sources). */
  attachments?: AttachmentsService | undefined;
  clock: Clock;
  timeZone?: string | undefined;
}

/**
 * Persistent background job queue: claims pending jobs and runs them through
 * the scheduler at background priority. `running` jobs found at startup are
 * reset by JobsService on boot; a job failing three times is marked failed.
 *
 * P08: `skill_suggestion` (reflection output) and `skill_authoring`
 * (create_skill) both drive the skill generation loop. P09: `wiki_suggestion`
 * registers a `wiki_ingest` job; `wiki_ingest` / `wiki_lint` run the wiki
 * maintenance loop (serialized per bot through the wiki service mutex).
 * Bot-scoped jobs defer to the next local day once the bot's daily background
 * budget is exhausted.
 */
export class JobsRunner {
  readonly #deps: JobsRunnerDeps;
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;
  readonly #inFlight = new Set<string>();
  #lastPurgeAt = 0;

  constructor(deps: JobsRunnerDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#purgeOldTerminalJobs();
    const tick = () => {
      if (this.#stopped) return;
      if (this.#deps.clock.now() - this.#lastPurgeAt >= JOB_PURGE_INTERVAL_MS) {
        this.#purgeOldTerminalJobs();
      }
      this.#claimAndRun();
      this.#timer = setTimeout(tick, POLL_INTERVAL_MS);
      this.#timer.unref?.();
    };
    tick();
  }

  /**
   * Terminal jobs (done / failed / cancelled) older than JOB_RETENTION_MS are
   * deleted — every schedule fire and guard retry leaves a terminal row, so
   * the table would grow without bound (BR-P10-008). Pending and running rows
   * are never touched, so parked deliveries and deferred work survive.
   */
  #purgeOldTerminalJobs(): void {
    this.#lastPurgeAt = this.#deps.clock.now();
    try {
      const deleted = this.#deps.jobs.purgeTerminalOlderThan(this.#lastPurgeAt - JOB_RETENTION_MS);
      if (deleted > 0) this.#deps.logger.info({ deleted }, 'purged terminal jobs past retention');
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'terminal jobs purge failed',
      );
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #claimAndRun(): void {
    // One claim per tick keeps the loop responsive to shutdown.
    const job = this.#deps.jobs.claimNext(JOBS_LEFT_PENDING);
    if (!job || this.#inFlight.has(job.id)) return;
    // 每日预算超出后当天推迟该 Bot 的后台任务（任务 12）。schedule_fire /
    // event_delivery are priority-1 response triggers, not background loops,
    // so they are exempt.
    // A job routed to an external agent is charged to (and gated by) its
    // owning bot where determinable — a direct chat's summary (审查 C5).
    const provider = this.#providerFor(job);
    const budgetBotId = provider.startsWith('agent:') ? this.#routeBotId(job) : job.bot_id;
    if (
      !RESPONSE_TRIGGER_JOBS.has(job.type) &&
      this.#deps.budget !== undefined &&
      budgetBotId !== null &&
      this.#deps.budget.exceeded(budgetBotId)
    ) {
      this.#deps.jobs.defer(job.id, this.#deps.budget.nextDayStart());
      this.#deps.logger.info({ botId: budgetBotId, jobId: job.id }, 'job deferred: daily budget');
      return;
    }
    this.#inFlight.add(job.id);
    this.#deps.scheduler.submit({
      // Response triggers (schedule_fire / event_delivery) submit at priority
      // 1, matching their run-layer priority (orchestrator) — the global
      // background-loop cap (BACKGROUND_LOOP_CONCURRENCY) must not gate a
      // due schedule behind long background loops (BR-P10-004).
      priority: RESPONSE_TRIGGER_JOBS.has(job.type) ? 1 : 2,
      provider,
      key: `job:${job.id}`,
      run: async () => {
        try {
          await this.#runJob(job);
          this.#deps.jobs.complete(job.id);
        } catch (error) {
          if (error instanceof DeferredJobError) {
            this.#deps.jobs.defer(job.id, this.#deps.clock.now() + 60_000);
          } else {
            this.#deps.logger.warn(
              { jobId: job.id, type: job.type, botId: job.bot_id, err: error },
              'job failed',
            );
            this.#deps.jobs.fail(job.id, error instanceof Error ? error.message : String(error));
          }
        } finally {
          this.#inFlight.delete(job.id);
        }
      },
    });
  }

  async #runJob(job: JobRow): Promise<void> {
    switch (job.type) {
      case 'conversation_summary':
        await runConversationSummaryJob({ ...this.#deps, job });
        return;
      case 'reflection':
        await runReflectionJob({ ...this.#deps, job });
        return;
      case 'profile_curation':
        await runProfileCurationJob({ ...this.#deps, job });
        return;
      case 'memory_consolidation':
        await runConsolidationJob({
          ...this.#deps,
          job,
          timeZone: this.#deps.timeZone ?? 'UTC',
        });
        return;
      case 'memory_vec_rebuild':
        await runVecRebuildJob({
          memory: this.#deps.memory,
          jobs: this.#deps.jobs,
          logger: this.#deps.logger,
          clock: this.#deps.clock,
        });
        return;
      case 'skill_authoring':
      case 'skill_suggestion':
        // P08: both task sources run the same generation loop (the reflection
        // already checked the repeat threshold for skill_suggestion).
        if (this.#deps.skills === undefined || this.#deps.sandbox === undefined || this.#deps.paths === undefined) {
          throw new Error('skills domain not wired; cannot run skill authoring');
        }
        await runSkillAuthoringJob({
          engine: this.#deps.engine,
          router: this.#deps.router,
          sandbox: this.#deps.sandbox,
          paths: this.#deps.paths,
          settings: this.#deps.settings,
          bots: this.#deps.bots,
          conversations: this.#deps.conversations,
          publish: (event, payload) => {
            if (this.#deps.publish !== undefined) this.#deps.publish(event, payload);
          },
          jobs: this.#deps.jobs,
          runs: this.#deps.runs,
          secrets: this.#deps.secrets,
          usage: this.#deps.usage,
          skills: this.#deps.skills,
          logger: this.#deps.logger,
          job,
        });
        return;
      case 'wiki_suggestion': {
        // P09 consumes the P07 reflection suggestion: validate the source,
        // then register the actual ingest job (dedupe collapses repeats).
        if (job.bot_id === null) return;
        const wiki = this.#requireWiki();
        const payload = JSON.parse(job.payload_json) as {
          sourceType?: string;
          ref?: string;
          note?: string;
        };
        const rawType = payload.sourceType;
        const sourceType = rawType === 'workspace_file' ? 'file' : rawType;
        if (sourceType !== 'attachment' && sourceType !== 'url' && sourceType !== 'file') {
          this.#deps.logger.info(
            { botId: job.bot_id, sourceType: rawType },
            'wiki suggestion dropped (unknown source type)',
          );
          return;
        }
        const outcome = wiki.enqueueIngest({
          botId: job.bot_id,
          conversationId: job.conversation_id,
          source: {
            sourceType,
            ref: payload.ref ?? '',
            note: payload.note ?? '',
          },
        });
        if (!outcome.ok) {
          this.#deps.logger.info(
            { botId: job.bot_id, ref: payload.ref, reason: outcome.message },
            'wiki suggestion dropped (unusable source)',
          );
        }
        return;
      }
      case 'wiki_ingest':
        if (this.#deps.wiki === undefined || this.#deps.sandbox === undefined || this.#deps.paths === undefined ||
            this.#deps.gateway === undefined || this.#deps.attachments === undefined) {
          throw new Error('wiki domain not wired; cannot run wiki ingest');
        }
        await runWikiIngestJob({
          engine: this.#deps.engine,
          router: this.#deps.router,
          sandbox: this.#deps.sandbox,
          paths: this.#deps.paths,
          settings: this.#deps.settings,
          bots: this.#deps.bots,
          conversations: this.#deps.conversations,
          messages: this.#deps.messages,
          attachments: this.#deps.attachments,
          jobs: this.#deps.jobs,
          runs: this.#deps.runs,
          secrets: this.#deps.secrets,
          usage: this.#deps.usage,
          gateway: this.#deps.gateway,
          memory: this.#deps.memory,
          wiki: this.#deps.wiki,
          orchestrator: this.#deps.orchestrator,
          publish: (event, payload) => {
            if (this.#deps.publish !== undefined) this.#deps.publish(event, payload);
          },
          logger: this.#deps.logger,
          clock: this.#deps.clock,
          job,
        });
        return;
      case 'wiki_lint':
        if (this.#deps.wiki === undefined || this.#deps.sandbox === undefined || this.#deps.paths === undefined ||
            this.#deps.gateway === undefined) {
          throw new Error('wiki domain not wired; cannot run wiki lint');
        }
        await runWikiLintJob({
          engine: this.#deps.engine,
          router: this.#deps.router,
          sandbox: this.#deps.sandbox,
          paths: this.#deps.paths,
          settings: this.#deps.settings,
          bots: this.#deps.bots,
          runs: this.#deps.runs,
          secrets: this.#deps.secrets,
          usage: this.#deps.usage,
          gateway: this.#deps.gateway,
          memory: this.#deps.memory,
          wiki: this.#deps.wiki,
          jobs: this.#deps.jobs,
          publish: (event, payload) => {
            if (this.#deps.publish !== undefined) this.#deps.publish(event, payload);
          },
          logger: this.#deps.logger,
          clock: this.#deps.clock,
          job,
        });
        return;
      case 'schedule_fire':
        // P10: the timer/catch-up enqueued this occurrence; the guard checks,
        // mailbox delivery and row bookkeeping live in the schedule service.
        if (this.#deps.schedules === undefined) {
          throw new Error('schedule domain not wired; cannot run schedule_fire');
        }
        await this.#deps.schedules.runFireJob(job);
        return;
      case 'watch_alert':
        // W7: the edge was committed with this job (dedupe watch:{id}:{seq}:{hash});
        // the alert card + the bot's wake are posted here, idempotently.
        if (this.#deps.watches === undefined) {
          throw new Error('watch domain not wired; cannot run watch_alert');
        }
        this.#deps.watches.runAlertJob(job);
        return;
      case 'event_delivery':
        // P10 (BR-P10-006): an event response trigger parked for quiet hours —
        // persistent across restarts; re-checks happen in the orchestrator.
        this.#deps.orchestrator.deliverParkedEvent(job);
        return;
      case 'delegation_delivery':
        // D71：跨 Bot 委派在 B 的免打扰时段内排队，到点重新过投递闸门。
        this.#deps.orchestrator.deliverParkedDelegation(job);
        return;
      default:
        // Loop types from later phases are registered by then; unknown types
        // fail so they are visible instead of looping forever.
        throw new Error(`No handler for job type "${job.type}"`);
    }
  }

  #requireWiki(): WikiService {
    if (this.#deps.wiki === undefined) {
      throw new Error('wiki domain not wired; cannot run wiki suggestion');
    }
    return this.#deps.wiki;
  }

  /**
   * Scheduler concurrency key of a job: `agent:{id}` only when the D72 P6
   * router sends its model calls to an external agent; built-in routes keep
   * the pre-P6 key (the app light / main model's provider) exactly (审查 C4).
   */
  #providerFor(job: JobRow): string {
    const purpose = JOB_PURPOSES[job.type];
    const router = this.#deps.router;
    if (purpose !== undefined && router !== undefined) {
      const route = router.resolveForBot(this.#routeBotId(job), purpose);
      if (route !== null && route.agentId !== null) return route.provider;
    }
    const settings = this.#deps.settings.get();
    const ref = settings.defaultLightModel || settings.defaultMainModel;
    const index = ref.indexOf('/');
    return index > 0 ? ref.slice(0, index) : 'unknown';
  }

  /** The bot a job's loop routes for (a direct chat's summary: its bot, as the loop does). */
  #routeBotId(job: JobRow): string | null {
    if (job.bot_id !== null) return job.bot_id;
    if (job.type === 'conversation_summary' && job.conversation_id !== null) {
      return this.#deps.conversations.get(job.conversation_id)?.directBotId ?? null;
    }
    return null;
  }
}

/** Background job type → the router purpose of its model calls (D72 P6). */
const JOB_PURPOSES: Readonly<Record<string, LlmPurpose>> = {
  conversation_summary: 'summary',
  reflection: 'reflection',
  profile_curation: 'profile_curation',
  memory_consolidation: 'consolidation',
  skill_authoring: 'skill_authoring',
  skill_suggestion: 'skill_authoring',
  wiki_ingest: 'wiki_maintenance',
  wiki_lint: 'wiki_maintenance',
};

/**
 * Response-trigger jobs (schedule_fire / event_delivery / D71 delegation_delivery):
 * priority 1 like their run-layer triggers and exempt from the daily background
 * budget — they are not background loops.
 */
const RESPONSE_TRIGGER_JOBS: ReadonlySet<string> = new Set([
  'schedule_fire',
  'event_delivery',
  'delegation_delivery',
  'watch_alert',
]);

/** Job types that stay pending forever (none since P09 consumed wiki_suggestion). */
const JOBS_LEFT_PENDING: readonly string[] = [];
