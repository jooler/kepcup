import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Message as PiAgentMessage } from '@earendil-works/pi-ai';
import {
  TASK_CONTEXT_SUMMARY_OUTPUT_TOKENS,
  TASK_IDLE_STOP_AFTER,
  TASK_IDLE_WARN_AFTER,
  TASK_IDLE_WINDOW_CALLS,
} from '@kepcup/shared';
import { executeToolSafely, toolResultBlocks } from './tool-execution.js';
import { buildModelRegistry, mapProviderError, resolveModel } from './models.js';
import { modelSessionId } from './model-session-id.js';
import { TaskContextCompactor } from './context/compaction.js';
import { LoopGuard } from './loop-guard.js';
import { estimateTokens } from './tokens.js';
import {
  buildUpdatePlanTool,
  currentPlanPrompt,
  currentPlanText,
  type PlanState,
} from '../tools/plan-tools.js';
import type {
  AgentEngine,
  CompletionRequest,
  CompletionResult,
  EngineEvent,
  EngineMessage,
  EngineUsage,
  RunHandle,
  RunOutcome,
  RunSpec,
  ToolContext,
} from './types.js';
import type { SettingsService } from '../domain/settings.js';
import type { SecretsService } from '../domain/secrets.js';
import type { CoreLogger } from '../infra/logger.js';
import {
  createRetryingFetch,
  isModelRouteChangedError,
  ModelRouteChangedError,
  retryProgressText,
  type ModelRetryPolicy,
} from './model-retry.js';
import type { EffectRecorder } from './effects/recorder.js';

interface Deps {
  settings: SettingsService;
  secrets: SecretsService;
  logger: CoreLogger;
  /** Model request retry policy (model-retry.ts); defaults to MODEL_RETRY_*. */
  modelRetry?: ModelRetryPolicy;
  /** W2 外部副作用台账（runs.db tool_effects）；缺省不记账。 */
  effects?: EffectRecorder;
}

function retryContext(
  model: { provider: string; id: string },
  runId: string | null,
): { runId: string | null; provider: string; model: string; baseUrl?: string } {
  const baseUrl = (model as { baseUrl?: unknown }).baseUrl;
  return {
    runId,
    provider: model.provider,
    model: model.id,
    ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
  };
}

interface UsageShape {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * AgentEngine on top of pi (@earendil-works/pi-agent-core + pi-ai).
 * Business code never imports pi directly, only this module.
 * pi's createAgentSession / session storage is not used by design.
 */
export class PiEngine implements AgentEngine {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  startRun(spec: RunSpec): RunHandle {
    const models = buildModelRegistry({
      settings: this.#deps.settings.get(),
      secrets: this.#deps.secrets,
      logger: this.#deps.logger,
    });
    const model = resolveModel(models, spec.model);
    // P11 browser_screenshot: images only reach models that accept them
    // (docs/dev/phases/P11-browser.md: 不支持时只返回页面快照文本).
    const acceptsImages =
      ((model as { input?: unknown }).input as readonly string[] | undefined)?.includes('image') ===
      true;

    // The handle does not exist when tools are built, so tools capture it
    // through this mutable reference (assigned right after construction).
    let handleRef: RunHandleImpl | null = null;

    // D93: run-scoped plan state. Only built-in pi tasks get update_plan;
    // external agents have native todo tools and subagents have bounded runs.
    let planState: PlanState | null = null;
    const planTool =
      spec.identity.loopType === 'task'
        ? buildUpdatePlanTool({
            getPlan: () => planState,
            setPlan: (state) => {
              planState = state;
            },
            onProgress: (text) => handleRef?.emit({ type: 'progress', payload: { text } }),
          })
        : null;
    const runTools = planTool === null ? spec.tools : [...spec.tools, planTool];

