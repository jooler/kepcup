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
  SUMMARY_TRIGGER_UNSUMMARIZED,
  TRIAGE_RECENT_MESSAGES,
  type Conversation,
  type GroupSetupStep,
  type Message,
  type Run,
  type SetupRequirement,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import { persistEngineSteps } from '../agent/step-persistence.js';
import {
  humanizeLateBy,
  inQuietHours,
  parseQuietHours,
  quietHoursEndAt,
} from '../schedule/guard.js';
import { buildSystemPrompt } from '../agent/context/system-prompt.js';
import {
  buildConversationContext,
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
import type { AgentEngine, RunHandle } from '../agent/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { Mailbox, MailboxRegistry, type TriggerBatch } from '../scheduler/mailbox.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { GroupsService } from '../domain/groups.js';
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
import { createSubagentFacade, buildSubagentSystemPrompt } from '../agent/subagent.js';
import { buildMcpTools, type McpToolFacade } from '../mcp/tools.js';
import type { McpService } from '../mcp/service.js';
import { FileReadState } from '../tools/fs-state.js';
import type { ToolGateway } from '../gateway/index.js';
import type { AppPaths } from '../infra/paths.js';
import { workspacePathFor } from '../infra/paths.js';
import { ChainsService } from './chains.js';
import { GroupTurnCoordinator } from './group-turn.js';
import { lightModelRefForBot, triageOneBot } from './dispatcher.js';
import type { BotCard } from '@kepcup/shared';
import type { InstalledToolchain } from '../env/manager.js';

export interface OrchestratorEnvironmentFacade {
  /** request_environment backend (docs/dev/phases/P06-environment.md 任务 3). */
  request(
    identity: {
      runId: string;
      botId: string | null;
      conversationId: string | null;
      loopType: 'response';
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
  scheduler: Scheduler;
  db: SqliteDatabase;
  paths: AppPaths;
  gateway: ToolGateway;
  bots: BotsService;
  conversations: ConversationsService;
  /** 群域服务（P05 成员管理 + 19/D60 对话内群创建的 createSetup/finalizeSetup）。 */
  groups: GroupsService;
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

interface ActiveRunEntry {
  handle: RunHandle;
  conversationId: string;
  botId: string;
  /** Highest message seq the model has seen (initial context + steers). */
  cutoffSeq: number;
}

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

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#mailboxes = new MailboxRegistry((key) => this.#createMailbox(key));
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

  cancelRun(runId: string): Run | null {
    const run = this.#deps.runs.get(runId);
    if (!run) return null;
    if (isTerminal(run.status)) return run;
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
    const runs = this.#deps.runs.markAllActiveInterrupted();
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
    return runs.length;
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
    this.#appendBotTextMessage(botId, conversationId, SETUP_GREETING);
    this.#appendSystemMessage(conversationId, SETUP_QUESTION_EVENT, SETUP_FIRST_QUESTION, {
      options: [...SETUP_FIRST_OPTIONS],
    });
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
  async #accessPromptInfo(identity: {
    runId: string;
    botId: string | null;
    conversationId: string | null;
    loopType: 'response';
  }) {
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
    const run = this.#deps.runs.create({
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
      priority:
        batch.reason === 'chain' || batch.reason === 'scheduled' || batch.reason === 'event'
          ? 1
          : 0,
      provider: this.#providerForRef(this.#modelRefForBot(batch.botId)),
      key: this.#mailboxKey(batch.botId, batch.conversationId),
      run: () => this.#executeResponseRun(run.id, batch),
    });
    return run.id;
  }

  #mailboxKey(botId: string, conversationId: string): string {
    return `${botId}:${conversationId}`;
  }

  #modelRefForBot(botId: string): string {
    try {
      const bot = this.#deps.bots.get(botId);
      const settings = this.#deps.settings.get();
      return bot?.profile.runtime.model || settings.defaultMainModel;
    } catch {
      return '';
    }
  }

  #providerForRef(modelRef: string): string {
    const index = modelRef.indexOf('/');
    return index > 0 ? modelRef.slice(0, index) : 'unknown';
  }

  async #executeResponseRun(runId: string, batch: TriggerBatch): Promise<void> {
    const { runs, messages } = this.#deps;
    // 本 run 命中的设置前置需求（inline setup，docs/design/18-inline-setup.md）：
    // media facade 在能力缺失时记下 requirement，工具结果以 SETUP_REQUIRED
    // 返回，abort 监听器随即中断 run——settle 时改判 failed 并携带 setup。
    const setupHit: { requirement: SetupRequirement | null } = { requirement: null };
    try {
      if (this.#cancelledBeforeStart.delete(runId)) {
        this.#settleRun(runId, 'cancelled', null);
        return;
      }

      const bot = this.#deps.bots.get(batch.botId);
      const conv = this.#deps.conversations.get(batch.conversationId);
      if (!bot || !conv || bot.status !== 'active' || conv.readOnly) {
        this.#settleRun(runId, 'cancelled', null);
        return;
      }

      const modelRef = this.#modelRefForBot(batch.botId);
      if (modelRef.length === 0) {
        this.#settleRun(
          runId,
          'failed',
          '未配置模型：请在设置页选择默认主模型或在 Bot 配置中指定',
          {
            kind: 'main-model',
          },
        );
        return;
      }

      runs.update(runId, {
        status: 'running',
        provider: this.#providerForRef(modelRef),
        model: modelRef,
      });
      this.#deps.publish('run.status', { run: runs.getOrThrow(runId) });

      // Conversation context: rolling summary + recent window (batch excluded;
      // it arrives separately through the trigger segment).
      const recent = messages.list(batch.conversationId, { limit: 120 });
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
      const triggerSegment = buildTriggerSegment({
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
        continuation = await this.#resolveContinuation({
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
      if (continuation !== null) {
        this.#deps.runs.update(runId, { continuedFromRunIds: continuation.continuedFromRunIds });
      }
      const contextAndContinuation = [contextSegment, continuation?.segment]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n\n');

      const workspacePath = workspacePathFor(this.#deps.paths, batch.botId, batch.conversationId);
      this.#deps.gateway.ensureWorkspace({
        runId,
        botId: batch.botId,
        conversationId: batch.conversationId,
        loopType: 'response',
      });
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
      // D66 宿主 SubAgent：减配子 run + 结果压缩回传（见 agent/subagent.ts）。
      const identity = {
        runId,
        botId: batch.botId,
        conversationId: batch.conversationId,
        loopType: 'response' as const,
      };
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
            lightModelRef: lightModelRefForBot(this.#deps.bots, this.#deps.settings, batch.botId),
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
      const handle = this.#deps.engine.startRun({
        identity,
        model: modelRef,
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
        tools: buildResponseTools({
          identity,
          deps: {
            ...toolDeps,
            environment: this.#environmentFacade(),
            onMentionBots: (mentionIds, message) =>
              this.#chains.mention(identity, mentionIds, message),
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
                        if (asked > SETUP_MAX_QUESTIONS) return questionCapReached();
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
                              ? `问题已发出（第 ${asked}/${SETUP_MAX_QUESTIONS} 问，已达上限）。这是最后一个问题：收到回答后请用 save_profile 保存全部信息并调用 finish_setup 结束访谈，不要再提问。`
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
        }),
        limits: { maxTurns: RUN_MAX_TURNS },
      });

      this.#activeRuns.set(runId, {
        handle,
        conversationId: batch.conversationId,
        botId: batch.botId,
        cutoffSeq: Math.max(-1, ...batch.messages.map((m) => m.seq)),
      });

      // Deliver batches that arrived while the run was registering.
      const buffered = this.#pendingSteers.get(mailboxKey);
      if (buffered) {
        this.#pendingSteers.delete(mailboxKey);
        for (const batch of buffered) handle.steer(this.#renderBatchText(batch));
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
      );
      let outcome;
      try {
        outcome = await handle.done;
      } finally {
        unsubscribe();
        unsubscribeSetup();
        unsubscribeInterim();
        this.#activeRuns.delete(runId);
      }

      if (outcome.status === 'completed' && outcome.finalText.trim().length > 0) {
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
          loopType: 'response',
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
        this.#settleRun(
          runId,
          'failed',
          setupRequirementErrorText(setupHit.requirement),
          setupHit.requirement,
        );
        this.#maybeEnqueueSummary(batch.conversationId);
        return;
      }

      this.#settleRun(runId, outcome.status, outcome.error?.message ?? null);
      // P07: a completed response registers its reflection job (dedupe
      // run:{runId}). Background work — failures never touch this run.
      if (outcome.status === 'completed') {
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
        'response run crashed',
      );
      await this.#deps.projects.releaseRun(runId).catch(() => {});
      this.#fsState.release(runId);
      this.#settleRun(runId, 'failed', error instanceof Error ? error.message : String(error));
    } finally {
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
      // A turn waiting for this mailbox to free up delivers now (BR-P05-002).
      this.#groupTurns.onMailboxIdle(batch.botId, batch.conversationId);
      this.#publishConversation(batch.conversationId);
    }
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
    const modelRef = lightModelRefForBot(this.#deps.bots, this.#deps.settings, botId);
    if (modelRef.length === 0) return null;
    const provider = modelRef.includes('/') ? modelRef.slice(0, modelRef.indexOf('/')) : 'unknown';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTINUATION_ARBITER_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const result = await completeStructured({
        complete: (req) => this.#deps.engine.complete(req),
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
      capability: 'image' | 'tts' | 'video',
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
      synthesizeSpeech: (input) => setupGuard('tts', () => media.synthesizeSpeech(input)),
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
      if (entry.handle.steer(text)) return runId; // the engine's steer event persists the step
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
  }
}

/** Plain text of a message (memory retrieval query input). */
function messageText(message: Message): string {
  const content = message.content as { text?: string } | undefined;
  return typeof content?.text === 'string' ? content.text : '';
}
