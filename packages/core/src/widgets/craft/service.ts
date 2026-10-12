import {
  WIDGET_ACCEPTANCE_ITEMS_MAX,
  WIDGET_CRAFTS_PER_RUN_MAX,
  WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX,
  WIDGET_CRAFT_ACCEPTANCE_HINT_MAX_CHARS,
  WIDGET_CRAFT_BRIEF_MAX_CHARS,
  WIDGET_CRAFT_DRAFT_TTL_DAYS,
  WIDGET_CRAFT_FIX_ROUNDS_MAX,
  WIDGET_CRAFT_REVIEW_ROUNDS_MAX,
  WIDGET_KNOWN_ISSUES_MAX,
  WIDGET_CRAFT_PHASE_MAX_TURNS,
  WIDGET_CRAFT_RESULT_MAX_CHARS,
  WIDGET_CRAFT_TIMEOUT_MS,
  WIDGET_CRAFT_TOKEN_BUDGET,
  WIDGET_CRAFT_TOKEN_POLL_MS,
  WIDGET_CHECK_TIMEOUT_MS,
  BOT_WIDGET_TITLE_MAX_CHARS,
  newId,
  widgetAcceptanceSchema,
  type Bot,
  type Run,
  type Settings,
  type WidgetAcceptance,
  type WidgetCheckIssue,
  type WidgetCheckReport,
  type WidgetCraftManifest,
  type WidgetCraftReceipt,
  type WidgetQueryDef,
  type WidgetReviewFinding,
  type WidgetReviewResult,
  type WidgetScope,
} from '@kepcup/shared';
import type {
  AgentEngine,
  EngineUsage,
  RunHandle,
  RunIdentity,
  RunOutcome,
  ToolResult,
} from '../../agent/types.js';
import {
  backgroundRunSpec,
  engineKeyOf,
  providerOfModelRef,
  routeFor,
  routeStillCurrent,
  type LlmRoute,
  type LlmRouter,
} from '../../agent/llm-router.js';
import { persistEngineSteps } from '../../agent/step-persistence.js';
import type { RunsService } from '../../domain/runs.js';
import type { SecretsService } from '../../domain/secrets.js';
import type { UsageService } from '../../domain/usage.js';
import type { Clock } from '../../infra/clock.js';
import type { AppPaths } from '../../infra/paths.js';
import {
  formatCheckReport,
  issueSignature,
  knownIssuesForUser,
  WIDGET_CHECKER_INTERNAL_ERROR_PREFIX,
  runWidgetCheck,
  widgetCheckRule,
  type WidgetPreviewRunner,
} from '../check/index.js';
import type { WidgetDeliveryCheck, WidgetWriteResult } from '../service.js';
import {
  DRAFT_ACCEPTANCE,
  DRAFT_HTML,
  DRAFT_QUERIES,
  DRAFT_SPEC,
  WidgetDraft,
  sweepExpiredDrafts,
} from './draft.js';
import {
  buildStageInput,
  craftSystemPrompt,
  fixStageInput,
  reviewStageInput,
  reviewSystemPrompt,
  specStageInput,
  type CraftStage,
  type CraftStageContext,
} from './prompts.js';
import { buildCraftTools } from './tools.js';

/**
 * Bot 组件制作 loop（D87，设计 32 §11）：`widget_craft` 的宿主状态机。
 *
 * SPEC → BUILD → GATE ⇄ FIX → DELIVER（P3c 在 GATE 合格后插入 REVIEW）。每个阶段一个 pi run
 * （`loop_type='widget_authoring'`，`parent_run_id` = 发起的任务 run，步骤落 run_steps、用量
 * 入账，不产生对话消息——同 subagent 的落库方式）；阶段之间以草稿目录文件为记忆，宿主从文件
 * 重建每个阶段的输入。GATE 永远由宿主执行（模型的 widget_check 只是自查）。
 *
 * 流程由宿主保证：阶段顺序、修复轮数、最佳快照回滚、收缩模式、时限与 token 预算、交付门槛
 * 都在这里，不靠模型遵守提示词。交付凭回执：DELIVER 复算草稿文件摘要，必须与一次非阻断的
 * GATE 回执一致才调 `WidgetService.create/update`。
 *
 * 发起任务只拿到 ≤ WIDGET_CRAFT_RESULT_MAX_CHARS 字的回执——HTML、diff、检查报告都不进任务
 * 上下文（§11.1 的上下文隔离）。
 */

export interface WidgetCraftParams {
  brief?: string;
  widget_id?: string;
  title?: string;
  scope?: WidgetScope;
  acceptance?: string[];
  resume_craft_id?: string;
}

/** The slice of WidgetService the craft loop delivers through. */
export interface WidgetCraftTarget {
  create(input: {
    botId: string;
    conversationId: string;
    title: string;
    description: string;
    html: string;
    queries?: WidgetQueryDef[];
    scope: WidgetScope;
    runId: string;
    check?: WidgetDeliveryCheck;
  }): WidgetWriteResult;
  update(input: {
    botId: string;
    widgetId: string;
    html: string;
    queries?: WidgetQueryDef[];
    conversationId?: string | null;
    changeNote: string;
    runId: string;
    check?: WidgetDeliveryCheck;
  }): WidgetWriteResult;
  validateQueries(defs: WidgetQueryDef[]): string | null;
  craftSource(
    botId: string,
    widgetId: string,
  ):
    | {
        ok: true;
        title: string;
        description: string;
        scope: WidgetScope;
        version: number;
        html: string;
        queries: WidgetQueryDef[];
      }
    | { ok: false; message: string; code: 'NOT_FOUND' | 'FORBIDDEN' };
}

export interface WidgetCraftDeps {
  engine: AgentEngine;
  router?: LlmRouter | undefined;
  settings: { get(): Settings };
  bots: { get(id: string): Bot | null };
  runs: RunsService;
  usage: UsageService;
  secrets: SecretsService;
  widgets: WidgetCraftTarget;
  paths: AppPaths;
  logger: {
    info(fields: Record<string, unknown>, msg: string): void;
    warn(fields: Record<string, unknown>, msg: string): void;
  };
  clock: Clock;
  /** run.status fan-out：界面看到阶段 run 出现与结束。 */
  publishRunStatus: (run: Run) => void;
  /**
   * 某个内置模型 ref 眼下能不能用（厂商在、有 key、模型登记了）。审查模型解析出来却不可用（换了
   * 厂商 / 删了 key）时退回制作的路由，而不是让每次审查都失败成 skipped。缺省不检查。
   */
  modelUsable?: (modelRef: string) => boolean;
  /**
   * S2 预览（主进程预览宿主的适配，`widgets/preview.ts`）；缺省 / 返回 null / 宿主未绑定 =
   * S2 skipped → 交付为 unverified。`screenshots` 只在模型自查时要（截图交给支持图片的模型，
   * 不落库）。
   */
  preview?: (options: {
    screenshots: boolean;
  }) =>
    (WidgetPreviewRunner & { screenshots?(): Array<{ mimeType: string; base64: string }> }) | null;
  /** 测试注入（真实默认值为 WIDGET_CRAFT_* 常量）。 */
  timeoutMs?: number;
  tokenBudget?: number;
  /** 单次检查的兜底时限（缺省 WIDGET_CHECK_TIMEOUT_MS + 余量）。 */
  checkTimeoutMs?: number;
  tokenPollMs?: number;
}

