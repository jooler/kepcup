import { AppError, PROFILE_CARD_TOKEN_BUDGET } from '@kepcup/shared';
import { completeStructured } from '../agent/structured.js';
import { truncateToBudget } from '../agent/tokens.js';
import type { AgentEngine } from '../agent/types.js';
import type { JobRow } from '../domain/jobs.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { CoreLogger } from '../infra/logger.js';
import { containsCredential } from './credential-patterns.js';
import { curationOutputSchema, curationParametersSchema, type CurationOutput } from './schemas.js';
import type { MemoryService } from './service.js';
import { recordLoopUsage, type LoopUsageDeps } from './loop-utils.js';
import { routeFor, type LlmRouter } from '../agent/llm-router.js';

export interface CurationJobDeps extends LoopUsageDeps {
  engine: AgentEngine;
  /** D72 P6：无内置模型时改走外部 Agent；缺省只用内置模型。 */
  router?: LlmRouter | undefined;
  settings: SettingsService;
  runs: RunsService;
  usage: UsageService;
  messages: MessagesService;
  memory: MemoryService;
  logger: CoreLogger;
  job: JobRow;
}

/**
 * profile_curation background loop (docs/dev/phases/P07-memory.md 任务 8):
 * the ONLY writer of profile_items besides the user's direct edits. Applies
 * the model's operations to pending proposals and recompiles the card.
 * C11 (62.05 §2): the job payload carries the principal key — the loop sees
 * and touches exactly that principal's profile domain.
 */
