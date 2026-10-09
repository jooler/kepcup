import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import {
  AppError,
  BOT_SETUP_PATH_QUESTION_EVENT,
  GROUP_SETUP_QUESTION_EVENT,
  GROUP_SETUP_STEPS,
  INTERIM_TEXT_MAX_CHARS,
  INTERIM_TEXT_MAX_PER_RUN,
  INTERIM_TEXT_MAX_PER_RUN_GROUP,
  PROFILE_CHANGE_FOLLOWUP_EVENT,
  RUN_MAX_TURNS,
  SETUP_MAX_QUESTIONS,
  SETUP_QUESTION_EVENT,
  SUMMARY_TRIGGER_UNSUMMARIZED,
  TASK_CHANGED_FILES_SHOWN,
  TURN_MAX_TURNS,
  TURN_MCP_RESOLVE_TIMEOUT_MS,
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
  WATCH_CARD_TYPE,
  WATCH_ALERT_EVENT,
  type Run,
  type ToolEffect,
  type SetupRequirement,
  type TaskChanges,
  type TaskEventContent,
  type TaskStateView,
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
  turnMcpNote,
} from '../agent/context/system-prompt.js';
import {
  buildConversationContext,
  buildConversationDelta,
  buildTriggerSegment,
  renderMessageLine,
  type RenderMessageOptions,
} from '../agent/context/conversation.js';
import type { ContinuationPlan } from '../agent/context/continuation.js';
import { buildTasksSegment } from '../agent/context/tasks-segment.js';
import type {
  AgentEngine,
  AgentSessionMode,
  RunHandle,
  RunIdentity,
  ToolDefinition,
} from '../agent/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import {
  isUserFacingReason,
  Mailbox,
  MailboxRegistry,
  mergeTriggerBatches,
  refreshTriggerBatch,
  storedTriggerParts,
  triggerParts,
  type TriggerBatch,
  type TriggerPart,
} from '../scheduler/mailbox.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { GroupsService } from '../domain/groups.js';
import type { DelegationsService } from '../domain/delegations.js';
import { isVisibleToUser, type MessagesService } from '../domain/messages.js';
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
import { browserProfileKey, effectiveBrowserProfileId } from '../browser/profiles.js';
import type { MemoryToolFacade } from '../tools/memory-tools.js';
import type { ScheduleToolFacade } from '../tools/schedule-tools.js';
import type { WatchToolFacade } from '../tools/watch-tools.js';
import { applyProfileChanges } from '../memory/service.js';
import {
  createSubagentFacade,
  buildSubagentSystemPrompt,
  type SubagentToolFacade,
} from '../agent/subagent.js';
import {
  resolveMcpToolEntries,
  selectReadOnlyMcpEntries,
  wrapMcpToolEntries,
  type McpToolEntry,
  type McpToolFacade,
} from '../mcp/tools.js';
import type { McpService } from '../mcp/service.js';
import { FileReadState } from '../tools/fs-state.js';
import type { ToolGateway } from '../gateway/index.js';
import type { AppPaths } from '../infra/paths.js';
import { workspacePathFor } from '../infra/paths.js';
import { neutralizeUntrusted } from '../infra/data-boundary.js';
import {
  BUTLER_SETUP_FIRST_OPTIONS,
  BUTLER_SETUP_FIRST_QUESTION,
  BUTLER_SETUP_GREETING,
  BUTLER_WELCOME_TEXT,
  butlerProfileTemplate,
} from '../domain/butler.js';
import { ButlerHost } from './butler.js';
import {
  buildEffectsBeforeInterruptSegment,
  buildTaskBriefSegment,
  buildTaskReplaySegment,
  isTerminalStatus as isTerminalTaskStatus,
  TASK_CARD,
  TaskHost,
  taskState,
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
import type { ToolEffectsStore } from '../agent/effects/store.js';

export interface OrchestratorEnvironmentFacade {
  /** request_environment backend (docs/dev/phases/P06-environment.md 任务 3). */
  request(
    identity: {
      runId: string;
      botId: string | null;
      conversationId: string | null;
      loopType: 'turn' | 'task';
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

/** W7: what the orchestrator needs of the watch domain (lazy facade from start.ts). */
export interface OrchestratorWatchFacade extends WatchToolFacade {
  contextSection(botId: string, conversationId: string): string;
  renderContextLine(message: Message): string;
}

export interface OrchestratorDeps {
  engine: AgentEngine;
  /**
   * W2 外部副作用台账（runs.db tool_effects）：启动恢复把 executing 行改为
   * uncertain；续接摘要据此标「结果未知」。缺省（精简测试装配）不记账。
   */
  effects?: ToolEffectsStore;
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
   * W7 确定性监看（optional in stripped setups）：watch_* tools, the
   * `<watches>` context section and the watch cards' context lines.
   */
  watch?: OrchestratorWatchFacade | undefined;
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
export type OrchestratorMemoryFacade = Omit<
  MemoryToolFacade,
  'triggerMessages' | 'submitProfileChange'
> & {
  /** A turn's non-blocking propose_profile_change (D75 审查 M4); decision → `onDecided`. */
  submitProfileChange(
    identity: RunIdentity,
    changes: Array<{ field: string; value: string }>,
    reason: string,
    onDecided: (outcome: { approved: boolean; note: string }) => void,
  ): void;
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

/**
 * What a part of a downgraded turn's trigger is (§8.4 / 审查 M5): the task it
 * is handed to must not mistake a system event or a schedule for the user.
 */
function downgradeLabel(part: TriggerPart): string {
  switch (part.reason) {
    case 'direct':
    case 'mention':
    case 'reply':
    case 'broadcast':
      return '用户的新消息';
    case 'event': {
      const event = part.extraAttributes?.['event'];
      if (event === 'message_edited') return '用户编辑了之前的消息（以编辑后的内容为准）';
      return `系统事件${event !== undefined ? `（${String(event)}）` : ''}，不是用户发的消息`;
    }
    case 'scheduled':
      return '定时任务到点（不是用户此刻发的消息）';
    case 'watch':
      return '网页监看条件满足（不是用户此刻发的消息）';
    case 'delegation':
      return '另一个 Bot 代用户转交给你的事';
    case 'chain':
      return '群里其他 Bot @ 了你';
    default:
      return '新消息';
  }
}

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

/** What an agent session has seen of its conversation (P5 审查 #2). */
interface AgentSeen {
  /** Every message with seq ≤ this was shown (context / delta / trigger). */
  baseCutoff: number;
  /** Later messages shown individually (steered batches): id → seq. */
  ids: Map<string, number>;
}

/** A running supervisor turn (D75: turns are never steered). */
interface ActiveRunEntry {
  handle: RunHandle;
  conversationId: string;
  botId: string;
  /** Highest message seq the turn has seen (its context and trigger). */
  cutoffSeq: number;
}

/**
 * How one execution of the shared run skeleton (`#executeRun`) is used:
 * - `turn` (D75 design 30 §2.1): the mailbox-driven supervisor turn —
 *   built-in engine only (an external agent is the bot's TASK engine, §8.1),
 *   read-only toolset with task management, TURN_MAX_TURNS, `<tasks>`
 *   segment, no D56 auto continuation (§7.1), visible final reply; at its
 *   terminal state the task results in its trigger are consumed (§3.2), the
 *   mailbox releases (buffered batches start the next turn) and group turns /
 *   D71 hooks advance;
 * - `task` (design 30 §2.2 / §2.4.5): a task — scheduler key `task:{id}`,
 *   loop_type 'task', brief as the trigger segment, shared-only conversation
 *   layer, interim texts with `origin:'task'`, final text → the private
 *   `result` entry via TaskHost.settle, never a visible message.
 */
type RunExecution =
  | { kind: 'turn'; batch: TriggerBatch }
  | {
      kind: 'task';
      /** Synthesized: the brief's source messages, reason 'task'. */
      batch: TriggerBatch;
      task: Run;
      brief: TaskBrief;
      control: TaskRunControl;
    };

/**
 * Drives conversations end to end: draft flush -> message rows -> mailbox ->
 * supervisor turn (scheduler -> engine -> persisted steps, bot messages, usage
 * entries and events; docs/dev/02-architecture.md "一条消息的完整链路") and
 * the D75 tasks the turns start (TaskHost).
 */
export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #mailboxes: MailboxRegistry;
  /**
   * Task ids whose terminal entries a begun turn carries in its trigger, by
   * turn run id (D75 审查 M4): the reconciliation does not re-deliver them
   * while that turn is live.
   */
  readonly #turnTaskHolds = new Map<string, Set<string>>();
  /** Change summaries of settled workspace write tasks (D75 审查 L5; bounded). */
  readonly #workspaceChangesCache = new Map<string, TaskChanges | null>();
  readonly #activeRuns = new Map<string, ActiveRunEntry>();
  readonly #cancelledBeforeStart = new Set<string>();
  /** Per-run file-read hashes (staleness detection, P04). */
  readonly #fsState = new FileReadState();
  /** Bot-to-bot @ chains (P05); owns chain rows, depth and budget checks. */
  readonly #chains: ChainsService;
  /** Group turns (P05): triage, ordered responses, re-dispatch bookkeeping. */
  readonly #groupTurns: GroupTurnCoordinator;
  /**
   * D66 子代理门面，按父 run 登记（D75 §1.2：子 run 只属于父 run，无对话级
   * 锚点）：runs.cancel 单独取消子 run 时据 parent_run_id 找到门面；父 run
   * 结束时 #closeSubagents 中止仍在跑的分支。
   */
  readonly #subagentFacades = new Map<string, SubagentToolFacade>();
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
      ...(deps.effects !== undefined ? { effects: deps.effects } : {}),
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
      // §3.2 投递: the entry reaches the bot as a `reason:'task'` trigger batch
      // through its mailbox — a new turn when idle, else buffered and merged
      // into the next turn (several settling tasks wake one turn).
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
        // W6：委派跟随的任务到达终态 → 等它的委派重新检查是否可以结算。
        try {
          this.#delegationHost.onTaskSettled(run);
        } catch (error) {
          deps.logger.warn(
            { runId: run.id, error: error instanceof Error ? error.message : String(error) },
            'delegation task follow-up failed',
          );
        }
      },
      releaseExecution: (runId) => {
        this.#fsState.release(runId);
        void deps.projects.releaseRun(runId).catch(() => {});
      },
      // W3 interrupt (permission revoked): the task's and its sub runs' cards go.
      cancelPendingApprovals: (runIds) =>
        runIds.flatMap((runId) => deps.approvals.cancelPendingForRun(runId)),
      // W4 复查 S4: a task over the wall clock on a「上次结果未知」repeat card.
      pendingUncertainRepeat: (runIds) => deps.approvals.hasPendingUncertainRepeat(runIds),
      recordVisibleMessage: (runId, message) => {
        // forward_task_result: the source task's agent session produced this
        // text — a continuation reusing that session must not get it again
        // in its conversation delta.
        this.#markForwardedSeen(message);
        if (deps.runs.get(runId) !== null) {
          this.#recordBotMessage(runId, message);
          return;
        }
        deps.publish('message.created', { conversationId: message.conversationId, message });
        this.#publishConversation(message.conversationId);
      },
      // D75 §8.5: kept sessions of settled tasks outlive them only for the
      // continuation window.
      // W6: a consumed failed / interrupted task may be the last thing a
      // delegation waits for.
      onConsumed: () => {
        this.#delegationHost.reevaluateAwaiting();
      },
      onSweep: (now) => {
        this.#sweepTaskAgentSessions(now);
        // W6 兜底：失败任务的结果被放弃投递（直接标消费）时没有别的钩子。
        try {
          this.#delegationHost.reevaluateAwaiting();
        } catch (error) {
          deps.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'delegation task follow-up failed',
          );
        }
      },
      // D75 W3 (design 30 §4.3 / §6.3): task cards, question cards and the
      // status line follow `task.updated`.
      publishTask: (view) => deps.publish('task.updated', { task: view }),
      publishMessage: (message, change) => {
        deps.publish(change === 'created' ? 'message.created' : 'message.updated', {
          conversationId: message.conversationId,
          message,
        });
        if (change === 'created') this.#publishConversation(message.conversationId);
      },
      describeWorkdir: (task, withChanges) => this.#describeTaskWorkdir(task, withChanges),
      // 审查 M3: an ask_user wait gives the task job's provider slot back (the
      // tool runs inside that job, so the scheduler finds it by run id).
      yieldSlotWhile: (runId, wait, signal) => deps.scheduler.yieldSlotWhile(runId, wait, signal),
      // 审查 M4 / L-3: a live turn carrying a result (begun, or still queued
      // for a slot) consumes it, and so does the next turn of a mailbox
      // buffering it; no re-delivery meanwhile.
      heldByTurn: (taskId) => {
        for (const held of this.#turnTaskHolds.values()) if (held.has(taskId)) return true;
        const task = deps.runs.get(taskId);
        if (task?.botId == null || task.conversationId === null) return false;
        return (
          this.#mailboxes
            .get(task.botId, task.conversationId)
            ?.hasBuffered((message) => message.kind === 'task_event' && message.taskId === taskId) ??
          false
        );
      },
      // D75 §8.5 并发 (审查 M3): an external-agent task launches (lease,
      // task slot) only while `agent:{id}` has room; the rest stay submitted.
      // A task of an external-agent bot is recorded on its engine from the
      // start: an early gate failure (agent disabled …) still shows it.
      taskEngine: (botId) => {
        const agentId = this.#agentIdOf(deps.bots.get(botId));
        return agentId.length > 0 ? agentEngineKey(agentId) : null;
      },
      launchSlot: (task) => {
        const agentId = this.#agentIdOf(task.botId !== null ? deps.bots.get(task.botId) : null);
        if (agentId.length === 0) return null;
        const key = agentEngineKey(agentId);
        return { key, limit: deps.scheduler.concurrencyFor(key) };
      },
    });
    this.#butlerHost = new ButlerHost({
      bots: deps.bots,
      conversations: deps.conversations,
      groups: deps.groups,
      approvals: deps.approvals,
      messages: deps.messages,
      logger: deps.logger,
      // D80: proposal routines are created through the schedule domain.
      ...(deps.schedule !== undefined ? { schedule: deps.schedule } : {}),
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
      cancelTask: (taskId, reason) => {
        this.#taskHost.cancelById(taskId, reason);
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
    const notified = this.#notifyRunningLoops(message.conversationId, message);
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

  /**
   * Turns that already saw the edited message get it again in their next
   * turn (an `event` trigger, `message_edited` — D75: turns are never
   * steered). False when no running turn saw it (the edit is a fresh trigger).
   */
  #notifyRunningLoops(conversationId: string, message: Message): boolean {
    let notified = false;
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.conversationId !== conversationId) continue;
      if (message.seq > entry.cutoffSeq) continue; // this turn never saw the message
      const mailbox = this.#mailboxes.for(entry.botId, conversationId);
      if (mailbox.bufferMessageEdit({ conversationId, botId: entry.botId, message })) {
        notified = true;
      }
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
    // D66：子 run 不在 #activeRuns，经父 run 的门面中止；它自己的 unwind
    // 负责 settle 行（排在另一路之后、尚未开始的前台子 run 由门面当场结算）。
    // 门面已不在（父 run 正在 close）：close 中止全部子 run 并由它们各自
    // settle——绝不走下面「排队未开始」的分支（审查 L1）。
    if (run.loopType === 'subagent') {
      if (run.parentRunId !== null) {
        this.#subagentFacades.get(run.parentRunId)?.abortSubRun(runId, 'user cancelled');
      }
      this.#deps.approvals.cancelPendingForRun(runId);
      void this.#deps.projects.releaseRun(runId).catch(() => {});
      return this.#deps.runs.get(runId) ?? run;
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
   * run creation (#startTurn is the only create path), so this only
   * validates and delivers; the returned run is the one the mailbox actually
   * started. When a turn is already running for the mailbox the batch waits
   * for the next turn instead (null is returned).
   */
  retryRun(runId: string, options: { reviewed?: boolean } = {}): Run | null {
    const original = this.#deps.runs.get(runId);
    if (!original) throw new AppError('RUN_NOT_FOUND', `Run ${runId} does not exist`);
    // D75 §7.5: a task is not a mailbox run — retrying it (the setup card,
    // after the setup it failed on is done) starts a new task continuing it.
    // W3 (D78): an interrupted task too — after the user's review when it
    // left external effects (`reviewed`, only from the task card).
    if (
      original.loopType === 'task' &&
      (original.status === 'failed' || original.status === 'interrupted')
    ) {
      return this.#taskHost.retry(original.id, options);
    }
    if (original.status !== 'failed') return original;
    if (original.conversationId === null || original.botId === null) return original;
    // Background loops (reflection / summary / triage / subagent) carry a
    // conversation id but are not mailbox turns: replaying their trigger
    // messages as a turn would answer the user a second time.
    if (original.loopType !== 'turn') {
      throw new AppError('INVALID_INPUT', '后台任务的失败不支持重试');
    }
    // The trigger as the failed turn had it: each source part with its own
    // reason / attributes (审查 L3), messages re-read (recalled ones dropped).
    const lookup = (id: string): Message | null => this.#deps.messages.getById(id);
    const stored = this.#deps.runs.triggerPartsOf(original.id) ?? [
      {
        reason: (original.triggerReason ?? 'direct') as TriggerBatch['reason'],
        messageIds: original.triggerMessageIds,
      },
    ];
    const parts: TriggerPart[] = stored.map((part) => ({
      reason: part.reason as TriggerBatch['reason'],
      messages: part.messageIds
        .map(lookup)
        .filter((message): message is Message => message !== null),
      ...(part.extraAttributes !== undefined ? { extraAttributes: part.extraAttributes } : {}),
    }));
    const rebuilt = refreshTriggerBatch(
      {
        conversationId: original.conversationId,
        botId: original.botId,
        messages: parts.flatMap((part) => part.messages),
        reason: (original.triggerReason ?? 'direct') as TriggerBatch['reason'],
        parts,
        // 审查 L6: tasks the failed turn already started are not started again.
        retryOf: original.id,
      },
      lookup,
    );
    if (rebuilt === null) {
      throw new AppError('INVALID_INPUT', '原始触发消息已不存在，无法重试');
    }
    const conv = this.#deps.conversations.getOrThrow(original.conversationId);
    if (conv.readOnly) throw new AppError('CONVERSATION_READ_ONLY', '该对话为只读');
    const mailbox = this.#mailboxes.for(original.botId, original.conversationId);
    const wasRunning = mailbox.isRunning;
    mailbox.deliver(rebuilt);
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

  /** Every active run of the conversation (status line seed, D75 审查 L3). */
  listActiveByConversation(conversationId: string) {
    return this.#deps.runs.listActiveByConversation(conversationId);
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
   * yet released) — a batch delivered while this is false waits for the next
   * turn, never starts a second one.
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
    // D75: tasks settle (cancelled, no wake) before the blanket settle below.
    this.#taskHost.abortForConversation(conversationId);
    for (const entry of [...this.#activeRuns.values()]) {
      if (entry.conversationId === conversationId) {
        entry.handle.abort('conversation deleted');
      }
    }
    this.#deps.approvals.cancelPendingForConversation(conversationId);
    // Only drop entries (and buffered batches) of THIS conversation: other
    // conversations' loops keep running (BR-P01-002).
    for (const [runId, entry] of [...this.#activeRuns.entries()]) {
      if (entry.conversationId === conversationId) this.#activeRuns.delete(runId);
    }
    this.#mailboxes.clearWhere({ conversationId });
    for (const run of this.#deps.runs.listActiveByConversation(conversationId)) {
      if (!this.#activeRuns.has(run.id)) this.#cancelledBeforeStart.add(run.id);
      this.#settleRun(run.id, 'cancelled', null);
    }
  }

  async abortRunsForBot(botId: string): Promise<void> {
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
    this.#mailboxes.clearWhere({ botId });
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
    this.#mailboxes.clearWhere({ botId, conversationId });
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
   * finished). Appends a system message and hands it to the mailbox: a fresh
   * `event` turn at priority 1, or the next turn when one is running.
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
    // W7: a watch alert is its own trigger reason (the bot created the watch).
    const isWatch = event === WATCH_ALERT_EVENT;
    this.#mailboxes.for(botId, conversationId).deliver({
      conversationId,
      botId,
      messages: [message],
      reason: isWatch ? 'watch' : 'event',
      ...(isWatch ? {} : { extraAttributes: { event } }),
    });
  }

  /**
   * W7 确定性监看：wakes one turn of the bot with the alert (internal
   * `watch_alert` event, trigger reason `watch`). Same guard as events: no
   * daily cap (the user asked for the watch), but quiet hours park the wake
   * as a persistent `event_delivery` job. The user-visible alert card is
   * posted by the watch service before this.
   */
  deliverWatchAlertToBot(input: { botId: string; conversationId: string; text: string }): void {
    this.deliverEventToBot(input.botId, input.conversationId, WATCH_ALERT_EVENT, input.text, {
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

  /**
   * The schedule a turn's reply comes from (D80 「⏰ 标题」 tag): a scheduled
   * part of the batch, or the result of a task launched by a scheduled turn
   * (scheduled turns usually hand the work to a task and relay its result in
   * a later `task` turn). Null for everything else.
   */
  #scheduleSourceOf(batch: TriggerBatch): { scheduleId: string; scheduleTitle: string } | null {
    const facade = this.#deps.schedule;
    if (facade === undefined) return null;
    // A user's message merged into the batch makes the reply theirs, not the schedule's.
    if (triggerParts(batch).some((part) => isUserFacingReason(part.reason))) return null;
    const resolve = (id: unknown) => {
      if (typeof id !== 'string' || id.length === 0) return null;
      const title = facade.displayTitle(id);
      return title === null ? null : { scheduleId: id, scheduleTitle: title };
    };
    try {
      for (const part of triggerParts(batch)) {
        if (part.reason === 'scheduled') {
          const found = resolve(part.extraAttributes?.['schedule_id']);
          if (found !== null) return found;
        }
      }
      for (const entry of batch.messages) {
        if (entry.kind !== 'task_event' || entry.taskId === null) continue;
        const originRunId = this.#deps.runs.get(entry.taskId)?.originRunId ?? null;
        if (originRunId === null) continue;
        for (const part of this.#deps.runs.triggerPartsOf(originRunId) ?? []) {
          if (part.reason !== 'scheduled') continue;
          const found = resolve(part.extraAttributes?.['schedule_id']);
          if (found !== null) return found;
        }
      }
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'schedule source lookup failed',
      );
    }
    return null;
  }

  // --- startup recovery ------------------------------------------------------

  /**
   * Marks unfinished runs `interrupted`, cancels their pending approvals and
   * inserts a system message into the affected conversations. Never resumes
   * them (docs/dev/02-architecture.md).
   */
  recoverInterrupted(): number {
    // W2 (step 0): nothing runs yet at startup, so every `executing` ledger
    // row belongs to a call the dead process never settled → uncertain. One
    // idempotent UPDATE covering tasks, turns, sub runs and external-agent
    // runs alike — before the task repair renders failure digests from it.
    try {
      const changed = this.#deps.effects?.markExecutingUncertain() ?? 0;
      if (changed > 0) {
        this.#deps.logger.info({ effects: changed }, 'marked interrupted tool effects uncertain');
      }
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'tool effect recovery failed',
      );
    }
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
    // D71：working 委派的 run 已被标 interrupted → 按该 run 结算（已派出任务的
    // request 进 awaiting_tasks 跟随任务，否则落 failed；不续跑，D49）；
    // awaiting_tasks 委派按已修复的任务终态重新判定（W6）；
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

  /**
   * W5: the bot's enabled MCP tools (app-enabled ∩ bot-selected servers,
   * `enabled:false` tools dropped). A task waits for the lists; a turn waits
   * at most TURN_MCP_RESOLVE_TIMEOUT_MS and goes without MCP tools otherwise
   * (the connection keeps going in the background and the next turn hits the
   * cache).
   */
  async #mcpEntriesFor(
    serverIds: string[],
    isTask: boolean,
  ): Promise<{ entries: McpToolEntry[]; hasServers: boolean; resolved: boolean }> {
    const mcp = this.#deps.mcp;
    if (mcp == null || serverIds.length === 0) return { entries: [], hasServers: false, resolved: true };
    const servers = mcp.serversForBot(serverIds);
    if (servers.length === 0) return { entries: [], hasServers: false, resolved: true };
    // Only a task's connect failures count toward MCP_RECONNECT_MAX: turns
    // resolve on every message and must not drain the budget tasks rely on.
    const resolving = resolveMcpToolEntries({
      servers,
      mcp,
      logger: this.#deps.logger,
      countFailures: isTask,
    });
    if (isTask) return { entries: await resolving, hasServers: true, resolved: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TURN_MCP_RESOLVE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const entries = await Promise.race([resolving, timeout]);
      if (entries === null) {
        resolving.catch(() => {});
        this.#deps.logger.warn(
          { serverIds },
          'mcp tool lists not ready within the turn budget; turn runs without MCP tools',
        );
        return { entries: [], hasServers: true, resolved: false };
      }
      return { entries, hasServers: true, resolved: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    return new Mailbox(key, { startRun: (batch) => this.#startTurn(batch) });
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
        if ('cardType' in content && content.cardType === WATCH_CARD_TYPE) {
          return this.#deps.watch?.renderContextLine(message) ?? '（监看记录已清理）';
        }
        if ('runId' in content && content.cardType === TASK_CARD) {
          return this.#renderTaskCard(String(content.runId ?? ''));
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

  /**
   * Starts a supervisor turn for a mailbox batch (D75 design 30 §2.1). Turns
   * always run on the built-in engine (decision 9: an external agent is the
   * bot's task engine), so the scheduler key is the built-in provider.
   */
  #startTurn(batch: TriggerBatch): string {
    const run = this.#deps.runs.create({
      engine: BUILTIN_ENGINE,
      botId: batch.botId,
      conversationId: batch.conversationId,
      loopType: 'turn',
      triggerReason: batch.reason,
      triggerMessageIds: batch.messages.map((m) => m.id),
      // Each source part keeps its reason / attributes for a retry (审查 L3).
      triggerParts: storedTriggerParts(batch),
      ...(batch.retryOf !== undefined ? { retryOfRunId: batch.retryOf } : {}),
      ...(batch.chain !== undefined
        ? { chainId: batch.chain.id, chainDepth: batch.chain.depth }
        : {}),
    });
    this.#deps.publish('run.status', { run });
    // The turn holds its trigger's task results from now on (审查 L-3): one
    // still queued for a slot is not handed them again — nor counted again.
    this.#holdTaskEntries(run.id, batch);
    try {
      this.#submitTurn(run.id, batch);
    } catch (error) {
      this.#turnTaskHolds.delete(run.id);
      throw error;
    }
    return run.id;
  }

  #submitTurn(runId: string, batch: TriggerBatch): void {
    this.#deps.scheduler.submit({
      // Chain / scheduled / event turns are priority 1; user-facing ones are 0
      // (docs/dev/04-agent-runtime.md "各类 loop 的配置") — D71 delegations
      // (the user waits in A's conversation) and task results (the user asked
      // for them) included. A merged batch counts as user-facing if any part is.
      priority: triggerParts(batch).some((part) => isUserFacingReason(part.reason)) ? 0 : 1,
      provider: this.#providerForRef(this.#turnModelRef(batch.botId)),
      key: this.#mailboxKey(batch.botId, batch.conversationId),
      // Lease waits of this run give the slot back (D75 审查 H2).
      runId,
      run: () => this.#executeRun(runId, { kind: 'turn', batch }),
    });
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
   * The built-in main model of a bot's supervisor turns (D75 §8.1: turns
   * never run on an external agent; '' = none configured).
   */
  #turnModelRef(botId: string): string {
    try {
      const bot = this.#deps.bots.get(botId);
      return bot?.profile.runtime.model || this.#deps.settings.get().defaultMainModel;
    } catch {
      return '';
    }
  }

  /**
   * The external agent driving a bot's tasks ('' = built-in engine).
   * The conversational setup interview (incl. the butler's) needs the
   * interview tools (ask_question / save_profile / finish_setup), which are
   * never injected into agents: it always runs on the built-in engine — a
   * user without a built-in model gets the structured main-model setup card.
   */
  #agentIdOf(bot: Bot | null | undefined): string {
    if (bot === null || bot === undefined || bot.setupState === 'interviewing') return '';
    return bot.profile.runtime.agent.id;
  }

  /** The engine driving a bot's tasks (D72 / D75 §8.1): pi unless an agent is set. */
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
    memorySections: {
      userProfile?: string;
      myState?: string;
      schedules?: string;
      watches?: string;
      relevantMemories?: string;
    };
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
    /**
     * D75 task run (design 30 §8.5): the task owning the session row, the
     * task it continues (inherits that task's row), and whether it may write
     * (a read-only task is forced onto the `read_only` tier — the agent's
     * writes inside the workdir would pass the tier logic before any gateway).
     */
    task?: { id: string; continuesTaskId: string | null; writes: boolean };
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
    session: {
      rowId: string;
      sessionKey: string;
      reuseId: string | null;
      fingerprint: string;
      seen: AgentSeen;
    };
  }> {
    const { bot, conversation, agentId } = input;
    const entry = findAgentEntry(this.#deps.agentCatalog?.() ?? [], agentId);
    if (entry === null) throw new AppError('AGENT_UNAVAILABLE', `智能体「${agentId}」不在目录中`);
    const provider = providerFor(entry);
    // D72 P3：Bot 的档位（Windows 下无可依赖沙箱时 workspace → ask）；D75
    // 只读任务一律 read_only（§5.1 只读任务硬拒写）。
    const permission =
      input.task !== undefined && !input.task.writes
        ? 'read_only'
        : effectiveAgentPermission(
            bot.profile.runtime.agent.permission,
            provider,
            process.platform,
          );
    const taskId = input.task?.id ?? null;
    const capabilities = resolveCapabilities(bot.profile.runtime.agent.capabilities, entry, {
      isButler: bot.systemRole === 'butler',
    });
    const loadUserConfig = this.#deps.settings.get().agents[agentId]?.loadUserConfig === true;
    // D72 P5 会话复用（design 28 §7）：窗口内、指纹一致的会话只发增量。桥
    // server 名由会话行 id 派生（换会话 = 换名字），会话级提示词里的工具名
    // 随之变化，所以按候选行先算一遍、指纹不符再按新行重算。
    // D75 §8.5：任务各占自己的行；continues_task_id 在旧任务的执行结束后
    // 继承它的行（单条 UPDATE，失败 = 新建会话）——仍在释放的旧任务不交出。
    let previous = this.#agentSessions.get(bot.id, conversation.id, agentId, taskId);
    const continuesTaskId = input.task?.continuesTaskId ?? null;
    if (previous === null && taskId !== null && continuesTaskId !== null) {
      if (!this.#taskHost.isExecuting(continuesTaskId)) {
        previous = this.#agentSessions.inheritTask(
          bot.id,
          conversation.id,
          agentId,
          continuesTaskId,
          taskId,
        );
      }
    }
    const now = this.#deps.clock.now();
    const continued =
      previous !== null && now - previous.lastUsedAt <= CONTINUATION_WINDOW_MS
        ? this.#agentConversationDelta(
            previous,
            input.batch,
            input.renderOptions,
            // A task reads shared rows only, and nothing reaches it as a steer
            // but injects: its delta runs up to the context it would get anew.
            taskId !== null ? { viewerBotId: null, upTo: input.contextCutoff } : undefined,
          )
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
        sessionKey: this.#agentSessionKey({
          id: session.rowId,
          botId: bot.id,
          conversationId: conversation.id,
          agentId,
          taskId,
        }),
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
    task?: { viewerBotId: null; upTo: number },
  ): { text: string; seen: AgentSeen } | null {
    const seen = this.#agentSessionSeen.get(row.id);
    if (seen === undefined) return null;
    const upTo = task?.upTo ?? Math.max(-1, ...batch.messages.map((message) => message.seq));
    const limit = 120;
    const recent = this.#contextMessages(
      batch.conversationId,
      task !== undefined ? task.viewerBotId : batch.botId,
      limit,
    );
    if (recent.length === limit && recent[0]!.seq > seen.baseCutoff + 1) return null;
    const batchIds = new Set(batch.messages.map((message) => message.id));
    const text = buildConversationDelta(
      recent.filter(
        (message) =>
          message.seq > seen.baseCutoff &&
          message.seq <= upTo &&
          !seen.ids.has(message.id) &&
          !batchIds.has(message.id) &&
          // The session wrote the bot's replies of a turn run; a task's
          // session did not write the bot's turn replies.
          (task !== undefined ||
            !(message.senderType === 'bot' && message.senderBotId === batch.botId)),
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

  /**
   * Bridge / engine key of an agent session (`RunSpec.external.sessionKey`:
   * bridge token, run binding, kept-session match). D72 rows: one per
   * (Bot, conversation, Agent). D75 task rows (design 30 §8.5): the key also
   * names the row — every task has its own row, so its own key and bridge
   * token, and a `continues_task_id` inheritance keeps the row (and so the
   * key and token the kept session was opened with).
   */
  #agentSessionKey(
    row: Pick<AgentSessionRow, 'id' | 'agentId' | 'botId' | 'conversationId' | 'taskId'>,
  ): string {
    const base = `${row.botId}:${row.conversationId}:${row.agentId}`;
    return row.taskId === null ? base : `${base}:task:${row.id}`;
  }

  /** Gives up a kept agent session (best effort, asynchronous). */
  #discardAgentSession(
    row: Pick<
      AgentSessionRow,
      'id' | 'agentId' | 'agentSessionId' | 'botId' | 'conversationId' | 'taskId'
    >,
    deleteHistory: boolean,
  ): void {
    this.#agentSessionSeen.delete(row.id);
    const discard = this.#deps.externalEngine?.discardSession;
    if (discard === undefined) return;
    void discard
      .call(this.#deps.externalEngine, {
        agentId: row.agentId,
        agentSessionId: row.agentSessionId,
        sessionKey: this.#agentSessionKey(row),
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

  /**
   * D75 §8.5 生命周期: a settled task's kept session stays for
   * `continues_task_id` only within CONTINUATION_WINDOW_MS of its last run;
   * then it is closed (not deleted — crash recovery may still resume a live
   * task's row) and its row removed. Rows of tasks still executing stay.
   */
  #sweepTaskAgentSessions(now: number): void {
    for (const row of this.#agentSessions.listTaskSessions()) {
      if (now - row.lastUsedAt <= CONTINUATION_WINDOW_MS) continue;
      const task = this.#deps.runs.get(row.taskId!);
      if (task !== null && !isTerminalTaskStatus(task.status)) continue;
      if (this.#taskHost.isExecuting(row.taskId!)) continue;
      this.#discardAgentSession(row, false);
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
        // Same fallback as the execution's workdir (#executeRun, 审查 L6).
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
      const writes = task.taskWrites === true;
      this.#deps.scheduler.submit({
        // A read-only task: below user-facing turns (0), and the
        // scheduler keeps one provider slot free of tasks for replies. A write
        // task already holds its lease — runs that want to write wait on it —
        // so it queues FIFO with replies and starts under the plain limit
        // (审查 round 2 #4: bounded, replies still borrow a slot over tasks).
        priority: writes ? 0 : 1,
        provider: this.#providerForRef(this.#modelRefForBot(botId)),
        key,
        runId: task.id,
        ...(writes ? { leaseHeld: true } : {}),
        run: async () => {
          started = true;
          control.signal.removeEventListener('abort', onAbort);
          control.waiting(null);
          await this.#executeRun(task.id, {
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
   * The shared run skeleton (D75 supervisor turns and tasks, see
   * RunExecution): gates → context / trigger → tools → engine run → interim
   * texts → outcome → usage → lease release → settle. The variants differ
   * only at the points branching on `exec.kind`.
   */
  async #executeRun(runId: string, exec: RunExecution): Promise<void> {
    let { batch } = exec;
    const isTask = exec.kind === 'task';
    const loopType = isTask ? ('task' as const) : ('turn' as const);
    const { runs, messages } = this.#deps;
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
    let agentSessionRowId: string | null = null;
    let agentPromptSent = false;
    /** The engine run once started: a crash after this point must stop it (审查 L8). */
    let startedHandle: RunHandle | null = null;
    /**
     * A turn handled its trigger (审查 M2): its engine run started, the §8.4
     * downgrade routed it, or it failed on a missing setup whose completion
     * retries this very trigger. Only then may its task results be consumed.
     */
    let handled = false;
    try {
      if (exec.kind === 'turn') {
        // 审查 M1: deliveries of the same tick (a reconciliation burst, tasks
        // settling together) reach the mailbox buffer first …
        await Promise.resolve();
      }
      if (
        exec.kind === 'task'
          ? exec.control.signal.aborted
          : this.#cancelledBeforeStart.delete(runId)
      ) {
        settle('cancelled', null);
        return;
      }
      if (exec.kind === 'turn') {
        // … then the turn takes everything buffered for its mailbox so far and
        // re-reads its messages: one turn sees it all (latest edits, no
        // recalled messages), and nothing in its context triggers the next
        // turn again. The context below is built synchronously from here on,
        // so no batch can be buffered in between.
        const absorbed = this.#absorbIntoTurn(runId, batch);
        if (absorbed === null) {
          settle('cancelled', null);
          return;
        }
        batch = absorbed;
      }

      const bot = this.#deps.bots.get(batch.botId);
      const conv = this.#deps.conversations.get(batch.conversationId);
      if (!bot || !conv || bot.status !== 'active' || conv.readOnly) {
        settle('cancelled', null);
        return;
      }

      // D75 §8.1: a turn always runs on the built-in engine with the bot's
      // built-in main model; a task runs on the bot's engine (an external
      // agent when one is set).
      const modelRef = isTask ? this.#modelRefForBot(batch.botId) : this.#turnModelRef(batch.botId);
      // 模型门禁（D58）按引擎判定：内置引擎看内置模型；外部 Agent（任务）
      // 看实验开关 + 目录 + 启用 / 安装 / 登录状态（D72 P4：结构化
      // setup `{kind:'agent'}` → 对话内 Agent 设置卡，完成后自动重试）。
      // `runtime.agent` is the bot's task engine — a task of an external-agent
      // bot runs on the agent in a session of its own (§8.5); a turn never does.
      const agentId = isTask ? this.#agentIdOf(bot) : '';
      const engine = isTask ? this.#engineFor(bot) : this.#deps.engine;
      if (agentId.length > 0) {
        if (engine === null) {
          settle('failed', '外部智能体引擎不可用');
          return;
        }
        const gate = agentRunGate(
          this.#deps.settings.get(),
          this.#deps.agentCatalog?.() ?? [],
          agentId,
          this.#agentView(),
        );
        if (gate !== null) {
          settle(
            'failed',
            gate.message,
            gate.reason !== null ? { kind: 'agent', agentId, reason: gate.reason } : undefined,
          );
          return;
        }
      } else if (modelRef.length === 0 && !isTask && this.#agentIdOf(bot).length > 0) {
        // §8.4 explicit downgrade: no built-in model for the turn, but the bot
        // has an external agent as its task engine — routing is deterministic.
        runs.update(runId, { status: 'running', engine: BUILTIN_ENGINE });
        this.#deps.publish('run.status', { run: runs.getOrThrow(runId) });
        handled = true;
        this.#routeWithoutModel(runId, batch, bot);
        settle('completed', null);
        return;
      } else if (modelRef.length === 0) {
        // The setup card retries this trigger once a model is configured.
        handled = true;
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
      // A turn's trigger: one <trigger> per source batch (batches buffered
      // during the previous turn arrive merged, each keeping its reason); a
      // task result in it is rendered in full up to the hard cap (§2.4.4).
      const triggerSegment =
        exec.kind === 'task'
          ? [
              this.#effectsBeforeInterrupt(exec.brief),
              buildTaskBriefSegment(exec.brief, renderOptions, exec.task.taskWorkdir),
            ]
              .filter((part) => part.length > 0)
              .join('\n\n')
          : triggerParts(batch)
              .map((part) =>
                buildTriggerSegment({
                  reason: part.reason,
                  messages: part.messages,
                  options: renderOptions,
                  extraAttributes: part.extraAttributes,
                }),
              )
              .join('\n');
      // Sequential group response: the later bot is told who already replied
      // (docs/dev/04-agent-runtime.md "触发段").
      const triggerContent = batch.afterNote
        ? `${triggerSegment}\n\n${batch.afterNote}`
        : triggerSegment;

      // Loop 续接 (D56 as revised by D75 §7.1): only a task replays, and only
      // the task it explicitly continues (continues_task_id). Turns never
      // auto-continue. Any failure means "no continuation", never a failed run.
      let continuation: ContinuationPlan | null = null;
      if (exec.kind === 'task') {
        try {
          continuation = this.#taskContinuation(exec.brief);
        } catch (error) {
          this.#deps.logger.warn(
            { runId, error: error instanceof Error ? error.message : String(error) },
            'continuation resolution failed; starting without replay',
          );
        }
      }
      // §4.2: the turn sees its in-flight tasks (state, queue reason, latest
      // progress) — deterministic, no model call.
      const tasksSegment = isTask
        ? ''
        : buildTasksSegment(this.#taskHost.list(identity), this.#deps.clock.now());
      const contextAndContinuation = [contextSegment, continuation?.segment, tasksSegment]
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
      // D65 MCP：应用 enabled ∩ Bot 选中 的 server → 工具（首次使用懒连接）。
      // W5：任务拿全部已启用工具；对话轮与只读子代理只拿只读 + 免审批的前
      // TURN_MCP_READ_TOOLS_MAX 个（调用时网关再校验）。对话轮最多等
      // TURN_MCP_RESOLVE_TIMEOUT_MS：连接慢就本轮不带，下一轮命中缓存。
      const mcpResolution = await this.#mcpEntriesFor(bot.profile.runtime.mcp_server_ids, isTask);
      const mcpEntries = mcpResolution.entries;
      const readOnlyMcp = selectReadOnlyMcpEntries(mcpEntries);
      const wrapMcp = (ident: RunIdentity, entries: McpToolEntry[]) =>
        this.#deps.mcp != null
          ? wrapMcpToolEntries({
              identity: ident,
              entries,
              mcp: this.#deps.mcp,
              gateway: this.#deps.gateway,
              secrets: this.#deps.secrets,
            })
          : [];
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
            // D75 审查 M4: a turn's proposal never waits — the user's decision
            // reaches the bot later as an internal event (next turn).
            submitProfileChange: (ident, changes, reason) =>
              memoryFacade.submitProfileChange(ident, changes, reason, (outcome) => {
                this.deliverEventToBot(
                  batch.botId,
                  batch.conversationId,
                  PROFILE_CHANGE_FOLLOWUP_EVENT,
                  outcome.approved
                    ? 'Profile 修改处理结果（宿主系统注入，不是用户消息）：用户批准了你的 Profile 修改建议，已写入生效。可以简短告诉用户。'
                    : `Profile 修改处理结果（宿主系统注入，不是用户消息）：${outcome.note === '已拒绝' ? '用户没有批准你的 Profile 修改建议' : `用户批准了修改，但没能写入（${outcome.note}）`}。不要原样重复同一个提议，可以在自我笔记（self_note）里记下你的想法。`,
                  { internal: true },
                );
              }),
            triggerMessages: () => batch.messages,
          }
        : undefined;
      // D80: a scheduled turn's messages carry the 「⏰ 标题」 tag.
      const scheduleSource = isTask ? null : this.#scheduleSourceOf(batch);
      const toolDeps: ResponseToolDeps = {
        ...(scheduleSource !== null ? { scheduleSource } : {}),
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
        ...(this.#deps.watch !== undefined ? { watch: this.#deps.watch } : {}),
        ...(this.#deps.browser !== undefined
          ? {
              browser: this.#deps.browser,
              // W8: re-read per call — a profile switch applies to the next ensurePage.
              browserProfileKey: (botId: string) =>
                browserProfileKey(
                  botId,
                  effectiveBrowserProfileId(
                    this.#deps.bots.get(botId),
                    this.#deps.settings.get().browserProfiles,
                  ),
                ),
            }
          : {}),
        ...(this.#deps.media !== undefined ? { media: this.#mediaFacade(setupHit) } : {}),
        ...(this.#deps.search !== undefined ? { search: this.#searchFacade(setupHit) } : {}),
        ...(this.#deps.skillInstall !== undefined ? { skillInstall: this.#deps.skillInstall } : {}),
        batchMessages: batch.messages,
        onBotMessage: (message) => this.#recordBotMessage(runId, message),
        // D75 §4.1: the turn's task management (buildResponseTools registers
        // the task tools for turns only).
        tasks: this.#taskHost,
        ...(mcpEntries.length > 0
          ? {
              mcp: (isTask
                ? { tools: wrapMcp(identity, mcpEntries), omitted: 0 }
                : {
                    tools: wrapMcp(identity, readOnlyMcp.entries),
                    omitted: readOnlyMcp.omitted,
                  }) satisfies McpToolFacade,
            }
          : {}),
        // D66 宿主 SubAgent：减配子 run + 结果压缩回传（见 agent/subagent.ts），
        // 子 run 挂在本 run 上，本 run 结束时 #closeSubagents。
        subagent: this.#registerSubagents(runId, createSubagentFacade(
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
                  // W5: read-only MCP tools, wrapped with the sub run's identity.
                  ...(readOnlyMcp.entries.length > 0
                    ? { mcp: { tools: wrapMcp(subIdentity, readOnlyMcp.entries) } }
                    : {}),
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
          },
        )),
      };

      // P07 injection: relevant memories come from the trigger text plus the
      // last two context messages (docs/dev/phases/P07-memory.md 任务 3).
      // D80 <schedules>: this bot's active schedules here + declined offers.
      const schedulesSection =
        this.#deps.schedule?.contextSection(batch.botId, batch.conversationId) ?? '';
      // W7 <watches>: this bot's live web-page watches here.
      const watchesSection =
        this.#deps.watch?.contextSection(batch.botId, batch.conversationId) ?? '';
      const memorySections = memoryFacade
        ? {
            userProfile: memoryFacade.profileCardSection(),
            myState: memoryFacade.myStateSection(batch.botId, batch.conversationId),
            ...(schedulesSection.length > 0 ? { schedules: schedulesSection } : {}),
            ...(watchesSection.length > 0 ? { watches: watchesSection } : {}),
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
        : {
            ...(schedulesSection.length > 0 ? { schedules: schedulesSection } : {}),
            ...(watchesSection.length > 0 ? { watches: watchesSection } : {}),
          };
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
          // P05 chains are a turn's (D75 §6.2: a task never @-mentions group
          // members, so chain budgets — counted over active turns — stay whole).
          ...(isTask
            ? {}
            : {
                onMentionBots: (mentionIds: string[], message: Message) =>
                  this.#chains.mention(identity, mentionIds, message),
              }),
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
      // The agent's cwd: the bound project, else the workspace; a D75 task
      // works in its resolved workdir (§3.4 task_workdir).
      const projectPath = project !== null && project.status === 'available' ? project.path : null;
      // A task without a recorded workdir works in the workspace — the root
      // #startTask leased — never in an unleased project (审查 L6).
      const agentWorkdir =
        exec.kind === 'task'
          ? (exec.task.taskWorkdir ?? workspacePath)
          : (projectPath ?? workspacePath);
      const agentRun =
        agentId.length > 0
          ? await this.#agentRunSetup({
              bot,
              conversation: conv,
              agentId,
              identity,
              responseTools,
              workspacePath,
              // The <project> section only when the agent works in it (a
              // workspace-workdir task does not, 审查 L10).
              hasProject: projectPath !== null && agentWorkdir === projectPath,
              memorySections,
              wikiTopics: wikiTopicsSection,
              skills: skillsSection,
              recommendedSkills: recommendedSkillsSection,
              conversationText: `${contextAndContinuation}\n\n${triggerContent}`,
              batch,
              renderOptions,
              triggerContent,
              workdir: agentWorkdir,
              modelRef,
              contextCutoff: Math.max(
                -1,
                ...recent.map((message) => message.seq),
                ...batch.messages.map((message) => message.seq),
              ),
              ...(exec.kind === 'task'
                ? {
                    task: {
                      id: runId,
                      continuesTaskId: exec.brief.continuesTaskId,
                      writes: exec.task.taskWrites === true,
                    },
                  }
                : {}),
            })
          : null;
      // D72 P3（design 28 §6）：project 内有 Agent 自己会读、无法关闭的配置
      // 文件时，首次在此 project 运行前确认（记住到对话）；project 绑定且档位
      // 可写时开工前显式取写入租约、整 run 持有（结算照常 releaseRun）。
      // A D75 task runs there only when its workdir is the project; a write
      // task already holds its (pinned) write lease from #startTask (§5.1).
      if (agentRun !== null && projectPath !== null && agentWorkdir === projectPath) {
        const gate = await this.#agentProjectGate({
          runId,
          identity,
          botId: batch.botId,
          conversationId: batch.conversationId,
          agentId,
          agentName: agentRun.agentName,
          projectPath,
          configFiles: agentRun.agentSideConfigFiles,
          writable: !isTask && agentRun.permission !== 'read_only',
        });
        if (gate !== 'ok') {
          // Cancelled while waiting: cancelRun already settled a turn;
          // a stopped task is settled by its host (this settle is a no-op then).
          if (gate === 'denied') {
            await this.#deps.projects.releaseRun(runId).catch(() => {});
            settle('failed', '用户未确认在此项目中加载智能体自身的配置文件，本次未执行');
          } else if (isTask) {
            settle('cancelled', null);
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
              workdir: agentWorkdir,
              promptParts: agentRun.promptParts,
              external: {
                agentId,
                permission: agentRun.permission,
                capabilities: agentRun.capabilities,
                sessionKey: agentRun.session.sessionKey,
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
                    taskId: isTask ? runId : null,
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
              // External agents only run tasks (D75 §8.1): a refused inject
              // (asynchronous steering) is downgraded to `queued` (§8.2).
              onSteerRejected: (text: string) => {
                if (exec.kind === 'task') exec.control.steerRefused(text);
              },
            }
          : {}),
        buildSystemPrompt: async () =>
          buildSystemPrompt({
            loop: isTask ? 'task' : 'turn',
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
            // Stable whenever the bot has MCP servers (even if this turn's
            // resolution timed out), so the prompt does not flip between turns.
            ...(!isTask && mcpResolution.hasServers
              ? {
                  mcpTurnNote: turnMcpNote(
                    mcpResolution.resolved
                      ? { onSurface: readOnlyMcp.entries.length, omitted: readOnlyMcp.omitted }
                      : null,
                  ),
                }
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
        // §2.1: a turn has no long tool chains (TURN_MAX_TURNS).
        limits: { maxTurns: isTask ? RUN_MAX_TURNS : TURN_MAX_TURNS },
      });

      startedHandle = handle;
      handled = true;
      let unsubscribeSteerConfirm: () => void = () => {};
      if (exec.kind === 'task') {
        // D75: tasks are not mailbox runs — steering a task is inject_task,
        // through the task host (buffered injects are flushed here). A steer
        // the engine really took in confirms its inject entry (审查 L4).
        const control = exec.control;
        unsubscribeSteerConfirm = handle.onEvent((event) => {
          if (event.type !== 'steer') return;
          const shown = control.steerConfirmed(event.payload.text);
          // The agent session saw the inject's source messages: a continuation's
          // delta does not repeat them (P5 审查 #3).
          if (agentRun === null) return;
          for (const id of shown) {
            const message = messages.getById(id);
            if (message !== null) agentRun.session.seen.ids.set(message.id, message.seq);
          }
        });
        control.attach(handle);
      } else {
        // D75: a turn is never steered — batches arriving meanwhile wait in
        // the mailbox for the next turn. The entry serves cancel / teardown,
        // edit notices and the chain budget.
        this.#activeRuns.set(runId, {
          handle,
          conversationId: batch.conversationId,
          botId: batch.botId,
          cutoffSeq: Math.max(
            -1,
            ...recent.map((m) => m.seq),
            ...batch.messages.map((m) => m.seq),
          ),
        });
      }

      // §2.1 TURN_MAX_TURNS: the engine just stops at the limit; a turn whose
      // last allowed model turn still called a tool (other than the
      // terminating skip_reply) ran out of steps.
      let assistantTurns = 0;
      let lastStopReason: string | null = null;
      let skipped = false;
      const unsubscribeStop = handle.onEvent((event) => {
        if (event.type === 'tool_result') {
          if ((event.payload as { toolName?: string }).toolName === 'skip_reply') skipped = true;
          return;
        }
        if (event.type !== 'assistant') return;
        assistantTurns += 1;
        lastStopReason = (event.payload as { stopReason?: string }).stopReason ?? null;
      });
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
        unsubscribeStop();
        unsubscribeSteerConfirm();
        if (exec.kind === 'task') exec.control.detach();
        else this.#activeRuns.delete(runId);
        // D75 §1.2: sub runs die with their parent — before the lease closes
        // and the run settles (a write task's sub run writes only under it).
        await this.#closeSubagents(runId);
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
          ...(scheduleSource !== null ? { scheduleSource } : {}),
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
        settle('failed', outcome.error?.message ?? null, agentSetup);
        this.#maybeEnqueueSummary(batch.conversationId);
        return;
      }

      // §2.1: a turn that ran out of steps is settled failed with a hint (the
      // failure banner offers a retry); the work belongs in a task.
      if (
        !isTask &&
        outcome.status === 'completed' &&
        !outcome.skipReply &&
        !skipped &&
        outcome.finalText.trim().length === 0 &&
        assistantTurns >= TURN_MAX_TURNS &&
        lastStopReason === 'toolUse'
      ) {
        settle(
          'failed',
          `对话轮超过 ${TURN_MAX_TURNS} 步上限仍未给出回复：较长的工作应派成任务（start_task）`,
        );
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
      this.#deps.logger.error({ runId, err: error }, isTask ? 'task run crashed' : 'turn crashed');
      // Thrown after the engine run started (e.g. while wiring it up): stop it
      // before the lease is released and the run settles — no-op once done.
      try {
        startedHandle?.abort('run crashed');
      } catch {
        // The settlement below matters more than a failing abort.
      }
      // No-op when the run got past handle.done (closed there).
      await this.#closeSubagents(runId).catch(() => {});
      await this.#deps.projects.releaseRun(runId).catch(() => {});
      this.#fsState.release(runId);
      settle('failed', error instanceof Error ? error.message : String(error));
    } finally {
      // Early returns before the engine started (no-op once closed).
      await this.#closeSubagents(runId).catch(() => {});
      if (exec.kind === 'task') {
        // Idempotent; covers the early returns. Then the slot / write target frees.
        await this.#deps.projects.releaseRun(runId).catch(() => {});
        this.#fsState.release(runId);
        exec.control.finish();
      } else {
        // Consumption, mailbox, group-turn and D71 bookkeeping belong to turns.
        this.#releaseTurnMailbox(runId, batch, handled);
      }
      this.#publishConversation(batch.conversationId);
    }
  }

  #registerSubagents(runId: string, facade: SubagentToolFacade): SubagentToolFacade {
    this.#subagentFacades.set(runId, facade);
    return facade;
  }

  /** The parent run ended: abort its sub runs still in flight and wait for them (idempotent). */
  async #closeSubagents(runId: string): Promise<void> {
    const facade = this.#subagentFacades.get(runId);
    if (facade === undefined) return;
    this.#subagentFacades.delete(runId);
    await facade.close('parent run ended');
  }

  /**
   * Design 30 §8.4, level 2 (the explicit downgrade for a bot whose only
   * engine is an external agent — no built-in model to run its turns): the
   * turn makes no model call and routes deterministically, i.e. "always one
   * task" as before D75. Task results in the trigger are forwarded verbatim
   * (a failure as a short notice); the other messages go to the bot's
   * in-flight task (inject_task), or start a new task when there is none or
   * the task could not take them — also when that turns out only later (an
   * asynchronous steering refusal, 审查 M5). Each part is labelled for what
   * it is (user message, edit, system event, schedule …). Level 1 (running the turn through the
   * agent's one-shot complete()) is not implemented (DEV-011).
   */
  #routeWithoutModel(runId: string, batch: TriggerBatch, bot: Bot): void {
    const identity: RunIdentity = {
      runId,
      botId: batch.botId,
      conversationId: batch.conversationId,
      loopType: 'turn',
    };
    const notice = (text: string): void => {
      const message = this.#deps.messages.append({
        conversationId: batch.conversationId,
        senderType: 'bot',
        senderBotId: batch.botId,
        kind: 'text',
        text,
        runId,
      });
      this.#recordBotMessage(runId, message);
    };
    for (const entry of batch.messages) {
      if (entry.kind !== 'task_event' || entry.taskId === null) continue;
      const content = entry.content as TaskEventContent;
      if (content.phase === 'result' && content.text.trim().length > 0) {
        try {
          this.#taskHost.forwardResult(identity, entry.taskId);
        } catch (error) {
          // Already forwarded (a re-delivery): nothing to add.
          this.#deps.logger.info(
            { taskId: entry.taskId, error: error instanceof Error ? error.message : String(error) },
            'downgraded turn: result not forwarded',
          );
        }
      } else if (content.phase === 'failure') {
        const title = this.#deps.runs.get(entry.taskId)?.taskTitle ?? entry.taskId;
        const label = content.status === 'interrupted' ? '中断了' : '失败了';
        notice(`任务「${title}」${label}${content.error ? `：${content.error}` : ''}`);
      }
    }
    // The rest goes to a task as it is, each source part under a label that
    // says what it is (a user message, an edit, a system event, a schedule …).
    const options: RenderMessageOptions = { ...this.#renderOptions(), selfBotId: batch.botId };
    const sections: string[] = [];
    // The inject text is shown on the task card's inject line (§4.3): only
    // what the user can see goes into it — the bot's internal affairs (wiki
    // ingest, environment, schedule triggers …, 01-conversation 消息原则)
    // reach the task as source messages instead (审查 L4).
    const visibleSections: string[] = [];
    const incoming: Message[] = [];
    for (const part of triggerParts(batch)) {
      const shared = part.messages.filter(
        (message) => message.kind !== 'task_event' && message.ownerBotId === null,
      );
      if (shared.length === 0) continue;
      incoming.push(...shared);
      const render = (list: Message[]): string =>
        `${downgradeLabel(part)}：\n${list.map((message) => renderMessageLine(message, options)).join('\n')}`;
      sections.push(render(shared));
      const visible = shared.filter((message) => isVisibleToUser(message));
      if (visible.length > 0) visibleSections.push(render(visible));
    }
    if (incoming.length === 0) return;
    const text = sections.join('\n\n');
    const injectText =
      visibleSections.length > 0 ? visibleSections.join('\n\n') : '（Bot 内部事务的通知，见原消息）';
    const sourceMessageIds = incoming.map((message) => message.id);
    const startTask = (): void => {
      const first = incoming
        .filter((message) => message.senderType === 'user')
        .map((message) => messageText(message).trim())
        .find((t) => t !== '');
      this.#taskHost.start(identity, {
        title: first !== undefined ? first.slice(0, 30) : '处理新消息',
        instruction: `这一轮没有对话模型，下面的消息原样交给你，按它们完成这件事：\n${text}`,
        sourceMessageIds,
        writes: bot.profile.runtime.agent.permission !== 'read_only',
      });
    };
    try {
      const inFlight = this.#taskHost
        .list(identity)
        .filter((task) => task.state === 'submitted' || task.state === 'running')
        .at(-1);
      if (inFlight !== undefined) {
        const injected = this.#taskHost.inject(
          identity,
          { taskId: inFlight.taskId, text: injectText, sourceMessageIds },
          {
            // 审查 M5: an inject that never reaches the task's engine run
            // (refused asynchronously, or buffered for a run that never took
            // it) becomes a task of its own — never silently dropped.
            onNotDelivered: () => {
              try {
                startTask();
              } catch (error) {
                notice(
                  `没能把这条消息交给任务：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          },
        );
        if (injected.delivery === 'delivered') return;
      }
      startTask();
    } catch (error) {
      notice(
        `没能把这条消息交给任务：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A turn begins executing (审查 M1 / M3): batches buffered for its mailbox
   * since it was created (it may have queued behind busy provider slots) join
   * its trigger, and every trigger message is re-read — the latest edit, no
   * recalled message. The run row follows. Null = no trigger message is left.
   */
  #absorbIntoTurn(runId: string, batch: TriggerBatch): TriggerBatch | null {
    // Only batches that can share this turn (审查 M1 / M2: a delegated turn
    // absorbs nothing, a delegation is never absorbed, different @ chains
    // stay apart); the rest wait for the next turn.
    const buffered =
      this.#mailboxes.get(batch.botId, batch.conversationId)?.takeBuffered(batch) ?? [];
    const merged = buffered.length > 0 ? mergeTriggerBatches([batch, ...buffered]) : batch;
    // A task result consumed meanwhile (a re-delivery of a result an earlier
    // turn relayed) is not relayed again (审查 M4) — except in the trigger of
    // a retried turn: the user asked to run that very trigger again.
    const retried = new Set(
      batch.retryOf !== undefined ? batch.messages.map((message) => message.id) : [],
    );
    const refreshed = refreshTriggerBatch(merged, (id) => {
      const message = this.#deps.messages.getById(id);
      if (message === null || retried.has(id)) return message;
      return this.#consumedTaskEntry(message) ? null : message;
    });
    if (refreshed === null) return null;
    const before = batch.messages.map((message) => message.id).join(',');
    const after = refreshed.messages.map((message) => message.id).join(',');
    // An absorbed @-chain trigger binds the turn to its chain at its depth
    // (审查 M1): without it the turn's own mentions would open a new chain at
    // depth 1 and bypass BOT_CHAIN_MAX_DEPTH / BOT_CHAIN_TOKEN_BUDGET.
    const stored = this.#deps.runs.get(runId);
    const chainChanged =
      refreshed.chain !== undefined &&
      (stored?.chainId !== refreshed.chain.id ||
        (stored.chainDepth ?? 0) < refreshed.chain.depth);
    if (buffered.length > 0 || before !== after || chainChanged) {
      const run = this.#deps.runs.setTrigger(runId, {
        reason: refreshed.reason,
        messageIds: refreshed.messages.map((message) => message.id),
        parts: storedTriggerParts(refreshed),
        retryOfRunId: refreshed.retryOf ?? null,
        ...(chainChanged && refreshed.chain !== undefined ? { chain: refreshed.chain } : {}),
      });
      this.#deps.publish('run.status', { run });
    }
    this.#holdTaskEntries(runId, refreshed);
    return refreshed;
  }

  /** Records the task entries a begun turn carries (released with its mailbox). */
  #holdTaskEntries(runId: string, batch: TriggerBatch): void {
    const taskIds = new Set<string>();
    for (const message of batch.messages) {
      if (message.kind === 'task_event' && message.taskId !== null) taskIds.add(message.taskId);
    }
    if (taskIds.size > 0) this.#turnTaskHolds.set(runId, taskIds);
    else this.#turnTaskHolds.delete(runId);
  }

  /** A terminal task entry whose task's result was consumed already. */
  #consumedTaskEntry(message: Message): boolean {
    if (message.kind !== 'task_event' || message.taskId === null) return false;
    const phase = (message.content as TaskEventContent).phase;
    if (phase !== 'result' && phase !== 'failure') return false;
    return (this.#deps.runs.get(message.taskId)?.resultConsumedAt ?? null) !== null;
  }

  /**
   * Turn epilogue (#executeRun finally, the turn is terminal): the task
   * results its trigger carried are consumed (§3.2), then the mailbox
   * releases — batches buffered meanwhile start the next turn — and the
   * group-turn / D71 idle hooks run.
   *
   * Consumption (审查 M2) needs a turn that handled its trigger (`handled`:
   * its engine run started, the §8.4 downgrade routed it, or a missing-setup
   * failure whose setup card retries it) AND ended `completed` or `failed`
   * (skip_reply included). A turn cancelled before it started, dropped as
   * inactive / read-only, cancelled by the user or the update gate, or
   * interrupted leaves its results unconsumed: the reconciliation re-delivers
   * them (at-least-once). A crash before this point does the same.
   */
  #releaseTurnMailbox(runId: string, batch: TriggerBatch, handled: boolean): void {
    this.#turnTaskHolds.delete(runId);
    const taskIds = new Set<string>();
    for (const message of batch.messages) {
      if (message.kind === 'task_event' && message.taskId !== null) taskIds.add(message.taskId);
    }
    const status = this.#deps.runs.get(runId)?.status;
    const consume = handled && (status === 'completed' || status === 'failed');
    if (taskIds.size > 0 && consume) {
      try {
        this.#taskHost.markConsumed(taskIds);
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'marking task results consumed failed',
        );
      }
    }
    const mailbox = this.#mailboxes.for(batch.botId, batch.conversationId);
    try {
      mailbox.release();
    } catch (error) {
      // The next turn could not be created (db closing): its batches are lost
      // to this process; task results among them are re-delivered by the
      // reconciliation (unconsumed).
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'starting the next turn failed',
      );
    }
    // A group turn waiting for this mailbox to free up delivers now (BR-P05-002).
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

  /**
   * A task result forwarded verbatim (`origin: 'task'` + taskId) is the
   * source task's own answer: every agent session of that task records it as
   * seen (P5 审查 #3 contract — a `continues_task_id` delta skips it).
   */
  #markForwardedSeen(message: Message): void {
    const content = message.content as { origin?: unknown; taskId?: unknown };
    if (content.origin !== 'task' || typeof content.taskId !== 'string') return;
    try {
      for (const row of this.#agentSessions.listByConversation(message.conversationId)) {
        if (row.taskId !== content.taskId) continue;
        this.#agentSessionSeen.get(row.id)?.ids.set(message.id, message.seq);
      }
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'marking a forwarded result seen failed',
      );
    }
  }

  #agentSessionRowExists(rowId: string): boolean {
    return this.#agentSessions.getById(rowId) !== null;
  }

  /**
   * Upserts the (Bot, conversation, Agent, task) session row once the session
   * exists (P5; D75 §8.5 — `taskId` null for a non-task run).
   */
  #recordAgentSession(input: {
    rowId: string;
    botId: string;
    conversationId: string;
    agentId: string;
    taskId: string | null;
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
      const previous = this.#agentSessions.get(
        input.botId,
        input.conversationId,
        input.agentId,
        input.taskId,
      );
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
        taskId: input.taskId,
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

  /** W2 ledger rows of one run for the digest; [] without a ledger / on error. */
  #effectsFor(runId: string): ToolEffect[] {
    try {
      return this.#deps.effects?.listForRun(runId) ?? [];
    } catch {
      return [];
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
      effects: this.#effectsFor(source.id),
    });
    return segment.length > 0 ? { continuedFromRunIds: [source.id], segment } : null;
  }

  /**
   * W3 `<effects_before_interrupt>` of a task continuing one that did not
   * complete (a 检查后重试, or a `continues_task_id`): the external calls of the
   * source's chain that completed / may have. It goes into the trigger (in
   * front of the brief), so a reused external-agent session — which only gets
   * the conversation delta and the trigger — sees it too. '' = none.
   */
  #effectsBeforeInterrupt(brief: TaskBrief): string {
    if (brief.continuesTaskId === null || this.#deps.effects === undefined) return '';
    try {
      const source = this.#deps.runs.get(brief.continuesTaskId);
      if (source === null || source.status === 'completed') return '';
      return buildEffectsBeforeInterruptSegment(this.#deps.effects.listForTask(source.id));
    } catch {
      return '';
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
    // Group turns advance on any terminal state (cancelled/failed included)
    // of a supervisor turn — never on a task (D75 design 30 §6.2).
    if (isTerminal(status) && run.loopType === 'turn') this.#groupTurns.onRunSettled(run);
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

  /**
   * D75 W3: one context line for a task card (§4.3 — status + title, never
   * the brief or the result: those live in the owner's private entries).
   */
  #renderTaskCard(taskId: string): string {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') return '（任务记录已清理）';
    const owner =
      task.botId !== null ? (this.#deps.bots.get(task.botId)?.name ?? task.botId) : '';
    const state = TASK_CARD_STATE_TEXT[taskState(task.status)];
    const extra =
      task.status === 'queued'
        ? (this.#taskHost.view(taskId)?.queueReason ?? '')
        : task.awaitingInput
          ? '等待用户回答'
          : '';
    // The title is the model's own words (start_task, possibly steered by
    // what it read): data, not a system statement (审查 L1).
    return `[系统] 任务卡 ${task.id}（${owner}）「<untrusted>${neutralizeUntrusted(task.taskTitle ?? '')}</untrusted>」：${state}${extra.length > 0 ? `，${extra}` : ''}`;
  }

  /**
   * Where a task works and what it left behind (TaskHost.describeWorkdir;
   * `withChanges` false = the kind only, no lookup).
   */
  #describeTaskWorkdir(
    task: Run,
    withChanges: boolean,
  ): { kind: 'project' | 'workspace'; changes: TaskChanges | null } {
    const workspace =
      task.botId !== null && task.conversationId !== null
        ? workspacePathFor(this.#deps.paths, task.botId, task.conversationId)
        : null;
    const kind = task.taskWorkdir !== null && task.taskWorkdir !== workspace ? 'project' : 'workspace';
    if (!withChanges) return { kind, changes: null };
    if (kind === 'project') {
      // A checkpoint lookup by run id (the revert state can still change).
      const change = this.#deps.projects.changesOf(task.id);
      if (change === null || change.files.length === 0) return { kind: 'project', changes: null };
      const counts = { added: 0, modified: 0, deleted: 0 };
      for (const file of change.files) counts[file.change] += 1;
      return {
        kind: 'project',
        changes: { kind: 'project', ...counts, reverted: change.revertedAt !== null },
      };
    }
    if (task.taskWrites !== true || workspace === null || task.conversationId === null) {
      return { kind: 'workspace', changes: null };
    }
    // A settled task's file list no longer changes: computed once (审查 L5).
    const cached = this.#workspaceChangesCache.get(task.id);
    if (cached !== undefined) return { kind: 'workspace', changes: cached };
    // No checkpoint in the workspace (§5.2): the files its file tools wrote —
    // through the conversation index (audit_log has none on run_id).
    const rows = this.#deps.db
      .prepare(
        "select detail_json from audit_log where conversation_id = ? and run_id = ? and action = 'fs_write' order by created_at",
      )
      .all(task.conversationId, task.id) as Array<{ detail_json: string }>;
    const files: string[] = [];
    for (const row of rows) {
      let detail: { path?: unknown; op?: unknown };
      try {
        detail = JSON.parse(row.detail_json) as { path?: unknown; op?: unknown };
      } catch {
        continue;
      }
      const target = detail.path;
      // Parent directories the write tool created are not changes of their own.
      if (typeof target !== 'string' || detail.op === 'mkdir') continue;
      const relative = nodePath.relative(workspace, target);
      const shown =
        relative.length > 0 && !relative.startsWith('..') && !nodePath.isAbsolute(relative)
          ? relative
          : target;
      if (!files.includes(shown)) files.push(shown);
    }
    const changes: TaskChanges | null =
      files.length === 0
        ? null
        : {
            kind: 'workspace',
            files: files.slice(0, TASK_CHANGED_FILES_SHOWN),
            more: Math.max(0, files.length - TASK_CHANGED_FILES_SHOWN),
          };
    // Only once the execution is over (an unwinding tool may still write).
    if (!this.#taskHost.isExecuting(task.id)) {
      if (this.#workspaceChangesCache.size >= 256) {
        const oldest = this.#workspaceChangesCache.keys().next().value;
        if (oldest !== undefined) this.#workspaceChangesCache.delete(oldest);
      }
      this.#workspaceChangesCache.set(task.id, changes);
    }
    return { kind: 'workspace', changes };
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

/** Task card states in the bots' context (design 30 §4.3). */
const TASK_CARD_STATE_TEXT: Record<TaskStateView, string> = {
  submitted: '排队中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

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
