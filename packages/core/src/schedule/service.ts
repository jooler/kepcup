import {
  AppError,
  SCHEDULE_CONTEXT_MAX,
  SCHEDULE_CREATED_EVENT,
  SCHEDULE_OFFER_DECLINE_MAX,
  SCHEDULE_OFFER_DECLINE_WINDOW_MS,
  SCHEDULE_OFFER_EVENT,
  describeScheduleWhen,
  scheduleDisplayTitle,
  type BotProfile,
  type Message,
  type Schedule,
  type ScheduleEntry,
  type ScheduleOfferContent,
  type ScheduleOrigin,
  type ScheduleReceiptSnapshot,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import { realTimerScheduler, type Clock, type TimerScheduler } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { localDayStart, nextLocalMidnight } from '../memory/local-date.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { MemoryService } from '../memory/service.js';
import type { MessagesService } from '../domain/messages.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import { parseIsoOrThrow } from './when.js';
import type { Orchestrator } from '../dispatch/orchestrator.js';
import { SchedulesStore } from './store.js';
import { nextCronFireAt, isValidCron } from './cron.js';
import {
  evaluateGuard,
  guardReasonText,
  inQuietHours,
  isLateEnough,
  parseQuietHours,
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
  /**
   * D80 visibility (optional in stripped unit setups): receipt cards on
   * creation, their status write-back, offer cards.
   */
  messages?: MessagesService | undefined;
  /** RPC events (message.created / message.updated / schedules.changed). */
  publish?: ((event: string, payload: unknown) => void) | undefined;
}

export interface CreateOnceInput {
  botId: string;
  conversationId: string;
  runAt: number;
  note: string;
  /** User-facing short name (D80); '' falls back to the note in displays. */
  title?: string | undefined;
  /** D80; defaults to 'commitment' with a commitmentId, else 'tool'. */
  origin?: ScheduleOrigin | undefined;
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
  title?: string | undefined;
  origin?: ScheduleOrigin | undefined;
  commitmentId?: string | null;
}

/** `schedule` tool / offer card / butler routine (D80): `when` is ISO 8601 or cron. */
export interface CreateFromWhenInput {
  botId: string;
  conversationId: string;
  when: string;
  timezone?: string | null | undefined;
  note: string;
  title?: string | undefined;
  origin: ScheduleOrigin;
}

/** A validated `when` (D80 validateWhen). */
export type ParsedWhen =
  | { kind: 'once'; runAt: number; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string; nextFireAt: number };

const NOTE_MAX_CHARS = 500;
const TITLE_MAX_CHARS = 40;
const QUESTION_MAX_CHARS = 200;

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
      title: this.#cleanTitle(input.title),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.commitmentId !== undefined && input.commitmentId !== null
        ? { commitmentId: input.commitmentId }
        : {}),
      nextFireAt: input.runAt,
    });
    this.#reload();
    this.#afterCreate(row);
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
      title: this.#cleanTitle(input.title),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.commitmentId !== undefined && input.commitmentId !== null
        ? { commitmentId: input.commitmentId }
        : {}),
      nextFireAt: next,
    });
    this.#reload();
    this.#afterCreate(row);
    return row;
  }

  /**
   * Parses and validates `when` without creating anything (D80): offer cards
   * and butler routines are checked when proposed, created when confirmed.
   */
  validateWhen(when: string, timezone?: string | null): ParsedWhen {
    let iso: number | null;
    try {
      iso = parseIsoOrThrow(when);
    } catch (error) {
      throw new AppError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
    }
    if (iso !== null) {
      if (iso <= this.#deps.clock.now()) {
        throw new AppError('INVALID_INPUT', '时间在过去，无法创建定时任务');
      }
      return { kind: 'once', runAt: iso, timezone: this.#deps.timeZone };
    }
    const expression = when.trim();
    if (!isValidCron(expression)) {
      throw new AppError('INVALID_INPUT', `无法识别的 cron 表达式：${expression}`);
    }
    const zone = timezone?.trim() || this.#deps.timeZone;
    if (!isValidTimeZone(zone)) throw new AppError('INVALID_INPUT', `无法识别的时区：${zone}`);
    const next = nextCronFireAt(expression, zone, this.#deps.clock.now());
    if (next === null) {
      throw new AppError('INVALID_INPUT', `无法计算 cron 表达式的下次触发时间：${expression}`);
    }
    return { kind: 'cron', expression, timezone: zone, nextFireAt: next };
  }

  /** Creates from an ISO 8601 / cron `when` (D80: tool, offer card, butler routine). */
  createFromWhen(input: CreateFromWhenInput): Schedule {
    const parsed = this.validateWhen(input.when, input.timezone);
    const common = {
      botId: input.botId,
      conversationId: input.conversationId,
      note: input.note,
      ...(input.title !== undefined ? { title: input.title } : {}),
      origin: input.origin,
    };
    return parsed.kind === 'once'
      ? this.createOnce({ ...common, runAt: parsed.runAt })
      : this.createCron({ ...common, expression: parsed.expression, timezone: parsed.timezone });
  }

  /** The schedule's timing in words (「每个工作日 09:00」), in the user's zone. */
  describeWhen(row: Pick<Schedule, 'kind' | 'runAt' | 'cron' | 'timezone'>): string {
    return describeScheduleWhen(row, {
      localTimeZone: this.#deps.timeZone,
      now: this.#deps.clock.now(),
    });
  }

  /**
   * Why a schedule will not fire as the user expects (D80): the bot's
   * proactive switch is off, or the first occurrence falls in quiet hours
   * (deferred to the quiet end). The tool result relays these to the user.
   */
  fireabilityWarnings(row: Schedule): string[] {
    const bot = this.#deps.bots.get(row.botId);
    if (bot === null) return [];
    const behavior = bot.profile.behavior;
    const warnings: string[] = [];
    if (!behavior.proactive) {
      warnings.push('该 Bot 已关闭主动消息：到点不会发消息，需要用户在 Bot 设置里打开「主动消息」。');
    }
    const window = parseQuietHours(behavior.quiet_hours);
    if (window !== null && row.nextFireAt !== null && inQuietHours(row.nextFireAt, window, this.#deps.timeZone)) {
      const [start, end] = behavior.quiet_hours ?? ['', ''];
      warnings.push(`触发时间落在免打扰时段（${start}–${end}），会推迟到免打扰结束后再发。`);
    }
    return warnings;
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

  #cleanTitle(title: string | undefined): string {
    return (title ?? '').trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX_CHARS);
  }

  // --- visibility (D80, todo/schedule-nudges.md §3.3) ---------------------------

  /**
   * After a creation: the receipt card (offers turn their own card into the
   * receipt instead) and the list refresh event.
   */
  #afterCreate(row: Schedule): void {
    if (row.origin !== 'offer') {
      // The user said yes in words and the bot scheduled it directly: the
      // pending offer for the same thing must not create a second one later.
      this.#resolvePendingOffers(row.botId, row.conversationId, 'superseded', scheduleDisplayTitle(row));
      this.#appendReceipt(row);
    }
    this.#publishChanged(row);
  }

  #snapshot(row: Schedule): ScheduleReceiptSnapshot {
    return {
      id: row.id,
      botId: row.botId,
      title: scheduleDisplayTitle(row),
      note: row.note,
      kind: row.kind,
      runAt: row.runAt,
      cron: row.cron,
      timezone: row.timezone,
      origin: row.origin,
      status: row.status,
    };
  }

  /** The card's text: what the bot's context (and search) sees of it. */
  #receiptText(row: Schedule, status: Schedule['status']): string {
    const title = scheduleDisplayTitle(row);
    const when = this.describeWhen(row);
    if (status === 'cancelled') return `定时任务「${title}」（${when}）已取消`;
    if (status === 'done') return `定时任务「${title}」（${when}）已完成`;
    return row.origin === 'commitment'
      ? `记下了：${when}提醒「${title}」`
      : `已设置定时任务「${title}」：${when}`;
  }

  #appendReceipt(row: Schedule): void {
    const messages = this.#deps.messages;
    if (messages === undefined) return;
    try {
      const message = messages.append({
        conversationId: row.conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: SCHEDULE_CREATED_EVENT,
        text: this.#receiptText(row, row.status),
        schedule: this.#snapshot(row),
      });
      this.#deps.publish?.('message.created', { conversationId: row.conversationId, message });
      this.#publishConversation(row.conversationId);
    } catch (error) {
      // The schedule exists either way; a missing card is cosmetic.
      this.#deps.logger.warn(
        { scheduleId: row.id, error: error instanceof Error ? error.message : String(error) },
        'schedule receipt card failed',
      );
    }
  }

  /** Status change of one row: persists, then writes back the receipt / offer card. */
  #setStatus(row: Schedule, status: 'done' | 'cancelled'): void {
    this.store.update(row.id, { status, nextFireAt: null });
    this.#syncCards({ ...row, status });
  }

  /** Receipt and accepted-offer cards carry `schedule.id`; their status follows the row. */
  #syncCards(row: Schedule): void {
    this.#publishChanged(row);
    if (this.#deps.messages === undefined) return;
    try {
      const ids = this.#deps.db
        .prepare(
          `select id from messages
           where conversation_id = ? and kind = 'system_event'
             and json_extract(content_json, '$.schedule.id') = ?`,
        )
        .all(row.conversationId, row.id) as Array<{ id: string }>;
      for (const { id } of ids) {
        const card = this.#deps.messages.getById(id);
        const isOffer = (card?.content as { event?: string } | undefined)?.event === SCHEDULE_OFFER_EVENT;
        this.#deps.db
          .prepare(
            `update messages set content_json = json_set(content_json, '$.schedule.status', ?, '$.text', ?)
             where id = ?`,
          )
          .run(row.status, isOffer ? this.#offerText(row, 'accepted', row.status) : this.#receiptText(row, row.status), id);
        this.#publishMessageUpdated(id);
      }
    } catch (error) {
      this.#deps.logger.warn(
        { scheduleId: row.id, error: error instanceof Error ? error.message : String(error) },
        'schedule card write-back failed',
      );
    }
  }

  #publishMessageUpdated(messageId: string): void {
    const updated = this.#deps.messages?.getById(messageId) ?? null;
    if (updated !== null) {
      this.#deps.publish?.('message.updated', { conversationId: updated.conversationId, message: updated });
    }
  }

  /** Sidebar preview / ordering follow a new card (orchestrator #publishConversation). */
  #publishConversation(conversationId: string): void {
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation !== null) this.#deps.publish?.('conversation.updated', { conversation });
  }

  #publishChanged(row: Schedule): void {
    this.#deps.publish?.('schedules.changed', { conversationId: row.conversationId, scheduleId: row.id });
  }

  /**
   * `<schedules>` context section (D80 §3.4): this bot's active schedules in
   * this conversation, plus recent declined offers. '' = nothing to say.
   */
  contextSection(botId: string, conversationId: string): string {
    const rows = this.store.listActiveForBotInConversation(botId, conversationId);
    const declined = this.recentDeclinedOffers(botId, conversationId);
    if (rows.length === 0 && declined === 0) return '';
    const lines: string[] = [];
    if (rows.length > 0) {
      const shown = rows.slice(0, SCHEDULE_CONTEXT_MAX);
      // Titles / notes originate from model output and user material.
      lines.push(
        '你在本对话中的有效定时任务（已有的不要重复提议或创建）：',
        untrustedBlock(
          shown.map((row) => `- [${row.id}] ${scheduleDisplayTitle(row)}：${this.describeWhen(row)}`).join('\n'),
        ),
      );
      if (rows.length > shown.length) lines.push(`（另有 ${rows.length - shown.length} 个，用 list_schedules 查看）`);
    } else {
      lines.push('你在本对话中没有有效的定时任务。');
    }
    if (declined > 0) {
      lines.push(
        declined >= SCHEDULE_OFFER_DECLINE_MAX
          ? `用户最近 7 天在本对话拒绝过 ${declined} 次你的定时提议：除非用户主动要求，不要再提议定时或提醒。`
          : `用户最近 7 天在本对话拒绝过 ${declined} 次你的定时提议，提议前多想想用户是否真的需要。`,
      );
    }
    return lines.join('\n');
  }

  // --- offer cards (D80 §3.5) --------------------------------------------------

  /** Offers of this bot in this conversation the user declined within the window. */
  recentDeclinedOffers(botId: string, conversationId: string): number {
    const since = this.#deps.clock.now() - SCHEDULE_OFFER_DECLINE_WINDOW_MS;
    const row = this.#deps.db
      .prepare(
        `select count(*) as n from messages
         where conversation_id = ? and kind = 'system_event'
           and json_extract(content_json, '$.event') = ?
           and json_extract(content_json, '$.offer.botId') = ?
           and json_extract(content_json, '$.offer.status') = 'declined'
           and coalesce(json_extract(content_json, '$.offer.decidedAt'), created_at) >= ?`,
      )
      .get(conversationId, SCHEDULE_OFFER_EVENT, botId, since) as { n: number };
    return row.n;
  }

  #offerText(
    offer: Pick<ScheduleOfferContent, 'title'> | Pick<Schedule, 'title' | 'note'>,
    status: ScheduleOfferContent['status'],
    scheduleStatus?: Schedule['status'],
  ): string {
    const title = 'note' in offer ? scheduleDisplayTitle(offer) : offer.title;
    switch (status) {
      case 'accepted':
        return scheduleStatus === 'cancelled'
          ? `定时提议「${title}」：用户设置过，后来取消了`
          : scheduleStatus === 'done'
            ? `定时提议「${title}」：已设置，已完成`
            : `定时提议「${title}」：用户点了「设置」，已创建`;
      case 'declined':
        return `定时提议「${title}」：用户点了「不用了」`;
      case 'superseded':
        return `定时提议「${title}」：已被新的提议取代`;
      case 'expired':
        return `定时提议「${title}」：时间已过，未设置`;
      default:
        return `定时提议「${title}」：等用户决定`;
    }
  }

  /**
   * offer_schedule tool: validates, enforces the decline back-off and the
   * duplicate check, supersedes this bot's pending offers here, then posts
   * the card. The card is the question — the model must not ask again in text.
   */
  createOffer(input: {
    botId: string;
    conversationId: string;
    when: string;
    timezone?: string | null | undefined;
    title: string;
    note: string;
    question: string;
  }): { ok: boolean; message: string } {
    const messages = this.#deps.messages;
    if (messages === undefined) return { ok: false, message: '当前环境不支持定时提议卡' };
    this.#assertFireable(input.botId, input.conversationId);
    const declined = this.recentDeclinedOffers(input.botId, input.conversationId);
    if (declined >= SCHEDULE_OFFER_DECLINE_MAX) {
      return {
        ok: false,
        message: `用户最近 7 天已在本对话拒绝 ${declined} 次你的定时提议：不要再提议；用户明确要求提醒时直接用 schedule 创建。`,
      };
    }
    const title = this.#cleanTitle(input.title);
    if (title.length === 0) return { ok: false, message: 'title 不能为空' };
    const note = this.#cleanNote(input.note);
    const question = input.question.trim().slice(0, QUESTION_MAX_CHARS);
    if (question.length === 0) return { ok: false, message: 'question 不能为空' };
    const parsed = this.validateWhen(input.when, input.timezone);
    const duplicate = this.store
      .listActiveForBotInConversation(input.botId, input.conversationId)
      .find((row) => scheduleDisplayTitle(row) === title);
    if (duplicate !== undefined) {
      return {
        ok: false,
        message: `本对话已有同名的定时任务「${title}」（${duplicate.id}，${this.describeWhen(duplicate)}），不要重复提议。`,
      };
    }
    this.#supersedePendingOffers(input.botId, input.conversationId);
    const offer: ScheduleOfferContent = {
      botId: input.botId,
      title,
      note,
      when: input.when.trim(),
      timezone: parsed.kind === 'cron' ? parsed.timezone : null,
      question,
      status: 'pending',
    };
    const message = messages.append({
      conversationId: input.conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: SCHEDULE_OFFER_EVENT,
      text: this.#offerText(offer, 'pending'),
      offer,
    });
    this.#deps.publish?.('message.created', { conversationId: input.conversationId, message });
    this.#publishConversation(input.conversationId);
    const when =
      parsed.kind === 'once'
        ? this.describeWhen({ kind: 'once', runAt: parsed.runAt, cron: null, timezone: parsed.timezone })
        : this.describeWhen({ kind: 'cron', runAt: null, cron: parsed.expression, timezone: parsed.timezone });
    return {
      ok: true,
      message: `提议卡已展示给用户（${when}）。不要再用文字重复问；用户点「设置」或「不用了」后卡片会显示结果，你下一轮从时间线看到。用户想换时间会直接回复你，届时再提一次或直接用 schedule 创建。`,
    };
  }

  #supersedePendingOffers(botId: string, conversationId: string): void {
    this.#resolvePendingOffers(botId, conversationId, 'superseded');
  }

  /**
   * Closes this bot's pending offers in the conversation (optionally only the
   * one with `title`): superseded by a new offer / a direct creation, or
   * expired once the bot can no longer act on them (removed / deleted).
   * `conversationId` null = every conversation (bot deletion).
   */
  #resolvePendingOffers(
    botId: string,
    conversationId: string | null,
    status: 'superseded' | 'expired',
    title?: string,
  ): void {
    if (this.#deps.messages === undefined) return;
    try {
      const ids = this.#deps.db
        .prepare(
          `select id from messages
           where (? is null or conversation_id = ?) and kind = 'system_event'
             and json_extract(content_json, '$.event') = ?
             and json_extract(content_json, '$.offer.botId') = ?
             and json_extract(content_json, '$.offer.status') = 'pending'
             and (? is null or json_extract(content_json, '$.offer.title') = ?)`,
        )
        .all(
          conversationId,
          conversationId,
          SCHEDULE_OFFER_EVENT,
          botId,
          title ?? null,
          title ?? null,
        ) as Array<{ id: string }>;
      for (const { id } of ids) this.#setOfferStatus(id, status);
    } catch (error) {
      this.#deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'resolving pending schedule offers failed',
      );
    }
  }

  #setOfferStatus(
    messageId: string,
    status: ScheduleOfferContent['status'],
    extra: { schedule?: Schedule } = {},
  ): void {
    const card = this.#deps.messages?.getById(messageId) ?? null;
    const offer = (card?.content as { offer?: ScheduleOfferContent } | undefined)?.offer;
    if (card === null || offer === undefined) return;
    const now = this.#deps.clock.now();
    const schedule = extra.schedule;
    this.#deps.db
      .prepare(
        schedule !== undefined
          ? `update messages set content_json = json_set(content_json,
               '$.offer.status', ?, '$.offer.decidedAt', ?, '$.text', ?,
               '$.offer.scheduleId', ?, '$.schedule', json(?)) where id = ?`
          : `update messages set content_json = json_set(content_json,
               '$.offer.status', ?, '$.offer.decidedAt', ?, '$.text', ?) where id = ?`,
      )
      .run(
        ...(schedule !== undefined
          ? [
              status,
              now,
              this.#offerText(offer, status, schedule.status),
              schedule.id,
              JSON.stringify(this.#snapshot(schedule)),
              messageId,
            ]
          : [status, now, this.#offerText(offer, status), messageId]),
      );
    this.#publishMessageUpdated(messageId);
  }

  #pendingOffer(messageId: string): { card: Message; offer: ScheduleOfferContent } {
    const card = this.#deps.messages?.getById(messageId) ?? null;
    const content = card?.content as { event?: string; offer?: ScheduleOfferContent } | undefined;
    if (card === null || content?.event !== SCHEDULE_OFFER_EVENT || content.offer === undefined) {
      throw new AppError('INVALID_INPUT', '不是定时提议卡');
    }
    if (content.offer.status !== 'pending') {
      throw new AppError('INVALID_INPUT', '这张提议卡已经处理过了');
    }
    return { card, offer: content.offer };
  }

  /**
   * 「设置」 on an offer card: deterministic creation (origin 'offer'); the
   * card itself becomes the receipt. Does not wake the bot (§3.5).
   */
  acceptOffer(messageId: string): Schedule {
    const { card, offer } = this.#pendingOffer(messageId);
    // Already scheduled under the same name (e.g. via the schedule tool after
    // the user agreed in words): point the card at it instead of duplicating.
    const existing = this.store
      .listActiveForBotInConversation(offer.botId, card.conversationId)
      .find((row) => scheduleDisplayTitle(row) === offer.title);
    if (existing !== undefined) {
      this.#setOfferStatus(messageId, 'accepted', { schedule: existing });
      return existing;
    }
    let created: Schedule;
    try {
      created = this.createFromWhen({
        botId: offer.botId,
        conversationId: card.conversationId,
        when: offer.when,
        timezone: offer.timezone,
        title: offer.title,
        note: offer.note,
        origin: 'offer',
      });
    } catch (error) {
      // Past time, bot gone / no longer a member, conversation read-only: the
      // offer can never be honoured — close the card instead of leaving live buttons.
      if (error instanceof AppError) this.#setOfferStatus(messageId, 'expired');
      throw error;
    }
    this.#setOfferStatus(messageId, 'accepted', { schedule: created });
    this.#deps.logger.info({ scheduleId: created.id, origin: 'offer' }, 'schedule offer accepted');
    return created;
  }

  /** 「不用了」 on an offer card: counts towards the decline back-off. */
  declineOffer(messageId: string): void {
    const { offer } = this.#pendingOffer(messageId);
    this.#setOfferStatus(messageId, 'declined');
    this.#deps.logger.info({ botId: offer.botId, title: offer.title }, 'schedule offer declined');
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
        this.#setStatus(row, 'cancelled');
        this.#reload();
        return;
      }

      // 承诺作废/撤回后任务取消（任务 6；事件之外的双查兜底）。
      if (row.commitmentId !== null) {
        const commitment = this.#deps.memory.getItemFor(row.botId, row.commitmentId);
        if (commitment === null || commitment.status !== 'active') {
          this.#setStatus(row, 'cancelled');
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
        this.#setStatus(row, 'done');
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
      this.#setStatus(row, 'cancelled');
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
        title: input.item.content,
        origin: 'commitment',
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
    if (cancelled.length > 0) {
      this.#deps.logger.info(
        { botId, commitmentId, cancelled: cancelled.length },
        'commitment schedules cancelled',
      );
      for (const row of cancelled) this.#syncCards(row);
      this.#reload();
    }
    return cancelled.length;
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
    this.#resolvePendingOffers(botId, null, 'expired');
    const deleted = this.store.deleteForBot(botId);
    if (deleted > 0) this.#reload();
    return deleted;
  }

  /** 移出群：该 Bot 在此群的任务取消。 */
  cancelForBotInConversation(botId: string, conversationId: string): number {
    this.#resolvePendingOffers(botId, conversationId, 'expired');
    const cancelled = this.store.cancelForBotInConversation(botId, conversationId);
    if (cancelled.length > 0) {
      for (const row of cancelled) this.#syncCards(row);
      this.#reload();
    }
    return cancelled.length;
  }

  // --- queries & RPC -----------------------------------------------------------

  cancel(id: string): Schedule {
    const row = this.store.get(id);
    if (row === null) throw new AppError('NOT_FOUND', `定时任务 ${id} 不存在`);
    if (row.status !== 'active') throw new AppError('INVALID_INPUT', '该任务已结束，无法取消');
    this.#setStatus(row, 'cancelled');
    this.#reload();
    return this.store.get(id) ?? row;
  }

  /** cancel_schedule tool: a bot may only cancel its own tasks. */
  cancelOwn(botId: string, scheduleId: string): { ok: boolean; message: string } {
    const row = this.store.get(scheduleId);
    if (row === null || row.botId !== botId) {
      return { ok: false, message: '定时任务不存在，或不是你创建的任务' };
    }
    if (row.status !== 'active') return { ok: false, message: '该任务已结束' };
    this.#setStatus(row, 'cancelled');
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

  /** Display title of a schedule (D80: the 「⏰ 标题」 tag of a scheduled turn's reply). */
  displayTitle(scheduleId: string): string | null {
    const row = this.store.get(scheduleId);
    return row === null ? null : scheduleDisplayTitle(row);
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
