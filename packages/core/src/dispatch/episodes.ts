import {
  AppError,
  EPISODE_HOP_BREAKER,
  EPISODE_PINGPONG_BREAKER,
  newId,
  type Episode,
  type Message,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { RunIdentity } from '../agent/types.js';
import type { TriggerBatch } from '../scheduler/mailbox.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';

interface EpisodeRow {
  id: string;
  conversation_id: string;
  root_batch_id: string;
  status: 'active' | 'paused' | 'stopped';
  hops: number;
  pair_hops_json: string;
  pending_json: string;
  paused_at: number | null;
  created_at: number;
}

/** One undelivered bot @ trigger kept on a paused episode (breaker, D92 T1a). */
interface PendingTrigger {
  toBotId: string;
  fromBotId: string;
  messageId: string;
  hop: number;
}

export interface EpisodesDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  /** Hands a trigger batch to the target bot's mailbox. */
  deliver(batch: TriggerBatch): void;
  /** Appends + publishes a system event message (visible unless `internal`). */
  appendSystemEvent(input: {
    conversationId: string;
    event: string;
    text: string;
    episodeId?: string;
    internal?: boolean;
  }): void;
  publishEpisode(episode: Episode): void;
  /** Test override of the breaker thresholds (defaults come from shared constants). */
  limits?: { hops?: number; pair?: number };
}

/** Unordered bot-pair key: lexicographically sorted "botA|botB". */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * e2e test seam (D92 T1a WP8): `KEPCUP_TEST_EPISODE_LIMITS="hops,pair"`
 * (e.g. "2,2") overrides both breaker thresholds so an e2e run can trip the
 * breaker with a short scripted ping-pong. Only read behind
 * `__KEPCUP_TEST_HOOKS__` (start.ts folds the whole call away in packaged
 * builds); malformed or non-positive values are ignored part by part — the
 * shared constants stay the single source of truth for production.
 */
export function episodeLimitsFromEnv(env: NodeJS.ProcessEnv): { hops?: number; pair?: number } {
  const raw = env.KEPCUP_TEST_EPISODE_LIMITS;
  if (raw === undefined || raw.length === 0) return {};
  const parts = raw.split(',');
  const limits: { hops?: number; pair?: number } = {};
  const hops = Number(parts[0]);
  const pair = Number(parts[1]);
  if (Number.isFinite(hops) && hops > 0) limits.hops = Math.floor(hops);
  if (Number.isFinite(pair) && pair > 0) limits.pair = Math.floor(pair);
  return limits;
}

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function rowToEpisode(row: EpisodeRow): Episode {
  const pending = parseJson(row.pending_json, []) as unknown;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    hops: row.hops,
    pausedAt: row.paused_at,
    pendingCount: Array.isArray(pending) ? pending.length : 0,
    createdAt: row.created_at,
  };
}

/**
 * Collaboration episodes (D92 T1a, design 41 §7): a `send_message` with
 * `mention_bot_ids` creates or extends the sending run's episode (epi_…). The
 * initiating run is bound as the episode root (hop 0); every delivered bot @
 * trigger counts one hop. There is no token budget and no hard depth — two
 * circuit breakers pause the episode instead: more than EPISODE_HOP_BREAKER
 * bot-initiated triggers in one round, or more than EPISODE_PINGPONG_BREAKER
 * between one unordered bot pair. Pausing keeps the undelivered triggers in
 * `pending_json`; the user resumes (pending re-delivered, counters reset) or
 * stops the round via `episodes.resume` / `episodes.stop`.
 */
export class EpisodesService {
  readonly #limits: { hops: number; pair: number };