export async function runProfileCurationJob(deps: CurationJobDeps): Promise<void> {
  const store = deps.memory.profileStore;
  const payload = safeParsePayload(deps.job.payload_json);
  const principalKey = payload.principalKey ?? '';
  const pending = store.pendingProposals(principalKey);
  const activeItems = store.list('active', undefined, principalKey);
  // A direct edit / retraction changes entries without a proposal; the card
  // must still be recompiled (docs/design/04-memory.md 画像整理).
  const stale = store.cardIsStale(principalKey);
  if (pending.length === 0 && !stale) return;
  // D72 P4 / P6：没有内置模型、也没有可用于后台的外部 Agent 时跳过（提议
  // 留待下次整理），不产生失败 run。
  const route = routeFor(deps, 'profile_curation', null);
  if (route === null) {
    deps.logger.info(
      { pending: pending.length, stale, principalKey },
      'profile curation skipped: no model for background calls',
    );
    return;
  }

  const run = deps.runs.create({
    botId: null, // 全局唯一写入者（画像整理 loop 无所属 Bot）
    conversationId: null,
    loopType: 'profile_curation',
    triggerReason: 'background',
    triggerMessageIds: [],
  });
  deps.runs.update(run.id, { status: 'running' });

  try {
    const { engine, modelRef: mainRef } = route;
    const output = await completeStructured<CurationOutput>({
      complete: (req) => engine.complete(req),
      resolveRoute: () => routeFor(deps, 'profile_curation', null),
      identity: { runId: run.id, botId: null, conversationId: null, loopType: 'profile_curation' },
      model: mainRef,
      systemPrompt: CURATION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `<existing_profile_items>\n${renderItems(activeItems)}\n</existing_profile_items>`,
            `<pending_proposals>\n${renderProposals(pending)}\n</pending_proposals>`,
          ].join('\n\n'),
          timestamp: Date.now(),
        },
      ],
      parametersSchema: curationParametersSchema,
      schema: curationOutputSchema,
      onUsage: (usage) => recordLoopUsage(deps, run.id, 'profile_curation', mainRef, usage),
    });

    applyOperations(deps, output, principalKey);
    const card = truncateToBudget(output.card, PROFILE_CARD_TOKEN_BUDGET);
    store.setCard(card.text, principalKey);
    deps.runs.update(run.id, { status: 'completed' });
  } catch (error) {
    deps.runs.update(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Curation job payload (legacy rows carry `{}` = the single-user bucket). */
function safeParsePayload(payloadJson: string): { principalKey?: string } {
  try {
    const parsed = JSON.parse(payloadJson === '' ? '{}' : payloadJson) as Record<string, unknown>;
    return typeof parsed['principalKey'] === 'string'
      ? { principalKey: parsed['principalKey'] }
      : {};
  } catch {
    return {};
  }
}

/**
 * Applies curation operations; unknown ids are ignored (logged). The card is
 * written even when every operation was invalid — an explicit empty card is
 * a valid curation outcome. Every operation is confined to the job's
 * principal bucket: items of another principal are out of reach.
 */
function applyOperations(deps: CurationJobDeps, output: CurationOutput, principalKey: string): void {
  const store = deps.memory.profileStore;
  /** The item must exist inside this job's principal bucket. */
  const itemOfBucket = (itemId: string) => {
    const item = store.getItem(itemId);
    if (item === null || item.principalKey !== principalKey) return null;
    return item;
  };
  /** Evidence with the conversation backfilled from the message (BR-P07-010). */
  const evidenceOf = (messageIds: string[]) =>
    messageIds.map((messageId) => ({
      messageId,
      conversationId: deps.messages.getById(messageId)?.conversationId ?? null,
    }));
  for (const operation of output.operations) {
    switch (operation.op) {
      case 'add': {
        const proposal = store.getProposal(operation.proposalId);
        if (
          proposal === null ||
          proposal.op !== 'add' ||
          proposal.status !== 'pending' ||
          proposal.principalKey !== principalKey
        ) {
          deps.logger.warn({ proposalId: operation.proposalId }, 'curation add: unknown proposal');
          continue;
        }
        const payload = proposal.payload as {
          content?: string;
          source?: 'explicit' | 'inferred';
          evidenceMessageIds?: string[];
          confidence?: number;
          validUntil?: number;
        };
        // Final gate: credentials never reach the shared profile either.
        if (containsCredential(operation.content)) {
          store.markProposal(operation.proposalId, 'rejected', { reason: 'credential pattern' });
          continue;
        }
        store.insert(
          {
            category: operation.category,
            content: operation.content,
            source: payload.source ?? 'inferred',
            evidence: evidenceOf(payload.evidenceMessageIds ?? []),
            contributedBy: proposal.botId,
            confidence: payload.confidence ?? 0.5,
            validUntil: payload.validUntil ?? null,
          },
          principalKey,
        );
        store.markProposal(operation.proposalId, 'applied', {
          op: 'add',
          category: operation.category,
        });
        break;
      }
      case 'update': {
        const item = itemOfBucket(operation.itemId);
        if (item === null) {
          deps.logger.warn({ itemId: operation.itemId }, 'curation update: unknown item');
          continue;
        }
        // Credential gate on every content entry point (BR-P07-004): a hit
        // rejects the whole operation and the item keeps its original content.
        if (containsCredential(operation.content)) {
          store.markProposal(operation.proposalId, 'rejected', { reason: 'credential pattern' });
          continue;
        }
        store.updateContent(operation.itemId, operation.content, principalKey);
        store.markProposal(operation.proposalId, 'applied', {
          op: 'update',
          itemId: operation.itemId,
        });
        break;
      }
      case 'supersede': {
        const item = itemOfBucket(operation.itemId);
        if (item === null) {
          deps.logger.warn({ itemId: operation.itemId }, 'curation supersede: unknown item');
          continue;
        }
        if (containsCredential(operation.content)) {
          store.markProposal(operation.proposalId, 'rejected', { reason: 'credential pattern' });
          continue;
        }
        const proposal = store.getProposal(operation.proposalId);
        const payload = proposal?.payload as
          | { source?: 'explicit' | 'inferred'; evidenceMessageIds?: string[]; confidence?: number }
          | undefined;
        store.supersede(operation.itemId, principalKey);
        store.insert(
          {
            category: item.category,
            content: operation.content,
            source: payload?.source ?? item.source,
            evidence: evidenceOf(
              payload?.evidenceMessageIds ??
                item.evidence.map((e) => e.messageId).filter((id): id is string => id !== null),
            ),
            contributedBy: proposal?.botId ?? item.contributedBy,
            confidence: payload?.confidence ?? item.confidence,
            supersedes: item.id,
          },
          principalKey,
        );
        store.markProposal(operation.proposalId, 'applied', {
          op: 'supersede',
          itemId: operation.itemId,
        });
        break;
      }
      case 'keep_both': {
        const item = itemOfBucket(operation.itemId);
        const proposal = store.getProposal(operation.proposalId);
        if (
          item === null ||
          proposal === null ||
          proposal.op !== 'add' ||
          proposal.principalKey !== principalKey ||
          proposal.botId === null
        ) {
          continue;
        }
        // 冲突无法判断：两条都保留 + 为提案来源 Bot 生成 self_note（任务 8）。
        const payload = proposal.payload as {
          content?: string;
          source?: 'explicit' | 'inferred';
          evidenceMessageIds?: string[];
          confidence?: number;
        };
        store.insert(
          {
            category: item.category,
            content: payload.content ?? '',
            source: payload.source ?? 'inferred',
            evidence: evidenceOf(payload.evidenceMessageIds ?? []),
            contributedBy: proposal.botId,
            confidence: payload.confidence ?? 0.5,
          },
          principalKey,
        );
        void deps.memory
          .writeReflectionMemory(proposal.botId, null, {
            kind: 'self_note',
            content: `用户的画像信息存在冲突（${operation.note}），找合适时机向用户确认。`,
            subject: null,
            source: 'inferred',
            evidenceMessageIds: [],
            confidence: 1,
            sensitivity: 'normal',
            evidenceRunId: null,
            // C12: the self_note stays inside the proposal principal's audience.
            sourcePrincipalId: principalKey.length > 0 ? principalKey : null,
          })
          .catch(() => {});
        store.markProposal(operation.proposalId, 'applied', {
          op: 'keep_both',
          itemId: operation.itemId,
        });
        break;
      }
      case 'reject': {
        store.markProposal(operation.proposalId, 'rejected', { reason: operation.reason });
        break;
      }
      default: {
        throw new AppError('INTERNAL', 'unreachable curation op');
      }
    }
  }
  // Retract proposals that the model did not mention explicitly (this bucket
  // only — other principals' pending retracts belong to their own jobs).
  for (const pending of store.pendingProposals(principalKey)) {
    if (pending.op === 'retract') {
      const target = pending.targetItemId;
      const targetItem = target !== null ? itemOfBucket(target) : null;
      if (target !== null && targetItem !== null) {
        store.retract(target, principalKey);
        store.markProposal(pending.id, 'applied', { op: 'retract', itemId: target });
      } else {
        store.markProposal(pending.id, 'applied', { op: 'retract', note: 'target gone' });
      }
    }
  }
}

function renderItems(
  items: Array<{
    id: string;
    category: string;
    content: string;
    source: string;
    createdAt: number;
  }>,
): string {
  if (items.length === 0) return '（空）';
  return items
    .map(
      (item) =>
        `- id=${item.id} category=${item.category} source=${item.source} created=${new Date(item.createdAt).toISOString()}：${item.content}`,
    )
    .join('\n');
}

function renderProposals(
  proposals: Array<{
    id: string;
    op: string;
    botId: string | null;
    targetItemId: string | null;
    payload: Record<string, unknown>;
  }>,
): string {
  if (proposals.length === 0) return '（空）';
  return proposals
    .map((proposal) => {
      const payload = proposal.payload as {
        category?: string;
        content?: string;
        source?: string;
        confidence?: number;
        evidenceMessageIds?: string[];
        targetItemId?: string;
      };
      if (proposal.op === 'retract') {
        return `- id=${proposal.id} op=retract target=${payload.targetItemId ?? proposal.targetItemId ?? ''}`;
      }
      return `- id=${proposal.id} op=add category=${payload.category ?? ''} source=${payload.source ?? ''} confidence=${payload.confidence ?? ''}：${payload.content ?? ''}`;
    })
    .join('\n');
}

const CURATION_PROMPT = [
  'You are the single curator of the shared user profile.',
  'Input: the existing profile entries and pending proposals (add / retract).',
  'Conflict priority: explicitly said by the user > inferred; newer > older.',
  'When a conflict cannot be resolved use keep_both and write a short note for the proposing bot to confirm with the user later.',
  'Reject proposals that are not durable facts about the user, duplicates of existing entries, or sourced from anything but the user.',
  'Then recompile the profile card: a compact third-person summary of the user in the SAME LANGUAGE as the entries, under 400 tokens.',
  'The card MUST keep the user boundaries and hard constraints (allergies, forbidden foods, explicit prohibitions). When space is tight, drop examples and stories first.',
  'Call submit with the operations and the new card.',
].join('\n');
