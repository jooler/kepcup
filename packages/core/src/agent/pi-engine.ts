import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Message as PiAgentMessage } from '@earendil-works/pi-ai';
import { TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import { truncateToBudget } from './tokens.js';
import { buildModelRegistry, mapProviderError, resolveModel } from './models.js';
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

interface Deps {
  settings: SettingsService;
  secrets: SecretsService;
  logger: CoreLogger;
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

    const piTools = spec.tools.map((tool) => ({
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
          signal,
          terminate: (reason) => handle.markTerminated(reason),
          progress: (text) => handle.emit({ type: 'progress', payload: { text } }),
        };
        void onUpdate;
        let result;
        try {
          result = await tool.execute(params as never, ctx);
        } catch (error) {
          // Tool failures never break the loop: they return as tool output.
          result = {
            ok: false,
            content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'INTERNAL',
          };
        }
        handle.emit({
          type: 'tool_result',
          payload: {
            toolCallId: String(toolCallId),
            toolName: tool.name,
            ok: result.ok,
            content: result.content,
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          },
        });
        const text = truncateToBudget(result.content, TOOL_OUTPUT_MAX_CHARS).text;
        const imageBlocks =
          result.images !== undefined && result.images.length > 0
            ? acceptsImages
              ? result.images.map((image) => ({
                  type: 'image' as const,
                  data: image.base64,
                  mimeType: image.mimeType,
                }))
              : [
                  {
                    type: 'text' as const,
                    text: '（截图已省略：当前模型不支持图像输入，请使用快照文本了解页面）',
                  },
                ]
            : [];
        return {
          content: [{ type: 'text', text }, ...imageBlocks],
          ...(result.terminate ? { terminate: true } : {}),
        };
      },
    }));

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
      streamFn: models.streamSimple.bind(models),
      steeringMode: 'all',
    });

    // The transcript's leading system message is the prompt; refresh it right
    // before every request so stateful sections stay current.
    agent.prepareRequest = async ({ context }) => {
      const systemPrompt = await spec.buildSystemPrompt();
      const messages = [...context.messages];
      const first = messages[0] as { role: string } | undefined;
      if (first?.role === 'system') {
        messages[0] = { ...(first as object), content: systemPrompt } as (typeof messages)[number];
      } else {
        messages.unshift({ role: 'system', content: systemPrompt } as (typeof messages)[number]);
      }
      return { context: { ...context, messages } };
    };

    // Full request payload (messages + tools) for the run_steps `request`
    // record — "模型看到的一切都在日志里" (docs/dev/03-data-model.md).
    agent.onPayload = (payload) => {
      handleRef!.emit({ type: 'request', payload });
      return undefined;
    };

    let turns = 0;
    agent.finishTurn = async () => {
      turns += 1;
      if (turns >= spec.limits.maxTurns) return { action: 'end' };
      return undefined;
    };

    const handle = new RunHandleImpl(spec, agent);
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
        { maxTokens: req.maxTokens, signal: req.signal },
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
  #aborted = false;
  #terminatedReason: string | null = null;
  #resolved = false;
  readonly done: Promise<RunOutcome>;
  #resolveDone!: (outcome: RunOutcome) => void;

  constructor(spec: RunSpec, agent: Agent) {
    this.#agent = agent;
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
    this.#agent.steer({ role: 'user', content: text, timestamp: Date.now() });
    return true;
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

    this.#resolveDone({
      status: 'completed',
      finalText: finalTextOf(assistants, this.#terminatedReason !== null),
      skipReply: this.#terminatedReason !== null,
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
            text: '（用户消息中的图片未注入：当前模型不支持图像输入。可用 get_attachment 获取文件，或建议用户配置支持视觉的模型。）',
          },
        ]),
  ];
}