  constructor(private readonly deps: EpisodesDeps) {
    this.#limits = {
      hops: deps.limits?.hops ?? EPISODE_HOP_BREAKER,
      pair: deps.limits?.pair ?? EPISODE_PINGPONG_BREAKER,
    };
  }

  /** The episode row (null = none). */
  #row(id: string): EpisodeRow | null {
    return (
      (this.deps.db.prepare('select * from episodes where id = ?').get(id) as
        | EpisodeRow
        | undefined) ?? null
    );
  }

  /**
   * send_message hook. `message` is the just-appended bot message carrying the
   * mentions. Returns a suffix for the tool result ('' when nothing to note).
   */
  mention(identity: RunIdentity, mentionBotIds: string[], message: Message): string {
    if (identity.botId === null || identity.conversationId === null) return '';
    const conversation = this.deps.conversations.get(identity.conversationId);
    if (!conversation || conversation.type !== 'project') {
      return '（仅项目组中可以 @ 其他 Bot，本次 @ 未触发任何人）';
    }
    const members = new Set(this.deps.conversations.memberBotIds(conversation.id));
    const valid: string[] = [];
    const skipped: string[] = [];
    for (const botId of [...new Set(mentionBotIds)]) {
      if (botId === identity.botId) {
        skipped.push('自己');
        continue;
      }
      const bot = this.deps.bots.get(botId);
      if (!bot || bot.status !== 'active' || !members.has(botId)) {
        skipped.push(this.deps.bots.get(botId)?.name ?? botId);
        continue;
      }
      valid.push(botId);
    }
    if (valid.length === 0) {
      return '（@ 未触发：目标不是当前项目组的成员）';
    }

    const currentRun = this.deps.runs.get(identity.runId);
    let episodeId = currentRun?.episodeId ?? null;
    // A legacy chain id on a pre-episode run points at no episodes row: treat
    // it as "no episode" and open a fresh one.
    if (episodeId !== null && this.#row(episodeId) === null) episodeId = null;
    const hop = (currentRun?.episodeHop ?? 0) + 1;
    const fromBotId = identity.botId;

    // Decide and persist in one immediate transaction (main db only; runs.db
    // writes happen outside it — the two databases cannot share a tx).
    const outcome = this.deps.db.transaction((): {
      created: boolean;
      episodeId: string;
      action: 'stopped' | 'paused' | 'breaker' | 'deliver';
      newHops: number;
    } => {
      let created = false;
      if (episodeId === null) {
        episodeId = newId('epi');
        const rootBatchId =
          currentRun?.triggerMessageIds
            .map((id) => this.deps.messages.getById(id)?.batchId ?? null)
            .find((batchId) => batchId !== null) ?? `run:${identity.runId}`;
        this.deps.db
          .prepare(
            "insert into episodes (id, conversation_id, root_batch_id, status, hops, pair_hops_json, pending_json, created_at) values (?, ?, ?, 'active', 0, '{}', '[]', ?)",
          )
          .run(episodeId, conversation.id, rootBatchId, this.deps.clock.now());
        created = true;
      }
      const row = this.#row(episodeId);
      if (row === null) throw new AppError('NOT_FOUND', `Episode ${episodeId} does not exist`);
      if (row.status === 'stopped') {
        return { created, episodeId, action: 'stopped', newHops: row.hops };
      }
      const pendingRaw = parseJson(row.pending_json, []);
      const pending = Array.isArray(pendingRaw) ? (pendingRaw as PendingTrigger[]) : [];
      const appendPending = (): void => {
        const next = [
          ...pending,
          ...valid.map((toBotId) => ({ toBotId, fromBotId, messageId: message.id, hop })),
        ];
        this.deps.db
          .prepare('update episodes set pending_json = ? where id = ?')
          .run(JSON.stringify(next), episodeId);
      };
      if (row.status === 'paused') {
        // Already paused: queue the trigger, never a second pause card.
        appendPending();
        return { created, episodeId, action: 'paused', newHops: row.hops };
      }
      const newHops = row.hops + valid.length;
      const pairs = { ...(parseJson(row.pair_hops_json, {}) as Record<string, number>) };
      for (const toBotId of valid) {
        const key = pairKey(fromBotId, toBotId);
        pairs[key] = (pairs[key] ?? 0) + 1;
      }
      const overLimit =
        newHops > this.#limits.hops ||
        valid.some((toBotId) => (pairs[pairKey(fromBotId, toBotId)] ?? 0) > this.#limits.pair);
      if (overLimit) {
        // Breaker: pause in the same transaction; the counters stay at the
        // allowed counts (this trigger is neither delivered nor counted).
        this.deps.db
          .prepare('update episodes set status = ?, paused_at = ? where id = ?')
          .run('paused', this.deps.clock.now(), episodeId);
        appendPending();
        return { created, episodeId, action: 'breaker', newHops: row.hops };
      }
      this.deps.db
        .prepare('update episodes set hops = ?, pair_hops_json = ? where id = ?')
        .run(newHops, JSON.stringify(pairs), episodeId);
      return { created, episodeId, action: 'deliver', newHops };
    }).immediate();

    // Bind the initiating run as the episode root (hop 0). runs.db is another
    // database: the episode row exists first, the run binding follows (the
    // crash window can only leave an unused episode row — harmless).
    if (outcome.created) {
      this.deps.runs.update(identity.runId, {
        episodeId: outcome.episodeId,
        episodeHop: 0,
      });
    }

    if (outcome.action === 'stopped') {
      return '（协作已被用户停止，@ 未触发）';
    }
    if (outcome.action === 'paused') {
      return '（协作已暂停，等待用户确认是否继续）';
    }
    if (outcome.action === 'breaker') {
      this.deps.logger.info(
        { episodeId: outcome.episodeId, hops: outcome.newHops, conversationId: conversation.id },
        'episode breaker tripped, collaboration paused',
      );
      this.deps.appendSystemEvent({
        conversationId: conversation.id,
        event: 'episode_paused',
        text: `协作已自动往返 ${outcome.newHops} 次，已暂停`,
        episodeId: outcome.episodeId,
      });
      const row = this.#row(outcome.episodeId);
      if (row !== null) this.deps.publishEpisode(rowToEpisode(row));
      return '（协作已暂停，等待用户确认是否继续）';
    }

    const fromName = this.deps.bots.get(fromBotId)?.name ?? fromBotId;
    for (const botId of valid) {
      this.deps.deliver({
        conversationId: conversation.id,
        botId,
        messages: [message],
        reason: 'bot_mention',
        extraAttributes: { from_bot: fromName, hop },
        episode: { id: outcome.episodeId, hop },
      });
    }
    const row = this.#row(outcome.episodeId);
    if (row !== null) this.deps.publishEpisode(rowToEpisode(row));
    const note = skipped.length > 0 ? `（未触发：${skipped.join('、')} 不是项目成员）` : '';
    return `（已通知 ${valid.length} 个 Bot，协作第 ${outcome.newHops} 次）${note}`;
  }

  get(id: string): Episode | null {
    const row = this.#row(id);
    return row === null ? null : rowToEpisode(row);
  }

  /**
   * User chose 继续 on the pause card: the round re-opens with fresh counters
   * and the kept triggers are re-delivered in order (skipping messages that
   * were recalled or deleted meanwhile). Re-delivered triggers do not count
   * towards the new round.
   */
  resume(id: string): Episode {
    const row = this.#row(id);
    if (row === null) throw new AppError('NOT_FOUND', `Episode ${id} does not exist`);
    if (row.status !== 'paused') throw new AppError('INVALID_INPUT', '协作不在暂停状态');
    const pendingRaw = parseJson(row.pending_json, []);
    const pending = Array.isArray(pendingRaw) ? (pendingRaw as PendingTrigger[]) : [];
    this.deps.db
      .prepare(
        "update episodes set status = 'active', paused_at = null, hops = 0, pair_hops_json = '{}', pending_json = '[]' where id = ?",
      )
      .run(id);
    for (const item of pending) {
      const message = this.deps.messages.getById(item.messageId);
      if (message === null || message.status === 'recalled') continue;
      const fromName = this.deps.bots.get(item.fromBotId)?.name ?? item.fromBotId;
      this.deps.deliver({
        conversationId: row.conversation_id,
        botId: item.toBotId,
        messages: [message],
        reason: 'bot_mention',
        extraAttributes: { from_bot: fromName, hop: item.hop },
        episode: { id, hop: item.hop },
      });
    }
    const episode = rowToEpisode(this.#row(id)!);
    this.deps.publishEpisode(episode);
    return episode;
  }

  /**
   * User chose 停止: the round ends, the kept triggers are dropped and an
   * internal event tells the bots the round is over. Idempotent on an already
   * stopped round.
   */
  stop(id: string): Episode {
    const row = this.#row(id);
    if (row === null) throw new AppError('NOT_FOUND', `Episode ${id} does not exist`);
    if (row.status !== 'stopped') {
      this.deps.db
        .prepare(
          "update episodes set status = 'stopped', paused_at = null, pending_json = '[]' where id = ?",
        )
        .run(id);
      this.deps.appendSystemEvent({
        conversationId: row.conversation_id,
        event: 'episode_stopped',
        text: '用户已停止本次协作（不再继续 Bot 之间的往返）',
        internal: true,
      });
    }
    const episode = rowToEpisode(this.#row(id)!);
    this.deps.publishEpisode(episode);
    return episode;
  }

  /** The run's episode binding (null = none: unbound run, or a legacy id with no row). */
  bindingOfRun(runId: string): { id: string; hop: number } | null {
    const run = this.deps.runs.get(runId);
    if (run === null || run.episodeId === null) return null;
    if (this.#row(run.episodeId) === null) return null;
    return { id: run.episodeId, hop: run.episodeHop ?? 0 };
  }
}