type StopReason = 'cancelled' | 'timeout' | 'budget' | 'stage_failed';

/** 一次 `widget_craft` 调用的运行时状态（不落盘的部分；落盘的在 manifest）。 */
interface CraftSession {
  draft: WidgetDraft;
  identity: RunIdentity & { botId: string; conversationId: string };
  route: LlmRoute;
  controller: AbortController;
  stop: StopReason | null;
  stageError: string | null;
  /** 本次调用已花掉的 token（已结束的阶段 run）；在跑的阶段另加 handle.tokensSoFar()。 */
  tokens: number;
  handle: RunHandle | null;
  progress: (text: string) => void;
  resumeNote: string | null;
  /** 已为「只剩警告」花过一轮修复（警告最多修一次，设计 32 §6 风险表）。 */
  warningFixDone: boolean;
  fixRoundsMax: number;
  reviewRoundsMax: number;
  /** 审查用的路由（设置「组件审查模型」；没有就用制作的路由）。 */
  reviewRoute: LlmRoute;
  /** 审查过的文件摘要 → 这份文件上审查提出、没修掉的 P0 / P1（交付时作为已知问题）。 */
  reviewFindings: Map<string, WidgetReviewFinding[]>;
  /** 有审查轮次没交结论（不阻断交付，回执如实注明）。 */
  reviewSkipped: boolean;
  /** 上一轮审查的 P0 / P1（第二轮审查只核对它们 + 新 P0）。 */
  lastReview: WidgetReviewFinding[];
}

/** core 兜底时限比给宿主的预算多出的余量（宿主按预算收尾、回传结果要一点时间）。 */
const WIDGET_CHECK_GRACE_MS = 5_000;

const STOP_TEXT: Readonly<Record<StopReason, string>> = {
  cancelled: '制作被取消',
  timeout: '制作超过时限',
  budget: '制作用尽了 token 预算',
  stage_failed: '模型调用失败',
};

export class WidgetCraftService {
  readonly #deps: WidgetCraftDeps;
  /** 每个任务 run 已发起的制作次数。 */
  readonly #craftsByRun = new Map<string, number>();
  /** 正在进行的制作（craftId → session），防同一草稿被并发续做。 */
  readonly #active = new Map<string, CraftSession>();
  /** 阶段 run → craftId（runs.cancel 取消某个阶段 run = 取消整次制作）。 */
  readonly #stageRuns = new Map<string, string>();

  constructor(deps: WidgetCraftDeps) {
    this.#deps = deps;
  }

