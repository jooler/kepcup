import { AppError, type Schedule, type ScheduleEntry, type BotProfile } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import { realTimerScheduler, type Clock, type TimerScheduler } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { localDayStart, nextLocalMidnight } from '../memory/local-date.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { MemoryService } from '../memory/service.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';
import { SchedulesStore } from './store.js';
import { nextCronFireAt, isValidCron } from './cron.js';
import {
  evaluateGuard,
  guardReasonText,
  isLateEnough,
  type GuardVerdict,
} from './guard.js';

export interface ScheduleServiceDeps {
  /** main.db (schedules table). */
  db: SqliteDatabase;
  /** runs.db (daily-cap counting over scheduled response runs). */
  runsDb: SqliteDatabase;
  clock: Clock;
  /** Injectable timer arming; tests drive it virtually. */
  timers?: TimerScheduler | undefined;
  logger: CoreLogger;
  timeZone: string;
  bots: BotsService;
  conversations: ConversationsService;
  jobs: JobsService;
  runs: RunsService;
  /** Commitment lookups (content + status) and item re-checks before firing. */
  memory: MemoryService;
  /** Mailbox delivery of the trigger message (reason='scheduled'). */
  orchestrator: Orchestrator;
}

export interface CreateOnceInput {
  botId: string;
  conversationId: string;
  runAt: number;
  note: string;
  commitmentId?: string | null;
  /** Commitment linkage may create overdue tasks (they fire with late_by). */
  allowPast?: boolean;
}

export interface CreateCronInput {
  botId: string;
  conversationId: string;
  expression: string;
  timezone?: string | undefined;
  note: string;
  commitmentId?: string | null;
}

const NOTE_MAX_CHARS = 500;

/**
 * Node clamps `setTimeout` delays above 2^31-1 ms down to 1 ms — an unclamped
 * far-future schedule (e.g. a yearly cron) would hot-loop: fire, find nothing
 * due, re-arm, fire again. Capping the delay makes the timer re-arm in large
 * steps until the occurrence is actually due (触发后重新计算 semantics).
 */
const TIMER_MAX_DELAY_MS = 2 ** 31 - 1 - 60_000;

/**
 * After a failed tick (BR-P10-003: a store read or jobs write threw) the
 * failing rows keep their due `next_fire_at`, so an immediate re-arm would
 * hot-loop at delay 0 if the failure persists. The next tick runs after this
 * backoff instead; successful ticks reset it.
 */
export const TICK_ERROR_RETRY_MS = 60_000;

/**
 * Proactive messaging domain (P10): owns the schedules table, the single
 * timer pointing at the nearest `next_fire_at`, the `schedule_fire` jobs, the
 * guardrails, missed-fire catch-up and the commitment linkage.
 *
 * Firing goes through the persistent job queue (`schedule_fire`, dedupe key
 * `schedule_fire:{id}:{fireAt}`) so an enqueue is never lost across a crash:
 * either the job survives and fires on boot, or the row still shows the
 * pending occurrence and startup catch-up picks it up.
 */
export class ScheduleService {
  readonly store: SchedulesStore;
  readonly #deps: ScheduleServiceDeps;
  readonly #timers: TimerScheduler;
  #timerCancel: (() => void) | null = null;
  #started = false;
  /** Set when a tick threw (BR-P10-003): the next re-arm backs off. */
  #tickFailed = false;

  constructor(deps: ScheduleServiceDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimerScheduler;
    this.store = new SchedulesStore(deps.db, deps.clock);
  }

  // --- lifecycle -------------------------------------------------------------

