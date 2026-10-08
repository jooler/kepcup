import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import {
  AppError,
  BOT_SETUP_PATH_QUESTION_EVENT,
  CONTINUATION_ARBITER_TIMEOUT_MS,
  GROUP_SETUP_QUESTION_EVENT,
  GROUP_SETUP_STEPS,
  INTERIM_TEXT_MAX_CHARS,
  INTERIM_TEXT_MAX_PER_RUN,
  INTERIM_TEXT_MAX_PER_RUN_GROUP,
  RUN_MAX_TURNS,
  SETUP_MAX_QUESTIONS,
  SETUP_QUESTION_EVENT,
  SUBAGENT_FOLLOWUP_EVENT,
  SUMMARY_TRIGGER_UNSUMMARIZED,
  TRIAGE_RECENT_MESSAGES,
  BUILTIN_ENGINE,
  CONTINUATION_WINDOW_MS,
  agentEngineKey,
  agentModelRef,
  agentSetupReasonForError,
  agentSetupReasonOf,
  agentToolApprovalPayloadSchema,
  findAgentEntry,
  newId,
  resolveCapabilities,
  type AgentCatalogEntry,
  type AgentToolApprovalPayload,
  type AgentPermissionTier,
  type AgentView,
  type Bot,
  type Conversation,
  type Delegation,
  type GroupSetupStep,
  type Message,
  type Run,
  type SetupRequirement,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import { agentRunGate, agentSetupMessage } from '../agent/external/catalog.js';
import {
  buildExternalAgentTools,
  hostServerNameFor,
  hostToolNamer,
  MAX_AGENT_TOOL_NAME,
} from '../agent/external/capabilities.js';
import type { DiscardAgentSessionInput } from '../agent/external/engine.js';
import { AgentSessionsStore, type AgentSessionRow } from '../domain/agent-sessions.js';
import { providerFor } from '../agent/external/providers/index.js';
import {
  effectiveAgentPermission,
  hashAgentConfigFiles,
} from '../agent/external/permission-bridge.js';
import type { SqliteDatabase } from '../infra/db.js';
import { persistEngineSteps } from '../agent/step-persistence.js';
import {
  humanizeLateBy,
  inQuietHours,
  parseQuietHours,
  quietHoursEndAt,
} from '../schedule/guard.js';
import {
  buildAgentRunContext,
  buildAgentSessionPrompt,
  buildSystemPrompt,
} from '../agent/context/system-prompt.js';
import {
  buildConversationContext,
  buildConversationDelta,
  buildNewMessagesInjection,
  buildTriggerSegment,
  renderMessageLine,
  type RenderMessageOptions,
} from '../agent/context/conversation.js';
import {
  buildArbiterUserMessage,
  CONTINUATION_ARBITER_SYSTEM_PROMPT,
  continuationOutputSchema,
  continuationParametersSchema,
  resolveContinuation,
  type ContinuationArbiterInput,
  type ContinuationCandidate,
  type ContinuationPlan,
} from '../agent/context/continuation.js';
import { completeStructured } from '../agent/structured.js';
import type {
  AgentEngine,
  AgentSessionMode,
  RunHandle,
  RunIdentity,
  ToolDefinition,
} from '../agent/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { Mailbox, MailboxRegistry, type TriggerBatch } from '../scheduler/mailbox.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { GroupsService } from '../domain/groups.js';
import type { DelegationsService } from '../domain/delegations.js';
import type { MessagesService } from '../domain/messages.js';
import type { DraftsService } from '../domain/drafts.js';
import type { AttachmentsService } from '../domain/attachments.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { UsageService } from '../domain/usage.js';
import type { SettingsService } from '../domain/settings.js';
import type { SecretsService } from '../domain/secrets.js';
import type { ApprovalsService } from '../permissions/approvals.js';
import type { GrantsService } from '../permissions/grants.js';
import type { ProjectRuntime } from '../project/service.js';
import type { SandboxBackend } from '../sandbox/types.js';
import type { CoreEventsMap } from '../start-types.js';
import {
  buildResponseTools,
  buildSubagentResearchTools,
  type EnvironmentToolFacade,
  type ResponseToolDeps,
} from '../tools/index.js';
import { TOOL_SETUP_REQUIRED, type MediaToolFacade } from '../tools/image-tools.js';
import type { SearchToolFacade } from '../tools/web-tools.js';
import type { SkillInstallFacade } from '../tools/skill-tools.js';
import {
  GROUP_SETUP_QUESTIONS,
  SETUP_FIRST_OPTIONS,
  SETUP_FIRST_QUESTION,
  SETUP_GREETING,
  SETUP_PATH_QUESTION,
  SETUP_PATH_SKIP_TEXT,
  questionCapReached,
} from '../tools/setup-tools.js';
import type { BrowserHostRpc } from '../browser/facade.js';
import type { MemoryToolFacade } from '../tools/memory-tools.js';
import type { ScheduleToolFacade } from '../tools/schedule-tools.js';
import { applyProfileChanges } from '../memory/service.js';
import {
  createSubagentFacade,
  createSubagentHost,
  buildSubagentSystemPrompt,
  type SubagentFollowUp,
  type SubagentHost,
} from '../agent/subagent.js';
import { buildMcpTools, type McpToolFacade } from '../mcp/tools.js';
import type { McpService } from '../mcp/service.js';
import { FileReadState } from '../tools/fs-state.js';
import type { ToolGateway } from '../gateway/index.js';
import type { AppPaths } from '../infra/paths.js';
import { workspacePathFor } from '../infra/paths.js';
import {
  BUTLER_SETUP_FIRST_OPTIONS,
  BUTLER_SETUP_FIRST_QUESTION,
  BUTLER_SETUP_GREETING,
  BUTLER_WELCOME_TEXT,
  butlerProfileTemplate,
} from '../domain/butler.js';
import { ButlerHost } from './butler.js';
import {
  buildTaskBriefSegment,
  buildTaskReplaySegment,
  TaskHost,
  type TaskBrief,
  type TaskOutcome,
  type TaskRunControl,
} from './tasks.js';
import { DELEGATION_RESULT_CARD, DELEGATION_SENT_CARD, DelegationHost } from './delegation.js';
import { ChainsService } from './chains.js';
import { GroupTurnCoordinator } from './group-turn.js';
import { lightModelRefForBot, triageOneBot } from './dispatcher.js';
import {
  builtinRoute,
  type LlmPurpose,
  type LlmRoute,
  type LlmRouter,
} from '../agent/llm-router.js';
import type { BotCard } from '@kepcup/shared';
import type { InstalledToolchain } from '../env/manager.js';

export interface OrchestratorEnvironmentFacade {
  /** request_environment backend (docs/dev/phases/P06-environment.md 任务 3). */
  request(
    identity: {
      runId: string;
      botId: string | null;
      conversationId: string | null;
      loopType: 'response' | 'task';
    },
    input: { item: string; version?: string; reason: string },
  ): Promise<
    | { status: 'installed'; item: string; version: string; path: string; system: boolean }
    | { status: 'installing'; item: string }
    | { status: 'submitted'; item: string; approvalId: string }
  >;
  offeredItems(): string[];
  installedToolchains(): InstalledToolchain[];
}

export interface OrchestratorDeps {
  engine: AgentEngine;
  /**
   * D72 外部智能体引擎（`bot.profile.runtime.agent.id` 非空的 Bot 由它驱动）；
   * 缺省（精简测试装配）时这类 Bot 的 run 以失败结算。
   */
  /**
   * D72 外部智能体引擎；`discardSession`（P5）丢弃保留的 Agent 会话（删除对话 /
   * Bot、会话被替换）。
   */
  externalEngine?: AgentEngine & {
    discardSession?(input: DiscardAgentSessionInput): Promise<void>;
    onSessionInvalidated?(listener: (agentId: string, agentSessionId: string) => void): () => void;
  };
  /** D72 生效目录（已按发行门禁过滤）；缺省 = 空目录。 */
  agentCatalog?: () => readonly AgentCatalogEntry[];
  /**
   * D72 P6 后台调用路由（群聊判断、续接仲裁、SubAgent 压缩）：无内置模型时
   * 改走外部 Agent。缺省 = 只用内置模型（P6 之前的行为）。
   */
  llmRouter?: LlmRouter;
  /**
   * D72 P4 本机 Agent 状态（AgentsService）：run 门禁按安装 / 登录状态给出
   * 结构化 setup（`{kind:'agent'}`），run 因未登录失败时回写登录态。缺省
   * （精简装配）时门禁只看启用开关。
   */
  agents?: {
    view(agentId: string): AgentView;
    noteRunError(agentId: string, code: string): void;
  };
  scheduler: Scheduler;
  db: SqliteDatabase;
  paths: AppPaths;
  gateway: ToolGateway;
  bots: BotsService;
  conversations: ConversationsService;
  /** 群域服务（P05 成员管理 + 19/D60 对话内群创建的 createSetup/finalizeSetup）。 */
  groups: GroupsService;
  /** 跨 Bot 委派行（D71，docs/design/27）。 */
  delegations: DelegationsService;
  messages: MessagesService;
  drafts: DraftsService;
  attachments: AttachmentsService;
  jobs: JobsService;
  runs: RunsService;
  usage: UsageService;
  settings: SettingsService;
  secrets: SecretsService;
  approvals: ApprovalsService;
  grants: GrantsService;
  projects: ProjectRuntime;
  sandbox: SandboxBackend;
  clock: Clock;
  logger: CoreLogger;
  timeZone: string;
  /** Test override of TRIAGE_TIMEOUT_MS (default from constants). */
  triageTimeoutMs?: number;
  /** Publishes an RPC event to connected interfaces. */
  publish<K extends keyof CoreEventsMap>(event: K, payload: CoreEventsMap[K]): void;
  /** P06 environment manager (optional: absent in some unit tests). */
  environment?: OrchestratorEnvironmentFacade;
  /**
   * P07 memory domain (optional so stripped unit tests keep constructing the
   * orchestrator): prompt injection, reflection registration, tool facade.
   */
  memory?: OrchestratorMemoryFacade;
  /**
   * P08 skills domain (optional in stripped setups): <skills> prompt section,
   * sandbox/file-tool readable directories and the create_skill tool facade.
   */
  skills?: OrchestratorSkillsFacade;
  /**
   * P09 wiki domain (optional in stripped setups): the <wiki_topics> prompt
   * section, the response-loop wiki tools facade and the recall cascade.
   */
  wiki?: OrchestratorWikiFacade;
  /**
   * P10 schedule domain (optional in stripped setups): the schedule /
   * list_schedules / cancel_schedule tools (lazy facade from start.ts).
   */
  schedule?: ScheduleToolFacade | undefined;
  /**
   * P11 browser capability hosted by the main process (port B); omitted in
   * stripped test setups, which then simply have no browser_* tools.
   */
  browser?: BrowserHostRpc | undefined;
  /**
   * 图像生成后端（docs/design/18-inline-setup.md）；omitted in stripped test
   * setups, which then simply have no generate_image tool.
   */
  media?: MediaToolFacade | undefined;
  /**
   * 联网检索网关（docs/design/21-web-search.md）：web_search / web_fetch 工具；
   * omitted in stripped test setups。web_search 未配置供应商时以结构化 setup
   * `{kind:'web-search'}` 失败引导设置。
   */
  search?: SearchToolFacade | undefined;
  /**
   * 技能安装门面（docs/design/22-file-skill-routing.md）：install_skill 工具
   * 的预置安装 / 外部仓库导入（阻塞审批）后端；omitted in stripped test setups。
   */
  skillInstall?: SkillInstallFacade | undefined;
  /**
   * MCP 网关（docs/design/23-mcp-and-subagent.md D65）：null = 无 MCP 能力
   * （无 server 工具注册）。
   */
  mcp?: McpService | null;
}

/** The slice of the wiki domain the response loop consumes. */
export interface OrchestratorWikiFacade {
  /** <wiki_topics> section body (index.md titles), '' when no wiki. */
  topicsSection(botId: string): string;
  /** wiki_search / wiki_read / wiki_enqueue backends. */
  search(
    botId: string,
    query: string,
    limit: number,
  ): Array<{ path: string; title: string; snippet: string }>;
  readPage(botId: string, path: string): { path: string; title: string; content: string };
  enqueueIngest(input: {
    botId: string;
    conversationId: string | null;
    source: { sourceType: 'attachment' | 'url' | 'file'; ref: string; note: string };
  }): { ok: boolean; message: string };
}

/** The slice of SkillsService the response loop consumes. */
export interface OrchestratorSkillsFacade {
  /** <skills> section body (names + descriptions only), '' when none. */
  promptSection(botId: string): string;
  /** <recommended_skills> section body（未安装预置，D63），'' when none. */
  recommendedSkillsSection(): string;
  /** Skill directories the file tools may read / sandbox sees read-only. */
  readableDirs(botId: string): string[];
  /** create_skill backend. */
  requestAuthoring(input: {
    botId: string;
    conversationId: string;
    name: string;
    description: string;
    reason: string;
  }): { ok: boolean; message: string };
}

/**
 * The slice of the memory domain the orchestrator uses: the tool facade minus
 * `triggerMessages` (the orchestrator supplies the current batch to the tools
 * itself) plus the prompt-section builders and the reflection hook.
 */
export type OrchestratorMemoryFacade = Omit<MemoryToolFacade, 'triggerMessages'> & {
  profileCardSection(): string;
  myStateSection(botId: string, currentConversationId: string | null): string;
  relevantMemoriesSection(input: {
    botId: string;
    conversationId: string;
    queryText: string;
  }): Promise<string>;
  /** Registers the post-run reflection job (dedupe run:{runId}). */
  registerReflection(input: {
    runId: string;
    botId: string;
    conversationId: string;
    triggerMessageIds: string[];
    batchId: string | null;
    /** Loop 续接 (D56): runs whose process records were replayed into this run. */
    continuedFromRunIds?: string[];
  }): void;
};

/** The nearest directory at or above `start` holding `.git` (null = none). */
function gitRootAbove(start: string): string | null {
  let dir = nodePath.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(nodePath.join(dir, '.git'))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `root`, its descendants on the way to `leaf`, and `leaf` (root must contain leaf). */
function directoryChain(root: string, leaf: string): string[] {
  const relative = nodePath.relative(root, leaf);
  const parts = relative === '' ? [] : relative.split(nodePath.sep);
  return [root, ...parts.map((_, index) => nodePath.join(root, ...parts.slice(0, index + 1)))];
}

/** Steers handed to an external agent run (D72 P5, `#onAgentSteerRejected`). */
interface AgentSteerLog {
  log: Array<{ text: string; batch: TriggerBatch }>;
  /** The run's mailbox was released: a refused batch is delivered directly. */
  released: boolean;
  /** The run's seen-state (steered batches are added; refused ones removed). */
  seen?: AgentSeen;
  /**
   * D75 §3.2: the run's consumed-task set — a refused batch's task entries
   * were not seen after all (their consumption moves to the re-delivery).
   */
  consumes?: Set<string>;
}

/** What an agent session has seen of its conversation (P5 审查 #2). */
interface AgentSeen {
  /** Every message with seq ≤ this was shown (context / delta / trigger). */
  baseCutoff: number;
  /** Later messages shown individually (steered batches): id → seq. */
  ids: Map<string, number>;
}

interface ActiveRunEntry {
  handle: RunHandle;
  conversationId: string;
  botId: string;
  /** Highest message seq the model has seen (initial context + steers). */
  cutoffSeq: number;
  /**
   * External-agent runs (D72 P5): batches handed to the engine as steers —
   * ACP steering is asynchronous; a refused one comes back by its text.
   */
  steerLog?: AgentSteerLog;
  /**
   * D75 §3.2 消费: task ids whose terminal entries this run saw (trigger batch
   * or steered); marked consumed when the run reaches a terminal state.
   */
  consumesTaskIds?: Set<string>;
}

/**
 * How one execution of the shared run skeleton (`#executeRun`) is used:
 * - `response`: today's mailbox-driven response run (visible final reply,
 *   mailbox release, group turns, D71 hooks, D56 auto continuation);
 * - `task` (D75, design 30 §2.2 / §2.4.5): a task — scheduler key
 *   `task:{id}`, loop_type 'task', brief as the trigger segment, shared-only
 *   conversation layer, interim texts with `origin:'task'`, final text → the
 *   private `result` entry via TaskHost.settle, never a visible message.
 * W2 adds the `turn` variant here.
 */
type RunExecution =
  | { kind: 'response'; batch: TriggerBatch }
  | {
      kind: 'task';
      /** Synthesized: the brief's source messages, reason 'task'. */
      batch: TriggerBatch;
      task: Run;
      brief: TaskBrief;
      control: TaskRunControl;
    };

/**
 * Drives the single-chat response loop end to end: draft flush -> message
 * rows -> mailbox -> scheduler -> engine -> persisted steps, bot messages,
 * usage entries and events (docs/dev/02-architecture.md "一条消息的完整链路").
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #mailboxes: MailboxRegistry;
  readonly #activeRuns = new Map<string, ActiveRunEntry>();
  readonly #cancelledBeforeStart = new Set<string>();
  /** Per-run file-read hashes (staleness detection, P04). */
  readonly #fsState = new FileReadState();
  /**
   * Batches that arrived while their mailbox was still marked running. Two
   * cases share this buffer: the run is registering (consumed as steers right
   * after registration) and the run has already settled but not released the
   * mailbox yet — the latter are re-delivered as new runs on release, so a
   * flushed batch can never silently vanish between settle and release.
   */
  readonly #pendingSteers = new Map<string, TriggerBatch[]>();
  /** Bot-to-bot @ chains (P05); owns chain rows, depth and budget checks. */
  readonly #chains: ChainsService;
  /** Group turns (P05): triage, ordered responses, re-dispatch bookkeeping. */
  readonly #groupTurns: GroupTurnCoordinator;
  /**
   * D66 mode B/C：对话级后台子 run 锚点（跨 response run 存活）。结束主 turn
   * 不级联；显式取消委派 / 关对话 / 删 Bot 时经此 abort；并发封顶也在这里计数。
   */
  readonly #subagentHost: SubagentHost = createSubagentHost();
  /** D75 任务层（dispatch/tasks.ts）：派出、注入、取消、结算、修复、对账、reaper。 */
  readonly #taskHost: TaskHost;
  /** 管家提议的宿主侧（D70）：提议卡提交、确认后确定性创建 Bot / 群。 */
  readonly #butlerHost: ButlerHost;
  /** 跨 Bot 委派的宿主侧（D71）：投递闸门、结算、取消、恢复。 */
  readonly #delegationHost: DelegationHost;
  /** D72 P5 外部 Agent 会话复用记录（agent_sessions）。 */
  readonly #agentSessions: AgentSessionsStore;
  /**
   * What a kept agent session has seen (row id → state, P5 审查 #2/#3): the
   * conversation up to `baseCutoff` plus the listed later messages (steered
   * batches). In memory only — after an app restart a session is not reused
   * (full context + D56 replay instead of a guessed delta).
   */
  readonly #agentSessionSeen = new Map<string, AgentSeen>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#agentSessions = new AgentSessionsStore(deps.db);
    // Sessions the engine gave up (poisoned, closed before use, changed mode
    // outside a run) are neither reused nor resumed (P5 审查 #1).
    deps.externalEngine?.onSessionInvalidated?.((agentId, agentSessionId) => {
      try {
        for (const row of this.#agentSessions.deleteByAgentSession(agentId, agentSessionId)) {
          this.#agentSessionSeen.delete(row.id);
        }
      } catch (error) {
        deps.logger.warn(
          { agentId, error: error instanceof Error ? error.message : String(error) },
          'dropping an invalidated agent session failed',
        );
      }
    });
    this.#mailboxes = new MailboxRegistry((key) => this.#createMailbox(key));
    this.#taskHost = new TaskHost({
      db: deps.db,
      runs: deps.runs,
      messages: deps.messages,
      conversations: deps.conversations,
      bots: deps.bots,
      clock: deps.clock,
      logger: deps.logger,
      timeZone: deps.timeZone,
      renderOptions: (selfBotId) => ({ ...this.#renderOptions(), selfBotId }),
      publishRunStatus: (run) => deps.publish('run.status', { run }),
      execute: (task, control) => {
        void this.#startTask(task, control);
      },
      // This wave (D75 W1-A): the entry reaches the bot as a `reason:'task'`
      // trigger batch through its mailbox (W2 changes the mailbox semantics).
      wake: (botId, conversationId, entry) => {
        this.#mailboxes.for(botId, conversationId).deliver({
          conversationId,
          botId,
          messages: [entry],
          reason: 'task',
        });
      },
      resolveWorkdir: (botId, conversationId, requested) => {
        const project = deps.projects.boundProject(conversationId);
        const available = project !== null && project.status === 'available';
        if (requested === 'project') {
          if (!available) throw new AppError('INVALID_INPUT', '本对话没有可用的 project');
          return project.path;
        }
        if (requested === 'workspace' || !available) {
          return workspacePathFor(deps.paths, botId, conversationId);
        }
        return project.path;
      },
      onSettled: (run, executorActive) => {
        deps.grants.expireForRun(run.id);
        deps.approvals.cancelPendingForRun(run.id);
        // A still-unwinding execution keeps its write lease until it ends (an
        // aborted tool may still be writing); it releases the lease itself.
        if (!executorActive) {
          this.#fsState.release(run.id);
          void deps.projects.releaseRun(run.id).catch(() => {});
        }
        deps.publish('run.status', { run });
        if (run.conversationId !== null) this.#publishConversation(run.conversationId);
      },
      releaseExecution: (runId) => {
        this.#fsState.release(runId);
        void deps.projects.releaseRun(runId).catch(() => {});
      },
      recordVisibleMessage: (runId, message) => {
        if (deps.runs.get(runId) !== null) {
          this.#recordBotMessage(runId, message);
          return;
        }
        deps.publish('message.created', { conversationId: message.conversationId, message });
        this.#publishConversation(message.conversationId);
      },
    });
    this.#butlerHost = new ButlerHost({
      bots: deps.bots,
      conversations: deps.conversations,
      groups: deps.groups,
      approvals: deps.approvals,
      messages: deps.messages,
      logger: deps.logger,
      publish: (event, payload) => deps.publish(event as never, payload as never),
      deliverDirect: (conversationId, botId, message) => {
        const conversation = deps.conversations.getOrThrow(conversationId);
        this.#deliverDirectThroughGate(conversation, botId, [message], 'direct');
        this.#publishConversation(conversationId);
      },
      deliverEvent: (botId, conversationId, event, text, options) =>
        this.deliverEventToBot(botId, conversationId, event, text, options),
    });
    this.#delegationHost = new DelegationHost({
      delegations: deps.delegations,
      bots: deps.bots,
      conversations: deps.conversations,
      messages: deps.messages,
      runs: deps.runs,
      jobs: deps.jobs,
      db: deps.db,
      clock: deps.clock,
      timeZone: deps.timeZone,
      logger: deps.logger,
      publish: (event, payload) => deps.publish(event as never, payload as never),
      isMailboxIdle: (botId, conversationId) => this.isMailboxIdle(botId, conversationId),
      deliverToBot: (input) => this.#deliverDelegationMessage(input),
      cancelRun: (runId) => {
        this.cancelRun(runId);
      },
      deliverEvent: (botId, conversationId, event, text, options) =>
        this.deliverEventToBot(botId, conversationId, event, text, options),
    });
    this.#chains = new ChainsService({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      bots: deps.bots,
      conversations: deps.conversations,
      messages: deps.messages,
      runs: deps.runs,
      usage: deps.usage,
      deliver: (batch) => this.#mailboxes.for(batch.botId, batch.conversationId).deliver(batch),
      tokensInFlightFor: (runIds) => {
        let sum = 0;
        for (const [runId, entry] of [...this.#activeRuns.entries()]) {
          if (runIds.includes(runId)) sum += entry.handle.tokensSoFar();
        }
        return sum;
      },
    });
    this.#groupTurns = new GroupTurnCoordinator({
      conversations: deps.conversations,
      bots: deps.bots,
      messages: deps.messages,
      clock: deps.clock,
      logger: deps.logger,
      timeZone: deps.timeZone,
      deliver: (batch) => this.#mailboxes.for(batch.botId, batch.conversationId).deliver(batch),
      isMailboxRunning: (botId, conversationId) =>
        this.#mailboxes.for(botId, conversationId).isRunning,
      appendSystemMessage: (input) =>
        this.#appendSystemMessage(input.conversationId, input.event, input.text, {
          botIds: input.botIds,
          batchId: input.batchId,
        }),
      publish: (event, payload) => deps.publish(event, payload),
      triage: (input) =>
        triageOneBot({
          engine: deps.engine,
          ...(deps.llmRouter !== undefined ? { router: deps.llmRouter } : {}),
          scheduler: deps.scheduler,
          runs: deps.runs,
          usage: deps.usage,
          settings: deps.settings,
          bots: deps.bots,
          messages: deps.messages,
          botId: input.botId,
          conversationId: input.conversationId,
          batchId: input.batchId,
          batchMessages: input.batchMessages,
          timeZone: deps.timeZone,
          logger: deps.logger,
          ...(deps.triageTimeoutMs !== undefined ? { timeoutMs: deps.triageTimeoutMs } : {}),
        }),
    });
  }

  // --- draft flush ---------------------------------------------------------

  /**
   * Converts drafts into messages (one shared batch id, attachments
   * re-linked) in a single transaction, then hands the batch to the mailbox.
   * Delivery happens after the transaction commits: a failed delivery never
   * rolls the messages back (docs/dev/phases/P01-direct-chat.md 注意事项).
   * draftId 缺省时冲掉整条队列；给定时只发那一条（UI 逐条「立即」），其余
   * 草稿原地保留。
   */
  flushDrafts(
    conversationId: string,
    draftId?: string,
  ): { messages: Message[]; runId: string | null } {
    const { drafts, messages, attachments } = this.#deps;
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.readOnly) {
      throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    }
    const queue = drafts.list(conversationId);
    const selected = draftId === undefined ? queue : queue.filter((d) => d.id === draftId);
    if (selected.length === 0) return { messages: [], runId: null };

    const batchId = `batch_${this.#deps.clock.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created: Message[] = [];
    const tx = this.#deps.db.transaction(() => {
      for (const draft of selected) {
        const attachmentIds = attachments.attachmentsForDraft(draft.id).map((a) => a.id);
        const message = messages.append({
          conversationId,
          senderType: 'user',
          kind: 'text',
          text: draft.text,
          mentions: draft.mentions,
          replyTo: draft.replyTo,
          batchId,
        });
        attachments.attachToMessage(attachmentIds, message.id);
        created.push({ ...message, attachments: messages.attachmentsFor(message.id) });
      }
      if (draftId === undefined) drafts.removeAll(conversationId);
      else drafts.remove(draftId);
    });
    tx.immediate();

    for (const message of created) {
      this.#deps.publish('message.created', { conversationId, message });
    }
    this.#publishDrafts(conversationId);
    this.#publishConversation(conversationId);

    if (conv.type === 'group') {
      // Group dispatch (P05): explicit targets, triage, ordered turns. The
      // runs (if any) are chosen asynchronously; no single run id to report.
      this.#groupTurns.onUserBatch(conversationId, batchId, created);
      return { messages: created, runId: null };
    }
    if (conv.directBotId !== null) {
      // 目录闸门（19/D59）：访谈中的自由输入同样只落库，等目录卡作答。
      this.#deliverDirectThroughGate(conv, conv.directBotId, created, 'direct');
    }
    return { messages: created, runId: this.#latestRunId(conversationId, conv.directBotId) };
  }

  /**
   * 初始化问询的用户回答（UI 改版）：不走草稿/普通气泡——落一条带
   * setupAnswer 标记的用户消息（照常进上下文并触发响应 run），渲染层隐藏
   * 它的气泡、由问题卡片自身展示已答内容（参考 Grok）。
   * 投递经目录闸门（docs/design/19 D59）：首问作答后先插入确定性的工作目录
   * 卡、扣下投递，目录卡作答（answerSetupPath）后才连同缓冲消息一起开始
   * 首个响应 run。
   */
  answerSetupQuestion(conversationId: string, text: string): Message {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.readOnly) {
      throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    }
    if (conv.type !== 'direct' || conv.directBotId === null) {
      throw new AppError('INVALID_INPUT', '初始化问询回答只能在单聊中提交');
    }
    // 访谈结束后残留的问题卡仍可点击：此时回答已无意义，且 setupAnswer 消息
    // 不渲染气泡——放行会产出一条用户看不见的文字和一次幽灵 run，必须拒绝。
    if (this.#deps.bots.get(conv.directBotId)?.setupState !== 'interviewing') {
      throw new AppError('INVALID_INPUT', '初始化访谈已结束，回答不再接收');
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new AppError('INVALID_INPUT', '回答不能为空');
    }
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'user',
      kind: 'text',
      text: trimmed,
      setupAnswer: true,
      batchId: `batch_${this.#deps.clock.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    this.#deps.publish('message.created', { conversationId, message });
    this.#publishConversation(conversationId);
    this.#deliverDirectThroughGate(conv, conv.directBotId, [message], 'direct');
    return message;
  }

  // --- setup path gate (docs/design/19 D59) ---------------------------------

  /**
   * 直聊投递的唯一闸口：Bot 在初始化访谈中且首问卡已发出时，工作目录卡
   * （确定性、无候选）未作答前扣下一切投递——首问作答、输入框自由输入
   * （flushDrafts）、编辑重触发（editMessage）共用；作答即放行。返回是否
   * 被扣下（true = 未投递）。
   */
  #deliverDirectThroughGate(
    conv: Conversation,
    botId: string,
    messages: Message[],
    reason: 'direct' | 'event',
    extraAttributes?: Record<string, string | number>,
  ): boolean {
    if (this.#setupPathGateClosed(conv.id, botId)) return true;
    this.#mailboxes.for(botId, conv.id).deliver({
      conversationId: conv.id,
      botId,
      messages,
      reason,
      ...(extraAttributes !== undefined ? { extraAttributes } : {}),
    });
    return false;
  }

  /** 闸门关闭判定；首问已出且目录卡未发时顺手插入目录卡（幂等）。 */
  #setupPathGateClosed(conversationId: string, botId: string): boolean {
    const bot = this.#deps.bots.get(botId);
    if (bot?.setupState !== 'interviewing') return false;
    // 管家访谈（D70）不绑定 project：没有目录卡，首答直接投递。
    if (bot.systemRole === 'butler') return false;
    // 访谈尚未开始（interview.start 未跑，如创建后立刻打字的极端竞态）：
    // 无首问可缓冲，不设闸。
    if (this.#deps.messages.countSystemEvents(conversationId, SETUP_QUESTION_EVENT) === 0) {
      return false;
    }
    if (
      this.#deps.messages.countSystemEvents(conversationId, BOT_SETUP_PATH_QUESTION_EVENT) === 0
    ) {
      this.#appendSystemMessage(conversationId, BOT_SETUP_PATH_QUESTION_EVENT, SETUP_PATH_QUESTION);
    }
    const cardSeq = this.#deps.messages.systemEventSeq(
      conversationId,
      BOT_SETUP_PATH_QUESTION_EVENT,
      'last',
    );
    // 已答判定只认 answerSetupPath 落的 setupAnswer 消息——目录卡之后经闸外
    // 途径出现的用户消息（理论上不该有）不放开闸门。
    return (
      cardSeq === null ||
      !this.#deps.messages
        .userMessagesAfter(conversationId, cardSeq)
        .some((m) => 'setupAnswer' in m.content && m.content.setupAnswer === true)
    );
  }

  /**
   * 访谈目录卡作答（docs/design/19 D59）：path 非空 → 绑定 project（复用手动
   * 绑定的系统消息通路）；随后落 setupAnswer 用户消息（选择或跳过），并把
   * 首问卡之后缓冲的全部用户消息一次性投递——首个响应 run 由此开始。
   */
  answerSetupPath(conversationId: string, path: string | null): Message {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.readOnly) {
      throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    }
    if (conv.type !== 'direct' || conv.directBotId === null) {
      throw new AppError('INVALID_INPUT', '目录选择只能在单聊中提交');
    }
    const bot = this.#deps.bots.get(conv.directBotId);
    if (bot?.setupState !== 'interviewing') {
      throw new AppError('INVALID_INPUT', '初始化访谈已结束，目录选择不再接收');
    }
    const cardSeq = this.#deps.messages.systemEventSeq(
      conversationId,
      BOT_SETUP_PATH_QUESTION_EVENT,
      'last',
    );
    if (cardSeq === null) {
      throw new AppError('INVALID_INPUT', '目录问题尚未发出');
    }
    if (
      this.#deps.messages
        .userMessagesAfter(conversationId, cardSeq)
        .some((m) => 'setupAnswer' in m.content && m.content.setupAnswer === true)
    ) {
      throw new AppError('INVALID_INPUT', '目录问题已作答，不能重复提交');
    }
    if (path !== null) {
      this.#deps.projects.select(conversationId, path);
    }
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'user',
      kind: 'text',
      text: path ?? SETUP_PATH_SKIP_TEXT,
      setupAnswer: true,
      batchId: `batch_${this.#deps.clock.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    this.#deps.publish('message.created', { conversationId, message });
    this.#publishConversation(conversationId);
    // 缓冲批 = 首问卡之后的全部用户消息（首答 + 期间自由输入 + 本次目录
    // 决定），一次投递一次 run（多触发消息是 flush 批的既有语义）。
    const firstCardSeq = this.#deps.messages.systemEventSeq(
      conversationId,
      SETUP_QUESTION_EVENT,
      'first',
    );
    const buffered =
      firstCardSeq !== null
        ? this.#deps.messages.userMessagesAfter(conversationId, firstCardSeq)
        : [message];
    if (buffered.length > 0) {
      this.#mailboxes.for(conv.directBotId, conversationId).deliver({
        conversationId,
        botId: conv.directBotId,
        messages: buffered,
        reason: 'direct',
      });
    }
    return message;
  }

  // --- group setup (docs/design/19 D60) ---------------------------------------

  /**
   * 对话内群创建第一步：创建 `setup_state='creating'` 的群对话并下发第一问
   * （群名称）。零模型调用——四问全部由 core 确定性下发，完成后 Bot 才进群。
   */
  beginGroupSetup(): Conversation {
    const conversation = this.#deps.groups.createSetup();
    this.#appendGroupSetupCard(conversation.id, 'title');
    return conversation;
  }

  #appendGroupSetupCard(conversationId: string, step: GroupSetupStep): void {
    this.#appendSystemMessage(
      conversationId,
      GROUP_SETUP_QUESTION_EVENT,
      GROUP_SETUP_QUESTIONS[step],
      {
        step,
      },
    );
  }

  /**
   * 群创建问答推进：每步校验「正是当前待答步骤」（幂等，重复提交拒绝）、
   * 落 setupAnswer 用户消息（不渲染气泡，卡片显示已答态）、发下一问；成员
   * 步作答即写成员行，project 步绑定后 finalize（名称/定位一次性生效）。
   * 全程不触发任何 dispatch。
   */
  answerGroupSetup(
    input:
      | { conversationId: string; step: 'title'; text: string }
      | { conversationId: string; step: 'purpose'; text: string }
      | { conversationId: string; step: 'members'; botIds: string[] }
      | { conversationId: string; step: 'project'; path: string | null },
  ): { conversation: Conversation; done: boolean } {
    const conversationId = input.conversationId;
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.type !== 'group' || conv.setupState !== 'creating') {
      throw new AppError('INVALID_INPUT', '该对话不在群创建流程中');
    }
    const current = this.#groupSetupCurrentStep(conversationId);
    if (current === null || current !== input.step) {
      throw new AppError('INVALID_INPUT', `当前应回答的步骤是「${current ?? '（已完成）'}」`);
    }
    const index = GROUP_SETUP_STEPS.indexOf(input.step);
    const answerText = (() => {
      switch (input.step) {
        case 'title':
          return input.text.trim();
        case 'purpose':
          return input.text.trim();
        case 'members':
          return input.botIds.map((id) => this.#deps.bots.get(id)?.name ?? id).join('、');
        case 'project':
          return input.path ?? SETUP_PATH_SKIP_TEXT;
      }
    })();
    if (answerText.length === 0) {
      throw new AppError('INVALID_INPUT', '回答不能为空');
    }
    const isLast = index === GROUP_SETUP_STEPS.length - 1;
    // 步骤副作用先于落卡执行（失败即整步失败，不留半答状态）。
    if (input.step === 'members') {
      this.#deps.groups.addMembers(conversationId, input.botIds);
    }
    if (input.step === 'project' && input.path !== null) {
      this.#deps.projects.select(conversationId, input.path);
    }
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'user',
      kind: 'text',
      text: answerText,
      setupAnswer: true,
    });
    this.#deps.publish('message.created', { conversationId, message });
    if (!isLast) {
      this.#appendGroupSetupCard(conversationId, GROUP_SETUP_STEPS[index + 1]!);
      this.#publishConversation(conversationId);
      return { conversation: this.#deps.conversations.getOrThrow(conversationId), done: false };
    }
    const updated = this.#deps.groups.finalizeSetup(conversationId, {
      title: this.#groupSetupAnswerText(conversationId, 'title') ?? '',
      description: this.#groupSetupAnswerText(conversationId, 'purpose') ?? '',
    });
    const memberNames = this.#deps.groups
      .members(conversationId)
      .map((m) => m.bot.name)
      .join('、');
    this.#appendSystemMessage(
      conversationId,
      'group_created',
      `群聊「${updated.title ?? ''}」创建完成，成员：${memberNames}。`,
    );
    this.#publishConversation(conversationId);
    return { conversation: updated, done: true };
  }

  /** The first not-yet-answered step, or null when the flow has finished. */
  #groupSetupCurrentStep(conversationId: string): GroupSetupStep | null {
    for (const step of GROUP_SETUP_STEPS) {
      const cardSeq = this.#groupSetupCardSeq(conversationId, step);
      if (cardSeq === null) return step;
      const answered = this.#deps.messages
        .userMessagesAfter(conversationId, cardSeq)
        .some((m) => 'setupAnswer' in m.content && m.content.setupAnswer === true);
      if (!answered) return step;
    }
    return null;
  }

  /** system_event seq of one group-setup step's card (substring match on step). */
  #groupSetupCardSeq(conversationId: string, step: GroupSetupStep): number | null {
    const row = this.#deps.db
      .prepare(
        "select seq from messages where conversation_id = ? and kind = 'system_event' and instr(content_json, ?) > 0 order by seq asc limit 1",
      )
      .get(conversationId, `"step":"${step}"`) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  /** The setupAnswer text a step received (first user message after its card). */
  #groupSetupAnswerText(conversationId: string, step: GroupSetupStep): string | null {
    const cardSeq = this.#groupSetupCardSeq(conversationId, step);
    if (cardSeq === null) return null;
    const answers = this.#deps.messages.userMessagesAfter(conversationId, cardSeq);
    const first = answers[0];
    return first && 'text' in first.content ? first.content.text : null;
  }

  // --- message lifecycle ---------------------------------------------------

  /** Edit notification rules (docs/design/02-execution.md "编辑作为一次新触发"). */
  editMessage(id: string, text: string): Message {
    const message = this.#deps.messages.edit(id, text);
    this.#deps.publish('message.updated', { conversationId: message.conversationId, message });
    const notified = this.#notifyRunningLoops(message.conversationId, message.seq, {
      type: 'edited',
      messageId: message.id,
      newText: text,
    });
    if (!notified) {
      // No running loop: the edit becomes a fresh trigger.
      const conv = this.#deps.conversations.getOrThrow(message.conversationId);
      if (conv.readOnly) return message;
      if (conv.type === 'group') {
        // Group: the edited message (its structured mentions/replyTo survive
        // the edit) goes through the same dispatcher as a fresh batch
        // (BR-P05-004, docs/design/02 "编辑作为一次新触发").
        this.#groupTurns.onUserBatch(message.conversationId, `edit:${message.id}`, [message]);
      } else if (conv.directBotId !== null) {
        // 同样过目录闸门：访谈期间编辑旧消息不绕过「先定目录」。
        this.#deliverDirectThroughGate(conv, conv.directBotId, [message], 'event', {
          event: 'message_edited',
        });
      }
    }
    return message;
  }

  /** Injects edit notices into loops that already saw the message. */
  #notifyRunningLoops(
    conversationId: string,
    seq: number,
    input: { type: 'edited'; messageId: string; newText?: string },
  ): boolean {
    let notified = false;
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.conversationId !== conversationId) continue;
      if (seq > entry.cutoffSeq) continue; // this loop never saw the message
      const mailbox = this.#mailboxes.for(entry.botId, conversationId);
      mailbox.injectMessageEvent({ conversationId, botId: entry.botId, ...input });
      notified = true;
    }
    return notified;
  }

  // --- runs ----------------------------------------------------------------

  /** D75 task layer: start / inject / cancel / list / settle / recover / sweep. */
  get tasks(): TaskHost {
    return this.#taskHost;
  }

  cancelRun(runId: string): Run | null {
    const run = this.#deps.runs.get(runId);
    if (!run) return null;
    if (isTerminal(run.status)) return run;
    // D75: a task is cancelled through its host (cancel entry → failure entry
    // → terminal; no wake — it is the user's decision, §3.3).
    if (run.loopType === 'task') return this.#taskHost.cancelById(runId, '用户取消');
    const entry = this.#activeRuns.get(runId);
    if (entry) {
      entry.handle.abort('user cancelled');
      // The engine may or may not unwind the pending tool await; cancelling
      // the approvals here guarantees the promise resolves either way.
      this.#deps.approvals.cancelPendingForRun(runId);
      // Checkpoint after-snapshot + lease release; the run's own unwind is
      // idempotent on both.
      void this.#deps.projects.releaseRun(runId).catch(() => {});
      return run;
    }
    // D66 mode B：后台子 run 不在 #activeRuns（独立于主 turn），显式取消委派
    // 经对话级锚点 abort；它自己的 unwind 负责 settle 行与审批清理。
    if (this.#subagentHost.abortOne(runId, 'user cancelled')) {
      this.#deps.approvals.cancelPendingForRun(runId);
      void this.#deps.projects.releaseRun(runId).catch(() => {});
      return run;
    }
    // Queued but not started: cancel directly.
    this.#cancelledBeforeStart.add(runId);
    this.#deps.approvals.cancelPendingForRun(runId);
    void this.#deps.projects.releaseRun(runId).catch(() => {});
    return this.#settleRun(runId, 'cancelled', null);
  }

  /**
   * P13 任务 2 (update gate, user-confirmed interrupt): cancels every
   * in-flight execution. Active runs abort asynchronously — the caller
   * re-queries `update.activeRuns` until it drains (bounded). Per-run
   * failures are collected, never thrown, so one stuck run cannot mask the
   * others. `reason` lands in the log for auditability.
   */
  cancelAllActive(reason: string): {
    cancelled: string[];
    failed: Array<{ id: string; reason: string }>;
  } {
    const cancelled: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const run of this.#deps.runs.listActive()) {
      try {
        this.cancelRun(run.id);
        cancelled.push(run.id);
      } catch (error) {
        failed.push({ id: run.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (cancelled.length > 0) {
      this.#deps.logger.info(
        { reason, count: cancelled.length },
        'cancelled active runs (update gate)',
      );
    }
    return { cancelled, failed };
  }

  /**
   * Retries a failed run with the same trigger messages. The mailbox owns
   * run creation (#startResponseRun is the only create path), so this only
   * validates and delivers; the returned run is the one the mailbox actually
   * started. When a loop is already running for the mailbox the batch is
   * injected as a steer instead and no new run is created (null is returned).
   */
  retryRun(runId: string): Run | null {
    const original = this.#deps.runs.get(runId);
    if (!original) throw new AppError('RUN_NOT_FOUND', `Run ${runId} does not exist`);
    if (original.status !== 'failed') return original;
    if (original.conversationId === null || original.botId === null) return original;
    // D75 §7.5: a task is not a mailbox run — retrying it (the setup card,
    // after the setup it failed on is done) starts a new task continuing it.
    if (original.loopType === 'task') return this.#taskHost.retry(original.id);
    const triggerMessages = original.triggerMessageIds
      .map((id) => this.#deps.messages.getById(id))
      .filter((m): m is Message => m !== null && m.status !== 'recalled');
    if (triggerMessages.length === 0) {
      throw new AppError('INVALID_INPUT', '原始触发消息已不存在，无法重试');
    }
    const conv = this.#deps.conversations.getOrThrow(original.conversationId);
    if (conv.readOnly) throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    const mailbox = this.#mailboxes.for(original.botId, original.conversationId);
    const wasRunning = mailbox.isRunning;
    mailbox.deliver({
      conversationId: original.conversationId,
      botId: original.botId,
      messages: triggerMessages,
      reason: (original.triggerReason ?? 'direct') as TriggerBatch['reason'],
    });
    if (wasRunning) return null;
    const created = this.#latestRunId(original.conversationId, original.botId);
    return created !== null ? this.#deps.runs.get(created) : null;
  }

  stepsFor(runId: string) {
    return this.#deps.runs.stepsFor(runId);
  }

  listByConversation(conversationId: string, limit?: number) {
    return this.#deps.runs.listByConversation(conversationId, limit);
  }

  /** Bot ids with an active run per conversation (sidebar indicator). */
  runningBotIds(conversationId: string): string[] {
    const ids = new Set<string>();
    for (const entry of this.#activeRuns.values()) {
      if (entry.conversationId === conversationId) ids.add(entry.botId);
    }
    return [...ids];
  }

  /**
   * True when a deliver() for this pair would start a fresh run right now.
   * Unlike runningBotIds this covers the registration window (run created,
   * loop not yet registered) and the closing window (settled, mailbox not
   * yet released) — a batch delivered while this is false becomes a steer,
   * never a second loop.
   */
  isMailboxIdle(botId: string, conversationId: string): boolean {
    const mailbox = this.#mailboxes.get(botId, conversationId);
    return mailbox === null || !mailbox.isRunning;
  }

  /** Used by lifecycle: cancels everything active for a conversation. */
  async abortRunsForConversation(conversationId: string): Promise<void> {
    // Drop the group-turn state BEFORE settling: a settle during teardown must
    // not advance the turn and start new runs (BR-P05-001).
    this.#groupTurns.clear(conversationId);
    // D66 mode B：后台子 run 挂对话级锚点，对话关闭才 abort（先于 settle 扫描）。
    this.#subagentHost.abortForConversation(conversationId, 'conversation deleted');
    // D75: tasks settle (cancelled, no wake) before the blanket settle below.
    this.#taskHost.abortForConversation(conversationId);
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.conversationId === conversationId) {
        entry.handle.abort('conversation deleted');
      }
    }
    this.#deps.approvals.cancelPendingForConversation(conversationId);
    // Only drop entries (and buffered steers) of THIS conversation: other
    // conversations' loops keep running (BR-P01-002).
    for (const [runId, entry] of [...this.#activeRuns.entries()]) {
      if (entry.conversationId === conversationId) this.#activeRuns.delete(runId);
    }
    for (const key of [...this.#pendingSteers.keys()]) {
      if (key.endsWith(`:${conversationId}`)) this.#pendingSteers.delete(key);
    }
    for (const run of this.#deps.runs.listActiveByConversation(conversationId)) {
      if (!this.#activeRuns.has(run.id)) this.#cancelledBeforeStart.add(run.id);
      this.#settleRun(run.id, 'cancelled', null);
    }
  }

  async abortRunsForBot(botId: string): Promise<void> {
    // D66 mode B：Bot 删除 abort 其全部后台子 run（对话级锚点）。
    this.#subagentHost.abortForBot(botId, 'bot deleted');
    this.#taskHost.abortForBot(botId);
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.botId === botId) {
        entry.handle.abort('bot deleted');
      }
    }
    this.#deps.approvals.cancelPendingForBot(botId);
    for (const [runId, entry] of [...this.#activeRuns.entries()]) {
      if (entry.botId === botId) this.#activeRuns.delete(runId);
    }
    for (const run of this.#deps.runs.listActiveByBot(botId)) {
      if (!this.#activeRuns.has(run.id)) this.#cancelledBeforeStart.add(run.id);
      this.#settleRun(run.id, 'cancelled', null);
    }
  }

  /**
   * Cancels one bot's runs in one conversation only (P05: removed from that
   * group) — other conversations of the bot keep running.
   */
  abortRunsForBotInConversation(botId: string, conversationId: string): void {
    // D66 mode B：该 Bot 在该对话的后台子 run 一并中止（移出群等）。
    this.#subagentHost.abortForBotInConversation(botId, conversationId, 'removed from group');
    this.#taskHost.abortForBotInConversation(botId, conversationId);
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.botId === botId && entry.conversationId === conversationId) {
        entry.handle.abort('removed from group');
      }
    }
    this.#deps.approvals.cancelPendingForBotInConversation(botId, conversationId);
    for (const [runId, entry] of [...this.#activeRuns.entries()]) {
      if (entry.botId === botId && entry.conversationId === conversationId) {
        this.#activeRuns.delete(runId);
      }
    }
    for (const run of this.#deps.runs.listActiveByConversation(conversationId)) {
      if (run.botId !== botId) continue;
      if (!this.#activeRuns.has(run.id)) this.#cancelledBeforeStart.add(run.id);
      this.#settleRun(run.id, 'cancelled', null);
    }
  }

  /** Group-turn coordinator hook for the interface: current/queued bots. */
  groupTurnState(conversationId: string) {
    return this.#groupTurns.stateOf(conversationId);
  }

  /**
   * A member left the group (removal or bot deletion): drop it from any turn
   * queue and cancel its runs in this conversation.
   */
  groupMemberRemoved(botId: string, conversationId: string): void {
    this.#groupTurns.onMemberRemoved(conversationId, botId);
    this.abortRunsForBotInConversation(botId, conversationId);
  }

  /** groups.redistribute: re-dispatch a stored batch as an explicit @. */
  redistributeBatch(conversationId: string, batchId: string, botId: string): void {
    this.#groupTurns.redistribute(conversationId, batchId, botId);
  }

  /**
   * Delivers a core event to one bot in one conversation (P06: install
   * finished). Appends a system message and hands it to the mailbox:
   * injected into a running loop, otherwise a fresh `event` run at priority 1.
   * The message is recorded with `internal: true` when `options.internal` is
   * set — Bot 内部事务（wiki 入库、环境安装、技能导入等）照常进入 Bot 的
   * 上下文与触发，但不作为对话内容展示给用户。Silent no-op when the
   * conversation or the bot is gone — installs outlive both (docs 任务 4).
   *
   * P10 unified guard entry: event triggers are exempt from the daily cap but
   * bound by quiet hours — during quiet hours the response trigger is parked
   * as a persistent `event_delivery` job until they end (BR-P10-006: a
   * restart or crash no longer loses the parked delivery; the system message
   * itself is recorded immediately).
   */
  deliverEventToBot(
    botId: string,
    conversationId: string,
    event: string,
    text: string,
    options: { internal?: boolean } = {},
  ): void {
    const conversation = this.#deps.conversations.get(conversationId);
    const bot = this.#deps.bots.get(botId);
    if (!conversation || conversation.readOnly) return;
    if (!bot || bot.status !== 'active') return;
    if (!this.#deps.conversations.memberBotIds(conversationId).includes(botId)) return;
    const message = this.#appendSystemMessage(conversationId, event, text, {
      ...(options.internal ? { internal: true } : {}),
    });
    const quiet = parseQuietHours(bot.profile.behavior.quiet_hours);
    const now = this.#deps.clock.now();
    if (quiet !== null && inQuietHours(now, quiet, this.#deps.timeZone)) {
      const endAt = quietHoursEndAt(now, quiet, this.#deps.timeZone);
      this.#deps.jobs.enqueue({
        type: 'event_delivery',
        botId,
        conversationId,
        // jobs-table priority is only the claim order; the scheduler submit
        // below (via jobs-runner) uses response priority 1.
        priority: 2,
        payload: { messageId: message.id, event },
        runAfter: endAt,
      });
      this.#deps.logger.info(
        { botId, conversationId, event, endAt },
        'event delivery parked to quiet hours end',
      );
      return;
    }
    this.#deliverEventMessage(botId, conversationId, event, message);
  }

  /**
   * jobs-runner `event_delivery` branch (BR-P10-006): delivers an event that
   * was parked for quiet hours. Re-validates the target and re-checks quiet
   * hours — the user may have changed (or cleared) the window while the
   * delivery was parked, in which case it is parked again.
   */
  deliverParkedEvent(job: JobRow): void {
    const payload = JSON.parse(job.payload_json) as { messageId?: unknown; event?: unknown };
    if (typeof payload.messageId !== 'string' || typeof payload.event !== 'string') {
      this.#deps.logger.warn({ jobId: job.id }, 'event_delivery job with malformed payload');
      return;
    }
    const message = this.#deps.messages.getById(payload.messageId);
    if (message === null || message.status === 'recalled') return;
    const conversation = this.#deps.conversations.get(message.conversationId);
    const bot = job.bot_id !== null ? this.#deps.bots.get(job.bot_id) : null;
    if (!conversation || conversation.readOnly) return;
    if (!bot || bot.status !== 'active') return;
    if (!this.#deps.conversations.memberBotIds(conversation.id).includes(bot.id)) return;
    const quiet = parseQuietHours(bot.profile.behavior.quiet_hours);
    const now = this.#deps.clock.now();
    if (quiet !== null && inQuietHours(now, quiet, this.#deps.timeZone)) {
      this.#deps.jobs.defer(job.id, quietHoursEndAt(now, quiet, this.#deps.timeZone));
      this.#deps.logger.info(
        { botId: bot.id, conversationId: conversation.id, event: payload.event },
        'parked event delivery re-deferred: quiet hours changed',
      );
      return;
    }
    this.#deliverEventMessage(bot.id, conversation.id, payload.event, message);
  }

  #deliverEventMessage(
    botId: string,
    conversationId: string,
    event: string,
    message: Message,
  ): void {
    this.#mailboxes.for(botId, conversationId).deliver({
      conversationId,
      botId,
      messages: [message],
      reason: 'event',
      extraAttributes: { event },
    });
  }

  /**
   * D66 mode B：后台委派子 run 结束后的 follow-up 注入。走与事件/定时共用的
   * 投递管道（deliverEventToBot → mailbox：在跑的 loop 被 steer，否则开新一轮
   * 响应 run）；消息带 internal 标记——进入 Bot 上下文与触发，但不作为对话
   * 内容展示、不冒充用户消息（D48/D54：子过程不刷聊天，只有主 Bot 对用户的
   * 发言进聊天）。
   */
  #injectDelegateFollowUp(followUp: SubagentFollowUp): void {
    if (followUp.botId === null || followUp.conversationId === null) return;
    const headline =
      followUp.conclusion !== null
        ? followUp.hitLimit
          ? '后台委派子任务达到时间/token 预算上限，以下为已完成部分的压缩结论：'
          : '后台委派子任务已完成，以下为压缩结论：'
        : (followUp.failure ?? '后台委派子任务失败');
    const text = [
      `委派任务结束通知（来源：delegate_task，child_run_id: ${followUp.childRunId}；宿主系统注入，不是用户消息）。`,
      headline,
      ...(followUp.conclusion !== null
        ? [`<untrusted>\n${followUp.conclusion}\n</untrusted>`]
        : []),
      '请决定是否向用户转述、继续追问或开启新任务；不要把结论重复委派给子代理。',
    ].join('\n');
    this.deliverEventToBot(followUp.botId, followUp.conversationId, SUBAGENT_FOLLOWUP_EVENT, text, {
      internal: true,
    });
  }

  /**
   * Delivers a scheduled trigger to one bot in one conversation (P10): the
   * guard has already passed in ScheduleService, so this only records the
   * system message and hands the batch to the mailbox with
   * reason='scheduled' (priority 1, docs/dev/04-agent-runtime.md 触发段).
   */
  deliverScheduleToBot(input: {
    botId: string;
    conversationId: string;
    scheduleId: string;
    text: string;
    /** >1 minute lateness, already humanized by the caller when present. */
    lateByMs?: number | null;
  }): void {
    const conversation = this.#deps.conversations.get(input.conversationId);
    const bot = this.#deps.bots.get(input.botId);
    if (!conversation || conversation.readOnly) return;
    if (!bot || bot.status !== 'active') return;
    if (!this.#deps.conversations.memberBotIds(input.conversationId).includes(input.botId)) return;
    // 调度触发是 Bot 自己的事务（P10）：触发消息照常进 Bot 的上下文，
    // 但不作为对话内容展示——Bot 到点干活，用任务结果说话。
    const message = this.#appendSystemMessage(input.conversationId, 'schedule_fired', input.text, {
      internal: true,
    });
    const extraAttributes: Record<string, string | number> = { schedule_id: input.scheduleId };
    if (input.lateByMs != null) extraAttributes['late_by'] = humanizeLateBy(input.lateByMs);
    this.#mailboxes.for(input.botId, input.conversationId).deliver({
      conversationId: input.conversationId,
      botId: input.botId,
      messages: [message],
      reason: 'scheduled',
      extraAttributes,
    });
  }

  // --- startup recovery ------------------------------------------------------

  /**
   * Marks unfinished runs `interrupted`, cancels their pending approvals and
   * inserts a system message into the affected conversations. Never resumes
   * them (docs/dev/02-architecture.md).
   */
  recoverInterrupted(): number {
    // D75 §7.4 step 1: tasks are repaired first — one with a terminal entry
    // adopts its status instead of being blanket-interrupted (§3.2 修复);
    // submitted tasks stay queued and are re-queued below.
    let tasksRepaired = true;
    try {
      this.#taskHost.recover();
    } catch (error) {
      tasksRepaired = false;
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'task repair failed; tasks fall back to the blanket interruption',
      );
    }
    // Fallback: unrepaired tasks are interrupted with the rest; reconciliation
    // (resume) then writes their missing failure entries and wakes the bot.
    const runs = this.#deps.runs.markAllActiveInterrupted(
      tasksRepaired ? { exceptLoopTypes: ['task'] } : {},
    );
    this.#deps.approvals.cancelAllPending();
    for (const run of runs) {
      this.#deps.grants.expireForRun(run.id);
      if (run.conversationId === null) continue;
      if (this.#deps.conversations.get(run.conversationId) === null) continue;
      const message = this.#deps.messages.append({
        conversationId: run.conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: 'run_interrupted',
        text: '上次执行因应用退出而中断',
      });
      this.#deps.publish('message.created', {
        conversationId: message.conversationId,
        message,
      });
    }
    if (runs.length > 0) {
      this.#deps.logger.info({ runs: runs.length }, 'recovered interrupted runs');
    }
    // D71：working 委派的 run 已被标 interrupted → 落 failed（不续跑，D49）；
    // 未投递的委派重新过投递闸门（启动时邮箱全空）。
    try {
      this.#delegationHost.recover();
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'delegation recovery failed',
      );
    }
    // D75 §7.4 steps 3–4: re-queue submitted tasks, re-deliver unconsumed results.
    try {
      this.#taskHost.resume();
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'task resume failed',
      );
    }
    return runs.length;
  }

  /** RPC `butler.acceptRoute`: the user agreed to a delegate route card (D70 §2.4). */
  acceptRoute(messageId: string): Message {
    return this.#butlerHost.acceptRoute(messageId);
  }

  // --- cross-bot delegation (D71) ---------------------------------------------

  /** RPC `delegations.get`. */
  getDelegation(id: string): Delegation | null {
    return this.#delegationHost.get(id);
  }

  /**
   * RPC `delegations.cancel` (A-side card button). 本地单用户应用：委派行不设
   * 属主作用域，取消只校验存在性——未知 id 报 NOT_FOUND（UI toast），而不是
   * 静默返回 null；终态行的取消在 host 里静默让路（返回当前行）。
   */
  cancelDelegation(id: string): Delegation | null {
    if (this.#delegationHost.get(id) === null) {
      throw new AppError('NOT_FOUND', `委派 ${id} 不存在`);
    }
    return this.#delegationHost.cancel(id, '用户取消');
  }

  /** jobs-runner `delegation_delivery`: B's quiet hours ended — re-run the delivery gate. */
  deliverParkedDelegation(job: JobRow): void {
    this.#delegationHost.deliverParked(job);
  }

  /** Lifecycle: a conversation is being deleted — delegations on either side end. */
  delegationsOnConversationDeleted(conversationId: string): void {
    this.#delegationHost.onConversationDeleted(conversationId);
  }

  /** Lifecycle: a bot is being deleted — delegations it sent or received end. */
  delegationsOnBotDeleted(botId: string): void {
    this.#delegationHost.onBotDeleted(botId);
  }

  /**
   * Hands a delegation's proxied user message to B's mailbox (reason
   * 'delegation'). The host only calls this when B's mailbox is idle, so the
   * batch starts a fresh run whose id is returned.
   */
  #deliverDelegationMessage(input: {
    botId: string;
    conversationId: string;
    message: Message;
    extraAttributes: Record<string, string | number>;
  }): string | null {
    const conversation = this.#deps.conversations.get(input.conversationId);
    if (!conversation || conversation.readOnly) return null;
    if (this.#setupPathGateClosed(conversation.id, input.botId)) return null;
    return this.#mailboxes.for(input.botId, conversation.id).deliver({
      conversationId: conversation.id,
      botId: input.botId,
      messages: [input.message],
      reason: 'delegation',
      extraAttributes: input.extraAttributes,
    });
  }

  // --- internals -------------------------------------------------------------

  /** Member cards for <conversation_info> (P05, docs/design/03-bot.md "名片"). */
  #memberCards(conversationId: string): BotCard[] {
    const cards: BotCard[] = [];
    for (const botId of this.#deps.conversations.memberBotIds(conversationId)) {
      const bot = this.#deps.bots.get(botId);
      if (!bot || bot.status !== 'active') continue;
      cards.push({
        id: bot.id,
        name: bot.profile.identity.name || bot.name,
        bio: bot.bio,
        role: bot.profile.role.responsibilities,
      });
    }
    return cards;
  }

  /** Appends + publishes a system message (group events, P05). */
  #appendSystemMessage(
    conversationId: string,
    event: string,
    text: string,
    extra: {
      botIds?: string[];
      batchId?: string | null;
      options?: string[];
      step?: string;
      internal?: boolean;
    } = {},
  ): Message {
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event,
      text,
      ...(extra.botIds !== undefined ? { botIds: extra.botIds } : {}),
      ...(extra.batchId != null ? { relatedBatchId: extra.batchId } : {}),
      ...(extra.options !== undefined ? { options: extra.options } : {}),
      ...(extra.step !== undefined ? { step: extra.step } : {}),
      ...(extra.internal ? { internal: true } : {}),
    });
    // 内部事务事件不是对话内容：不向 UI 推送（读取侧也会过滤）。
    if (!extra.internal) {
      this.#deps.publish('message.created', { conversationId, message });
    }
    this.#publishConversation(conversationId);
    return message;
  }

  /**
   * Bot text bubble appended outside a run (setup interview opening/acks):
   * same persistence + push path as a run's final reply.
   */
  #appendBotTextMessage(botId: string, conversationId: string, text: string): Message {
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'bot',
      senderBotId: botId,
      kind: 'text',
      text,
    });
    this.#deps.publish('message.created', { conversationId, message });
    this.#publishConversation(conversationId);
    return message;
  }

  /**
   * 对话式新建（UI 改版）`bots.interview.start` 落点：确定性下发问候气泡与
   * 固定首问卡片（含预置候选），不触发 LLM run——用户作答后才开始第一个
   * 响应 run。后续问题由访谈中的 Bot 通过 ask_question 工具发出。
   */
  beginSetupInterview(botId: string, conversationId: string): void {
    // 幂等守卫：interview.start 重试/重复触发不得重复下发问候与首问（还会
    // 抬高 ask_question 的 5 问计数）。任何已开始的访谈都至少有首问这张卡。
    if (this.#deps.messages.countSystemEvents(conversationId, SETUP_QUESTION_EVENT) > 0) return;
    // 管家访谈（D70）是同一机制的变体：问的是用户的领域与场景，不是「这个
    // 助手要做什么」。
    const butler = this.#deps.bots.get(botId)?.systemRole === 'butler';
    this.#appendBotTextMessage(
      botId,
      conversationId,
      butler ? BUTLER_SETUP_GREETING : SETUP_GREETING,
    );
    this.#appendSystemMessage(
      conversationId,
      SETUP_QUESTION_EVENT,
      butler ? BUTLER_SETUP_FIRST_QUESTION : SETUP_FIRST_QUESTION,
      { options: butler ? [...BUTLER_SETUP_FIRST_OPTIONS] : [...SETUP_FIRST_OPTIONS] },
    );
  }

  /**
   * 确保唯一管家存在并有一个打开的私聊（D70，docs/design/27）。幂等。
   * `interview`（新用户引导）让新建的管家进入访谈：确定性问候 + 固定首问卡；
   * 否则（存量用户升级）只发一条确定性欢迎语。已存在的管家不再下发任何
   * 消息——私聊被删过时只重开一个空私聊，保证侧栏置顶入口在。
   */
  ensureButler(options: { interview?: boolean } = {}): {
    bot: Bot;
    conversationId: string;
    created: boolean;
  } {
    const { bot, created } = this.#deps.bots.ensureButler(
      butlerProfileTemplate(),
      options.interview === true ? { interview: true } : {},
    );
    if (created) this.#deps.publish('bot.updated', { bot });
    const { conversation, created: conversationCreated } = this.#deps.conversations.openDirect(
      bot.id,
    );
    if (conversationCreated) this.#publishConversation(conversation.id);
    if (created) {
      if (bot.setupState === 'interviewing') this.beginSetupInterview(bot.id, conversation.id);
      else this.#appendBotTextMessage(bot.id, conversation.id, BUTLER_WELCOME_TEXT);
    }
    return { bot, conversationId: conversation.id, created };
  }

  /** Environment tool facade: real manager when wired, fail-closed stub otherwise. */
  #environmentFacade(): EnvironmentToolFacade & { installedToolchains(): InstalledToolchain[] } {
    const environment = this.#deps.environment;
    if (environment !== undefined) return environment;
    return {
      request: async () => {
        throw new AppError('ENV_ITEM_UNKNOWN', '环境管理器未就绪');
      },
      offeredItems: () => [],
      installedToolchains: () => [],
    };
  }

  /** <workspace> 可用工具链 lines (P06, docs/dev/04-agent-runtime.md). */
  #toolchainPromptLines(): string[] {
    return this.#environmentFacade()
      .installedToolchains()
      .map((toolchain) => {
        const label = toolchain.item === 'python' ? 'python3' : toolchain.item;
        return `${label} ${toolchain.version}`;
      });
  }

  /** <access> prompt section input: sandbox state + this bot's active grants. */
  async #accessPromptInfo(identity: RunIdentity) {
    const availability = await this.#deps.sandbox.probe();
    const grants = this.#deps.grants.listEffective(identity);
    const isWindows = process.platform === 'win32';
    return {
      sandboxAvailable: availability.available,
      confirmModeReason: availability.reason,
      confirmShell: isWindows ? 'PowerShell' : '/bin/sh',
      grants,
    };
  }

  #createMailbox(key: string): Mailbox {
    return new Mailbox(key, {
      startRun: (batch) => this.#startResponseRun(batch),
      steer: (batch, text) => this.#steerRunningRun(batch, text),
      injectEvent: (batch, text) => this.#steerRunningRun(batch, text),
      renderOptions: () => this.#renderOptions(),
    });
  }

  #renderOptions(): RenderMessageOptions {
    const names = new Map<string, string>();
    for (const bot of this.#deps.bots.listActive()) names.set(bot.id, bot.name);
    return {
      selfBotId: null,
      timeZone: this.#deps.timeZone,
      botNames: names,
      renderCard: (message) => {
        if (message.senderType !== 'system' || message.kind !== 'card') return null;
        const content = message.content;
        if (
          'cardType' in content &&
          (content.cardType === DELEGATION_SENT_CARD || content.cardType === DELEGATION_RESULT_CARD)
        ) {
          return this.#delegationHost.renderContextLine(
            content.cardType,
            String(content.delegationId ?? ''),
          );
        }
        if ('runId' in content && content.cardType === 'run_changes') {
          const change = this.#deps.projects.changesOf(String(content.runId ?? ''));
          if (change === null) return '（改动记录已清理）';
          if (change.revertedAt !== null) return `[系统] 执行 ${content.runId} 的改动已整次回退`;
          const counts = { added: 0, modified: 0, deleted: 0 };
          for (const file of change.files) counts[file.change] += 1;
          return `[系统] 本次执行改动了 ${change.files.length} 个文件（新增 ${counts.added}、修改 ${counts.modified}、删除 ${counts.deleted}），可在界面查看 diff 或整次回退`;
        }
        const approvalId =
          content && 'approvalId' in content ? String(content.approvalId ?? '') : '';
        const approval = this.#deps.approvals.get(approvalId);
        return approval ? this.#deps.approvals.renderContextLine(approval) : '（审批记录已清理）';
      },
    };
  }

  #startResponseRun(batch: TriggerBatch): string {
    const agentId = this.#agentIdOf(this.#deps.bots.get(batch.botId));
    const run = this.#deps.runs.create({
      // D72: recorded up front so every settle path (cancelled before start,
      // inactive bot, failed gate) carries the engine the run was meant for.
      engine: agentId.length > 0 ? agentEngineKey(agentId) : BUILTIN_ENGINE,
      botId: batch.botId,
      conversationId: batch.conversationId,
      loopType: 'response',
      triggerReason: batch.reason,
      triggerMessageIds: batch.messages.map((m) => m.id),
      ...(batch.chain !== undefined
        ? { chainId: batch.chain.id, chainDepth: batch.chain.depth }
        : {}),
    });
    this.#deps.publish('run.status', { run });
    this.#deps.scheduler.submit({
      // Chain / scheduled / event responses are priority 1; user-triggered
      // responses are 0 (docs/dev/04-agent-runtime.md "各类 loop 的配置").
      // D71 delegation runs count as user-triggered (0): the user asked A
      // for it and is waiting in A's conversation.
      priority:
        batch.reason === 'chain' || batch.reason === 'scheduled' || batch.reason === 'event'
          ? 1
          : 0,
      provider: this.#providerForRef(this.#modelRefForBot(batch.botId)),
      key: this.#mailboxKey(batch.botId, batch.conversationId),
      // Lease waits of this run give the slot back (D75 审查 H2).
      runId: run.id,
      run: () => this.#executeRun(run.id, { kind: 'response', batch }),
    });
    return run.id;
  }

  /** D72 P6：后台调用的模型路由（未装配路由器时只用内置模型）。 */
  #backgroundRoute(botId: string, purpose: LlmPurpose): LlmRoute | null {
    if (this.#deps.llmRouter !== undefined) {
      return this.#deps.llmRouter.resolveForBot(botId, purpose);
    }
    return builtinRoute(
      this.#deps.engine,
      lightModelRefForBot(this.#deps.bots, this.#deps.settings, botId),
    );
  }

  /** SubAgent 结果压缩的模型与引擎（'' = 不压缩、截断兜底）。 */
  #compactionRoute(botId: string): { lightModelRef: string; lightEngine?: AgentEngine } {
    const route = this.#backgroundRoute(botId, 'subagent_compaction');
    if (route === null) return { lightModelRef: '' };
    return { lightModelRef: route.modelRef, lightEngine: route.engine };
  }

  /**
   * Messages a bot sees in a conversation (D75, design 30 §2.4.3): shared rows
   * plus the viewer's own private `task_event` rows; `viewerBotId === null`
   * means shared rows only (a task's conversation layer). Every context read
   * goes through here so the viewer rule lives in one place.
   */
  #contextMessages(conversationId: string, viewerBotId: string | null, limit: number): Message[] {
    return viewerBotId === null
      ? this.#deps.messages.listShared(conversationId, { limit })
      : this.#deps.messages.listForBot(conversationId, viewerBotId, { limit });
  }

  #mailboxKey(botId: string, conversationId: string): string {
    return `${botId}:${conversationId}`;
  }

  /**
   * Main model ref of a bot. External-agent bots (D72) get the pseudo ref
   * `agent:{id}/{model|default}` so #providerForRef and the scheduler's
   * concurrency key land on `agent:{id}`.
   */
  #modelRefForBot(botId: string): string {
    try {
      const bot = this.#deps.bots.get(botId);
      const agent = bot?.profile.runtime.agent;
      if (agent !== undefined && this.#agentIdOf(bot).length > 0) {
        return agentModelRef(agent.id, agent.model);
      }
      const settings = this.#deps.settings.get();
      return bot?.profile.runtime.model || settings.defaultMainModel;
    } catch {
      return '';
    }
  }

  /**
   * The external agent driving a bot's response runs ('' = built-in engine).
   * The conversational setup interview (incl. the butler's) needs the
   * interview tools (ask_question / save_profile / finish_setup), which are
   * never injected into agents: it always runs on the built-in engine — a
   * user without a built-in model gets the structured main-model setup card.
   */
  #agentIdOf(bot: Bot | null | undefined): string {
    if (bot === null || bot === undefined || bot.setupState === 'interviewing') return '';
    return bot.profile.runtime.agent.id;
  }

  /** The engine driving a bot's response runs (D72): pi unless an agent is set. */
  #engineFor(bot: Bot): AgentEngine | null {
    if (this.#agentIdOf(bot).length === 0) return this.#deps.engine;
    return this.#deps.externalEngine ?? null;
  }

  /**
   * D72 外部 Agent run 的准备（design 28 §4–§5）：按能力包过滤宿主工具，生成
   * 会话级提示词（ACP 版平台规则 + `<tool_policy>` + 身份 / 人设 / 对话信息，
   * 工具名经 Provider 映射）与 run 级动态段（只读上下文与能力包解耦，照常
   * 注入；`<project>` 跳过 Agent 自己会读的约定文件）。
   */
  async #agentRunSetup(input: {
    bot: Bot;
    conversation: Conversation;
    agentId: string;
    identity: RunIdentity;
    responseTools: ToolDefinition[];
    workspacePath: string;
    hasProject: boolean;
    memorySections: { userProfile?: string; myState?: string; relevantMemories?: string };
    wikiTopics: string;
    skills: string;
    recommendedSkills: string;
    conversationText: string;
    /** P5 会话复用：触发批、触发段（增量对话段用）、工作目录与模型引用（指纹）。 */
    batch: TriggerBatch;
    renderOptions: RenderMessageOptions;
    triggerContent: string;
    workdir: string;
    modelRef: string;
    /** Highest seq of the conversation context shown to a new session. */
    contextCutoff: number;
  }): Promise<{
    tools: ToolDefinition[];
    capabilities: string[];
    hostServerName: string;
    loadUserConfig: boolean;
    permission: AgentPermissionTier;
    agentSideConfigFiles: readonly string[];
    agentName: string;
    promptParts: {
      session: string;
      run: string;
      conversation: string;
      conversationDelta?: string;
    };
    session: { rowId: string; reuseId: string | null; fingerprint: string; seen: AgentSeen };
  }> {
    const { bot, conversation, agentId } = input;
    const entry = findAgentEntry(this.#deps.agentCatalog?.() ?? [], agentId);
    if (entry === null) throw new AppError('AGENT_UNAVAILABLE', `智能体「${agentId}」不在目录中`);
    const provider = providerFor(entry);
    // D72 P3：Bot 的档位（Windows 下无可依赖沙箱时 workspace → ask）。
    const permission = effectiveAgentPermission(
      bot.profile.runtime.agent.permission,
      provider,
      process.platform,
    );
    const capabilities = resolveCapabilities(bot.profile.runtime.agent.capabilities, entry, {
      isButler: bot.systemRole === 'butler',
    });
    const loadUserConfig = this.#deps.settings.get().agents[agentId]?.loadUserConfig === true;
    // D72 P5 会话复用（design 28 §7）：窗口内、指纹一致的会话只发增量。桥
    // server 名由会话行 id 派生（换会话 = 换名字），会话级提示词里的工具名
    // 随之变化，所以按候选行先算一遍、指纹不符再按新行重算。
    const previous = this.#agentSessions.get(bot.id, conversation.id, agentId);
    const now = this.#deps.clock.now();
    const continued =
      previous !== null && now - previous.lastUsedAt <= CONTINUATION_WINDOW_MS
        ? this.#agentConversationDelta(previous, input.batch, input.renderOptions)
        : null;
    const delta = continued?.text ?? null;
    const sessionFor = (rowId: string) => {
      // Per-session bridge server name (no user MCP server can pose as it);
      // the prompt's tool names are spelled with it.
      const hostServerName = hostServerNameFor(rowId);
      const toolName = hostToolNamer(provider, hostServerName);
      const tools = buildExternalAgentTools({
        responseTools: input.responseTools,
        capabilities,
        maxNameLength: MAX_AGENT_TOOL_NAME - toolName('').length,
      });
      const sessionPrompt = buildAgentSessionPrompt({
        bot,
        conversation,
        ...(conversation.type === 'group' ? { members: this.#memberCards(conversation.id) } : {}),
        tools: {
          toolNames: tools.map((tool) => tool.name),
          nativeCapabilities: entry.nativeCapabilities,
          toolName,
        },
      });
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            v: 1,
            sessionPrompt,
            cwd: input.workdir,
            permission,
            model: input.modelRef,
            effort: bot.profile.runtime.agent.effort,
            capabilities: [...capabilities].sort(),
            tools: tools.map((tool) => tool.name).sort(),
            server: hostServerName,
            loadUserConfig,
          }),
        )
        .digest('hex');
      return { rowId, hostServerName, tools, sessionPrompt, fingerprint };
    };
    let session = sessionFor(delta !== null ? previous!.id : newId('ags'));
    let reuseId: string | null = null;
    if (delta !== null && session.fingerprint === previous!.fingerprint) {
      reuseId = previous!.agentSessionId;
    } else {
      if (delta !== null) session = sessionFor(newId('ags'));
      // Expired / changed: the old session is given up (closed if its process
      // still has it; the row is replaced once the new session exists).
      if (previous !== null) this.#discardAgentSession(previous, false);
    }
    const tools = session.tools;
    const access = await this.#accessPromptInfo(input.identity);
    const project = input.hasProject
      ? await this.#deps.projects.promptSection(conversation.id, {
          skipGuideFiles: provider.agentSideConfigFiles,
        })
      : null;
    return {
      tools,
      capabilities,
      hostServerName: session.hostServerName,
      loadUserConfig,
      permission,
      agentSideConfigFiles: provider.agentSideConfigFiles,
      agentName: entry.name,
      session: {
        rowId: session.rowId,
        reuseId,
        fingerprint: session.fingerprint,
        // Committed only once the prompt is really sent (onPromptSent).
        seen:
          reuseId !== null && continued !== null
            ? continued.seen
            : { baseCutoff: input.contextCutoff, ids: new Map() },
      },
      promptParts: {
        session: session.sessionPrompt,
        run: buildAgentRunContext({
          timeZone: this.#deps.timeZone,
          now: new Date(this.#deps.clock.now()),
          permission,
          ...(project !== null ? { project } : {}),
          workspace: {
            path: input.workspacePath,
            entries: this.#deps.gateway.workspaceTopLevel(input.workspacePath),
            toolchains: this.#toolchainPromptLines(),
          },
          grants: access.grants,
          ...input.memorySections,
          ...(input.wikiTopics.length > 0 ? { wikiTopics: input.wikiTopics } : {}),
          ...(input.skills.length > 0 ? { skills: input.skills } : {}),
          ...(input.recommendedSkills.length > 0
            ? { recommendedSkills: input.recommendedSkills }
            : {}),
        }),
        conversation: input.conversationText,
        ...(reuseId !== null
          ? {
              conversationDelta: [delta, input.triggerContent]
                .filter((part): part is string => part !== null && part.length > 0)
                .join('\n\n'),
            }
          : {}),
      },
    };
  }

  /**
   * What a reused agent session has not seen (P5, 审查 #2/#3/#5): messages
   * after its `baseCutoff` up to the trigger batch (later ones arrive as
   * steers or the next batch), minus those shown individually (steered), the
   * batch itself and the bot's own replies (the session produced them). Null
   * when the seen-state is unknown (app restarted) or the gap exceeds the
   * recent window — the session is then not reused.
   */
  #agentConversationDelta(
    row: AgentSessionRow,
    batch: TriggerBatch,
    renderOptions: RenderMessageOptions,
  ): { text: string; seen: AgentSeen } | null {
    const seen = this.#agentSessionSeen.get(row.id);
    if (seen === undefined) return null;
    const upTo = Math.max(-1, ...batch.messages.map((message) => message.seq));
    const limit = 120;
    const recent = this.#contextMessages(batch.conversationId, batch.botId, limit);
    if (recent.length === limit && recent[0]!.seq > seen.baseCutoff + 1) return null;
    const batchIds = new Set(batch.messages.map((message) => message.id));
    const text = buildConversationDelta(
      recent.filter(
        (message) =>
          message.seq > seen.baseCutoff &&
          message.seq <= upTo &&
          !seen.ids.has(message.id) &&
          !batchIds.has(message.id) &&
          !(message.senderType === 'bot' && message.senderBotId === batch.botId),
      ),
      renderOptions,
    );
    return {
      text,
      seen: {
        baseCutoff: Math.max(seen.baseCutoff, upTo),
        ids: new Map([...seen.ids].filter(([, seq]) => seq > upTo)),
      },
    };
  }

  /** Gives up a kept agent session (best effort, asynchronous). */
  #discardAgentSession(
    row: Pick<AgentSessionRow, 'id' | 'agentId' | 'agentSessionId' | 'botId' | 'conversationId'>,
    deleteHistory: boolean,
  ): void {
    this.#agentSessionSeen.delete(row.id);
    const discard = this.#deps.externalEngine?.discardSession;
    if (discard === undefined) return;
    void discard
      .call(this.#deps.externalEngine, {
        agentId: row.agentId,
        agentSessionId: row.agentSessionId,
        sessionKey: `${row.botId}:${row.conversationId}:${row.agentId}`,
        deleteHistory,
      })
      .catch((error: unknown) => {
        this.#deps.logger.warn(
          { agentId: row.agentId, error: error instanceof Error ? error.message : String(error) },
          'discarding the agent session failed',
        );
      });
  }

  /**
   * Lifecycle (D72 P5): the conversation / bot / group membership is gone —
   * its agent sessions are deleted on the agent side when it can
   * (`session/delete`, best effort) and their rows removed. The agents' own
   * on-disk history is not KepCup's to manage beyond that.
   */
  agentSessionsOnConversationDeleted(conversationId: string): void {
    for (const row of this.#agentSessions.listByConversation(conversationId)) {
      this.#discardAgentSession(row, true);
      this.#agentSessions.delete(row.id);
    }
  }

  agentSessionsOnBotDeleted(botId: string): void {
    for (const row of this.#agentSessions.listByBot(botId)) {
      this.#discardAgentSession(row, true);
      this.#agentSessions.delete(row.id);
    }
  }

  agentSessionsOnGroupMemberRemoved(botId: string, conversationId: string): void {
    for (const row of this.#agentSessions.listByConversation(conversationId)) {
      if (row.botId !== botId) continue;
      this.#discardAgentSession(row, true);
      this.#agentSessions.delete(row.id);
    }
  }

  /**
   * D72 P3 project 闸门（design 28 §6）：
   * 1. Agent 侧配置确认——project 根下有 Provider 声明的、Agent 自己会读且
   *    无法关闭的配置（AGENTS.md、.codex/ …）时，首次在此 project 运行前弹
   *    `agent_tool`（子类型 config）卡；批准记住到对话（同 Bot、同 Agent、
   *    同 project，文件集合未增加即不再问）；
   * 2. 显式租约——档位可写时 run 开工前取 project 写入租约（排队时 run 进
   *    waiting_lease），整 run 持有，结算照常 releaseRun（前后快照 → 改动卡 /
   *    回退可用）。
   * 返回 'cancelled' 时 run 已被 cancelRun 结算。
   */
  async #agentProjectGate(input: {
    runId: string;
    identity: RunIdentity;
    botId: string;
    conversationId: string;
    agentId: string;
    agentName: string;
    projectPath: string;
    configFiles: readonly string[];
    writable: boolean;
  }): Promise<'ok' | 'denied' | 'cancelled'> {
    // Agents look for their config from the session directory up to the git
    // worktree root (OpenCode, Codex AGENTS.md …, P5 审查 H1): so does the gate.
    const searchRoot = gitRootAbove(input.projectPath) ?? input.projectPath;
    const found: string[] = [];
    for (const dir of directoryChain(searchRoot, input.projectPath)) {
      for (const name of input.configFiles) {
        const bare = name.replace(/[\\/]+$/, '');
        if (!existsSync(nodePath.join(dir, bare))) continue;
        const relative = nodePath
          .relative(searchRoot, nodePath.join(dir, bare))
          .split(nodePath.sep)
          .join('/');
        found.push(bare === name ? relative : `${relative}/`);
      }
    }
    if (found.length > 0) {
      // Remembered only for the same content: any change to the files (also
      // by the agent itself) asks again (review M2).
      const configHash = hashAgentConfigFiles(searchRoot, found);
      const remembered = this.#deps.approvals
        .approvedAgentConfigs(input.conversationId, input.botId)
        .some((approval) => {
          const payload = agentToolApprovalPayloadSchema.safeParse(approval.payload);
          return (
            payload.success &&
            payload.data.agentId === input.agentId &&
            payload.data.projectPath === input.projectPath &&
            payload.data.configHash === configHash
          );
        });
      if (!remembered) {
        const payload: AgentToolApprovalPayload = {
          agentId: input.agentId,
          agentName: input.agentName,
          title: '加载项目内的智能体配置',
          kind: 'config',
          toolKind: '',
          locations:
            searchRoot === input.projectPath
              ? found
              : found.map((name) => nodePath.join(searchRoot, name)),
          cwd: input.projectPath,
          options: [],
          durations: ['conversation'],
          reason:
            '这些文件由智能体自己读取（可能包含指令、钩子或权限规则，可能放宽智能体的权限），KepCup 无法关闭' +
            (searchRoot === input.projectPath ? '' : '；含项目上层直到 git 根目录中的同类文件'),
          sensitive: false,
          exemptDirs: [],
          projectPath: input.projectPath,
          configHash,
        };
        const outcome = await this.#deps.approvals.request(input.identity, 'agent_tool', payload);
        if (this.#cancelledBeforeStart.delete(input.runId)) return 'cancelled';
        if (outcome.decision === 'cancelled') return 'cancelled';
        if (outcome.decision !== 'approved') return 'denied';
      }
    }
    if (!input.writable) return 'ok';
    try {
      await this.#deps.projects.ensureWriteLease(input.identity, input.projectPath, {
        reason: '外部智能体在 project 内执行（整 run 持有写入租约）',
        // No other lease target may replace it during the run (review M6).
        pin: true,
      });
    } catch (error) {
      if (this.#cancelledBeforeStart.delete(input.runId)) return 'cancelled';
      throw error;
    }
    if (this.#cancelledBeforeStart.delete(input.runId)) {
      await this.#deps.projects.releaseRun(input.runId).catch(() => {});
      return 'cancelled';
    }
    return 'ok';
  }

  /** Whether a run already did visible work (model / tool steps or messages). */
  #runProducedWork(runId: string): boolean {
    if ((this.#deps.runs.get(runId)?.outputMessageIds.length ?? 0) > 0) return true;
    return this.#deps.runs
      .stepsFor(runId)
      .some(
        (step) =>
          step.type === 'assistant' || step.type === 'tool_call' || step.type === 'tool_result',
      );
  }

  /** AgentsService 的状态视图（未装配 → undefined，门禁只看启用开关）。 */
  #agentView(): ((agentId: string) => AgentView | null) | undefined {
    const agents = this.#deps.agents;
    if (agents === undefined) return undefined;
    return (agentId) => {
      try {
        return agents.view(agentId);
      } catch {
        return null;
      }
    };
  }

  /**
   * 外部 Agent run 失败的错误码 → 结构化 setup（null = 普通失败）。先把错误
   * 回写给 AgentsService（未登录 → 状态 needs_auth，设置卡据此展示登录）。
   */
  #agentFailureSetup(
    agentId: string,
    code: string | undefined,
    message?: string,
  ): SetupRequirement | null {
    if (code === undefined) return null;
    this.#deps.agents?.noteRunError(agentId, code);
    const view = this.#agentView();
    const stateReason =
      code === 'AGENT_UNAVAILABLE' && view !== undefined
        ? agentSetupReasonOf(view(agentId), true)
        : null;
    const reason = agentSetupReasonForError(code, stateReason);
    if (reason === null) return null;
    // Which file / key to fix (第三轮审查 #6): the error message lists them.
    return reason === 'config_unsafe' && message !== undefined && message.length > 0
      ? { kind: 'agent', agentId, reason, detail: message }
      : { kind: 'agent', agentId, reason };
  }

  #providerForRef(modelRef: string): string {
    const index = modelRef.indexOf('/');
    return index > 0 ? modelRef.slice(0, index) : 'unknown';
  }

  /**
   * D75 task launch (TaskHost `execute`): rebuilds the brief from the task's
   * private entries, takes the write lease for a write task (§5.1 — the whole
   * task holds it; the row stays `queued` = submitted while it waits, and no
   * scheduler slot is held meanwhile), then submits the shared run skeleton
   * (`kind: 'task'`) under scheduler key `task:{id}`. Every path ends in
   * `control.finish()`.
   */
  async #startTask(task: Run, control: TaskRunControl): Promise<void> {
    let submitted = false;
    try {
      // Stopped before it got here: the host already settled it.
      if (control.signal.aborted) return;
      if (task.botId === null || task.conversationId === null) {
        this.#taskHost.settle(task.id, { status: 'failed', error: '任务缺少 Bot 或对话' });
        return;
      }
      const brief = control.brief();
      if (brief === null) {
        this.#taskHost.settle(task.id, {
          status: 'failed',
          error: '任务的交代条目缺失（派出时应用退出），请重新派出',
        });
        return;
      }
      const botId = task.botId;
      const conversationId = task.conversationId;
      if (task.taskWrites === true) {
        const root = task.taskWorkdir ?? workspacePathFor(this.#deps.paths, botId, conversationId);
        control.waiting('等写入租约');
        try {
          await this.#deps.projects.ensureWriteLease(
            { runId: task.id, botId, conversationId, loopType: 'task' },
            root,
            { pin: true, signal: control.signal, reason: `任务「${brief.title}」` },
          );
        } catch (error) {
          // Cancelled while waiting: the host already settled the task.
          if (control.signal.aborted) return;
          // Project roots and the bot's own workspace both have lease targets
          // (design 30 §5.2); anything else must fail rather than run unleased.
          throw error;
        }
        if (control.signal.aborted) return;
      }
      const key = `task:${task.id}`;
      let started = false;
      // Stopped while still queued for a slot: the job never runs — free the
      // write lease and the task's place now, not when the job would start.
      const onAbort = (): void => {
        if (started || !this.#deps.scheduler.cancelQueued(key)) return;
        void this.#deps.projects
          .releaseRun(task.id)
          .catch(() => {})
          .finally(() => control.finish());
      };
      control.waiting('等模型并发额度');
      this.#deps.scheduler.submit({
        // Below user-triggered responses (0); the scheduler also keeps one
        // provider slot free of tasks for conversation replies.
        priority: 1,
        provider: this.#providerForRef(this.#modelRefForBot(botId)),
        key,
        runId: task.id,
        run: () => {
          started = true;
          control.signal.removeEventListener('abort', onAbort);
          control.waiting(null);
          return this.#executeRun(task.id, {
            kind: 'task',
            batch: { conversationId, botId, messages: brief.sourceMessages, reason: 'task' },
            task,
            brief,
            control,
          });
        },
      });
      submitted = true;
      if (!started) control.signal.addEventListener('abort', onAbort, { once: true });
    } catch (error) {
      this.#taskHost.settle(task.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!submitted) {
        // Lease taken before a stop / failure: release it with the slot.
        await this.#deps.projects.releaseRun(task.id).catch(() => {});
        control.finish();
      }
    }
  }

  /**
   * The shared run skeleton (response runs and D75 tasks, see RunExecution):
   * gates → context / trigger → tools → engine run → interim texts → outcome
   * → usage → lease release → settle. The variants differ only at the points
   * branching on `exec.kind`.
   */
  async #executeRun(runId: string, exec: RunExecution): Promise<void> {
    const { batch } = exec;
    const isTask = exec.kind === 'task';
    const loopType = isTask ? ('task' as const) : ('response' as const);
    const { runs, messages } = this.#deps;
    // D75 §3.2 消费 (this wave; W2 moves it to the turn's terminal state):
    // task entries in the trigger batch / steered into this response run.
    const consumesTaskIds = new Set<string>();
    if (!isTask) this.#noteTaskEntries(consumesTaskIds, batch);
    const settle = (
      status: Run['status'],
      error: string | null,
      setup?: SetupRequirement,
      resultText?: string,
    ): void => {
      if (exec.kind === 'task') {
        // A host-stopped task is terminal already: this is a no-op then.
        this.#taskHost.settle(runId, {
          status: status as TaskOutcome['status'],
          error,
          ...(setup !== undefined ? { setup } : {}),
          ...(resultText !== undefined ? { resultText } : {}),
        });
        return;
      }
      this.#settleRun(runId, status, error, setup);
    };
    // 本 run 命中的设置前置需求（inline setup，docs/design/18-inline-setup.md）：
    // media facade 在能力缺失时记下 requirement，工具结果以 SETUP_REQUIRED
    // 返回，abort 监听器随即中断 run——settle 时改判 failed 并携带 setup。
    const setupHit: { requirement: SetupRequirement | null } = { requirement: null };
    // D72 P5: batches steered into an external agent run (a refused steer
    // comes back by its text) and whether the mailbox was already released.
    const agentSteer: AgentSteerLog = { log: [], released: false, consumes: consumesTaskIds };
    let agentSessionRowId: string | null = null;
    let agentPromptSent = false;
    try {
      if (
        exec.kind === 'task'
          ? exec.control.signal.aborted
          : this.#cancelledBeforeStart.delete(runId)
      ) {
        settle('cancelled', null);
        return;
      }

      const bot = this.#deps.bots.get(batch.botId);
      const conv = this.#deps.conversations.get(batch.conversationId);
      if (!bot || !conv || bot.status !== 'active' || conv.readOnly) {
        settle('cancelled', null);
        return;
      }

      const modelRef = this.#modelRefForBot(batch.botId);
      // 模型门禁（D58）按 Bot 的引擎判定：内置 Bot 看内置模型；外部 Agent
      // Bot 看实验开关 + 目录 + 启用 / 安装 / 登录状态（D72 P4：结构化
      // setup `{kind:'agent'}` → 对话内 Agent 设置卡，完成后自动重试）。
      const agentId = this.#agentIdOf(bot);
      const engine = this.#engineFor(bot);
      if (isTask && agentId.length > 0) {
        // External agents as the task engine (per-task sessions, design 30
        // §8.5) land with D75 W4; a task must not share the bot's response
        // session row meanwhile.
        settle('failed', '外部智能体暂不能作为任务引擎（D75 后续接入），请改用内置模型的 Bot');
        return;
      }
      if (agentId.length > 0) {
        if (engine === null) {
          this.#settleRun(runId, 'failed', '外部智能体引擎不可用');
          return;
        }
        const gate = agentRunGate(
          this.#deps.settings.get(),
          this.#deps.agentCatalog?.() ?? [],
          agentId,
          this.#agentView(),
        );
        if (gate !== null) {
          this.#settleRun(
            runId,
            'failed',
            gate.message,
            gate.reason !== null ? { kind: 'agent', agentId, reason: gate.reason } : undefined,
          );
          return;
        }
      } else if (modelRef.length === 0) {
        settle('failed', '未配置模型：请在设置页选择默认主模型或在 Bot 配置中指定', {
          kind: 'main-model',
        });
        return;
      }

      const identity: RunIdentity = {
        runId,
        botId: batch.botId,
        conversationId: batch.conversationId,
        loopType,
      };
      runs.update(runId, {
        status: 'running',
        provider: this.#providerForRef(modelRef),
        model: modelRef,
        engine: agentId.length > 0 ? agentEngineKey(agentId) : BUILTIN_ENGINE,
      });
      this.#deps.publish('run.status', { run: runs.getOrThrow(runId) });

      // Conversation context: rolling summary + recent window (batch excluded;
      // it arrives separately through the trigger segment).
      // D75 §2.4.5: a task's conversation layer is shared rows only.
      const recent = this.#contextMessages(batch.conversationId, isTask ? null : batch.botId, 120);
      const recentFiltered = recent.filter((m) => !batch.messages.some((b) => b.id === m.id));
      const renderOptions: RenderMessageOptions = {
        ...this.#renderOptions(),
        selfBotId: batch.botId,
      };
      const contextSegment = buildConversationContext({
        summary: conv.summary,
        recent: recentFiltered,
        options: renderOptions,
      });
      const triggerSegment =
        exec.kind === 'task'
          ? buildTaskBriefSegment(exec.brief, renderOptions, exec.task.taskWorkdir)
          : buildTriggerSegment({
              reason: batch.reason,
              messages: batch.messages,
              options: renderOptions,
              extraAttributes: batch.extraAttributes,
            });
      // Sequential group response: the later bot is told who already replied
      // (docs/dev/04-agent-runtime.md "触发段").
      const triggerContent = batch.afterNote
        ? `${triggerSegment}\n\n${batch.afterNote}`
        : triggerSegment;

      // Loop 续接 (D56): replay recent finished runs' process records when this
      // batch continues them — L1 deterministic, L2 light-model arbiter. Any
      // failure here means "no continuation", never a failed run.
      let continuation: ContinuationPlan | null = null;
      try {
        // D75 §7.1: tasks replay only on explicit continues_task_id.
        continuation =
          exec.kind === 'task'
            ? this.#taskContinuation(exec.brief)
            : await this.#resolveContinuation({
                runId,
                botId: batch.botId,
                conversationId: batch.conversationId,
                batch,
                recentFiltered,
                renderOptions,
              });
      } catch (error) {
        this.#deps.logger.warn(
          { runId, error: error instanceof Error ? error.message : String(error) },
          'continuation resolution failed; starting without replay',
        );
      }
      if (continuation !== null && !isTask) {
        this.#deps.runs.update(runId, { continuedFromRunIds: continuation.continuedFromRunIds });
      }
      const contextAndContinuation = [contextSegment, continuation?.segment]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n\n');

      const workspacePath = workspacePathFor(this.#deps.paths, batch.botId, batch.conversationId);
      this.#deps.gateway.ensureWorkspace(identity);
      const project = this.#deps.projects.boundProject(batch.conversationId);
      const network = {
        mode: bot.profile.runtime.network_policy,
        allowDomains: bot.profile.runtime.network_allowlist,
      };
      const environmentFacade = this.#environmentFacade();
      const memoryFacade = this.#deps.memory;
      // Explicit delegation (spreading a class instance drops its methods).
      const memoryToolFacade: MemoryToolFacade | undefined = memoryFacade
        ? {
            writeMemory: (botId, conversationId, input) =>
              memoryFacade.writeMemory(botId, conversationId, input),
            recall: (botId, conversationId, query, kind) =>
              memoryFacade.recall(botId, conversationId, query, kind),
            getUserProfile: (category) => memoryFacade.getUserProfile(category),
            listCommitments: (botId) => memoryFacade.listCommitments(botId),
            feedback: (botId, itemId, reason) => memoryFacade.feedback(botId, itemId, reason),
            forget: (botId, itemIds) => memoryFacade.forget(botId, itemIds),
            requestProfileChange: (ident, changes, reason, signal) =>
              memoryFacade.requestProfileChange(ident, changes, reason, signal),
            triggerMessages: () => batch.messages,
          }
        : undefined;
      const toolDeps: ResponseToolDeps = {
        messages,
        attachments: this.#deps.attachments,
        runs,
        secrets: this.#deps.secrets,
        renderOptions,
        gateway: this.#deps.gateway,
        workspacePath,
        projectPath: project !== null && project.status === 'available' ? project.path : null,
        projects: this.#deps.projects,
        network,
        fsState: this.#fsState,
        environment: environmentFacade,
        ...(memoryToolFacade !== undefined ? { memory: memoryToolFacade } : {}),
        ...(this.#deps.skills !== undefined
          ? {
              skills: {
                requestAuthoring: (input) => this.#deps.skills!.requestAuthoring(input),
              },
            }
          : {}),
        ...(this.#deps.schedule !== undefined ? { schedule: this.#deps.schedule } : {}),
        ...(this.#deps.browser !== undefined ? { browser: this.#deps.browser } : {}),
        ...(this.#deps.media !== undefined ? { media: this.#mediaFacade(setupHit) } : {}),
        ...(this.#deps.search !== undefined ? { search: this.#searchFacade(setupHit) } : {}),
        ...(this.#deps.skillInstall !== undefined ? { skillInstall: this.#deps.skillInstall } : {}),
        batchMessages: batch.messages,
        onBotMessage: (message) => this.#recordBotMessage(runId, message),
        // D65 MCP：应用 enabled ∩ Bot 选中 的 server → 包装工具（首次使用懒连接）。
        ...(this.#deps.mcp != null && bot.profile.runtime.mcp_server_ids.length > 0
          ? {
              mcp: {
                tools: await buildMcpTools({
                  identity,
                  servers: this.#deps.mcp.serversForBot(bot.profile.runtime.mcp_server_ids),
                  mcp: this.#deps.mcp,
                  gateway: this.#deps.gateway,
                  secrets: this.#deps.secrets,
                  logger: this.#deps.logger,
                }),
              } satisfies McpToolFacade,
            }
          : {}),
        // D66 宿主 SubAgent：减配子 run + 结果压缩回传（见 agent/subagent.ts）。
        subagent: createSubagentFacade(
          {
            engine: this.#deps.engine,
            runs,
            usage: this.#deps.usage,
            secrets: this.#deps.secrets,
            logger: this.#deps.logger,
            clock: this.#deps.clock,
            timeZone: this.#deps.timeZone,
            providerForRef: (ref) => this.#providerForRef(ref),
            publishRunStatus: (run) => this.#deps.publish('run.status', { run }),
          },
          {
            parent: identity,
            modelRef,
            ...this.#compactionRoute(batch.botId),
            buildTools: (subIdentity) =>
              buildSubagentResearchTools({
                identity: subIdentity,
                deps: {
                  gateway: this.#deps.gateway,
                  workspacePath,
                  projectPath:
                    project !== null && project.status === 'available' ? project.path : null,
                  network,
                  secrets: this.#deps.secrets,
                  fsState: this.#fsState,
                  ...(this.#deps.search !== undefined ? { search: this.#deps.search } : {}),
                },
              }),
            buildSystemPrompt: () =>
              Promise.resolve(
                buildSubagentSystemPrompt({
                  botName: bot.profile.identity.name || bot.name,
                  workspacePath,
                  projectPath:
                    project !== null && project.status === 'available' ? project.path : null,
                  timeZone: this.#deps.timeZone,
                  now: new Date(this.#deps.clock.now()),
                }),
              ),
            onSubRunSettled: (subRunId) => this.#fsState.release(subRunId),
            host: this.#subagentHost,
            onFollowUp: (followUp) => this.#injectDelegateFollowUp(followUp),
          },
        ),
      };

      const mailboxKey = this.#mailboxKey(batch.botId, batch.conversationId);
      // P07 injection: relevant memories come from the trigger text plus the
      // last two context messages (docs/dev/phases/P07-memory.md 任务 3).
      const memorySections = memoryFacade
        ? {
            userProfile: memoryFacade.profileCardSection(),
            myState: memoryFacade.myStateSection(batch.botId, batch.conversationId),
            relevantMemories: await memoryFacade.relevantMemoriesSection({
              botId: batch.botId,
              conversationId: batch.conversationId,
              queryText: [
                ...batch.messages.map((m) => messageText(m)),
                ...recentFiltered.slice(-2).map((m) => messageText(m)),
              ]
                .filter((text) => text.length > 0)
                .join('\n'),
            }),
          }
        : {};
      // P08: <skills> lists names + descriptions only (design 05 加载方式);
      // the model reads the full SKILL.md via the read tool when needed.
      const skillsSection = this.#deps.skills?.promptSection(batch.botId) ?? '';
      // D63：未安装的预置技能列表（install_skill 的匹配来源）。
      const recommendedSkillsSection = this.#deps.skills?.recommendedSkillsSection() ?? '';
      // P09: <wiki_topics> — index.md titles, budget-truncated (04 段 11).
      const wikiTopicsSection = this.#deps.wiki?.topicsSection(batch.botId) ?? '';
      const triggerImages = this.#triggerImages(batch.messages);
      const responseTools = buildResponseTools({
        identity,
        deps: {
          ...toolDeps,
          environment: this.#environmentFacade(),
          onMentionBots: (mentionIds, message) =>
            this.#chains.mention(identity, mentionIds, message),
          // 管家（D70）：list_bots 人人可用，提议类工具仅管家。
          butler: { host: this.#butlerHost, isButler: bot.systemRole === 'butler' },
          // 跨 Bot 委派（D71）：被委派 run 不注册（单跳的真正保障在宿主
          // 执行时按 run_id 反查，这里只是少给模型一个无用工具）。
          ...(batch.reason === 'delegation' ? {} : { delegation: this.#delegationHost }),
          // 对话式新建（UI 改版）：访谈中的 Bot 额外拿到 save_profile /
          // finish_setup；写入直接生效（本次创建流程的明确目的）并广播
          // bot.updated 让 UI 实时反映新名字与 profile。
          ...(bot.setupState === 'interviewing'
            ? {
                setup: {
                  saveProfile: (
                    setupBotId: string,
                    changes: Array<{ field: string; value: string }>,
                  ) => {
                    try {
                      const source = this.#deps.bots.get(setupBotId);
                      if (source === null) return { ok: false, message: 'Bot 不存在' };
                      const updated = this.#deps.bots.updateDuringSetup(
                        setupBotId,
                        applyProfileChanges(source.profile, changes),
                      );
                      this.#deps.publish('bot.updated', { bot: updated });
                      return {
                        ok: true,
                        message: `已保存 ${changes.length} 个字段到你的 profile。`,
                      };
                    } catch (error) {
                      return {
                        ok: false,
                        message: error instanceof Error ? error.message : String(error),
                      };
                    }
                  },
                  finishSetup: (setupBotId: string) => {
                    try {
                      const updated = this.#deps.bots.finishSetup(setupBotId);
                      this.#deps.publish('bot.updated', { bot: updated });
                      return { ok: true, message: '初始化完成，你已进入正常运行状态。' };
                    } catch (error) {
                      return {
                        ok: false,
                        message: error instanceof Error ? error.message : String(error),
                      };
                    }
                  },
                  askQuestion: (
                    setupBotId: string,
                    askInput: {
                      acknowledgement?: string;
                      question: string;
                      options: string[];
                    },
                  ) => {
                    try {
                      const asked =
                        this.#deps.messages.countSystemEvents(
                          batch.conversationId,
                          SETUP_QUESTION_EVENT,
                        ) + 1;
                      const variant = bot.systemRole === 'butler' ? 'butler' : 'bot';
                      if (asked > SETUP_MAX_QUESTIONS) return questionCapReached(variant);
                      if (askInput.acknowledgement !== undefined) {
                        this.#appendBotTextMessage(
                          setupBotId,
                          batch.conversationId,
                          askInput.acknowledgement,
                        );
                      }
                      this.#appendSystemMessage(
                        batch.conversationId,
                        SETUP_QUESTION_EVENT,
                        askInput.question,
                        { options: askInput.options },
                      );
                      return {
                        ok: true,
                        message:
                          asked >= SETUP_MAX_QUESTIONS
                            ? variant === 'butler'
                              ? `问题已发出（第 ${asked}/${SETUP_MAX_QUESTIONS} 问，已达上限）。这是最后一个问题：收到回答后请直接调用 propose_team 提出组队建议，不要再提问。`
                              : `问题已发出（第 ${asked}/${SETUP_MAX_QUESTIONS} 问，已达上限）。这是最后一个问题：收到回答后请用 save_profile 保存全部信息并调用 finish_setup 结束访谈，不要再提问。`
                            : `问题已发出（第 ${asked}/${SETUP_MAX_QUESTIONS} 问）。`,
                      };
                    } catch (error) {
                      return {
                        ok: false,
                        message: error instanceof Error ? error.message : String(error),
                      };
                    }
                  },
                },
              }
            : {}),
          ...(this.#deps.wiki !== undefined
            ? {
                wiki: {
                  search: (botId, query, limit) => this.#deps.wiki!.search(botId, query, limit),
                  readPage: (botId, pagePath) => this.#deps.wiki!.readPage(botId, pagePath),
                  enqueueIngest: (input) => this.#deps.wiki!.enqueueIngest(input),
                },
              }
            : {}),
        },
      });
      // D72 外部 Agent Bot（design 28 §4–§5）：能力包决定注入哪些宿主工具（经
      // 宿主 MCP 桥）；提示词拆成会话级（ACP 版平台规则 + <tool_policy> + 身份 /
      // 人设 / 对话信息）、run 级动态段与对话段。内置引擎不受影响。
      const agentRun =
        agentId.length > 0
          ? await this.#agentRunSetup({
              bot,
              conversation: conv,
              agentId,
              identity,
              responseTools,
              workspacePath,
              hasProject: project !== null && project.status === 'available',
              memorySections,
              wikiTopics: wikiTopicsSection,
              skills: skillsSection,
              recommendedSkills: recommendedSkillsSection,
              conversationText: `${contextAndContinuation}\n\n${triggerContent}`,
              batch,
              renderOptions,
              triggerContent,
              workdir:
                project !== null && project.status === 'available' ? project.path : workspacePath,
              modelRef,
              contextCutoff: Math.max(
                -1,
                ...recent.map((message) => message.seq),
                ...batch.messages.map((message) => message.seq),
              ),
            })
          : null;
      if (agentRun !== null) agentSteer.seen = agentRun.session.seen;
      // D72 P3（design 28 §6）：project 内有 Agent 自己会读、无法关闭的配置
      // 文件时，首次在此 project 运行前确认（记住到对话）；project 绑定且档位
      // 可写时开工前显式取写入租约、整 run 持有（结算照常 releaseRun）。
      if (agentRun !== null && project !== null && project.status === 'available') {
        const gate = await this.#agentProjectGate({
          runId,
          identity,
          botId: batch.botId,
          conversationId: batch.conversationId,
          agentId,
          agentName: agentRun.agentName,
          projectPath: project.path,
          configFiles: agentRun.agentSideConfigFiles,
          writable: agentRun.permission !== 'read_only',
        });
        if (gate !== 'ok') {
          // Cancelled while waiting: cancelRun already settled the run.
          if (gate === 'denied') {
            await this.#deps.projects.releaseRun(runId).catch(() => {});
            this.#settleRun(
              runId,
              'failed',
              '用户未确认在此项目中加载智能体自身的配置文件，本次未执行',
            );
          }
          this.#fsState.release(runId);
          return;
        }
      }
      const handle = engine!.startRun({
        identity,
        model: modelRef,
        // D72：外部 Agent 的会话参数（PiEngine 忽略）。
        ...(agentRun !== null
          ? {
              workdir:
                project !== null && project.status === 'available' ? project.path : workspacePath,
              promptParts: agentRun.promptParts,
              external: {
                agentId,
                permission: agentRun.permission,
                capabilities: agentRun.capabilities,
                sessionKey: `${batch.botId}:${batch.conversationId}:${agentId}`,
                effort: bot.profile.runtime.agent.effort,
                loadUserConfig: agentRun.loadUserConfig,
                hostServerName: agentRun.hostServerName,
                // P5 会话复用：会话留在 Agent 进程里；窗口内指纹一致时续用。
                session: {
                  reuseId: agentRun.session.reuseId,
                  fingerprint: agentRun.session.fingerprint,
                },
                onSession: (agentSessionId: string, mode: AgentSessionMode) => {
                  runs.update(runId, { agentSessionId });
                  // A new session got the full context, not the delta.
                  if (mode === 'new') {
                    agentRun.session.seen.baseCutoff = Math.max(
                      -1,
                      ...recent.map((message) => message.seq),
                      ...batch.messages.map((message) => message.seq),
                    );
                  }
                  this.#recordAgentSession({
                    rowId: agentRun.session.rowId,
                    botId: batch.botId,
                    conversationId: batch.conversationId,
                    agentId,
                    agentSessionId,
                    fingerprint: agentRun.session.fingerprint,
                    runId,
                    mode,
                  });
                  agentSessionRowId = agentRun.session.rowId;
                },
                // Only a prompt that really went out moves the session's
                // seen-state and reuse window (审查 #1).
                onPromptSent: () => {
                  agentPromptSent = true;
                  if (this.#agentSessionRowExists(agentRun.session.rowId)) {
                    this.#agentSessionSeen.set(agentRun.session.rowId, agentRun.session.seen);
                  }
                },
              },
              // ACP steering is asynchronous: a refused steer's batch goes
              // back to the buffer (re-delivered as a new run on release).
              onSteerRejected: (text: string) => this.#onAgentSteerRejected(agentSteer, text),
            }
          : {}),
        buildSystemPrompt: async () =>
          buildSystemPrompt({
            bot,
            conversation: conv,
            timeZone: this.#deps.timeZone,
            now: new Date(this.#deps.clock.now()),
            ...(conv.type === 'group' ? { members: this.#memberCards(conv.id) } : {}),
            project: (await this.#deps.projects.promptSection(batch.conversationId)) ?? undefined,
            workspace: {
              path: workspacePath,
              entries: this.#deps.gateway.workspaceTopLevel(workspacePath),
              toolchains: this.#toolchainPromptLines(),
            },
            access: await this.#accessPromptInfo(identity),
            ...memorySections,
            ...(wikiTopicsSection.length > 0 ? { wikiTopics: wikiTopicsSection } : {}),
            ...(skillsSection.length > 0 ? { skills: skillsSection } : {}),
            ...(recommendedSkillsSection.length > 0
              ? { recommendedSkills: recommendedSkillsSection }
              : {}),
          }),
        messages: [
          {
            role: 'user',
            content: `${contextAndContinuation}\n\n${triggerContent}`,
            timestamp: this.#deps.clock.now(),
            // 触发批的图片附件直接进视觉通道（docs/design/20-conversation-media.md）：
            // 引擎按模型能力决定转 image blocks 或降级为提示文本。
            ...(triggerImages.length > 0 ? { images: triggerImages } : {}),
          },
        ],
        // D72：外部 Agent 的宿主工具已按能力包过滤，经宿主 MCP 桥注入。
        tools: agentRun?.tools ?? responseTools,
        limits: { maxTurns: RUN_MAX_TURNS },
      });

      if (exec.kind === 'task') {
        // D75: tasks are not mailbox runs — steering a task is inject_task,
        // through the task host (buffered injects are flushed here).
        exec.control.attach(handle);
      } else {
        const activeEntry: ActiveRunEntry = {
          handle,
          conversationId: batch.conversationId,
          botId: batch.botId,
          cutoffSeq: Math.max(-1, ...batch.messages.map((m) => m.seq)),
          ...(agentRun !== null ? { steerLog: agentSteer } : {}),
          consumesTaskIds,
        };
        this.#activeRuns.set(runId, activeEntry);

        // Deliver batches that arrived while the run was registering. A batch
        // the loop cannot take (external agents without steering, D72) goes back
        // to the buffer: mailbox release re-delivers it as a new run.
        const buffered = this.#pendingSteers.get(mailboxKey);
        if (buffered) {
          this.#pendingSteers.delete(mailboxKey);
          const refused = buffered.filter((pending) => {
            const text = this.#renderBatchText(pending);
            if (!handle.steer(text)) return true;
            this.#noteAgentSteer(agentSteer, text, pending);
            this.#noteTaskEntries(consumesTaskIds, pending);
            return false;
          });
          if (refused.length > 0) {
            this.#pendingSteers.set(mailboxKey, [
              ...refused,
              ...(this.#pendingSteers.get(mailboxKey) ?? []),
            ]);
          }
        }
      }

      const unsubscribe = this.#persistSteps(runId, batch.conversationId, handle);
      const unsubscribeSetup = handle.onEvent((event) => {
        if (event.type !== 'tool_result') return;
        if ((event.payload as { errorCode?: string }).errorCode !== TOOL_SETUP_REQUIRED) return;
        // 工具报告缺设置：中断本 run（engine 侧产出 cancelled），settle 阶段
        // 依据 setupHit 改判 failed + 结构化 setup（retry 只接受 failed）。
        // 延迟到微任务之外：此刻正处引擎工具执行的 await 链内，同步 abort
        // 不会被消化；mailbox 释放前 done promise 均会兑现，无泄漏窗口。
        setTimeout(() => handle.abort('setup required'), 0);
      });
      const unsubscribeInterim = this.#deliverInterimTexts(
        runId,
        batch,
        conv.type === 'group',
        handle,
        isTask ? runId : null,
      );
      let outcome;
      try {
        outcome = await handle.done;
      } finally {
        unsubscribe();
        unsubscribeSetup();
        unsubscribeInterim();
        if (exec.kind === 'task') exec.control.detach();
        else this.#activeRuns.delete(runId);
      }
      // P5: the reuse window counts from the end of the session's last run;
      // the session has seen everything up to the run's cutoff.
      // (Not for a row deleted meanwhile — conversation / bot deletion or an
      // invalidated session, 审查 #13.)
      if (
        agentSessionRowId !== null &&
        agentPromptSent &&
        this.#agentSessionRowExists(agentSessionRowId)
      ) {
        this.#agentSessions.touch(agentSessionRowId, runId, this.#deps.clock.now());
      }

      // D75 §6.1: a task's final text is its private result entry (settle
      // below), never a visible message.
      if (!isTask && outcome.status === 'completed' && outcome.finalText.trim().length > 0) {
        const message = messages.append({
          conversationId: batch.conversationId,
          senderType: 'bot',
          senderBotId: batch.botId,
          kind: 'text',
          text: outcome.finalText,
          runId,
        });
        this.#recordBotMessage(runId, message);
      }

      for (const usage of outcome.usage) {
        this.#deps.usage.record({
          runId,
          botId: batch.botId,
          conversationId: batch.conversationId,
          loopType,
          provider: this.#providerForRef(modelRef),
          model: modelRef.slice(this.#providerForRef(modelRef).length + 1),
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          costUsd: usage.costUsd,
        });
      }

      // Close the lease window before settling: the after-snapshot writes the
      // changes summary card, which must land after the bot's final message.
      try {
        await this.#deps.projects.releaseRun(runId);
      } catch (error) {
        this.#deps.logger.warn(
          { runId, error: error instanceof Error ? error.message : String(error) },
          'lease release failed',
        );
      }
      this.#fsState.release(runId);

      // 缺设置中断（setupHit 非空且 run 非正常完成）：统一改判 failed 并携带
      // 结构化 setup，界面上是可引导的设置卡片而非普通失败。
      if (setupHit.requirement !== null && outcome.status !== 'completed') {
        settle('failed', setupRequirementErrorText(setupHit.requirement), setupHit.requirement);
        this.#maybeEnqueueSummary(batch.conversationId);
        return;
      }

      // D72 P4：外部 Agent 因未登录 / 未安装 / 版本不兼容 / 桥未启动失败 →
      // 结构化 setup（对话内 Agent 设置卡），不走普通失败横幅。只在 run 还
      // 没做任何事（无模型 / 工具步骤、无已发消息）时挂 setup：设置卡完成后
      // 会整段重试原 run，中途失败的重放会重复中间说明与文件改动。
      const agentSetup =
        agentId.length > 0 && outcome.status === 'failed' && !this.#runProducedWork(runId)
          ? this.#agentFailureSetup(agentId, outcome.error?.code, outcome.error?.message)
          : null;
      if (agentSetup !== null) {
        this.#settleRun(runId, 'failed', outcome.error?.message ?? null, agentSetup);
        this.#maybeEnqueueSummary(batch.conversationId);
        return;
      }

      settle(
        outcome.status,
        outcome.error?.message ?? null,
        undefined,
        // skip_reply → an empty result (no wake, §3.3).
        outcome.status === 'completed' && !outcome.skipReply ? outcome.finalText.trim() : '',
      );
      // P07: a completed response registers its reflection job (dedupe
      // run:{runId}); D75 §7.2: so does a completed task. Background work —
      // failures never touch this run.
      // (A task stopped by the host meanwhile is not completed after all.)
      if (outcome.status === 'completed' && (!isTask || runs.get(runId)?.status === 'completed')) {
        this.#deps.memory?.registerReflection({
          runId,
          botId: batch.botId,
          conversationId: batch.conversationId,
          triggerMessageIds: batch.messages.map((m) => m.id),
          batchId: batch.messages[0]?.batchId ?? null,
          continuedFromRunIds: continuation?.continuedFromRunIds ?? [],
        });
      }
      this.#maybeEnqueueSummary(batch.conversationId);
    } catch (error) {
      this.#deps.logger.error(
        { runId, error: error instanceof Error ? error.message : String(error) },
        isTask ? 'task run crashed' : 'response run crashed',
      );
      await this.#deps.projects.releaseRun(runId).catch(() => {});
      this.#fsState.release(runId);
      settle('failed', error instanceof Error ? error.message : String(error));
    } finally {
      if (exec.kind === 'task') {
        // Idempotent; covers the early returns. Then the slot / write target frees.
        await this.#deps.projects.releaseRun(runId).catch(() => {});
        this.#fsState.release(runId);
        exec.control.finish();
      } else {
        // Mailbox, group-turn and D71 bookkeeping belong to response runs only.
        this.#releaseResponseMailbox(batch, consumesTaskIds, agentSteer);
      }
      this.#publishConversation(batch.conversationId);
    }
  }

  /** Response-run epilogue (#executeRun finally): consumption, mailbox release, hooks. */
  #releaseResponseMailbox(
    batch: TriggerBatch,
    consumesTaskIds: Set<string>,
    agentSteer: AgentSteerLog,
  ): void {
    const mailbox = this.#mailboxes.for(batch.botId, batch.conversationId);
    mailbox.release();
    // Batches buffered during the closing window (settled run, mailbox not
    // yet released) never reached a loop: re-deliver them as new runs.
    const key = this.#mailboxKey(batch.botId, batch.conversationId);
    const buffered = this.#pendingSteers.get(key);
    if (buffered !== undefined && buffered.length > 0) {
      this.#pendingSteers.delete(key);
      for (const pending of buffered) mailbox.deliver(pending);
    }
    agentSteer.released = true;
    // A turn waiting for this mailbox to free up delivers now (BR-P05-002).
    this.#groupTurns.onMailboxIdle(batch.botId, batch.conversationId);
    // D71：B 的私聊邮箱空了——排队中的委派（若有）可以投递了。
    try {
      this.#delegationHost.onMailboxIdle(batch.botId, batch.conversationId);
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'queued delegation delivery failed',
      );
    }
    // D75 §3.2 消费 (after the mailbox bookkeeping: a failure here must not
    // leave the mailbox held).
    if (consumesTaskIds.size > 0) {
      try {
        this.#taskHost.markConsumed(consumesTaskIds);
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'marking task results consumed failed',
        );
      }
    }
  }

  /**
   * An external agent refused / failed a steer (D72 P5, design 28 §7): the
   * batch goes back to the buffer while the run's mailbox is held (re-delivered
   * as a new run on release), or straight to the mailbox afterwards.
   */
  #onAgentSteerRejected(steer: AgentSteerLog, text: string): void {
    const index = steer.log.findIndex((item) => item.text === text);
    if (index === -1) return;
    const [{ batch }] = steer.log.splice(index, 1) as [{ text: string; batch: TriggerBatch }];
    // Not shown after all: the next delta / batch carries it.
    for (const message of batch.messages) steer.seen?.ids.delete(message.id);
    // D75 §3.2: neither were its task results — the run that re-delivers the
    // batch consumes them. Already marked by this run's release: undo it.
    const refusedTaskIds = new Set<string>();
    this.#noteTaskEntries(refusedTaskIds, batch);
    for (const taskId of refusedTaskIds) steer.consumes?.delete(taskId);
    if (steer.released && refusedTaskIds.size > 0) {
      try {
        this.#taskHost.reopenConsumption(refusedTaskIds);
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'reopening task result consumption failed',
        );
      }
    }
    // The bot was deleted / left the group meanwhile (审查 #12).
    const conversation = this.#deps.conversations.get(batch.conversationId);
    const bot = this.#deps.bots.get(batch.botId);
    if (conversation === null || conversation.readOnly) return;
    if (bot === null || bot.status !== 'active') return;
    if (!this.#botInConversation(conversation, batch.botId)) return;
    if (!steer.released) {
      const key = this.#mailboxKey(batch.botId, batch.conversationId);
      this.#pendingSteers.set(key, [...(this.#pendingSteers.get(key) ?? []), batch]);
      return;
    }
    this.#mailboxes.for(batch.botId, batch.conversationId).deliver(batch);
  }

  /** A batch handed to an external run as a steer: shown to its session (P5 审查 #2). */
  #noteAgentSteer(steer: AgentSteerLog, text: string, batch: TriggerBatch): void {
    steer.log.push({ text, batch });
    for (const message of batch.messages) steer.seen?.ids.set(message.id, message.seq);
  }

  /** The bot is the direct conversation's bot or still a member of the group. */
  #botInConversation(
    conversation: { id: string; directBotId: string | null },
    botId: string,
  ): boolean {
    return (
      conversation.directBotId === botId ||
      this.#deps.conversations.memberBotIds(conversation.id).includes(botId)
    );
  }

  #agentSessionRowExists(rowId: string): boolean {
    return this.#agentSessions.getById(rowId) !== null;
  }

  /** Upserts the (Bot, conversation, Agent) session row once the session exists (P5). */
  #recordAgentSession(input: {
    rowId: string;
    botId: string;
    conversationId: string;
    agentId: string;
    agentSessionId: string;
    fingerprint: string;
    runId: string;
    mode: AgentSessionMode;
  }): void {
    try {
      // Deleted meanwhile (conversation / bot / membership): no row (审查 #13),
      // and the session opened meanwhile is deleted too — the cascade ran
      // before it existed (第三轮 #9). It belongs to the run right now: the
      // engine deletes it on release and sends no prompt.
      const conversation = this.#deps.conversations.get(input.conversationId);
      const bot = this.#deps.bots.get(input.botId);
      if (
        conversation === null ||
        bot === null ||
        bot.status !== 'active' ||
        // Removed from the group meanwhile (复审 #7): the cascade already ran.
        !this.#botInConversation(conversation, input.botId)
      ) {
        this.#discardAgentSession({ ...input, id: input.rowId }, true);
        return;
      }
      const previous = this.#agentSessions.get(input.botId, input.conversationId, input.agentId);
      const now = this.#deps.clock.now();
      // A different agent session behind the same row (new session after a
      // failed resume): its seen-state restarts with this run.
      if (previous !== null && previous.agentSessionId !== input.agentSessionId) {
        this.#agentSessionSeen.delete(previous.id);
      }
      this.#agentSessions.upsert({
        id: input.rowId,
        botId: input.botId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        agentSessionId: input.agentSessionId,
        fingerprint: input.fingerprint,
        lastRunId: input.runId,
        lastUsedAt: now,
        createdAt:
          previous !== null && previous.id === input.rowId && input.mode !== 'new'
            ? previous.createdAt
            : now,
      });
    } catch (error) {
      // Conversation deleted meanwhile, db closing: reuse is an optimization.
      this.#deps.logger.warn(
        { runId: input.runId, error: error instanceof Error ? error.message : String(error) },
        'recording the agent session failed',
      );
    }
  }

  /** Task ids of the task_event entries in a batch (D75 §3.2 消费 bookkeeping). */
  #noteTaskEntries(target: Set<string>, batch: TriggerBatch): void {
    for (const message of batch.messages) {
      if (message.kind === 'task_event' && message.taskId !== null) target.add(message.taskId);
    }
  }

  /** `continues_task_id` replay of a task (D75 §7.1, D56 budget). */
  #taskContinuation(brief: TaskBrief): ContinuationPlan | null {
    if (brief.continuesTaskId === null) return null;
    const source = this.#deps.runs.get(brief.continuesTaskId);
    if (source === null) return null;
    const segment = buildTaskReplaySegment({
      source,
      steps: this.#deps.runs.stepsFor(source.id),
      timeZone: this.#deps.timeZone,
    });
    return segment.length > 0 ? { continuedFromRunIds: [source.id], segment } : null;
  }

  /** Formats a buffered batch into the steer text the mailbox hook produced. */
  #renderBatchText(batch: TriggerBatch): string {
    return buildNewMessagesInjection(
      batch.messages,
      (() => {
        const options = this.#renderOptions();
        return { ...options, selfBotId: batch.botId };
      })(),
    );
  }

  // --- loop continuation (Loop 续接, docs/design/02-execution.md "Loop 续接") ---

  /**
   * Resolves the continuation plan for a starting response run (D56): L1
   * replays the newest terminal run ended within CONTINUATION_WINDOW_MS;
   * otherwise the light-model arbiter picks from candidates within 24h. The
   * caller catches any throw — a broken resolver never fails a run.
   */
  #resolveContinuation(input: {
    runId: string;
    botId: string;
    conversationId: string;
    batch: TriggerBatch;
    recentFiltered: Message[];
    renderOptions: RenderMessageOptions;
  }): Promise<ContinuationPlan | null> {
    const candidates: ContinuationCandidate[] = this.#deps.runs
      // Reflection runs interleave ~1:1 with response runs, so fetch enough
      // rows before filtering to keep CONTINUATION_ARBITER_MAX_RUNS reachable.
      .listByConversation(input.conversationId, 20)
      .filter(
        (run) => run.botId === input.botId && run.loopType === 'response' && isTerminal(run.status),
      )
      .map((run) => ({ run, summaryLine: this.#runSummaryLine(run) }));
    if (candidates.length === 0) return Promise.resolve(null);
    // The arbiter reads the recent conversation with the trigger batch as the
    // last lines — they are the input whose continuation intent gets judged.
    const recentLines = [
      ...input.recentFiltered
        .slice(-TRIAGE_RECENT_MESSAGES)
        .map((message) => renderMessageLine(message, input.renderOptions)),
      ...input.batch.messages.map((message) => renderMessageLine(message, input.renderOptions)),
    ];
    return resolveContinuation({
      candidates,
      now: this.#deps.clock.now(),
      timeZone: this.#deps.timeZone,
      recentLines,
      stepsFor: (runId) => this.#deps.runs.stepsFor(runId),
      arbiter: (arbiterInput) =>
        this.#arbitrateContinuation(input.runId, input.botId, input.conversationId, arbiterInput),
    });
  }

  /** One-line arbiter summary fallback: reflection summary → error → last output. */
  #runSummaryLine(run: Run): string {
    const clip = (text: string, max = 120): string =>
      text.length > max ? `${text.slice(0, max)}…` : text;
    if (run.summary !== null && run.summary.trim().length > 0) return clip(run.summary.trim());
    if (run.error !== null) return `失败：${clip(run.error, 80)}`;
    for (let i = run.outputMessageIds.length - 1; i >= 0; i -= 1) {
      const message = this.#deps.messages.getById(run.outputMessageIds[i] ?? '');
      const content = message?.content as { text?: string } | undefined;
      if (message && typeof content?.text === 'string' && content.text.trim().length > 0) {
        return clip(content.text.trim());
      }
    }
    return '（无摘要）';
  }

  /**
   * L2 arbiter: light-model structured call (mirrors group triage). Never
   * throws — timeout, provider errors and unparsable output all mean "no
   * continuation". Usage is attributed to the response run being started.
   */
  async #arbitrateContinuation(
    runId: string,
    botId: string,
    conversationId: string,
    input: ContinuationArbiterInput,
  ): Promise<string[] | null> {
    const route = this.#backgroundRoute(botId, 'continuation');
    if (route === null) {
      // D72 P4 / P6：没有内置模型时续接 L2 仲裁关闭（视为不续接；外部 Agent
      // 冷启动远超仲裁时限，路由不给 Agent 兜底）。
      this.#deps.logger.debug({ runId, botId }, 'continuation arbiter skipped: no built-in model');
      return null;
    }
    const { modelRef, provider } = route;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTINUATION_ARBITER_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const result = await completeStructured({
        complete: (req) => route.engine.complete(req),
        identity: { runId, botId, conversationId, loopType: 'response' },
        model: modelRef,
        systemPrompt: CONTINUATION_ARBITER_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildArbiterUserMessage(input), timestamp: Date.now() },
        ],
        parametersSchema: continuationParametersSchema,
        schema: continuationOutputSchema,
        signal: controller.signal,
        onUsage: (usage) => {
          if (!usage) return;
          this.#deps.usage.record({
            runId,
            botId,
            conversationId,
            loopType: 'response',
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
      this.#deps.logger.info(
        { runId, selected: result.continueRunIds, reason: result.reason },
        'continuation arbitrated',
      );
      return result.continueRunIds;
    } catch (error) {
      this.#deps.logger.info(
        { runId, error: error instanceof Error ? error.message : String(error) },
        'continuation arbiter failed -> no continuation',
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 触发批中的图片附件 → 引擎消息的 images（docs/design/20-conversation-media.md）：
   * 只取 image/*、单张 ≤5MB、一批最多 4 张；超限的留在文本行（附件行已列出）。
   * 读取失败按没有处理——图片进不了上下文不应阻断响应。
   */
  #triggerImages(batchMessages: Message[]): Array<{ mimeType: string; base64: string }> {
    const MAX_IMAGES = 4;
    const MAX_BYTES = 5_000_000;
    const images: Array<{ mimeType: string; base64: string }> = [];
    for (const message of batchMessages) {
      for (const attachment of message.attachments) {
        if (images.length >= MAX_IMAGES) return images;
        if (!attachment.mime.startsWith('image/') || attachment.size > MAX_BYTES) continue;
        try {
          const bytes = this.#deps.attachments.readBytes(attachment);
          images.push({ mimeType: attachment.mime, base64: bytes.toString('base64') });
        } catch (error) {
          this.#deps.logger.warn(
            {
              attachment: attachment.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'trigger image read failed; skipping',
          );
        }
      }
    }
    return images;
  }

  /**
   * 媒体生成工具的 media facade（docs/design/18-inline-setup.md、
   * 20-conversation-media.md）：调用照常透传给 MediaService；仅当失败属于
   * "缺用户配置"（能力未配置 / 厂商缺 Key）时记下 requirement——工具据此
   * 返回 SETUP_REQUIRED，run 随即被中断并引导设置。其余失败（厂商不支持、
   * 参数问题、网络错误）照常作为工具失败结果回到模型。
   */
  #mediaFacade(setupHit: { requirement: SetupRequirement | null }): MediaToolFacade {
    const media = this.#deps.media!;
    const setupGuard = async <T>(
      capability: 'image' | 'tts' | 'video' | 'multimodal' | 'asr',
      run: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED')
        ) {
          setupHit.requirement = { kind: 'capability-model', capability };
        }
        throw error;
      }
    };
    return {
      generateImage: (input) => setupGuard('image', () => media.generateImage(input)),
      understandImage: (input) => setupGuard('multimodal', () => media.understandImage(input)),
      synthesizeSpeech: (input) => setupGuard('tts', () => media.synthesizeSpeech(input)),
      transcribeSpeech: (input) => setupGuard('asr', () => media.transcribeSpeech(input)),
      generateVideo: (input) => setupGuard('video', () => media.generateVideo(input)),
      videoStatus: (provider, taskId) => media.videoStatus(provider, taskId),
    };
  }

  /**
   * 联网检索工具的 search facade（docs/design/21-web-search.md）：web_search
   * 缺配置/缺 key 时记下结构化 setup 需求（工具返回 SETUP_REQUIRED，run 中断
   * 引导设置后自动续跑）；web_fetch 独立可用，失败照常回到模型。
   */
  #searchFacade(setupHit: { requirement: SetupRequirement | null }): SearchToolFacade {
    const search = this.#deps.search!;
    return {
      search: async (query, maxResults, signal) => {
        try {
          return await search.search(query, maxResults, signal);
        } catch (error) {
          if (
            error instanceof AppError &&
            (error.code === 'CAPABILITY_NOT_CONFIGURED' || error.code === 'PROVIDER_AUTH_FAILED')
          ) {
            setupHit.requirement = { kind: 'web-search' };
          }
          throw error;
        }
      },
      fetchPage: (url, signal) => search.fetchPage(url, signal),
    };
  }

  /** Records a bot message as run output, publishes it and refreshes the conversation view. */
  #recordBotMessage(runId: string, message: Message): void {
    const current = this.#deps.runs.get(runId);
    this.#deps.runs.update(runId, {
      outputMessageIds: [...(current?.outputMessageIds ?? []), message.id],
    });
    this.#deps.publish('message.created', {
      conversationId: message.conversationId,
      message,
    });
    this.#publishConversation(message.conversationId);
  }

  /**
   * Interim visibility (todo/loop-interim-updates.md): the prose the model
   * writes on a toolUse assistant turn is delivered into the conversation as
   * a real bot message, so long tasks narrate instead of staying silent.
   * Guardrails cap the per-run count (lower in groups) and the length of each
   * text; over-cap or empty text stays only in run_steps (#persistSteps).
   * 'stop' turns land separately via outcome.finalText, so they never
   * duplicate here, and already-delivered texts survive a later failure or
   * cancel — they are communication that already happened.
   */
  #deliverInterimTexts(
    runId: string,
    batch: TriggerBatch,
    isGroup: boolean,
    handle: RunHandle,
    /** D75 §6.1: a task's interim texts carry `origin:'task'` (same guardrails). */
    taskId: string | null = null,
  ): () => void {
    let delivered = 0;
    const max = isGroup ? INTERIM_TEXT_MAX_PER_RUN_GROUP : INTERIM_TEXT_MAX_PER_RUN;
    return handle.onEvent((event) => {
      if (event.type !== 'assistant') return;
      const { text, stopReason } = event.payload as { text?: string; stopReason?: string };
      if (stopReason !== 'toolUse') return;
      const trimmed = (text ?? '').trim();
      if (trimmed.length === 0) return;
      delivered += 1;
      if (delivered > max) return;
      const message = this.#deps.messages.append({
        conversationId: batch.conversationId,
        senderType: 'bot',
        senderBotId: batch.botId,
        kind: 'text',
        text:
          trimmed.length > INTERIM_TEXT_MAX_CHARS
            ? `${trimmed.slice(0, INTERIM_TEXT_MAX_CHARS)}…`
            : trimmed,
        runId,
        ...(taskId !== null ? { taskOrigin: { taskId } } : {}),
      });
      this.#recordBotMessage(runId, message);
    });
  }
  /** Persists engine events as (redacted) run steps. */
  #persistSteps(runId: string, conversationId: string, handle: RunHandle): () => void {
    return persistEngineSteps({
      runs: this.#deps.runs,
      secrets: this.#deps.secrets,
      runId,
      handle,
      onProgress: (progress) => {
        // Status line: the loop's current tool / progress text.
        this.#deps.publish('run.progress', { runId, conversationId, ...progress });
      },
    });
  }

  #steerRunningRun(batch: TriggerBatch, text: string): string | null {
    const mailboxKey = this.#mailboxKey(batch.botId, batch.conversationId);
    for (const [runId, entry] of [...this.#activeRuns.entries()]) {
      if (entry.conversationId !== batch.conversationId || entry.botId !== batch.botId) continue;
      entry.cutoffSeq = Math.max(
        entry.cutoffSeq,
        Math.max(-1, ...batch.messages.map((m) => m.seq)),
      );
      // The loop may already have ended (agent_end) while the run is still
      // settling — a steer queued then would silently drop. Fall through to
      // the buffer and re-deliver the batch as a new run on release.
      if (entry.handle.steer(text)) {
        if (entry.steerLog !== undefined) this.#noteAgentSteer(entry.steerLog, text, batch);
        if (entry.consumesTaskIds !== undefined)
          this.#noteTaskEntries(entry.consumesTaskIds, batch);
        return runId; // the engine's steer event persists the step
      }
      break;
    }
    // No registered loop (or one that just finished): buffer the whole batch.
    // Registration injects it as a steer; mailbox release re-delivers it.
    const buffered = this.#pendingSteers.get(mailboxKey) ?? [];
    buffered.push(batch);
    this.#pendingSteers.set(mailboxKey, buffered);
    return null;
  }

  #settleRun(
    runId: string,
    status: Run['status'],
    error: string | null,
    setup?: SetupRequirement,
  ): Run {
    const run = this.#deps.runs.update(runId, {
      status,
      ...(error !== null ? { error } : {}),
      ...(setup !== undefined ? { setup } : {}),
    });
    if (isTerminal(status)) {
      // Once-grants die with the run; pending approvals (if any survived)
      // must not dangle.
      this.#deps.grants.expireForRun(runId);
      this.#deps.approvals.cancelPendingForRun(runId);
    }
    this.#deps.publish('run.status', { run });
    // Group turns advance on any terminal state (cancelled/failed included).
    if (isTerminal(status)) this.#groupTurns.onRunSettled(run);
    // D71：被委派 run 的终态 → A 侧结果卡 + follow-up（按 run_id 匹配）。
    if (isTerminal(status)) {
      try {
        this.#delegationHost.onRunSettled(run);
      } catch (error) {
        this.#deps.logger.warn(
          { runId, error: error instanceof Error ? error.message : String(error) },
          'delegation settle failed',
        );
      }
    }
    return run;
  }

  #latestRunId(conversationId: string, botId: string | null): string | null {
    if (botId === null) return null;
    const run = this.#deps.runs
      .listByConversation(conversationId, 5)
      .find((r) => r.botId === botId);
    return run?.id ?? null;
  }

  /** Registers the summary job when enough messages sit unsummarized. */
  #maybeEnqueueSummary(conversationId: string): void {
    const conv = this.#deps.conversations.get(conversationId);
    if (!conv) return;
    const unsummarized = conv.lastSeq - conv.summaryUptoSeq;
    if (unsummarized <= SUMMARY_TRIGGER_UNSUMMARIZED) return;
    this.#deps.jobs.enqueue({
      type: 'conversation_summary',
      conversationId,
      payload: { targetSeq: conv.lastSeq },
      priority: 2,
      dedupeKey: `conversation_summary:${conversationId}`,
    });
  }

  #publishConversation(conversationId: string): void {
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation) {
      this.#deps.publish('conversation.updated', { conversation });
    }
  }

  #publishDrafts(conversationId: string): void {
    this.#deps.publish('draft.changed', {
      conversationId,
      drafts: this.#deps.drafts.list(conversationId),
    });
  }
}

function isTerminal(status: Run['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

/** 缺设置失败的 run.error 兜底文案（界面以设置卡片为主，横幅不展示）。 */
function setupRequirementErrorText(requirement: SetupRequirement): string {
  switch (requirement.kind) {
    case 'main-model':
      return '未配置模型：请在设置页选择默认主模型或在 Bot 配置中指定';
    case 'capability-model':
      return `未配置${requirement.capability === 'image' ? '图像生成' : requirement.capability}模型：请先完成设置`;
    case 'web-search':
      return '未配置联网检索：请先在设置中选择检索供应商并填写 API key';
    case 'agent':
      return agentSetupMessage(requirement.agentId, requirement.reason);
  }
}

/** Plain text of a message (memory retrieval query input). */
function messageText(message: Message): string {
  const content = message.content as { text?: string } | undefined;
  return typeof content?.text === 'string' ? content.text : '';
}
