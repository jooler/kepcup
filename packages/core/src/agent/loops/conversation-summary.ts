import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { AppError } from '@kepcup/shared';
import { completeStructured } from '../structured.js';
import type { AgentEngine } from '../types.js';
import type { JobsService, JobRow } from '../../domain/jobs.js';
import type { MessagesService } from '../../domain/messages.js';
import type { ConversationsService } from '../../domain/conversations.js';
import type { UsageService } from '../../domain/usage.js';
import type { BotsService } from '../../domain/bots.js';
import type { SettingsService } from '../../domain/settings.js';
import type { RunsService } from '../../domain/runs.js';
import type { CoreLogger } from '../../infra/logger.js';

const summaryOutputSchema = z.object({
  summary: z.string().min(1).max(4000),
});
const summaryParametersSchema = Type.Object({
  summary: Type.String({ description: '不超过 800 字的对话滚动摘要' }),
});

const SUMMARY_PROMPT = [
  'You maintain a rolling summary of a chat conversation.',
  'Input: the previous summary and the messages that it does not cover yet.',
  'Merge the new information into a single concise summary (max 800 characters; use the language of the conversation).',
  'Keep durable facts (preferences, decisions, open threads, commitments); drop small talk.',
  'Call the submit tool with the new summary.',
].join('\n');

/**
 * conversation_summary background loop (light model, structured output):
 * covers everything the summary does not yet include up to the recorded
 * target, then advances summary_upto_seq.
 */
export async function runConversationSummaryJob(deps: {
  engine: AgentEngine;
  settings: SettingsService;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  usage: UsageService;
  runs: RunsService;
  jobs: JobsService;
  logger: CoreLogger;
  job: JobRow;
}): Promise<void> {
  const { job } = deps;
  if (job.conversation_id === null) {
    throw new AppError('INVALID_INPUT', 'Summary job has no conversation');
  }
  const conv = deps.conversations.get(job.conversation_id);
  if (!conv) throw new AppError('NOT_FOUND', 'Conversation no longer exists');

  const payload = JSON.parse(job.payload_json) as { targetSeq?: number };
  const targetSeq = payload.targetSeq ?? conv.lastSeq;
  const run = deps.runs.create({
    botId: job.bot_id,
    conversationId: job.conversation_id,
    loopType: 'conversation_summary',
    triggerReason: 'background',
    triggerMessageIds: [],
  });
  deps.runs.update(run.id, { status: 'running' });

  try {
    const pending = deps.messages.unsummarized(job.conversation_id, targetSeq);
    if (pending.length === 0) {
      deps.runs.update(run.id, { status: 'completed' });
      return;
    }

    const settings = deps.settings.get();
    const lightRef = settings.defaultLightModel || settings.defaultMainModel;
    if (lightRef.length === 0) {
      throw new AppError('PROVIDER_UNAVAILABLE', '未配置轻量模型');
    }

    const result = await completeStructured({
      complete: (req) => deps.engine.complete(req),
      identity: {
        runId: run.id,
        botId: job.bot_id,
        conversationId: job.conversation_id,
        loopType: 'conversation_summary',
      },
      model: lightRef,
      systemPrompt: SUMMARY_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<previous_summary>\n${conv.summary ?? '（无）'}\n</previous_summary>\n\n<new_messages>\n${renderForSummary(pending)}\n</new_messages>`,
          timestamp: Date.now(),
        },
      ],
      parametersSchema: summaryParametersSchema,
      schema: summaryOutputSchema,
      onUsage: (usage) => {
        if (!usage) return;
        deps.usage.record({
          runId: run.id,
          botId: job.bot_id,
          conversationId: job.conversation_id,
          loopType: 'conversation_summary',
          provider: lightRef.slice(0, lightRef.indexOf('/')),
          model: lightRef.slice(lightRef.indexOf('/') + 1),
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          costUsd: usage.costUsd,
        });
      },
    });

    const covered = Math.max(...pending.map((m) => m.seq));
    deps.messages.setSummary(job.conversation_id, result.summary, covered);
    deps.runs.update(run.id, { status: 'completed' });
  } catch (error) {
    deps.runs.update(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function renderForSummary(messages: Array<{ id: string; createdAt: number; senderType: string; senderBotId: string | null; content: unknown }>): string {
  return messages
    .map((m) => {
      const sender =
        m.senderType === 'user' ? '用户' : m.senderType === 'system' ? '系统' : (m.senderBotId ?? 'bot');
      const content = m.content as { text?: string } | null;
      return `[${m.id} | ${new Date(m.createdAt).toISOString()} | ${sender}] ${content?.text ?? ''}`;
    })
    .join('\n');
}