    // D93 §5.2：任务空转检测。只对内置 pi 任务启用；子代理有轮数 / 时限上限。
    const taskLoop = spec.taskLoop;
    const loopGuard =
      spec.identity.loopType === 'task' && taskLoop?.idleGuardEnabled !== false
        ? new LoopGuard({
            warnAfter: taskLoop?.idleWarnAfter ?? TASK_IDLE_WARN_AFTER,
            stopAfter: taskLoop?.idleStopAfter ?? TASK_IDLE_STOP_AFTER,
            windowCalls: taskLoop?.idleWindowCalls ?? TASK_IDLE_WINDOW_CALLS,
          })
        : null;

    const piTools = runTools.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal,
        onUpdate?: (r: unknown) => void,
      ) => {
        const handle = handleRef!;
        const ctx: ToolContext = {
          identity: spec.identity,
          toolCallId: String(toolCallId),
          signal,
          terminate: (reason) => handle.markTerminated(reason),
          progress: (text) => handle.emit({ type: 'progress', payload: { text } }),
        };
        void onUpdate;

        // D93 §5.2: the same call + result repeated past the stop threshold is
        // not executed again. A second blocked repeat fails the task.
        const guardCheck = loopGuard?.check(tool.name, params);
        if (guardCheck?.block === true) {
          const message = guardCheck.fatal
            ? '检测到被阻止的重复操作仍在继续：任务中止（LOOP_DETECTED）。请换一种方法，或把当前进展写进结果。'
            : '检测到重复操作（LOOP_DETECTED）：本次调用没有执行。请停止重复，改用其他做法或直接给出结果。';
          const blocked = {
            ok: false,
            content: message,
            errorCode: 'LOOP_DETECTED' as const,
          };
          handle.emit({
            type: 'tool_result',
            payload: {
              toolCallId: String(toolCallId),
              toolName: tool.name,
              ok: false,
              content: blocked.content,
              errorCode: blocked.errorCode,
            },
          });
          if (guardCheck.fatal) {
            handle.fail({ code: 'LOOP_DETECTED', message });
          } else {
            handle.emit({
              type: 'progress',
              payload: { text: '检测到重复操作，请换一种方法' },
            });
          }
          // Do not terminate the batch: the model must see the error and pick
          // another approach (a second blocked repeat fails the run above).
          return { content: toolResultBlocks(blocked, acceptsImages) };
        }

        // Tool failures never break the loop: they return as tool output.
        const result = await executeToolSafely(
          tool,
          params,
          ctx,
          this.#deps.effects,
          spec.toolOutputSpill,
        );
        const guardRecord = loopGuard?.record(tool.name, params, {
          ok: result.ok,
          content: result.content,
        });
        if (guardRecord?.warn === true) {
          result.content = `${result.content}\n\n[空转提醒] 相同的调用与结果已重复 ${guardRecord.count} 次：请换一种做法，或把当前进展写进结果，不要继续重复。`;
          handle.emit({
            type: 'progress',
            payload: { text: '检测到重复操作，请换一种方法' },
          });
        }
        handle.emit({
          type: 'tool_result',
          payload: {
            toolCallId: String(toolCallId),
            toolName: tool.name,
            ok: result.ok,
            content: result.content,
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
            // W2: a tool-reported effect outcome (MCP transport failure) counts too.
            ...((result.outcome ?? result.effect?.outcome) !== undefined
              ? { outcome: result.outcome ?? result.effect?.outcome }
              : {}),
            ...(result.sensitiveParams !== undefined && result.sensitiveParams.length > 0
              ? { sensitiveParams: result.sensitiveParams }
              : {}),
          },
        });
        return {
          content: toolResultBlocks(result, acceptsImages),
          ...(result.terminate ? { terminate: true } : {}),
        };
      },
    }));

    // D93: automatic context compaction for built-in task / subagent runs.
    // The compactor only shapes the transcript this request sees; run_steps
    // keep the full process (design 43 §3.4).
    const compaction = spec.compaction;
    const compactor =
      compaction !== undefined &&
      (spec.identity.loopType === 'task' || spec.identity.loopType === 'subagent')
        ? new TaskContextCompactor({
            contextWindow: Number((model as { contextWindow?: unknown }).contextWindow ?? 0),
            maxOutputTokens: Number((model as { maxTokens?: unknown }).maxTokens ?? 0),
            toolSchemaReserveTokens: Math.max(
              0,
              estimateTokens(
                JSON.stringify(
                  piTools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                ),
              ),
            ),
            taskBrief: spec.messages[0]?.content ?? '',
            currentPlan: () => currentPlanText(planState),
            complete: async ({ systemPrompt, userText, signal }) => {
              if (compaction.modelRef.length === 0) throw new Error('no compaction model');
              const result = await (compaction.engine ?? this).complete({
                identity: spec.identity,
                model: compaction.modelRef,
                systemPrompt,
                messages: [{ role: 'user', content: userText, timestamp: Date.now() }],
                maxTokens: TASK_CONTEXT_SUMMARY_OUTPUT_TOKENS,
                signal,
                ...(compaction.isRouteCurrent !== undefined
                  ? { isRouteCurrent: compaction.isRouteCurrent }
                  : {}),
              });
              if (result.usage !== null) compaction.onUsage?.([result.usage]);
              return { text: result.text, usage: result.usage };
            },
            onProgress: (text) => handleRef?.emit({ type: 'progress', payload: { text } }),
            logger: this.#deps.logger,
          })
        : null;

    const agent = new Agent({
      initialState: {
        systemPrompt: '', // refreshed by prepareRequest before every request
        model,
        tools: piTools as unknown as AgentTool[],
        messages: spec.messages.map((m) => ({
          role: 'user',
          content: buildUserMessageContent(m.content, m.images, acceptsImages),
          timestamp: m.timestamp,
        })),
      },
      streamFn: (m, context, options) =>
        models.streamSimple(m, context, {
          ...options,
          // Opaque keyed id, stable per (provider, conversation/Bot, loop): pi-ai
          // sends it as OpenCode's `x-opencode-session` and as other providers'
          // session-affinity headers / prompt-cache keys (model-session-id.ts).
          sessionId: modelSessionId(() => this.#deps.secrets.modelSessionKey(), {
            provider: m.provider,
            identity: spec.identity,
            call: 'loop',
          }),
          // Retries (network + 408/409/429/5xx, Retry-After, backoff) happen
          // before the first token; each one shows on the run status line.
          // A model change for this run's Bot (spec.isRouteCurrent) stops us
          // hammering the old provider mid-backoff.
          fetch: createRetryingFetch({
            ...(this.#deps.modelRetry ? { policy: this.#deps.modelRetry } : {}),
            logger: this.#deps.logger,
            context: retryContext(model, spec.identity.runId),
            ...(options?.fetch ? { inner: options.fetch } : {}),
            ...(spec.isRouteCurrent ? { shouldContinueRetry: spec.isRouteCurrent } : {}),
            onRetry: (notice) =>
              handleRef?.emit({ type: 'progress', payload: { text: retryProgressText(notice) } }),
            onRecovered: () =>
              handleRef?.emit({ type: 'progress', payload: { text: '已重新连接模型服务' } }),
          }),
        }),
      steeringMode: 'all',
    });

    // The transcript's leading system message is the prompt; refresh it right
    // before every request so stateful sections stay current.
    agent.prepareRequest = async ({ context }) => {
      const basePrompt = await spec.buildSystemPrompt();
      // D93: the plan is model-owned execution state, re-injected every turn
      // (and never part of the compaction summary).
      const plan = currentPlanPrompt(planState);
      const systemPrompt = plan.length > 0 ? `${basePrompt}\n\n${plan}` : basePrompt;
      const messages = [...context.messages];
      const first = messages[0] as { role: string } | undefined;
      if (first?.role === 'system') {
        messages[0] = { ...(first as object), content: systemPrompt } as (typeof messages)[number];
      } else {
        messages.unshift({ role: 'system', content: systemPrompt } as (typeof messages)[number]);
      }
      return { context: { ...context, messages } };
    };

    // D93: transformContext runs before convertToLlm on every model request.
    // Contract: never throw / reject — a broken compaction degrades to the
    // untouched transcript and the task keeps running.
    agent.transformContext = async (messages, signal) => {
      if (compactor === null) return messages;
      try {
        const result = await compactor.transform(messages as PiAgentMessage[], signal);
        return result.messages as typeof messages;
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'task context compaction failed; using the original transcript',
        );
        return messages;
      }
    };

    // Full request payload (messages + tools) for the run_steps `request`
    // record — "模型看到的一切都在日志里" (docs/dev/03-data-model.md).
    agent.onPayload = (payload) => {
      handleRef!.emit({ type: 'request', payload });
      return undefined;
    };

    let turns = 0;
    let softBudgetWarned = false;
    let softBudgetReached = false;
    agent.finishTurn = async () => {
      turns += 1;
      // D93 §5.1: task token soft budget. 0 = off; never abort, only converge.
      const budget = taskLoop?.tokenSoftBudget ?? 0;
      if (budget > 0 && spec.identity.loopType === 'task' && handleRef !== null) {
        const used = handleRef.tokensSoFar();
        if (used >= budget && !softBudgetReached) {
          softBudgetReached = true;
          handleRef.steer(
            'token 软预算已到上限：请立即收敛，停止新增探索，在下一轮给出最终结果（写清已完成、未完成与验证结果）。',
          );
        } else if (used >= budget * 0.8 && !softBudgetWarned && !softBudgetReached) {
          softBudgetWarned = true;
          handleRef.steer(
            'token 预算接近上限：先收敛，把剩余步骤与未完成项写进结果，避免继续扩大范围。',
          );
        }
      }
      // maxTurns ≤ 0 = unlimited (supervisor turns and task Agent loops).
      if (spec.limits.maxTurns > 0 && turns >= spec.limits.maxTurns) return { action: 'end' };
      return undefined;
    };

    const handle = new RunHandleImpl(spec, agent, () => loopGuard?.reset());
    handleRef = handle;
    // The transcript already carries the trigger messages; continue() starts
    // the loop from them (prompt() would append a duplicate user message).
    void agent.continue().catch(() => {
      // Failures surface through agent_end / state.errorMessage.
    });
    return handle;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const models = buildModelRegistry({
      settings: this.#deps.settings.get(),
      secrets: this.#deps.secrets,
      logger: this.#deps.logger,
    });
    const model = resolveModel(models, req.model);
    try {
      const result = await models.complete(
        model,
        {
          systemPrompt: req.systemPrompt,
          messages: req.messages.map((m) => ({
            role: 'user',
            content: m.content,
            timestamp: m.timestamp,
          })),
          tools: (req.tools ?? []) as never,
        },
        {
          maxTokens: req.maxTokens,
          signal: req.signal,
          // See startRun; a separate purpose from the agent loop's prompt prefix.
          sessionId: modelSessionId(() => this.#deps.secrets.modelSessionKey(), {
            provider: model.provider,
            identity: req.identity,
            call: 'oneshot',
          }),
          fetch: createRetryingFetch({
            ...(this.#deps.modelRetry ? { policy: this.#deps.modelRetry } : {}),
            logger: this.#deps.logger,
            context: retryContext(model, null),
            ...(req.isRouteCurrent ? { shouldContinueRetry: req.isRouteCurrent } : {}),
          }),
        },
      );
      return {
        text: textOf(result.content),
        toolCalls: result.content
          .map((b) => b as { type?: string; name?: string; arguments?: unknown })
          .filter((b) => b.type === 'toolCall')
          .map((b) => ({ name: b.name ?? '', arguments: b.arguments })),
        usage: toUsage(result.usage),
        stopReason: result.stopReason,
      };
    } catch (error) {
      // Route change is a signal for the route's owner (completeStructured),
      // not a provider failure: let it through typed.
      if (isModelRouteChangedError(error)) throw new ModelRouteChangedError();
      throw mapProviderError(error);
    }
  }
}

