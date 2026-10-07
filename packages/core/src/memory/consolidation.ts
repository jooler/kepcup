import { MEMORY_CONSOLIDATION_BATCH } from '@kepcup/shared';
import { completeStructured } from '../agent/structured.js';
import type { AgentEngine } from '../agent/types.js';
import type { Clock } from '../infra/clock.js';
import type { JobRow } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { CoreLogger } from '../infra/logger.js';
import type { MemoryKind } from '@kepcup/shared';
import {
  consolidationOutputSchema,
  consolidationParametersSchema,
  type ConsolidationOutput,
} from './schemas.js';
import type { MemoryService } from './service.js';
import { localDateKey } from './local-date.js';
import { lightModelRef } from './reflection.js';
import { builtinModelRefOrNull, recordLoopUsage, type LoopUsageDeps } from './loop-utils.js';

export interface ConsolidationJobDeps extends LoopUsageDeps {
  engine: AgentEngine;
  settings: SettingsService;
  runs: RunsService;
  usage: UsageService;
  memory: MemoryService;
  logger: CoreLogger;
  job: JobRow;
  timeZone: string;
  clock: Clock;
}

const CONSOLIDATION_KINDS: MemoryKind[] = [
  'fact',
  'preference',
  'commitment',
  'feedback',
  'episode',
  'lesson',
  'self_note',
];

/**
 * memory_consolidation background loop (docs/dev/phases/P07-memory.md 任务 9):
 * once per bot per local day. Expired items are superseded directly (no
 * model); the model merges near-duplicates and summarizes episodes per kind
 * batch. Reflection-style loops never throw into the conversation.
 */
