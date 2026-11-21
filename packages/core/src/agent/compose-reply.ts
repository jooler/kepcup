import { AppError, type Bot } from '@kepcup/shared';
import type { LlmRoute } from './llm-router.js';
import type { RunIdentity } from './types.js';
import type { RunsService } from '../domain/runs.js';
import type { UsageService } from '../domain/usage.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * Host-composed one-shot reply (T10 `bots.composeReply`): a NO-TOOL light
 * generation in the persona of one bot. A general capability any host may call
 * (an away-reply composer is only one caller) — this module knows nothing about
 * the calling scenario and injects NOTHING from the local brain: no memory
 * sections, no user profile, no tools. The caller owns the instructions and
 * their content boundaries; the model chain and bookkeeping follow the
 * light-judgement precedent (dispatch/light-judgement.ts): one run row
 * (`loop_type='triage'`, `conversation_id` NULL — the call is not attached to a
 * conversation) created BEFORE the model call, usage recorded against
 * `usage_ledger.run_id`, failed calls leave a failed run (same shape).
 */

export interface ComposeReplyDeps {
  /** Resolved route (light chain, same resolution as the triage calls). */
  route: LlmRoute | null;
  runs: RunsService;
  usage: UsageService;
  logger: Pick<CoreLogger, 'warn'>;
}

export interface ComposeReplyInput {
  /** The bot whose persona speaks (its profile fields are the ONLY injected source). */
  bot: Bot;
  /** Rendered as dialogue lines, one per entry, in order. */
  transcript: ReadonlyArray<{ speaker: string; text: string }>;
  /** The caller's instructions for this round, injected verbatim. */
  instructions: string;
}

/** Persona section: the bot profile fields only (no local-memory injection). */
function personaSystemPrompt(bot: Bot): string {
  const persona = bot.profile.persona;
  const identity = [
    `你是「${bot.profile.identity.name}」。`,
    bot.profile.identity.bio.trim().length > 0 ? `简介：${bot.profile.identity.bio.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const personaLines = [
    persona.personality && `性格：${persona.personality}`,
    persona.tone && `语气：${persona.tone}`,
    persona.style && `风格：${persona.style}`,
    persona.values && `价值观：${persona.values}`,
    persona.sample_dialogues && `示例对话：\n${persona.sample_dialogues}`,
  ].filter(Boolean);
  const boundaries =
    bot.profile.boundaries.length > 0
      ? `边界（不得越过的红线）：\n${bot.profile.boundaries.map((line) => `- ${line}`).join('\n')}`
      : '';
  const capabilityLine =
    '这是一次无工具的纯文本回复：你没有挂载任何工具，不要提及或尝试调用任何工具，只输出要回复的正文本身（不要前缀、不要解释）。';
  return [
    '<identity>',
    identity,
    '</identity>',
    personaLines.length > 0 ? `<persona>\n${personaLines.join('\n')}\n</persona>` : '',
    boundaries,
    capabilityLine,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Dialogue transcript + the caller's instructions, rendered as one user turn. */
function composeUserMessage(input: ComposeReplyInput): string {
  const transcript = input.transcript
    .map((entry) => `${entry.speaker}：${entry.text}`)
    .join('\n');
  return [
    '<transcript>',
    transcript,
    '</transcript>',
    '<instructions>',
    input.instructions,
    '</instructions>',
  ].join('\n');
}

/**
 * One no-tool light generation in the bot's persona. Throws on provider
 * failure (the run row is left failed — the light-judgement failure shape);
 * a model-less core refuses before any run is created.
 */
export async function composeBotReply(
  deps: ComposeReplyDeps,
  input: ComposeReplyInput,
): Promise<{ text: string }> {
  const route = deps.route;
  if (route === null) {
    throw new AppError('PROVIDER_UNAVAILABLE', '没有可用的轻量模型');
  }
  // The run exists BEFORE the model call so usage_ledger.run_id is never null
  // (T10 验收). conversationId stays NULL: the call has no conversation of its
  // own; the caller renders / forwards the text wherever it belongs.
  const run = deps.runs.create({
    botId: input.bot.id,
    conversationId: null,
    loopType: 'triage',
    triggerReason: 'background',
    triggerMessageIds: [],
    principalId: null,
  });
  try {
    deps.runs.update(run.id, { status: 'running' });
    const identity = {
      runId: run.id,
      botId: input.bot.id,
      conversationId: null,
      loopType: 'triage',
    } satisfies RunIdentity;
    // No `tools` field on the request: the model gets an empty tool surface.
    const result = await route.engine.complete({
      identity,
      model: route.modelRef,
      systemPrompt: personaSystemPrompt(input.bot),
      messages: [
        { role: 'user', content: composeUserMessage(input), timestamp: Date.now() },
      ],
    });
    if (result.usage) {
      deps.usage.record({
        runId: run.id,
        botId: input.bot.id,
        conversationId: null,
        loopType: 'triage',
        provider: route.provider,
        model: route.modelRef.slice(route.provider.length + 1),
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead,
        cacheWriteTokens: result.usage.cacheWrite,
        costUsd: result.usage.costUsd,
      });
    }
    deps.runs.update(run.id, { status: 'completed' });
    return { text: result.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn({ botId: input.bot.id, runId: run.id, error: message }, 'compose reply failed');
    try {
      deps.runs.update(run.id, { status: 'failed', error: message });
    } catch {
      // Core shutting down: recovery marks the run interrupted.
    }
    throw error;
  }
}