class RunHandleImpl implements RunHandle {
  readonly #agent: Agent;
  /** Set at agent_end: the loop can no longer consume steers. */
  #agentEnded = false;
  readonly #listeners = new Set<(e: EngineEvent) => void>();
  readonly #usage: EngineUsage[] = [];
  readonly #onSteer: (() => void) | undefined;
  #aborted = false;
  #failure: { code: string; message: string } | null = null;
  #terminatedReason: string | null = null;
  #resolved = false;
  readonly done: Promise<RunOutcome>;
  #resolveDone!: (outcome: RunOutcome) => void;

  constructor(spec: RunSpec, agent: Agent, onSteer?: () => void) {
    this.#agent = agent;
    this.#onSteer = onSteer;
    this.done = new Promise<RunOutcome>((resolve) => {
      this.#resolveDone = resolve;
    });

    // pi awaits subscribers in registration order: the orchestrator's async
    // step persistence acts as a barrier before the loop continues.
    agent.subscribe(async (event) => {
      if (event.type === 'message_end') {
        const message = event.message as PiAgentMessage;
        if (message.role !== 'assistant') return;
        this.#recordUsage(message as PiAgentMessage & { usage?: UsageShape });
        this.emit({
          type: 'assistant',
          payload: {
            text: textOf(message.content),
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
          },
        });
        return;
      }
      if (event.type === 'tool_execution_start') {
        this.emit({
          type: 'tool_call',
          payload: {
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            args: event.args,
          },
        });
      }
    });
    agent.subscribe(async (event) => {
      if (event.type === 'agent_end') {
        // After this point a queued steer would never be consumed — steer()
        // reports "not accepted" and the orchestrator buffers the batch.
        this.#agentEnded = true;
        this.#settle();
      }
    });
  }