export async function runConsolidationJob(deps: ConsolidationJobDeps): Promise<void> {
  const botId = deps.job.bot_id;
  if (botId === null) throw new Error('memory_consolidation job requires a bot');
  if (!deps.memory.hasMemoryDb(botId)) return; // nothing to consolidate

  const store = deps.memory.storeFor(botId);
  // D72 P4：没有内置模型时只做不经模型的过期失效，跳过合并（不建 run）。
  if (builtinModelRefOrNull(deps.settings, 'light') === null) {
    const expired = store.expirePastValidUntil(deps.clock.now());
    // Recorded like a finished consolidation: the hourly scheduler only
    // deduplicates pending jobs and would otherwise re-enqueue every hour.
    store.setMeta(
      'last_consolidation_date',
      localDateKey(new Date(deps.clock.now()), deps.timeZone),
    );
    deps.logger.info({ botId, expired }, 'memory consolidation skipped: no built-in model');
    return;
  }
  const run = deps.runs.create({
    botId,
    conversationId: null,
    loopType: 'memory_consolidation',
    triggerReason: 'background',
    triggerMessageIds: [],
  });
  deps.runs.update(run.id, { status: 'running' });

  try {
    // 过期条目直接失效，不经模型（任务 9）。
    const now = deps.clock.now();
    const expired = store.expirePastValidUntil(now);
    if (expired > 0) {
      deps.logger.info({ botId, expired }, 'consolidation expired items');
    }

    const lightRef = lightModelRef(deps.settings);
    for (const kind of CONSOLIDATION_KINDS) {
      const batch = store.activeByKind(kind, MEMORY_CONSOLIDATION_BATCH);
      if (batch.length < 2) continue; // nothing to merge in this batch
      const output = await completeStructured<ConsolidationOutput>({
        complete: (req) => deps.engine.complete(req),
        identity: { runId: run.id, botId, conversationId: null, loopType: 'memory_consolidation' },
        model: lightRef,
        systemPrompt: CONSOLIDATION_PROMPT,
        messages: [
          {
            role: 'user',
            content: `<items kind="${kind}">\n${batch
              .map(
                (item) =>
                  `- id=${item.id} created=${new Date(item.createdAt).toISOString()}：${item.content}`,
              )
              .join('\n')}\n</items>`,
            timestamp: Date.now(),
          },
        ],
        parametersSchema: consolidationParametersSchema,
        schema: consolidationOutputSchema,
        onUsage: (usage) => recordLoopUsage(deps, run.id, 'memory_consolidation', lightRef, usage),
      });
      // Awaited: the job (and the date below) settles only after the merges and
      // their vector writes; their errors fail the run and the job.
      await applyOperations(deps, botId, output);
    }

    store.setMeta(
      'last_consolidation_date',
      localDateKey(new Date(deps.clock.now()), deps.timeZone),
    );
    deps.runs.update(run.id, { status: 'completed' });
  } catch (error) {
    deps.runs.update(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Latest non-null timestamp, or null when no item carries one. */
function latestOf(
  items: Array<{ dueAt: number | null; validUntil: number | null }>,
  pick: (item: { dueAt: number | null; validUntil: number | null }) => number | null,
): number | null {
  const values = items.map(pick).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Merging must not launder constraints away (BR-P07-002): sensitivity and
 * privacy take the strongest value (any sensitive ⇒ sensitive, any private ⇒
 * private), due/valid dates keep the LATEST so a merged commitment never
 * becomes due (or expire) earlier than any of its sources.
 */
async function applyOperations(
  deps: ConsolidationJobDeps,
  botId: string,
  output: ConsolidationOutput,
): Promise<void> {
  for (const operation of output.operations) {
    // Re-acquired per operation: embedItem awaits the embedder in between and
    // the db pool may evict (close) the connection (BR-P07-005).
    const store = deps.memory.storeFor(botId);
    switch (operation.op) {
      case 'merge': {
        const items = operation.itemIds
          .map((id) => store.getItem(id))
          .filter(
            (item): item is NonNullable<typeof item> => item !== null && item.status === 'active',
          );
        if (items.length < 2) continue;
        for (const item of items) store.supersede(item.id);
        const merged = store.insert({
          kind: items[0]!.kind,
          content: operation.content,
          subject: null,
          source: items.some((item) => item.source === 'explicit') ? 'explicit' : 'inferred',
          evidence: items.flatMap((item) => item.evidence),
          origin: items[0]!.origin,
          originConversationId: items[0]!.originConversationId,
          confidence: Math.max(...items.map((item) => item.confidence)),
          sensitivity: items.some((item) => item.sensitivity === 'sensitive')
            ? 'sensitive'
            : 'normal',
          privateToBot: items.some((item) => item.privateToBot),
          dueAt: latestOf(items, (item) => item.dueAt),
          validUntil: latestOf(items, (item) => item.validUntil),
          supersedes: items[0]!.id,
        });
        // The consolidation product must stay KNN-searchable (BR-P07-002).
        await deps.memory.embedItem(botId, merged);
        break;
      }
      case 'expire': {
        for (const id of operation.itemIds) {
          const item = store.getItem(id);
          if (item !== null && item.status === 'active') store.supersede(id);
        }
        break;
      }
      case 'summarize_episodes': {
        const items = operation.itemIds
          .map((id) => store.getItem(id))
          .filter(
            (item): item is NonNullable<typeof item> => item !== null && item.status === 'active',
          );
        if (items.length === 0) continue;
        for (const item of items) store.supersede(item.id);
        const summarized = store.insert({
          kind: 'episode',
          content: operation.content,
          subject: null,
          source: 'inferred',
          evidence: items.flatMap((item) => item.evidence),
          origin: items[0]!.origin,
          originConversationId: items[0]!.originConversationId,
          confidence: 0.9,
          sensitivity: items.some((item) => item.sensitivity === 'sensitive')
            ? 'sensitive'
            : 'normal',
          privateToBot: items.some((item) => item.privateToBot),
          validUntil: latestOf(items, (item) => item.validUntil),
        });
        await deps.memory.embedItem(botId, summarized);
        break;
      }
    }
  }
}

const CONSOLIDATION_PROMPT = [
  'You consolidate one kind of a bot\'s memories (the "sleep" pass).',
  'merge: several entries saying the same thing become one entry (keep the wording, not a list).',
  'expire: entries that are no longer true or useful.',
  'summarize_episodes: compress a series of related episodes into one milestone summary.',
  'Be conservative: when in doubt, keep the entries untouched (empty operations).',
  'Call submit with the operations.',
].join('\n');