  /** 审查路由：解析不到、或解析到的内置模型眼下不可用时，退回制作的路由（并记日志）。 */
  #reviewRoute(botId: string, fallback: LlmRoute): LlmRoute {
    const route = routeFor(this.#deps, 'widget_review', botId);
    if (route === null) return fallback;
    if (
      route.agentId === null &&
      route.modelRef !== fallback.modelRef &&
      this.#deps.modelUsable !== undefined &&
      !this.#deps.modelUsable(route.modelRef)
    ) {
      this.#deps.logger.warn(
        { botId, reviewModel: route.modelRef },
        'widget review model unavailable; reviewing with the authoring model',
      );
      return fallback;
    }
    return route;
  }

  /** core 启动：清掉全部 Bot 的过期草稿。 */
  sweepDrafts(): number {
    return sweepExpiredDrafts({ paths: this.#deps.paths, now: this.#deps.clock.now() });
  }

  /**
   * runs.cancel 落到某个阶段 run：中止整次制作（草稿保留，可续做）。false = 不是进行中的
   * 制作阶段 run。
   */
  cancelStageRun(runId: string, reason = 'user cancelled'): boolean {
    const craftId = this.#stageRuns.get(runId);
    const session = craftId !== undefined ? this.#active.get(craftId) : undefined;
    if (session === undefined) return false;
    session.stop ??= 'cancelled';
    session.controller.abort(reason);
    return true;
  }

  /** `widget_craft` 的执行体（前台阻塞；进度经 ctx.progress 报到任务卡）。 */
  async craft(input: {
    identity: RunIdentity;
    params: WidgetCraftParams;
    signal: AbortSignal;
    progress: (text: string) => void;
    /**
     * 只给基准评测用的轮数上限（§5.4 的「一次写成」基线 = 0 修复 / 0 审查）；工具路径从不传。
     */
    limits?: { fixRounds?: number; reviewRounds?: number };
  }): Promise<ToolResult> {
    const { identity, params } = input;
    const botId = identity.botId;
    const conversationId = identity.conversationId;
    if (botId === null || conversationId === null) {
      return invalid('组件必须发给一个对话（当前没有对话上下文）');
    }
    const brief = String(params.brief ?? '').trim();
    if (brief === '') {
      return invalid('需要 brief：目标、主要交互、数据来源与是否保存、风格（尽量引用用户原话）');
    }
    if (brief.length > WIDGET_CRAFT_BRIEF_MAX_CHARS) {
      return invalid(`brief 过长（最多 ${WIDGET_CRAFT_BRIEF_MAX_CHARS} 字），只写组件需要的信息`);
    }
    const hints = (Array.isArray(params.acceptance) ? params.acceptance : [])
      .map((hint) => String(hint ?? '').trim())
      .filter((hint) => hint !== '');
    if (hints.length > WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX) {
      return invalid(`acceptance 最多 ${WIDGET_CRAFT_ACCEPTANCE_HINTS_MAX} 条`);
    }
    if (hints.some((hint) => hint.length > WIDGET_CRAFT_ACCEPTANCE_HINT_MAX_CHARS)) {
      return invalid(`每条 acceptance 最多 ${WIDGET_CRAFT_ACCEPTANCE_HINT_MAX_CHARS} 字`);
    }
    const crafts = this.#craftsByRun.get(identity.runId) ?? 0;
    if (crafts >= WIDGET_CRAFTS_PER_RUN_MAX) {
      return {
        ok: false,
        content: `一次执行里最多制作 ${WIDGET_CRAFTS_PER_RUN_MAX} 次组件；请把结果告诉用户，需要时下次再继续`,
        errorCode: 'WIDGET_CRAFT_FAILED',
      };
    }
    const route = routeFor(this.#deps, 'widget_authoring', botId);
    if (route === null) {
      return {
        ok: false,
        content:
          '组件未制作：没有可用于制作组件的模型（未配置内置模型，后台任务也没有可用的智能体）。请如实告诉用户，可在设置里配置模型后再试。',
        errorCode: 'WIDGET_CRAFT_UNAVAILABLE',
      };
    }

    const now = this.#deps.clock.now();
    sweepExpiredDrafts({
      paths: this.#deps.paths,
      now,
      botId,
      skip: new Set(this.#active.keys()),
    });

    const opened = this.#openDraft({
      botId,
      conversationId,
      runId: identity.runId,
      params,
      brief,
      hints,
      now,
    });
    if ('error' in opened) return opened.error;
    const { draft, resumeNote } = opened;
    const manifest = draft.readManifest();
    if (this.#craftsByRun.size > 1000) this.#craftsByRun.clear();
    this.#craftsByRun.set(identity.runId, crafts + 1);

    const session: CraftSession = {
      draft,
      identity: { ...identity, botId, conversationId },
      route,
      controller: new AbortController(),
      stop: null,
      stageError: null,
      tokens: 0,
      handle: null,
      progress: (text) => {
        try {
          input.progress(text);
        } catch {
          // 进度只是展示，不影响制作。
        }
      },
      resumeNote,
      warningFixDone: false,
      fixRoundsMax: input.limits?.fixRounds ?? WIDGET_CRAFT_FIX_ROUNDS_MAX,
      reviewRoundsMax: input.limits?.reviewRounds ?? WIDGET_CRAFT_REVIEW_ROUNDS_MAX,
      reviewRoute: this.#reviewRoute(botId, route),
      reviewFindings: new Map(),
      reviewSkipped: false,
      lastReview: [],
    };
    this.#active.set(manifest.craftId, session);

    const onParentAbort = () => {
      session.stop ??= 'cancelled';
      session.controller.abort('parent run aborted');
    };
    if (input.signal.aborted) onParentAbort();
    else input.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      session.stop ??= 'timeout';
      session.controller.abort('widget craft timeout');
    }, this.#deps.timeoutMs ?? WIDGET_CRAFT_TIMEOUT_MS);
    timer.unref?.();
    const budget = this.#deps.tokenBudget ?? WIDGET_CRAFT_TOKEN_BUDGET;
    const poll = setInterval(() => {
      if (session.tokens + (session.handle?.tokensSoFar() ?? 0) > budget) {
        session.stop ??= 'budget';
        session.controller.abort('widget craft token budget exceeded');
      }
    }, this.#deps.tokenPollMs ?? WIDGET_CRAFT_TOKEN_POLL_MS);
    poll.unref?.();

    try {
      await this.#runPhases(session);
      return await this.#finish(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.logger.warn({ craftId: manifest.craftId, error: message }, 'widget craft crashed');
      this.#settleManifest(session, 'failed', [`制作过程出错：${message}`]);
      return this.#failure(session, [`制作过程出错：${clip(message, 200)}`]);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      input.signal.removeEventListener('abort', onParentAbort);
      this.#active.delete(manifest.craftId);
      for (const [runId, craftId] of this.#stageRuns) {
        if (craftId === manifest.craftId) this.#stageRuns.delete(runId);
      }
    }
  }

  // --- 草稿 -----------------------------------------------------------------------

  #openDraft(input: {
    botId: string;
    conversationId: string;
    runId: string;
    params: WidgetCraftParams;
    brief: string;
    hints: string[];
    now: number;
  }): { draft: WidgetDraft; resumeNote: string | null } | { error: ToolResult } {
    const { params, botId } = input;
    const resumeId = params.resume_craft_id?.trim() ?? '';
    if (resumeId !== '') {
      const draft = WidgetDraft.open(this.#deps.paths, botId, resumeId);
      if (draft === null) {
        return {
          error: invalid(
            `找不到可续做的制作（craftId: ${resumeId}）：草稿可能已交付或已过期（保留 ${WIDGET_CRAFT_DRAFT_TTL_DAYS} 天）。请不带 resume_craft_id 重新制作`,
            'NOT_FOUND',
          ),
        };
      }
      if (this.#active.has(resumeId)) {
        return { error: invalid('这次制作正在进行中，不能同时续做', 'WIDGET_CRAFT_FAILED') };
      }
      const previous = draft.readManifest();
      const resumeNote = input.brief !== previous.brief ? input.brief : null;
      draft.updateManifest((m) => ({
        ...m,
        parentRunId: input.runId,
        conversationId: input.conversationId,
        status: 'running',
        failure: [],
        rounds: { ...m.rounds, fix: 0, review: 0 },
        // 已有源码就从检查开始（续做不重写规格）；还没有源码就回到编写（规格没写完的从规格开始）。
        phase:
          (draft.read(DRAFT_HTML) ?? '').trim() !== ''
            ? 'gate'
            : m.phase === 'spec'
              ? 'spec'
              : 'build',
        updatedAt: input.now,
      }));
      return { draft, resumeNote };
    }

    const widgetId = params.widget_id?.trim() ?? '';
    let title = (params.title ?? '').trim();
    let scope: WidgetScope = params.scope === 'bot' ? 'bot' : 'conversation';
    let baseVersion: number | null = null;
    let source: { html: string; queries: WidgetQueryDef[] } | null = null;
    if (widgetId !== '') {
      const found = this.#deps.widgets.craftSource(botId, widgetId);
      if (!found.ok) return { error: invalid(found.message, found.code) };
      title = found.title;
      scope = found.scope;
      baseVersion = found.version;
      source = { html: found.html, queries: found.queries };
    } else {
      if (title === '')
        return { error: invalid('新建组件需要 title（简短的组件名，如「费用分摊计算器」）') };
      if (title.length > BOT_WIDGET_TITLE_MAX_CHARS) {
        return { error: invalid(`title 过长（最多 ${BOT_WIDGET_TITLE_MAX_CHARS} 字）`) };
      }
    }
    const manifest: WidgetCraftManifest = {
      craftId: newId('wcf'),
      botId,
      conversationId: input.conversationId,
      parentRunId: input.runId,
      widgetId: widgetId !== '' ? widgetId : null,
      baseVersion,
      title,
      scope,
      brief: input.brief,
      acceptanceHints: input.hints,
      phase: 'spec',
      rounds: { gate: 0, fix: 0, review: 0 },
      best: null,
      receipts: [],
      status: 'running',
      failure: [],
      stageRunIds: [],
      tokensUsed: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const draft = WidgetDraft.create(this.#deps.paths, manifest);
    if (source !== null) {
      draft.write(DRAFT_HTML, source.html);
      if (source.queries.length > 0) {
        draft.write(DRAFT_QUERIES, `${JSON.stringify(source.queries, null, 2)}\n`);
      }
    }
    return { draft, resumeNote: null };
  }

  #stageContext(session: CraftSession): CraftStageContext {
    const manifest = session.draft.readManifest();
    return {
      draftDir: session.draft.dir,
      brief: manifest.brief,
      title: manifest.title,
      acceptanceHints: manifest.acceptanceHints,
      modifying: manifest.widgetId !== null,
      resumeNote: session.resumeNote,
      spec: session.draft.read(DRAFT_SPEC),
      acceptance: session.draft.read(DRAFT_ACCEPTANCE),
    };
  }

  #setPhase(session: CraftSession, phase: WidgetCraftManifest['phase']): void {
    session.draft.updateManifest((m) => ({ ...m, phase, updatedAt: this.#deps.clock.now() }));
  }

  // --- 状态机 ---------------------------------------------------------------------

  async #runPhases(session: CraftSession): Promise<void> {
    const { draft } = session;
    let manifest = draft.readManifest();

    if (manifest.phase === 'spec') {
      session.progress('组件制作：正在整理规格');
      await this.#stage(
        session,
        'spec',
        specStageInput({ ...this.#stageContext(session), outline: this.#outline(session) }),
      );
      if (session.stop !== null) return;
      const invalidAcceptance = acceptanceError(draft.read(DRAFT_ACCEPTANCE));
      if (invalidAcceptance !== null) {
        // 验收点不合格：SPEC 收到报错重写一次；仍不合格就只跑乱点冒烟（检查器记 warning）。
        await this.#stage(
          session,
          'spec',
          specStageInput({
            ...this.#stageContext(session),
            outline: null,
            retryError: invalidAcceptance,
          }),
        );
        if (session.stop !== null) return;
      }
      this.#setPhase(session, 'build');
      manifest = draft.readManifest();
    }

    if (manifest.phase === 'build') {
      session.progress('组件制作：规格已定，正在编写');
      await this.#stage(session, 'build', buildStageInput(this.#stageContext(session)));
      if (session.stop !== null) return;
      this.#setPhase(session, 'gate');
    }

    let previousErrors: Set<string> | null = null;
    for (;;) {
      if (session.stop !== null) return;
      this.#setPhase(session, 'gate');
      const { report, round } = await this.#gate(session);
      const errorIssues = report.issues.filter((issue) => issue.level === 'error');
      const failedAcceptance = report.acceptance.filter((item) => !item.passed);
      const warnings = report.issues.filter((issue) => issue.level === 'warning');
      session.progress(`组件制作：第 ${round} 轮检查——${gateSummary(report)}`);
      // 检查器自身出错：修复改变不了它，直接按最佳快照收尾（不会交付这一轮）。
      if (report.issues.some((issue) => issue.rule === CHECKER_FAILED_RULE)) return;

      const hasErrors = errorIssues.length > 0 || failedAcceptance.length > 0;
      // 只为警告修了一轮反而修出了错误：不再继续，按最佳快照（那个只剩警告的版本）收尾。
      if (hasErrors && session.warningFixDone) return;
      const fixRounds = draft.readManifest().rounds.fix;
      // 合格：没有错误（含验收失败）；只剩警告时最多花一轮修复。合格之后才审查（设计 32 §11.10）。
      if (!hasErrors && (warnings.length === 0 || session.warningFixDone)) {
        const review = await this.#review(session, report);
        if (review === null || session.stop !== null) return;
        if (fixRounds >= session.fixRoundsMax) return;
        // 审查的 P0 / P1 进 FIX（P2 只记录）；修完回到 GATE 全量回归。
        const fixRound = fixRounds + 1;
        draft.updateManifest((m) => ({
          ...m,
          phase: 'fix',
          rounds: { ...m.rounds, fix: fixRound },
          updatedAt: this.#deps.clock.now(),
        }));
        session.progress(`组件制作：第 ${fixRound} 轮修复（审查意见）`);
        await this.#stage(
          session,
          'fix',
          fixStageInput({
            ...this.#stageContext(session),
            round: fixRound,
            report: formatReviewFindings(review),
            rolledBack: null,
            shrink: false,
            source: 'review',
          }),
        );
        continue;
      }
      if (fixRounds >= session.fixRoundsMax) return;
      if (!hasErrors) session.warningFixDone = true;

      // 回归：本轮比之前最好的版本更差 → 先回滚，FIX 的输入写明新增的问题。「最好」与交付同口径
      // （可交付的优先）：不会从一个可交付的版本退回到一个阻断的版本。
      const receipts = draft.readManifest().receipts;
      const current = receipts.find((r) => r.round === round);
      const penalty = reviewPenalty(session.reviewFindings);
      const best = bestReceipt(
        receipts.filter((r) => r.round !== round),
        penalty,
      );
      let fixReport = report;
      let rolledBack: string | null = null;
      let reviewNote: string | null = null;
      if (
        best !== null &&
        current !== undefined &&
        (best.verdict !== 'blocked' || current.verdict === 'blocked') &&
        report.score + penalty(current) > best.score + penalty(best)
      ) {
        const bestReport = draft.readReport(best.round);
        if (bestReport !== null) {
          draft.restore(best.round);
          const known = new Set(bestReport.issues.map(issueSignature));
          const added = report.issues.filter((issue) => !known.has(issueSignature(issue)));
          rolledBack =
            added.length > 0 ? added.slice(0, 8).map(describeIssue).join('\n') : '（分数变差）';
          fixReport = bestReport;
          // 回滚到的版本审查过、还有没修的 P0 / P1：这一轮 FIX 仍要修它们（不能只剩一份空报告）。
          const pending = session.reviewFindings.get(`${best.htmlSha256}:${best.queriesSha256}`);
          if (pending !== undefined && pending.length > 0)
            reviewNote = formatReviewFindings(pending);
        }
      }
      // 防震荡：同一组错误签名连续两次 GATE 都出现 → 收缩模式。
      const errorSignatures = new Set(errorIssues.map(issueSignature));
      const shrink =
        previousErrors !== null &&
        errorSignatures.size > 0 &&
        errorSignatures.size === previousErrors.size &&
        [...errorSignatures].every((sig) => previousErrors!.has(sig));
      previousErrors = errorSignatures;

      const fixRound = fixRounds + 1;
      draft.updateManifest((m) => ({
        ...m,
        phase: 'fix',
        rounds: { ...m.rounds, fix: fixRound },
        updatedAt: this.#deps.clock.now(),
      }));
      session.progress(`组件制作：第 ${fixRound} 轮修复`);
      // 警告不进修复清单，除非已经没有错误（设计 32 §6 风险表）。
      const listed = hasErrors
        ? { ...fixReport, issues: fixReport.issues.filter((issue) => issue.level === 'error') }
        : fixReport;
      await this.#stage(
        session,
        'fix',
        fixStageInput({
          ...this.#stageContext(session),
          round: fixRound,
          report:
            reviewNote !== null
              ? `${formatCheckReport(listed)}\n\n${reviewNote}`
              : formatCheckReport(listed),
          rolledBack,
          shrink,
        }),
      );
    }
  }

  /**
   * REVIEW（设计 32 §11.10）：全新上下文的只读 run，结论经 submit_review 提交。同一份文件只审一次；
   * 至多 WIDGET_CRAFT_REVIEW_ROUNDS_MAX 轮。返回要修的 P0 / P1，null = 不用再修（通过 / 跳过 /
   * 轮数用尽——用尽时没修掉的留作这份文件的已知问题）。
   */
  async #review(
    session: CraftSession,
    report: WidgetCheckReport,
  ): Promise<WidgetReviewFinding[] | null> {
    const { draft } = session;
    const digestKey = `${report.htmlSha256}:${report.queriesSha256}`;
    if (session.reviewFindings.has(digestKey)) return null;
    const round = draft.readManifest().rounds.review + 1;
    if (round > session.reviewRoundsMax) return null;
    draft.updateManifest((m) => ({
      ...m,
      phase: 'review',
      rounds: { ...m.rounds, review: round },
      updatedAt: this.#deps.clock.now(),
    }));
    session.progress(`组件制作：独立审查（第 ${round} 轮）`);
    let submitted: WidgetReviewResult | null = null;
    await this.#stage(
      session,
      'review',
      reviewStageInput({
        draftDir: draft.dir,
        round,
        spec: draft.read(DRAFT_SPEC),
        acceptance: draft.read(DRAFT_ACCEPTANCE),
        checkSummary: formatCheckReport(report, 1_500),
        previewed: report.stages.S2.status === 'ran',
        previous: session.lastReview,
      }),
      {
        onSubmitReview: (result) => {
          submitted = result;
        },
      },
    );
    const result = submitted as WidgetReviewResult | null;
    if (result === null) {
      // 没交结论（自然结束 / 轮数用尽 / 模型失败）：这一轮记 skipped，不阻断交付。
      session.reviewSkipped = true;
      draft.writeReport('review', round, { skipped: true });
      return null;
    }
    draft.writeReport('review', round, result);
    const actionable = result.findings.filter((item) => item.severity !== 'P2');
    session.reviewFindings.set(digestKey, actionable);
    session.lastReview = actionable;
    session.progress(
      actionable.length > 0
        ? `组件制作：审查发现 ${actionable.length} 个要修的问题`
        : '组件制作：审查通过',
    );
    if (actionable.length === 0 || round >= session.reviewRoundsMax) return null;
    return actionable;
  }

  /** GATE：宿主执行检查，快照 + 报告 + 回执 + 最佳快照。 */
  async #gate(session: CraftSession): Promise<{ report: WidgetCheckReport; round: number }> {
    const { draft } = session;
    const round = draft.readManifest().rounds.gate + 1;
    // 先快照再检查：快照与检查读到的是同一份文件（回滚目标与回执对应）。
    draft.snapshot(round);
    const report = blockOnCheckerFailure(await this.#check(session));
    draft.writeReport('check', round, report);
    const receipt: WidgetCraftReceipt = {
      round,
      htmlSha256: report.htmlSha256,
      queriesSha256: report.queriesSha256,
      verdict: report.verdict,
      score: report.score,
      previewed: report.stages.S2.status === 'ran',
      at: this.#deps.clock.now(),
    };
    draft.updateManifest((m) => {
      // 最佳快照：与交付同口径（可交付的优先，分数最低，同分取较新的一轮）。
      const top = bestReceipt([...m.receipts, receipt]);
      const best = top === null ? null : { round: top.round, score: top.score };
      return {
        ...m,
        rounds: { ...m.rounds, gate: round },
        receipts: [...m.receipts, receipt],
        best,
        updatedAt: this.#deps.clock.now(),
      };
    });
    return { report, round };
  }

  /**
   * GATE 的检查：带制作的 signal 与时限。预览宿主按调用方给的预算（`budgetMs`，见 preview.ts）
   * 自己收尾——组件真的挂住时宿主在视口时限内回 `preview.timeout`（阻断项）。core 这边的时限
   * 只是兜底（宿主没回音 / 排队太久）：那是宿主的问题不是组件的，退回只跑 S0 / S1，S2 记
   * skipped（这一轮最多算 unverified），不冤枉组件。
   */
  async #check(session: CraftSession): Promise<WidgetCheckReport> {
    const base = {
      draftDir: session.draft.dir,
      validateQueries: (defs: WidgetQueryDef[]) => this.#deps.widgets.validateQueries(defs),
      now: this.#deps.clock.now(),
    };
    const preview = this.#deps.preview?.({ screenshots: false }) ?? null;
    if (preview === null || session.controller.signal.aborted) {
      return runWidgetCheck({ ...base, preview: null });
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(session.controller.signal.reason);
    session.controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort('widget check timeout');
      },
      this.#deps.checkTimeoutMs ?? WIDGET_CHECK_TIMEOUT_MS + WIDGET_CHECK_GRACE_MS,
    );
    timer.unref?.();
    try {
      // 与中止本身竞速：预览实现没理会 signal 也不能把 GATE 挂住。
      return await raceAbort(
        runWidgetCheck({ ...base, preview, signal: controller.signal }),
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      const report = await runWidgetCheck({ ...base, preview: null });
      return {
        ...report,
        stages: {
          ...report.stages,
          S2: {
            status: 'skipped',
            reason: timedOut
              ? '预览宿主没有按时回应（繁忙或异常），本轮未经运行验证'
              : '制作已停止，预览未完成',
          },
        },
      };
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  /** 模型的 widget_check：同一检查器、同一报告格式；只是自查，不留回执。 */
  async #selfCheck(session: CraftSession, signal: AbortSignal): Promise<ToolResult> {
    // 自查要截图（模型支持图片时引擎才会带上，run_steps 只存文本）；同样受检查时限约束。
    const preview = this.#deps.preview?.({ screenshots: true }) ?? null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort('widget check timeout'),
      this.#deps.checkTimeoutMs ?? WIDGET_CHECK_TIMEOUT_MS + WIDGET_CHECK_GRACE_MS,
    );
    timer.unref?.();
    try {
      const report = await raceAbort(
        runWidgetCheck({
          draftDir: session.draft.dir,
          validateQueries: (defs) => this.#deps.widgets.validateQueries(defs),
          preview,
          now: this.#deps.clock.now(),
          signal: controller.signal,
        }),
        controller.signal,
      );
      const images = preview?.screenshots?.() ?? [];
      return {
        ok: true,
        content: formatCheckReport(report),
        ...(images.length > 0 ? { images } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        content: controller.signal.aborted
          ? '自查被中止（超时或制作已取消）；宿主在阶段结束后仍会检查'
          : `检查器出错：${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'TOOL_FAILED',
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** 一个阶段 = 一个 pi run（照抄 subagent 的落库：runs 行、run_steps、用量、run.status）。 */
  async #stage(
    session: CraftSession,
    stage: CraftStage,
    userMessage: string,
    options: { onSubmitReview?: (result: WidgetReviewResult) => void } = {},
  ): Promise<void> {
    if (session.stop !== null) return;
    const { identity, draft } = session;
    const route = stage === 'review' ? session.reviewRoute : session.route;
    const deps = this.#deps;
    const manifest = draft.readManifest();
    const row = deps.runs.create({
      botId: identity.botId,
      conversationId: identity.conversationId,
      loopType: 'widget_authoring',
      triggerReason: null,
      triggerMessageIds: [],
      parentRunId: manifest.parentRunId,
      provider: route.provider,
      model: route.modelRef,
      engine: engineKeyOf(route),
    });
    this.#stageRuns.set(row.id, manifest.craftId);
    draft.updateManifest((m) => ({ ...m, stageRunIds: [...m.stageRunIds, row.id] }));
    const update = (patch: Parameters<RunsService['update']>[1]): void => {
      try {
        deps.publishRunStatus(deps.runs.update(row.id, patch));
      } catch (error) {
        deps.logger.warn(
          { runId: row.id, error: error instanceof Error ? error.message : String(error) },
          'widget craft stage run update failed',
        );
      }
    };
    update({ status: 'running' });

    let stageDone = false;
    let outcome: RunOutcome;
    try {
      outcome = await this.#runStage(session, stage, route, userMessage, row.id, {
        onStageDone: () => {
          stageDone = true;
        },
        ...(options.onSubmitReview !== undefined ? { onSubmitReview: options.onSubmitReview } : {}),
      });
    } catch (error) {
      // 引擎 / 工具装配抛错：阶段 run 也必须结算，不能留一条取消不掉的 running 行。
      const message = error instanceof Error ? error.message : String(error);
      update({ status: 'failed', error: message });
      // 审查失败不停制作（记 skipped，见 #review）。
      if (session.stop === null && stage !== 'review') {
        session.stop = 'stage_failed';
        session.stageError = message;
      }
      return;
    }
    update({
      status: outcome.status,
      ...(outcome.error !== undefined ? { error: outcome.error.message } : {}),
    });
    this.#recordUsage(session, route, row.id, outcome.usage);
    if (outcome.status === 'failed' && session.stop === null && stage !== 'review') {
      session.stop = 'stage_failed';
      session.stageError = outcome.error?.message ?? '未知错误';
    }
    deps.logger.info(
      { craftId: manifest.craftId, stage, runId: row.id, status: outcome.status, stageDone },
      'widget craft stage settled',
    );
  }

  /** 启动阶段 run 并等它结束（级联取消、步骤落库、token 计数）。 */
  async #runStage(
    session: CraftSession,
    stage: CraftStage,
    route: LlmRoute,
    userMessage: string,
    runId: string,
    callbacks: {
      onStageDone: () => void;
      onSubmitReview?: (result: WidgetReviewResult) => void;
    },
  ): Promise<RunOutcome> {
    const { identity, draft } = session;
    const purpose = stage === 'review' ? 'widget_review' : 'widget_authoring';
    const deps = this.#deps;
    const subIdentity: RunIdentity = {
      runId,
      botId: identity.botId,
      conversationId: identity.conversationId,
      loopType: 'widget_authoring',
    };
    const handle = route.engine.startRun(
      backgroundRunSpec(route, {
        identity: subIdentity,
        model: route.modelRef,
        isRouteCurrent: () => routeStillCurrent(deps, purpose, identity.botId, route.modelRef),
        buildSystemPrompt: async () =>
          stage === 'review' ? reviewSystemPrompt() : craftSystemPrompt(),
        messages: [{ role: 'user', content: userMessage, timestamp: deps.clock.now() }],
        tools: buildCraftTools({
          draftDir: draft.dir,
          stage,
          // 修改已有组件时不给模板工具：它会整份覆盖现有源码。
          templates: draft.readManifest().widgetId === null,
          selfCheck: (signal) => this.#selfCheck(session, signal),
          onStageDone: callbacks.onStageDone,
          ...(callbacks.onSubmitReview !== undefined
            ? { onSubmitReview: callbacks.onSubmitReview }
            : {}),
        }),
        limits: { maxTurns: WIDGET_CRAFT_PHASE_MAX_TURNS[stage] },
      }),
    );
    session.handle = handle;
    const onAbort = () =>
      handle.abort(String(session.controller.signal.reason ?? 'widget craft aborted'));
    if (session.controller.signal.aborted) onAbort();
    else session.controller.signal.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = persistEngineSteps({
      runs: deps.runs,
      secrets: deps.secrets,
      runId,
      handle,
    });
    try {
      return await handle.done;
    } finally {
      session.controller.signal.removeEventListener('abort', onAbort);
      unsubscribe();
      const spent = handle.tokensSoFar();
      session.tokens += spent;
      session.handle = null;
      try {
        draft.updateManifest((m) => ({
          ...m,
          tokensUsed: m.tokensUsed + spent,
          updatedAt: deps.clock.now(),
        }));
      } catch {
        // 草稿目录已不在（Bot 删除）：计数只是记录。
      }
    }
  }

  #recordUsage(session: CraftSession, route: LlmRoute, runId: string, usage: EngineUsage[]): void {
    const provider = providerOfModelRef(route.modelRef);
    for (const entry of usage) {
      try {
        this.#deps.usage.record({
          runId,
          botId: session.identity.botId,
          conversationId: session.identity.conversationId,
          loopType: 'widget_authoring',
          provider: route.agentId === null ? provider : route.provider,
          model:
            route.agentId === null ? route.modelRef.slice(provider.length + 1) : route.modelRef,
          inputTokens: entry.input,
          outputTokens: entry.output,
          cacheReadTokens: entry.cacheRead,
          cacheWriteTokens: entry.cacheWrite,
          costUsd: entry.costUsd,
        });
      } catch (error) {
        this.#deps.logger.warn(
          { runId, error: error instanceof Error ? error.message : String(error) },
          'widget craft usage record failed',
        );
      }
    }
  }

  /** 修改模式下给 SPEC 的现有组件概要（行数 + id 清单；不给全文，SPEC 自己 read）。 */
  #outline(session: CraftSession): string | null {
    const manifest = session.draft.readManifest();
    if (manifest.widgetId === null) return null;
    const html = session.draft.read(DRAFT_HTML) ?? '';
    const ids = [
      ...new Set([...html.matchAll(/\bid\s*=\s*["']([^"']{1,64})["']/g)].map((m) => m[1]!)),
    ];
    const queries = session.draft.queries() ?? [];
    return [
      `现有版本 v${manifest.baseVersion ?? '?'}：index.html ${html.split('\n').length} 行`,
      ids.length > 0 ? `元素 id：${ids.slice(0, 60).join(', ')}` : '没有带 id 的元素',
      queries.length > 0 ? `查询模板：${queries.map((q) => q.name).join(', ')}` : '没有查询模板',
    ].join('\n');
  }

  // --- 收尾：交付或如实失败 -------------------------------------------------------

  async #finish(session: CraftSession): Promise<ToolResult> {
    const { draft } = session;
    if (session.stop === 'cancelled') {
      this.#settleManifest(session, 'cancelled', [STOP_TEXT.cancelled]);
      const manifest = draft.readManifest();
      return {
        ok: false,
        content: `组件制作已取消，未交付。草稿保留 ${WIDGET_CRAFT_DRAFT_TTL_DAYS} 天（craftId: ${manifest.craftId}），需要时可用 resume_craft_id 续做。`,
        errorCode: 'CANCELLED',
      };
    }
    // 中途停下（时限 / 预算 / 模型失败）且当前文件还没检查过：补一次确定性检查（不调模型）。
    if (session.stop !== null && draft.exists(DRAFT_HTML)) {
      const digest = draft.digest();
      const checked = draft
        .readManifest()
        .receipts.some(
          (r) => r.htmlSha256 === digest.htmlSha256 && r.queriesSha256 === digest.queriesSha256,
        );
      if (!checked) await this.#gate(session);
    }
    const manifest = draft.readManifest();
    const best = bestReceipt(manifest.receipts, reviewPenalty(session.reviewFindings));
    const stopNote = session.stop !== null ? stopReasonText(session) : null;
    if (best === null) {
      const reasons = [stopNote ?? '没有产出可检查的组件源码'];
      this.#settleManifest(session, 'failed', reasons);
      return this.#failure(session, reasons);
    }
    const bestReport = draft.readReport(best.round);
    if (best.verdict === 'blocked') {
      const reasons = [
        ...(stopNote !== null ? [stopNote] : []),
        ...(bestReport !== null ? blockingReasons(bestReport) : ['检查未通过']),
      ].slice(0, 5);
      this.#settleManifest(session, 'failed', reasons);
      return this.#failure(session, reasons);
    }
    // 交付最佳快照（当前文件不是它就回滚）。
    const digest = draft.digest();
    if (digest.htmlSha256 !== best.htmlSha256 || digest.queriesSha256 !== best.queriesSha256) {
      draft.restore(best.round);
    }
    return this.#deliver(session);
  }

  /** DELIVER：回执关卡 → WidgetService.create/update → 删除草稿 → 回执文本。 */
  #deliver(session: CraftSession): ToolResult {
    const { draft, identity } = session;
    this.#setPhase(session, 'deliver');
    const manifest = draft.readManifest();
    // 只读一次：交付的就是算摘要的这份字节（不留「算完摘要再读一遍」的窗口）。
    const { html, queries, digest } = draft.deliverable();
    // 同一份字节检查过多次时以最后一次为准（预览偶发失败的那次不能被更早的合格回执盖住）。
    const receipt = manifest.receipts
      .filter((r) => r.htmlSha256 === digest.htmlSha256 && r.queriesSha256 === digest.queriesSha256)
      .at(-1);
    if (receipt === undefined || receipt.verdict === 'blocked' || queries === null) {
      // 文件与任何一次合格检查都对不上（检查之后被改动过）：宿主拒绝交付。
      const reasons = ['交付被拒：组件文件与检查回执不一致（检查之后被改动过）'];
      this.#settleManifest(session, 'failed', reasons);
      return this.#failure(session, reasons);
    }
    // 修改已有组件：制作期间组件已有更新的版本（并发制作 / 另一路交付）→ 不覆盖，如实失败。
    if (manifest.widgetId !== null && manifest.baseVersion !== null) {
      const latest = this.#deps.widgets.craftSource(identity.botId, manifest.widgetId);
      if (latest.ok && latest.version !== manifest.baseVersion) {
        const reasons = [
          `制作期间组件已有新版本 v${latest.version}（本次基于 v${manifest.baseVersion}），为避免覆盖未交付；请基于最新版重新制作`,
        ];
        this.#settleManifest(session, 'failed', reasons);
        return this.#failure(session, reasons);
      }
    }
    const report = draft.readReport(receipt.round);
    // 审查对这份文件提出、没修掉的 P0 / P1（轮数用尽）：交付但列为已知问题；没审过这份文件 =
    // 审查未完成（跳过、或停在审查之前）。
    const digestKey = `${digest.htmlSha256}:${digest.queriesSha256}`;
    const reviewed = session.reviewFindings.get(digestKey);
    const unresolved = reviewed ?? [];
    const reviewSkipped = session.reviewSkipped || reviewed === undefined;
    // 「已通过自检」= 机器检查全绿 + 运行验证过 + 交付的这份文件审查过且没有剩余 P0 / P1。
    const status = !receipt.previewed
      ? 'unverified'
      : receipt.verdict === 'pass' && reviewed !== undefined && unresolved.length === 0
        ? 'passed'
        : 'issues';
    const knownIssues = [
      ...unresolved.map((item) => `审查：${clip(item.problem, 80)}`),
      ...(reviewed === undefined ? ['未完成独立审查'] : []),
      ...(report !== null
        ? knownIssuesForUser(report, undefined, acceptanceItems(draft.read(DRAFT_ACCEPTANCE)))
        : []),
    ].slice(0, WIDGET_KNOWN_ISSUES_MAX);
    const check: WidgetDeliveryCheck = {
      status,
      summary: {
        craftId: manifest.craftId,
        gateRounds: manifest.rounds.gate,
        reviewRounds: manifest.rounds.review,
        reviewSkipped,
        previewed: receipt.previewed,
        knownIssues,
      },
    };
    const description = oneLiner(draft.read(DRAFT_SPEC), manifest.brief);
    const result =
      manifest.widgetId !== null
        ? this.#deps.widgets.update({
            botId: identity.botId,
            widgetId: manifest.widgetId,
            html,
            queries,
            conversationId: identity.conversationId,
            changeNote: description,
            runId: manifest.parentRunId,
            check,
          })
        : this.#deps.widgets.create({
            botId: identity.botId,
            conversationId: identity.conversationId,
            title: manifest.title,
            description,
            html,
            queries,
            scope: manifest.scope,
            runId: manifest.parentRunId,
            check,
          });
    if (!result.ok) {
      const reasons = [`交付失败：${result.message}`];
      this.#settleManifest(session, 'failed', reasons);
      return this.#failure(session, reasons);
    }
    draft.destroy();
    this.#deps.logger.info(
      {
        craftId: manifest.craftId,
        widgetId: result.widgetId,
        version: result.version,
        status,
        gateRounds: manifest.rounds.gate,
        fixRounds: manifest.rounds.fix,
        tokens: manifest.tokensUsed,
      },
      'widget crafted and delivered',
    );
    session.progress(`组件制作：已交付 v${result.version}`);
    return {
      ok: true,
      content: successText({
        result,
        status,
        manifest,
        knownIssues,
        stop: session.stop,
        reviewSkipped,
      }),
    };
  }

  #settleManifest(session: CraftSession, status: 'failed' | 'cancelled', failure: string[]): void {
    try {
      session.draft.updateManifest((m) => ({
        ...m,
        status,
        failure: failure.slice(0, 5),
        updatedAt: this.#deps.clock.now(),
      }));
    } catch {
      // 草稿目录被外力删除（Bot 删除）：回执照常给出。
    }
  }

  #failure(session: CraftSession, reasons: string[]): ToolResult {
    const craftId = session.draft.tryReadManifest()?.craftId ?? '';
    const numbered = reasons
      .slice(0, 5)
      .map((reason, index) => `${CIRCLED[index] ?? `${index + 1}.`} ${clip(safeText(reason), 160)}`)
      .join(' ');
    const text = [
      `组件未交付：${numbered}`,
      `草稿保留 ${WIDGET_CRAFT_DRAFT_TTL_DAYS} 天（craftId: ${craftId}），可用 resume_craft_id 续做（可在 brief 里补充说明），或缩小需求后重新制作。请如实告诉用户没有做成及原因，不要假装成功。`,
    ].join('\n');
    return {
      ok: false,
      content: clip(text, WIDGET_CRAFT_RESULT_MAX_CHARS),
      errorCode: 'WIDGET_CRAFT_FAILED',
    };
  }
}

// --- helpers ------------------------------------------------------------------------

const CIRCLED = ['①', '②', '③', '④', '⑤'];

/** 审查意见 → FIX 的问题清单文本（按严重度，带场景与改法）。 */
function formatReviewFindings(findings: WidgetReviewFinding[]): string {
  const ordered = [...findings].sort((a, b) => a.severity.localeCompare(b.severity));
  return [
    `独立审查提出 ${findings.length} 个要修的问题（P0 = 主要功能不可用或数据会错，P1 = 一条使用路径出错）：`,
    ...ordered.map(
      (item) =>
        `[${item.severity}]${item.line !== undefined ? ` 第 ${item.line} 行` : ''} — ${item.problem} — 场景：${item.scenario}${item.fixHint !== '' ? ` — 改法：${item.fixHint}` : ''}`,
    ),
  ].join('\n');
}

/** 等 promise，或 signal 先中止就立刻 reject（不依赖被等的那一方理会 signal）。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function invalid(content: string, errorCode = 'INVALID_INPUT'): ToolResult {
  return { ok: false, content, errorCode };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 回执里的文字不带尖括号（上下文隔离的验收：任务上下文里不出现任何标签片段）。 */
function safeText(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

/** acceptance.json 的校验错误（null = 合格；文件缺省也算不合格）。 */
function acceptanceError(text: string | null): string | null {
  if (text === null || text.trim() === '') return '没有写 acceptance.json';
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return `不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`;
  }
  const parsed = widgetAcceptanceSchema.safeParse(raw);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}：` : '';
  return `${where}${issue?.message ?? '格式不符'}（必须是 1–${WIDGET_ACCEPTANCE_ITEMS_MAX} 条验收点的数组）`;
}

/**
 * 交付候选：可交付（非阻断）的回执里分数最低的一条；都阻断时取分数最低的一条（用于失败原因）。
 * 同分取较新的。分数不能单独决定——一个只差一条必需验收点的版本（阻断）可能比一个有若干
 * 警告的可交付版本分数还低。
 */
function bestReceipt(
  receipts: WidgetCraftReceipt[],
  penalty: (receipt: WidgetCraftReceipt) => number = () => 0,
): WidgetCraftReceipt | null {
  const pick = (pool: WidgetCraftReceipt[]): WidgetCraftReceipt | null => {
    let best: WidgetCraftReceipt | null = null;
    for (const receipt of pool) {
      if (best === null || receipt.score + penalty(receipt) <= best.score + penalty(best)) {
        best = receipt;
      }
    }
    return best;
  };
  return pick(receipts.filter((r) => r.verdict !== 'blocked')) ?? pick(receipts);
}

/**
 * 审查意见计入「最好的版本」的分数（审查修复）：检查分只看机器问题，审查出 P1 的版本与修好它、
 * 却多了一个警告的版本相比，分数反而更低——不加罚分就会把修好的版本回滚掉。P0 ×50、P1 ×10
 * （与检查分同量级：P0 接近阻断，P1 相当于一个错误）。
 */
function reviewPenalty(findings: Map<string, WidgetReviewFinding[]>) {
  return (receipt: WidgetCraftReceipt): number =>
    (findings.get(`${receipt.htmlSha256}:${receipt.queriesSha256}`) ?? []).reduce(
      (sum, item) => sum + (item.severity === 'P0' ? 50 : item.severity === 'P1' ? 10 : 0),
      0,
    );
}

/** 检查器自身出错（S0 / S1 记 skipped）时的合成阻断项：没检查过的代码不能当作合格。 */
const CHECKER_FAILED_RULE = 'checker.failed';

function blockOnCheckerFailure(report: WidgetCheckReport): WidgetCheckReport {
  // 只认检查器自身的异常；「缺少 index.html」这类 skipped 已有 html.missing 阻断项，走正常的 FIX。
  const failed = (['S0', 'S1'] as const).filter(
    (stage) =>
      report.stages[stage].status === 'skipped' &&
      report.stages[stage].reason.startsWith(WIDGET_CHECKER_INTERNAL_ERROR_PREFIX),
  );
  if (failed.length === 0) return report;
  const issues: WidgetCheckIssue[] = failed.map((stage) => ({
    rule: CHECKER_FAILED_RULE,
    level: 'error',
    stage,
    blocking: true,
    file: 'index.html',
    message: `检查器没能完成 ${stage}：${report.stages[stage].reason || '未知原因'}`,
    hint: '',
  }));
  return {
    ...report,
    issues: [...issues, ...report.issues],
    blockers: report.blockers + issues.length,
    score: report.score + 100 * issues.length,
    verdict: 'blocked',
  };
}

/** acceptance.json 的条目（给「已知问题」用验收点描述；不合格 / 缺省为 undefined）。 */
function acceptanceItems(text: string | null): WidgetAcceptance | undefined {
  if (text === null) return undefined;
  try {
    const parsed = widgetAcceptanceSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function gateSummary(report: WidgetCheckReport): string {
  if (report.verdict === 'pass') return '全部通过';
  const parts: string[] = [];
  if (report.blockers > 0) parts.push(`${report.blockers} 个阻断项`);
  const otherErrors = report.errors - report.blockers;
  if (otherErrors > 0) parts.push(`${otherErrors} 个错误`);
  if (report.warnings > 0) parts.push(`${report.warnings} 个警告`);
  const failedMust = report.acceptance.filter((a) => a.must && !a.passed).length;
  if (failedMust > 0) parts.push(`${failedMust} 个必需验收点未通过`);
  return parts.length > 0 ? parts.join('、') : '有问题';
}

function describeIssue(issue: WidgetCheckIssue): string {
  const at = issue.line !== undefined ? ` 第 ${issue.line} 行` : '';
  return `[${issue.rule}]${at} ${issue.message}`;
}

/** 失败回执里的原因：阻断项按规则标题 + 行号（不带源码片段），必需验收点按描述。 */
function blockingReasons(report: WidgetCheckReport): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const issue of report.issues) {
    if (!issue.blocking) continue;
    let title = issue.rule;
    try {
      title = widgetCheckRule(issue.rule).title;
    } catch {
      // 未登记的规则 id：用 id 本身。
    }
    const key = `${issue.rule}`;
    const at = issue.line !== undefined ? `（第 ${issue.line} 行）` : '';
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(issue.rule === CHECKER_FAILED_RULE ? issue.message : `${title}${at}`);
  }
  for (const item of report.acceptance) {
    if (item.must && !item.passed) reasons.push(`必需验收点「${item.id}」未通过`);
  }
  return reasons.length > 0 ? reasons : ['检查未通过'];
}

function stopReasonText(session: CraftSession): string {
  const stop = session.stop!;
  if (stop === 'stage_failed')
    return `${STOP_TEXT.stage_failed}：${clip(session.stageError ?? '', 120)}`;
  return STOP_TEXT[stop];
}

/**
 * 卡片上给用户看的一句话：spec.md 里第一条 `>` 引用行（SPEC 阶段按约定写），否则 brief 的
 * 第一句。
 */
function oneLiner(spec: string | null, brief: string): string {
  const quoted = spec
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('>'));
  const text =
    quoted !== undefined ? quoted.replace(/^>\s*/, '') : (brief.split(/[。！？\n]/)[0] ?? '');
  return clip(text.trim(), 120);
}

const STATUS_TEXT = {
  passed: '已通过自检',
  issues: '有已知问题',
  unverified: '通过静态检查，未经运行验证',
} as const;

function successText(input: {
  result: Extract<WidgetWriteResult, { ok: true }>;
  status: keyof typeof STATUS_TEXT;
  manifest: WidgetCraftManifest;
  knownIssues: string[];
  stop: StopReason | null;
  reviewSkipped: boolean;
}): string {
  const { result, status, manifest, knownIssues } = input;
  const rounds = `检查 ${manifest.rounds.gate} 轮、修复 ${manifest.rounds.fix} 轮、审查 ${manifest.rounds.review} 轮${input.reviewSkipped ? '（审查未完成）' : ''}`;
  const lines = [
    `组件「${safeText(result.title)}」v${result.version} 已交付（${STATUS_TEXT[status]}：${rounds}）。widgetId: ${result.widgetId}`,
  ];
  if (knownIssues.length > 0) {
    lines.push(
      `已知问题：${knownIssues.map((issue, index) => `${CIRCLED[index] ?? '-'} ${safeText(issue)}`).join(' ')}`,
    );
  }
  if (input.stop !== null) {
    lines.push(`（${STOP_TEXT[input.stop]}，交付的是检查结果最好的版本。）`);
  }
  if (result.cardMessageId === null) {
    lines.push(
      '组件已保存，但卡片消息发送失败，用户暂时看不到它；请如实告诉用户，之后可用 widget_publish（Bot 级组件）或再次 widget_craft 发新卡。',
    );
  } else {
    lines.push(
      '卡片已发进对话，请用户点「加载」使用（加载前用户仍要确认源码）。不要用文字复述代码；要修改时再调 widget_craft 并传 widget_id。',
    );
  }
  return clip(lines.join('\n'), WIDGET_CRAFT_RESULT_MAX_CHARS);
}