  /** Called by skip_reply while a tool executes. */
  markTerminated(reason?: string): void {
    this.#terminatedReason = reason ?? 'skip_reply';
  }

  steer(text: string): boolean {
    if (this.#agentEnded) return false;
    this.emit({ type: 'steer', payload: { text } });
    // A new instruction may legitimately ask for a retry.
    this.#onSteer?.();
    this.#agent.steer({ role: 'user', content: text, timestamp: Date.now() });
    return true;
  }

  /** D93: abort with a structured failure instead of a plain cancellation. */
  fail(error: { code: string; message: string }): void {
    if (this.#failure !== null || this.#aborted) return;
    this.#failure = error;
    this.#agent.abort();
  }

  abort(_reason: string): void {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#agent.abort();
  }

  tokensSoFar(): number {
    return this.#usage.reduce((sum, usage) => sum + usage.input + usage.output, 0);
  }

  onEvent(listener: (e: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: EngineEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #recordUsage(message: PiAgentMessage & { usage?: UsageShape }): void {
    const usage = message.usage;
    if (!usage) return;
    this.#usage.push({
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      costUsd: usage.cost?.total ?? null,
    });
  }

  #settle(): void {
    if (this.#resolved) return;
    this.#resolved = true;

    if (this.#failure !== null) {
      this.#resolveDone({
        status: 'failed',
        finalText: '',
        skipReply: false,
        usage: this.#usage,
        error: this.#failure,
      });
      return;
    }