  /** Loads active schedules and arms the single timer (startup). */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#reload();
  }

  stop(): void {
    this.#started = false;
    this.#timerCancel?.();
    this.#timerCancel = null;
  }

  /** Test hook: disarms the timer without ending the service (simulates sleep). */
  disarmTimerForTest(): void {
    this.#timerCancel?.();
    this.#timerCancel = null;
  }

  /** Re-arms the single timer at the nearest next_fire_at (触发后重新计算). */
  #reload(): void {
    this.#timerCancel?.();
    this.#timerCancel = null;
    if (!this.#started) return;
    let next: ReturnType<SchedulesStore['earliestActive']>;
    try {
      next = this.store.earliestActive();
    } catch (error) {
      // Even a failing store read must not kill the timer chain (BR-P10-003):
      // retry after the backoff instead of never arming again.
      this.#deps.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'schedule timer reload failed; retrying after backoff',
      );
      this.#arm(TICK_ERROR_RETRY_MS);
      return;
    }
    if (next === null || next.nextFireAt === null) return;
    const delay = Math.min(Math.max(0, next.nextFireAt - this.#deps.clock.now()), TIMER_MAX_DELAY_MS);
    this.#arm(delay);
  }

  #arm(delay: number): void {
    // A failed tick backs off (the failing rows keep their due fire time, so
    // the naive delay would be 0 and a persistent failure would hot-loop).
    const effective = this.#tickFailed ? Math.max(delay, TICK_ERROR_RETRY_MS) : delay;
    this.#timerCancel = this.#timers.setTimer(effective, () => {
      this.#timerCancel = null;
      try {
        this.#onDue();
        this.#tickFailed = false;
      } catch (error) {
        // One failed pass (store read / jobs enqueue) must not stop the
        // service forever: log, back off and re-arm below (BR-P10-003).
        this.#tickFailed = true;
        this.#deps.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'schedule tick failed; retrying after backoff',
        );
      } finally {
        this.#reload();
      }
    });
  }

  // --- creation ---------------------------------------------------------------

  /** `schedule` tool / commitment linkage: one-shot task at an absolute time. */
  createOnce(input: CreateOnceInput): Schedule {
    this.#assertFireable(input.botId, input.conversationId);
    const note = this.#cleanNote(input.note);
    if (!input.allowPast && input.runAt <= this.#deps.clock.now()) {
      throw new AppError('INVALID_INPUT', '时间在过去，无法创建定时任务');
    }
    const row = this.store.insert({
      botId: input.botId,
      conversationId: input.conversationId,
      kind: 'once',
      runAt: input.runAt,
      timezone: this.#deps.timeZone,
      note,
      ...(input.commitmentId !== undefined && input.commitmentId !== null
        ? { commitmentId: input.commitmentId }
        : {}),
      nextFireAt: input.runAt,
    });
    this.#reload();
    return row;
  }

  /** `schedule` tool: recurring task on a cron expression in a time zone. */
  createCron(input: CreateCronInput): Schedule {
    this.#assertFireable(input.botId, input.conversationId);
    const expression = input.expression.trim();
    if (!isValidCron(expression)) {
      throw new AppError('INVALID_INPUT', `无法识别的 cron 表达式：${expression}`);
    }
    const timezone = input.timezone?.trim() || this.#deps.timeZone;
    if (!isValidTimeZone(timezone)) {
      throw new AppError('INVALID_INPUT', `无法识别的时区：${timezone}`);
    }
    const note = this.#cleanNote(input.note);
    const next = nextCronFireAt(expression, timezone, this.#deps.clock.now());
    if (next === null) {
      throw new AppError('INVALID_INPUT', `无法计算 cron 表达式的下次触发时间：${expression}`);
    }
    const row = this.store.insert({
      botId: input.botId,
      conversationId: input.conversationId,
      kind: 'cron',
      cron: expression,
      timezone,
      note,
      ...(input.commitmentId !== undefined && input.commitmentId !== null
        ? { commitmentId: input.commitmentId }
        : {}),
      nextFireAt: next,
    });
    this.#reload();
    return row;
  }

  #assertFireable(botId: string, conversationId: string): void {
    const bot = this.#deps.bots.get(botId);
    if (!bot || bot.status !== 'active') {
      throw new AppError('NOT_FOUND', 'Bot 不存在或已删除');
    }
    const conversation = this.#deps.conversations.get(conversationId);
    if (!conversation || conversation.readOnly) {
      throw new AppError('NOT_FOUND', '对话不存在或已删除');
    }
    if (!this.#deps.conversations.memberBotIds(conversationId).includes(botId)) {
      throw new AppError('INVALID_INPUT', 'Bot 不在该对话中');
    }
  }

  #cleanNote(note: string): string {
    const cleaned = note.trim();
    if (cleaned.length === 0) throw new AppError('INVALID_INPUT', '定时任务说明不能为空');
    return cleaned.slice(0, NOTE_MAX_CHARS);
  }

  // --- firing -----------------------------------------------------------------

  /** Enqueues `schedule_fire` jobs for every due occurrence, then re-arms. */
  #onDue(): number {
    const now = this.#deps.clock.now();
    let enqueued = 0;
    for (const row of this.store.due(now)) {
      const fireAt = row.nextFireAt;
      if (fireAt === null) continue;
      this.#enqueueFireJob(row, fireAt);
      enqueued += 1;
      // Advance the row in the same synchronous step as the enqueue: the job
      // (persisted) and the row (advanced) together leave no fire window.
      if (row.kind === 'cron') {
        this.store.update(row.id, {
          nextFireAt: nextCronFireAt(row.cron ?? '', row.timezone, now),
        });
      } else {
        this.store.update(row.id, { nextFireAt: null });
      }
    }
    this.#reload();
    return enqueued;
  }

  #enqueueFireJob(row: Schedule, fireAt: number): void {
    this.#deps.jobs.enqueue({
      type: 'schedule_fire',
      botId: row.botId,
      conversationId: row.conversationId,
      payload: { scheduleId: row.id, fireAt },
      priority: 2,
      dedupeKey: `schedule_fire:${row.id}:${fireAt}`,
      runAfter: Math.min(fireAt, this.#deps.clock.now()),
    });
  }

  /** jobs-runner `schedule_fire` branch. */
  async runFireJob(job: JobRow): Promise<void> {
    const payload = JSON.parse(job.payload_json) as { scheduleId?: unknown; fireAt?: unknown };
    if (typeof payload.scheduleId !== 'string' || typeof payload.fireAt !== 'number') {
      this.#deps.logger.warn({ jobId: job.id }, 'schedule_fire job with malformed payload');
      return;
    }
    const row = this.store.get(payload.scheduleId);
    if (row === null || row.status !== 'active') return;
    this.#fire(row, payload.fireAt);
  }

  #fire(row: Schedule, fireAt: number): void {
    try {
      const bot = this.#deps.bots.get(row.botId);
      const conversation = this.#deps.conversations.get(row.conversationId);
      const isMember =
        conversation !== null &&
        this.#deps.conversations.memberBotIds(row.conversationId).includes(row.botId);
      if (
        bot === null ||
        bot.status !== 'active' ||
        conversation === null ||
        conversation.readOnly ||
        !isMember
      ) {
        // The target is gone for good (deleted bot / removed from group /
        // deleted conversation): the task can never fire again.
        this.store.update(row.id, { status: 'cancelled' });
        this.#reload();
        return;
      }

      // 承诺作废/撤回后任务取消（任务 6；事件之外的双查兜底）。
      if (row.commitmentId !== null) {
        const commitment = this.#deps.memory.getItemFor(row.botId, row.commitmentId);
        if (commitment === null || commitment.status !== 'active') {
          this.store.update(row.id, { status: 'cancelled' });
          this.#reload();
          return;
        }
      }

      const now = this.#deps.clock.now();
      const verdict = evaluateGuard({
        behavior: bot.profile.behavior,
        now,
        timeZone: this.#deps.timeZone,
        sentToday: this.sentProactiveCount(row.botId, now),
        isEvent: false,
      });
      if (verdict.kind === 'defer') {
        const retryAt = Math.max(verdict.retryAt, now + 1);
        this.store.update(row.id, { nextFireAt: retryAt });
        this.#reload();
        this.#deps.logger.info(
          { scheduleId: row.id, reason: verdict.reason, retryAt },
          'schedule fire deferred by guardrails',
        );
        return;
      }

      const lateByMs = now - fireAt;
      const commitmentContent =
        row.commitmentId !== null
          ? (this.#deps.memory.getItemFor(row.botId, row.commitmentId)?.content ?? null)
          : null;
      const text =
        row.commitmentId !== null
          ? `承诺到期：${commitmentContent ?? row.note}`
          : `定时任务触发：${row.note}`;
      this.#deps.orchestrator.deliverScheduleToBot({
        botId: row.botId,
        conversationId: row.conversationId,
        scheduleId: row.id,
        text,
        lateByMs: isLateEnough(lateByMs) ? lateByMs : null,
      });
      this.store.update(row.id, { lastFiredAt: now });
      if (row.kind === 'once') {
        this.store.update(row.id, { status: 'done', nextFireAt: null });
      } else {
        this.store.update(row.id, {
          nextFireAt: nextCronFireAt(row.cron ?? '', row.timezone, now),
        });
      }
      this.#reload();
    } catch (error) {
      // A fire that throws repeatedly would leave an invisible zombie row
      // (once tasks sit with next_fire_at = null); cancel it visibly instead.
      this.#deps.logger.error(
        { scheduleId: row.id, error: error instanceof Error ? error.message : String(error) },
        'schedule fire failed; cancelling task',
      );
      this.store.update(row.id, { status: 'cancelled', nextFireAt: null });
      this.#reload();
    }
  }

  /**
   * Startup + power.resume (docs/dev/phases/P10-proactive.md 范围): fires the
   * jobs missed while the app was closed or asleep. Cron tasks that missed
   * several occurrences fire once and resume from the first occurrence after
   * now. Returns the number of catch-up jobs enqueued.
   */
  catchUpMissed(): number {
    return this.#onDue();
  }

  /**
   * Proactive executions of this bot that sent a message today (local day),
   * plus scheduled runs of today that are still in flight. The in-flight part
   * reserves a slot at fire time — the run row is created synchronously by the
   * delivery, long before its output exists — so same-instant fires cannot all
   * slip past the cap (BR-P10-005). The reservation dissolves when the run
   * settles without output (skip_reply and failed runs never count, P10 任务 5).
   */
  sentProactiveCount(botId: string, now: number): number {
    const timeZone = this.#deps.timeZone;
    const dayStart = localDayStart(now, timeZone);
    const dayEnd = nextLocalMidnight(now, timeZone);
    const row = this.#deps.runsDb
      .prepare(
        `select count(*) as n from runs
         where bot_id = ? and trigger_reason = 'scheduled'
           and created_at >= ? and created_at < ?
           and (output_message_ids_json is not null and output_message_ids_json != '[]'
                or status in ('queued', 'running', 'waiting_approval', 'waiting_lease'))`,
      )
      .get(botId, dayStart, dayEnd) as { n: number };
    return row.n;
  }

  // --- commitment linkage (docs/design/04-memory.md, P10 任务 6) ---------------

  /** Event-bus subscriber: a commitment with a due date creates a one-shot task. */
  onCommitmentCreated(input: {
    botId: string;
    conversationId: string | null;
    item: { id: string; kind: string; dueAt: number | null; content: string };
  }): Schedule | null {
    if (input.item.kind !== 'commitment' || input.item.dueAt === null) return null;
    if (input.conversationId === null) return null;
    const conversation = this.#deps.conversations.get(input.conversationId);
    if (!conversation || conversation.readOnly) return null;
    if (!this.#deps.conversations.memberBotIds(input.conversationId).includes(input.botId)) {
      return null;
    }
    try {
      return this.createOnce({
        botId: input.botId,
        conversationId: input.conversationId,
        runAt: input.item.dueAt,
        note: input.item.content,
        commitmentId: input.item.id,
        allowPast: true,
      });
    } catch (error) {
      this.#deps.logger.warn(
        { botId: input.botId, item: input.item.id, error: error instanceof Error ? error.message : String(error) },
        'commitment schedule creation failed',
      );
      return null;
    }
  }

  /** Event-bus subscriber: void / retracted commitments cancel their tasks. */
  onCommitmentInvalidated(botId: string, commitmentId: string): number {
    const cancelled = this.store.cancelByCommitment(botId, commitmentId);
    if (cancelled > 0) {
      this.#deps.logger.info({ botId, commitmentId, cancelled }, 'commitment schedules cancelled');
      this.#reload();
    }
    return cancelled;
  }

  // --- lifecycle (03-data-model.md 删除级联) -----------------------------------

  /** 删除对话：任务删除。 */
  deleteForConversation(conversationId: string): number {
    const deleted = this.store.deleteForConversation(conversationId);
    if (deleted > 0) this.#reload();
    return deleted;
  }

  /** 删除 Bot：任务删除（schedule_fire jobs 已由 jobs.cancelByBot 取消）。 */
  prepareBotDeletion(botId: string): number {
    const deleted = this.store.deleteForBot(botId);
    if (deleted > 0) this.#reload();
    return deleted;
  }

  /** 移出群：该 Bot 在此群的任务取消。 */
  cancelForBotInConversation(botId: string, conversationId: string): number {
    const cancelled = this.store.cancelForBotInConversation(botId, conversationId);
    if (cancelled > 0) this.#reload();
    return cancelled;
  }

  // --- queries & RPC -----------------------------------------------------------

  cancel(id: string): Schedule {
    const row = this.store.get(id);
    if (row === null) throw new AppError('NOT_FOUND', `定时任务 ${id} 不存在`);
    if (row.status !== 'active') throw new AppError('INVALID_INPUT', '该任务已结束，无法取消');
    const updated = this.store.update(id, { status: 'cancelled', nextFireAt: null });
    this.#reload();
    return updated ?? row;
  }

  /** cancel_schedule tool: a bot may only cancel its own tasks. */
  cancelOwn(botId: string, scheduleId: string): { ok: boolean; message: string } {
    const row = this.store.get(scheduleId);
    if (row === null || row.botId !== botId) {
      return { ok: false, message: '定时任务不存在，或不是你创建的任务' };
    }
    if (row.status !== 'active') return { ok: false, message: '该任务已结束' };
    this.store.update(scheduleId, { status: 'cancelled', nextFireAt: null });
    this.#reload();
    return { ok: true, message: '已取消该定时任务' };
  }

  listEntries(conversationId?: string | undefined): ScheduleEntry[] {
    const rows =
      conversationId !== undefined
        ? this.store.listActiveForConversation(conversationId)
        : this.store.listActive();
    const now = this.#deps.clock.now();
    return rows.map((row) => {
      const bot = this.#deps.bots.get(row.botId);
      return {
        ...row,
        botName: bot?.profile.identity.name ?? bot?.name ?? null,
        deferredReason: this.#deferredReason(row, bot?.profile ?? null, now),
      };
    });
  }

  /** list_schedules tool: the bot's own active tasks in one conversation. */
  listForBotInConversation(botId: string, conversationId: string): Schedule[] {
    return this.store.listActiveForBotInConversation(botId, conversationId);
  }

  /** Live guard verdict for an active task that cannot fire right now. */
  #deferredReason(row: Schedule, profile: BotProfile | null, now: number): string | null {
    if (row.status !== 'active' || profile === null) return null;
    const verdict = this.#verdictFor(profile, row.botId, now);
    return verdict.kind === 'defer' ? guardReasonText(verdict.reason) : null;
  }

  #verdictFor(profile: BotProfile, botId: string, now: number): GuardVerdict {
    return evaluateGuard({
      behavior: profile.behavior,
      now,
      timeZone: this.#deps.timeZone,
      sentToday: this.sentProactiveCount(botId, now),
      isEvent: false,
    });
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
