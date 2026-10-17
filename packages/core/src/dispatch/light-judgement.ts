import { type TSchema } from '@earendil-works/pi-ai';
import type { ZodType } from 'zod';
import {
  AGENT_TRIAGE_TIMEOUT_MS,
  TRIAGE_RECENT_MESSAGES,
  TRIAGE_TIMEOUT_MS,
  type Bot,
  type Message,
} from '@kepcup/shared';
import { completeStructured } from '../agent/structured.js';
import { builtinModelRef, builtinRoute, type LlmRouter } from '../agent/llm-router.js';
import type { AgentEngine, RunIdentity } from '../agent/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { BotsService } from '../domain/bots.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * One lightweight structured judgement (D92 T1a routing): the shared skeleton
 * of the continuation check (the last replier P) and the lead gate — route
 * selection (built-in light model, else the external agent), scheduler
 * submission at priority 0, a run row (`loop_type='triage'`), the structured
 * call with usage recording, and the timeout counted from submission
 * (审查 M6). The skeleton the former per-bot broadcast triage used, now shared
 * by the continuation check and the lead gate (D92 T1a), parameterized.
 */
export interface LightJudgementSpec<T> {
  engine: AgentEngine;
  /**
   * D72 P6 后台路由：无内置模型时改走外部 Agent（一次性精简会话；超时照旧取
   * `fallback`）。缺省 = 只用内置模型。
   */
  router?: LlmRouter;
  scheduler: Scheduler;
  runs: RunsService;
  usage: UsageService;
  settings: SettingsService;
  bots: BotsService;
  messages: MessagesService;
  logger: CoreLogger;
  timeZone: string;
  /** Whose model / identity runs the call (the judged bot, or the lead for the gate). */
  botId: string;
  conversationId: string;
  batchId: string;
  batchMessages: Message[];
  /** Stored on the run row: 'continuation' | 'routing_gate'. */
  triggerReason: 'continuation' | 'routing_gate';
  /** Scheduler key prefix: `${keyPrefix}:${conversationId}:${botId}:${batchId}`. */
  keyPrefix: 'continuation' | 'gate';
  systemPrompt: string;
  /**
   * Builds the user message; `recent` is the bot's own view (shared rows + its
   * private task entries), excluding the batch.
   */
  buildUserMessage(ctx: { bot: Bot; recent: Message[] }): string;
  /** TypeBox schema, for the submit tool. */
  parametersSchema: TSchema;
  /** zod schema, for parsing. */
  schema: ZodType<T>;
  /** Returned on timeout, provider failure, unparsable output, no model, or throttled. */
  fallback: T;
  /** Test override of TRIAGE_TIMEOUT_MS / AGENT_TRIAGE_TIMEOUT_MS (default from constants). */
  timeoutMs?: number;
}

/** Bots already logged as judgement-skipped for lack of a usable model. */
const judgementSkipLogged = new Set<string>();