    if (this.#aborted) {
      this.#resolveDone({
        status: 'cancelled',
        finalText: '',
        skipReply: false,
        usage: this.#usage,
      });
      return;
    }

    const assistants = (
      this.#agent.state.messages as Array<{
        role: string;
        stopReason?: string;
        errorMessage?: string;
        content?: unknown;
      }>
    ).filter((m) => m.role === 'assistant');
    const last = assistants.at(-1);

    // A provider-side abort may also carry an errorMessage; map it before the
    // generic error branch so the failure code/message stays specific.
    if (last?.stopReason === 'aborted') {
      this.#resolveDone({
        status: 'failed',
        finalText: '',
        skipReply: false,
        usage: this.#usage,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: '模型中止了本次生成，任务没有完成',
        },
      });
      return;
    }

    if (last?.stopReason === 'error' || this.#agent.state.errorMessage) {
      const mapped = mapProviderError(
        new Error(last?.errorMessage ?? this.#agent.state.errorMessage ?? 'unknown model error'),
      );
      this.#resolveDone({
        status: 'failed',
        finalText: '',
        skipReply: false,
        usage: this.#usage,
        error: { code: mapped.code, message: mapped.message },
      });
      return;
    }

    const terminated = this.#terminatedReason !== null;
    // D93: a provider-side stop that is not a normal completion must reach the
    // task host as a failure — otherwise an empty `completed` result is silently
    // consumed and the bot never learns that the task did not finish.
    if (
      !terminated &&
      last !== undefined &&
      last.stopReason !== 'stop' &&
      last.stopReason !== 'toolUse'
    ) {
      if (last.stopReason === 'length') {
        this.#resolveDone({
          status: 'failed',
          finalText: '',
          skipReply: false,
          usage: this.#usage,
          error: {
            code: 'OUTPUT_TRUNCATED',
            message: '模型输出达到上限被截断，任务没有完成；请缩小范围或重试',
          },
        });
        return;
      }
      this.#resolveDone({
        status: 'failed',
        finalText: '',
        skipReply: false,
        usage: this.#usage,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: `模型以非正常状态结束（${last.stopReason ?? 'unknown'}），任务没有完成`,
        },
      });
      return;
    }

    this.#resolveDone({
      status: 'completed',
      finalText: finalTextOf(assistants, terminated),
      skipReply: terminated,
      usage: this.#usage,
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let result = '';
  for (const block of content) {
    const candidate = block as { type?: string; text?: string };
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      result += candidate.text;
    }
  }
  return result;
}

