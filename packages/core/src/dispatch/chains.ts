import { BOT_CHAIN_MAX_DEPTH, BOT_CHAIN_TOKEN_BUDGET, newId, type Message } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { RunIdentity } from '../agent/types.js';
import type { TriggerBatch } from '../scheduler/mailbox.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { UsageService } from '../domain/usage.js';

interface ChainRow {
  id: string;
  conversation_id: string;
  root_batch_id: string;
  max_depth_seen: number;
  tokens_used: number;
  created_at: number;
}

export interface ChainsDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  usage: UsageService;
  /** Hands the chain trigger to the target bot's mailbox. */
  deliver(batch: TriggerBatch): void;
  /** Tokens spent so far by still-running runs among the given ids (usage rows
   * land only at settle, so in-flight runs must be summed from the engine). */
  tokensInFlightFor(runIds: string[]): number;
}

/**
 * Bot-to-bot @ chains (docs/dev/phases/P05-group-chat.md): a `send_message`
 * with `mention_bot_ids` creates or extends a chain (chn_…). The initiating
 * run is bound to the chain as depth 0; delivered triggers are capped at
 * BOT_CHAIN_MAX_DEPTH and the chain's aggregated token spend (settled usage
 * rows + in-flight engine tokens of every run bound to it) at
 * BOT_CHAIN_TOKEN_BUDGET; over either limit the mention is not delivered and
 * the tool result explains why.
 */
export class ChainsService {
  constructor(private readonly deps: ChainsDeps) {}

  /**
   * send_message hook. `message` is the just-appended bot message carrying the
   * mentions. Returns a suffix for the tool result ('' when nothing to note).
   */
  mention(identity: RunIdentity, mentionBotIds: string[], message: Message): string {
    if (identity.botId === null || identity.conversationId === null) return '';
    const conversation = this.deps.conversations.get(identity.conversationId);
    if (!conversation || conversation.type !== 'group') {
      return '（仅群聊中可以 @ 其他 Bot，本次 @ 未触发任何人）';
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
      return '（@ 未触发：目标不是当前群的成员）';
    }

    const currentRun = this.deps.runs.get(identity.runId);
    let chainId = currentRun?.chainId ?? null;
    const depth = (currentRun?.chainDepth ?? 0) + 1;
    if (depth > BOT_CHAIN_MAX_DEPTH) {
      this.deps.logger.info(
        { chainId, depth, conversationId: conversation.id },
        'chain depth limit reached, mention dropped',
      );
      return `（@ 未触发：已达连锁层数上限（${BOT_CHAIN_MAX_DEPTH} 层））`;
    }
    if (chainId === null) {
      chainId = newId('chn');
      const rootBatchId =
        currentRun
          ?.triggerMessageIds.map((id) => this.deps.messages.getById(id)?.batchId ?? null)
          .find((batchId) => batchId !== null) ?? `run:${identity.runId}`;
      this.deps.db
        .prepare(
          'insert into chains (id, conversation_id, root_batch_id, max_depth_seen, tokens_used, created_at) values (?, ?, ?, ?, 0, ?)',
        )
        .run(chainId, conversation.id, rootBatchId, depth, this.deps.clock.now());
      // Bind the initiating run as the chain root (depth 0) so its usage
      // counts towards the chain budget (BR-P05-003).
      this.deps.runs.update(identity.runId, { chainId, chainDepth: 0 });
    } else {
      this.deps.db
        .prepare('update chains set max_depth_seen = max(max_depth_seen, ?) where id = ?')
        .run(depth, chainId);
    }

    const chainRunIds = this.deps.runs.listIdsByChain(chainId);
    // A run is either still active (tokens via the engine) or settled (rows in
    // the ledger) — the two sums never double-count.
    const used =
      this.deps.usage.sumForRuns(chainRunIds) + this.deps.tokensInFlightFor(chainRunIds);
    if (used > BOT_CHAIN_TOKEN_BUDGET) {
      this.deps.logger.info(
        { chainId, used, conversationId: conversation.id },
        'chain token budget exhausted, mention dropped',
      );
      return '（@ 未触发：该连锁的 token 预算已用尽）';
    }

    const fromName = this.deps.bots.get(identity.botId)?.name ?? identity.botId;
    for (const botId of valid) {
      this.deps.deliver({
        conversationId: conversation.id,
        botId,
        messages: [message],
        reason: 'chain',
        extraAttributes: { from_bot: fromName, depth },
        chain: { id: chainId, depth },
      });
    }
    const note = skipped.length > 0 ? `（未触发：${skipped.join('、')} 不是群成员）` : '';
    return `（已通知 ${valid.length} 个 Bot，连锁第 ${depth} 层）${note}`;
  }

  /** Chains of one conversation (tests / diagnostics). */
  listByConversation(conversationId: string): ChainRow[] {
    return this.deps.db
      .prepare('select * from chains where conversation_id = ? order by created_at')
      .all(conversationId) as ChainRow[];
  }
}
