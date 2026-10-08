import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { AppError } from '@kepcup/shared';
import { routeFor, type LlmRouter } from '../llm-router.js';
import { completeStructured } from '../structured.js';
import {
  TASK_QUESTION_EVENT,
  TASK_UNDELIVERED_EVENT,
  taskUndeliveredLine,
} from '../context/conversation.js';
import { neutralizeUntrusted } from '../../infra/data-boundary.js';
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
  /** D72 P6：无内置模型时改走外部 Agent（降频）；缺省只用内置模型。 */
  router?: LlmRouter | undefined;
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
  // D72 P4 / P6：没有内置模型时改走后台 Agent；也没有（或已关闭）时跳过，
  // 不产生失败 run。只有外部 Agent 时每 AGENT_BACKGROUND_EVERY_N_RUNS 次触发
  // 一跑（未摘要的消息留给下一次，摘要覆盖到届时的 targetSeq）。
  // 直聊的摘要按该 Bot 选后台 Agent（自动模式下优先它自己的 Agent）。
  const ownerBotId = job.bot_id ?? conv.directBotId ?? null;
  const route = routeFor(deps, 'summary', ownerBotId);
  if (route === null) {
    deps.logger.info(
      { conversationId: job.conversation_id },
      'conversation summary skipped: no model for background calls',
    );
    return;
  }
  if (deps.router !== undefined && !deps.router.admit(route, 'summary', job.conversation_id)) {
    deps.logger.info(
      { conversationId: job.conversation_id },
      'conversation summary skipped: agent background throttle',
    );
    return;
  }
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

    const lightRef = route.modelRef;
    const result = await completeStructured({
      complete: (req) => route.engine.complete(req),
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
          // Agent rows are charged to the owning bot (审查 C5); built-in rows
          // keep the pre-P6 attribution.
          botId: route.agentId !== null ? ownerBotId : job.bot_id,
          conversationId: job.conversation_id,
          loopType: 'conversation_summary',
          provider: route.provider,
          model: lightRef.slice(route.provider.length + 1),
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

export function renderForSummary(
  messages: Array<{
    id: string;
    createdAt: number;
    senderType: string;
    senderBotId: string | null;
    content: unknown;
    taskId?: string | null;
  }>,
): string {
  return messages
    .map((m) => {
      const event = m.content as { event?: unknown; text?: unknown; taskBotId?: unknown } | null;
      if (m.senderType === 'system' && event?.event === TASK_QUESTION_EVENT) {
        // A task's question is its model output, not the system's (D75 审查 H1).
        const botId = typeof event.taskBotId === 'string' ? event.taskBotId : 'bot';
        const text = typeof event.text === 'string' ? event.text : '';
        return `[${m.id} | ${new Date(m.createdAt).toISOString()} | ${botId}（任务 ${m.taskId ?? ''}）向用户提问] <untrusted>${neutralizeUntrusted(text)}</untrusted>`;
      }
      if (m.senderType === 'system' && event?.event === TASK_UNDELIVERED_EVENT) {
        // The notice quotes the model-chosen task title for the user: the
        // summarizer gets the fixed line bots get (审查 L-2).
        return `[${m.id} | ${new Date(m.createdAt).toISOString()} | 系统] ${taskUndeliveredLine(m.taskId ?? '')}`;
      }
      const sender =
        m.senderType === 'user'
          ? '用户'
          : m.senderType === 'system'
            ? '系统'
            : (m.senderBotId ?? 'bot');
      const content = m.content as { text?: string } | null;
      return `[${m.id} | ${new Date(m.createdAt).toISOString()} | ${sender}] ${content?.text ?? ''}`;
    })
    .join('\n');
}