function toUsage(usage: unknown): EngineUsage | null {
  const u = usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
      }
    | undefined;
  if (!u) return null;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    costUsd: u.cost?.total ?? null,
  };
}

/** The final message is the last assistant turn that stopped normally; a run
 * ended by skip_reply or an error never sends a final message. */
function finalTextOf(
  assistants: Array<{ stopReason?: string; content?: unknown }>,
  terminatedByTool: boolean,
): string {
  if (terminatedByTool) return '';
  const last = assistants.at(-1);
  if (!last || last.stopReason !== 'stop') return '';
  return textOf(last.content).trim();
}

export type { EngineMessage };

/**
 * 触发批图片的入模组装（docs/design/20-conversation-media.md）：支持视觉的
 * 模型收 text + image blocks；不支持的收一行提示文本（与 ToolResult.images
 * 同判定）。纯函数，便于单测。空文本不产生空 text block——部分厂商（如
 * Anthropic）对空文本块直接 400。
 */
export function buildUserMessageContent(
  text: string,
  images: Array<{ mimeType: string; base64: string }> | undefined,
  acceptsImages: boolean,
) {
  if (images === undefined || images.length === 0) return text;
  return [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...(acceptsImages
      ? images.map((image) => ({
          type: 'image' as const,
          data: image.base64,
          mimeType: image.mimeType,
        }))
      : [
          {
            type: 'text' as const,
            text: '（用户消息中的图片未注入：当前模型不支持图像输入。可用 understand_image 工具识别图片内容——本执行的工具面里没有它时（对话轮），用 start_task 派任务调用；或建议用户配置支持视觉的模型。）',
          },
        ]),
  ];
}