/** Never rejects — every failure mode resolves with `spec.fallback`. */
export function runLightJudgement<T>(spec: LightJudgementSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (result: T) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const route =
      spec.router !== undefined
        ? spec.router.resolveForBot(spec.botId, 'triage')
        : builtinRoute(
            spec.engine,
            builtinModelRef('triage', spec.settings.get(), spec.bots.get(spec.botId)),
          );
    if (route === null) {
      // D72 P4 / P6：没有内置模型、也没有可用于后台的外部 Agent（或已关闭 /
      // 选了「群聊仅 @ 响应」）时轻量判断跳过（每个 Bot 只记一次 info，避免
      // 每条项目消息刷日志）。
      if (!judgementSkipLogged.has(spec.botId)) {
        judgementSkipLogged.add(spec.botId);
        spec.logger.info(
          { botId: spec.botId },
          'light judgement skipped: no model for background calls',
        );
      }
      finish(spec.fallback);
      return;
    }
    // Agent judgement (审查 C2): throttled per (bot, conversation) — in between
    // the bot answers @ / replies only.
    if (
      spec.router !== undefined &&
      !spec.router.admit(route, 'triage', `${spec.botId}:${spec.conversationId}`)
    ) {
      finish(spec.fallback);
      return;
    }
    const { modelRef, provider } = route;
    const bot = spec.bots.get(spec.botId);
    // A one-shot agent session (cold start included) needs longer (审查 C2).
    const timeoutMs =
      spec.timeoutMs ?? (route.agentId !== null ? AGENT_TRIAGE_TIMEOUT_MS : TRIAGE_TIMEOUT_MS);

    const key = `${spec.keyPrefix}:${spec.conversationId}:${spec.botId}:${spec.batchId}`;
    const controller = new AbortController();
    let started = false;
    // The timeout counts from submission, not from the start (D75 审查 M6):
    // the router waits on this decision, and the job may sit queued for hours
    // behind long tasks filling every slot of its provider. On expiry the
    // caller gets the fallback and a still-queued job is dropped.
    const timeout = setTimeout(() => {
      controller.abort();
      if (!started) spec.scheduler.cancelQueued(key);
      spec.logger.warn(
        { botId: spec.botId, conversationId: spec.conversationId, started },
        'light judgement timed out -> fallback',
      );
      finish(spec.fallback);
    }, timeoutMs);
    timeout.unref?.();
    spec.scheduler.submit({
      priority: 0,
      provider,
      key,
      run: async () => {
        started = true;
        if (settled) {
          clearTimeout(timeout);
          return;
        }
        const run = spec.runs.create({
          botId: spec.botId,
          conversationId: spec.conversationId,
          loopType: 'triage',
          triggerReason: spec.triggerReason,
          triggerMessageIds: spec.batchMessages.map((m) => m.id),
        });
        try {
          if (!bot) throw new Error('judgement target vanished');
          spec.runs.update(run.id, { status: 'running' });

          // D75 §2.4.3: the judging bot's view — shared rows + its own
          // private task entries, never another member's.
          const recent = spec.messages.listForBot(spec.conversationId, spec.botId, {
            limit: TRIAGE_RECENT_MESSAGES,
          });
          const recentFiltered = recent.filter(
            (m) => !spec.batchMessages.some((b) => b.id === m.id) && m.status !== 'recalled',
          );
          const result = await completeStructured({
            complete: (req) => route.engine.complete(req),
            resolveRoute: () =>
              spec.router !== undefined
                ? spec.router.resolveForBot(spec.botId, 'triage')
                : builtinRoute(
                    spec.engine,
                    builtinModelRef('triage', spec.settings.get(), spec.bots.get(spec.botId)),
                  ),
            identity: {
              runId: run.id,
              botId: spec.botId,
              conversationId: spec.conversationId,
              loopType: 'triage',
            } satisfies RunIdentity,
            model: modelRef,
            systemPrompt: spec.systemPrompt,
            messages: [
              {
                role: 'user',
                content: spec.buildUserMessage({ bot, recent: recentFiltered }),
                timestamp: Date.now(),
              },
            ],
            parametersSchema: spec.parametersSchema,
            schema: spec.schema,
            signal: controller.signal,
            onUsage: (usage) => {
              if (!usage) return;
              spec.usage.record({
                runId: run.id,
                botId: spec.botId,
                conversationId: spec.conversationId,
                loopType: 'triage',
                provider,
                model: modelRef.slice(provider.length + 1),
                inputTokens: usage.input,
                outputTokens: usage.output,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                costUsd: usage.costUsd,
              });
            },
          });
          spec.runs.update(run.id, { status: 'completed' });
          finish(result);
        } catch (error) {
          spec.logger.warn(
            {
              botId: spec.botId,
              conversationId: spec.conversationId,
              error: error instanceof Error ? error.message : String(error),
            },
            'light judgement failed -> fallback',
          );
          try {
            spec.runs.update(run.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Core shutting down: the run row stays interrupted via recovery.
          }
          finish(spec.fallback);
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  });
}
