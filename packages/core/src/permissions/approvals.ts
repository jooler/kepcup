import {
  accessApprovalPayloadSchema,
  agentToolApprovalPayloadSchema,
  butlerProposalPayloadSchema,
  environmentApprovalPayloadSchema,
  profileChangeApprovalPayloadSchema,
  skillImportApprovalPayloadSchema,
  mcpToolApprovalPayloadSchema,
  mcpToolRiskSchema,
  type McpToolRisk,
  skillPresetApprovalPayloadSchema,
  type Approval,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalStatus,
  type Run,
} from '@kepcup/shared';
import path from 'node:path';
import { AppError, newId } from '@kepcup/shared';
import { canonicalPath, expandTilde, workspacePathFor, type AppPaths } from '../infra/paths.js';
import { neutralizeUntrusted } from '../infra/data-boundary.js';
import { literalCommandSegments, optionValuePath } from './allowlist-match.js';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { MessagesService } from '../domain/messages.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { BotsService } from '../domain/bots.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { RunIdentity } from '../agent/types.js';
import type { UnattendedService } from './unattended.js';
import { activeEffectHooks } from './tool-call-scope.js';

interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  bot_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  payload_json: string;
  status: ApprovalStatus;
  decision_json: string | null;
  auto_approved: number;
  message_id: string | null;
  created_at: number;
  decided_at: number | null;
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    kind: row.kind,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    decision: row.decision_json ? (JSON.parse(row.decision_json) as ApprovalDecision) : null,
    autoApproved: row.auto_approved === 1,
    messageId: row.message_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export interface ApprovalOutcome {
  approval: Approval;
  decision: 'approved' | 'denied' | 'cancelled';
}

export interface ApprovalsDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  paths: AppPaths;
  /** The real user home, for home-variable detection in the unattended floor. */
  homeDir: string;
  messages: MessagesService;
  conversations: ConversationsService;
  bots: BotsService;
  runs: RunsService;
  secrets: SecretsService;
  unattended: UnattendedService;
  /** Core event bus (approval.created / approval.resolved / run.status ...). */
  publish: (event: string, payload: unknown) => void;
  /** Port-B notification request; the main process filters by window focus. */
  notify: (approval: Approval, description: string) => void;
  /** Audit sink (writes approval_auto / approval_refused entries). */
  audit: (identity: RunIdentity, action: string, detail: Record<string, unknown>) => void;
}

type Resolver = (outcome: ApprovalOutcome) => void;

/**
 * Kinds unattended mode never decides on its own (D70): a butler proposal
 * creates contacts / groups — it always waits for the user, unattended or not.
 */
const NEVER_AUTO_DECIDED: ReadonlySet<ApprovalKind> = new Set(['butler_proposal']);

/**
 * Non-blocking kinds whose card must outlive the requesting run: the tool
 * returned immediately and the run usually settles long before the user
 * decides (`environment` P06, `butler_proposal` D70).
 */
const SURVIVES_RUN: ApprovalKind[] = ['environment', 'butler_proposal'];

/**
 * The approval mechanism (docs/dev/phases/P03-permissions.md "审批框架").
 * Requests persist before anything else happens: approvals row → card message
 * → waiting_approval → user decision → resolved promise. The promise only
 * bridges the in-memory wait; the row is the source of truth (a restart
 * cancels pending approvals and the cards render as cancelled).
 */
export class ApprovalsService {
  readonly #deps: ApprovalsDeps;
  readonly #waiters = new Map<string, Resolver>();
  /**
   * Non-blocking decisions (P06 `request_environment`): the caller submitted
   * and moved on; the callback runs when the user (or unattended mode)
   * decides. Never holds a run.
   */
  readonly #decisionCallbacks = new Map<string, (outcome: ApprovalOutcome) => void>();
  /** Grants already credited to a run (audit dedupe). */
  readonly #grantUsedLogged = new Set<string>();

  constructor(deps: ApprovalsDeps) {
    this.#deps = deps;
  }

  get #db(): SqliteDatabase {
    return this.#deps.db;
  }

  // --- requesting -----------------------------------------------------------

  /**
   * Creates an approval, blocks the caller until the user decides (or
   * unattended mode auto-approves). The `signal` hooks run cancellation:
   * an aborted signal cancels the approval instead of leaving it pending.
   */
  async request(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApprovalOutcome> {
    if (options.signal?.aborted) {
      return this.#cancelledOutcome(identity, kind, payload, 'run already aborted');
    }
    const unattended = this.#deps.unattended.effective();
    if (unattended.enabled && !NEVER_AUTO_DECIDED.has(kind)) {
      return this.#autoDecide(identity, kind, payload);
    }
    return this.#requestAndWait(identity, kind, payload, options);
  }

  #requestAndWait(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<ApprovalOutcome> {
    const approval = this.#insert(identity, kind, payload, { status: 'pending' });
    const card = this.#insertCard(approval);
    const withCard = this.#updateRow(approval.id, { messageId: card.id });
    this.#deps.publish('approval.created', {
      conversationId: approval.conversationId,
      approval: withCard,
    });
    this.#publishConversation(approval.conversationId);
    this.#deps.notify(withCard, this.describe(withCard));

    if (approval.runId !== null) {
      this.#setRunStatus(approval.runId, 'waiting_approval');
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        options.signal?.removeEventListener('abort', onAbort);
        this.#resolvePending(approval.id, {
          approval: this.#markCancelled(approval.id),
          decision: 'cancelled',
        });
      };
      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#waiters.set(approval.id, (outcome) => {
        options.signal?.removeEventListener('abort', onAbort);
        this.#afterResolution(outcome);
        resolve(outcome);
      });
    });
  }

  /**
   * P06 non-blocking submit (docs/dev/phases/P06-environment.md 任务 3):
   * creates the approval + card and registers `onDecided`, but never parks a
   * run — the tool returns "已提交申请" immediately. Unattended mode routes
   * through the same auto-decision as `request`.
   */
  submitNonBlocking(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
    onDecided: (outcome: ApprovalOutcome) => void,
  ): Approval {
    if (this.#deps.unattended.effective().enabled && !NEVER_AUTO_DECIDED.has(kind)) {
      const outcome = this.#autoDecideSync(identity, kind, payload);
      onDecided(outcome);
      return outcome.approval;
    }
    const approval = this.#insert(identity, kind, payload, { status: 'pending' });
    const card = this.#insertCard(approval);
    const withCard = this.#updateRow(approval.id, { messageId: card.id });
    this.#deps.publish('approval.created', {
      conversationId: approval.conversationId,
      approval: withCard,
    });
    this.#publishConversation(approval.conversationId);
    this.#deps.notify(withCard, this.describe(withCard));
    this.#decisionCallbacks.set(approval.id, (outcome) => {
      this.#afterResolution(outcome);
      onDecided(outcome);
    });
    return withCard;
  }

  /** Unattended mode: approve everything at once — except the data dir. */
  #autoDecide(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
  ): Promise<ApprovalOutcome> {
    return Promise.resolve(this.#autoDecideSync(identity, kind, payload));
  }

  #autoDecideSync(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
  ): ApprovalOutcome {
    // Security review round 2: unsandboxed / confirm-mode commands are only
    // auto-approved when a static analysis can vouch for them (literal words,
    // no context switch, no path into the data directory) — fail closed.
    const workspace =
      identity.botId !== null && identity.conversationId !== null
        ? workspacePathFor(this.#deps.paths, identity.botId, identity.conversationId)
        : null;
    const touchesDataDir =
      (kind === 'command' || kind === 'unsandboxed') &&
      !unattendedCommandVerdict(String(payload['command'] ?? ''), {
        dataHome: this.#deps.paths.home,
        homeDir: this.#deps.homeDir,
        cwd:
          typeof payload['cwd'] === 'string' && payload['cwd'].length > 0 ? payload['cwd'] : null,
        exemptDirs: workspace !== null ? [workspace] : [],
      }).safe;
    // git_remote (P04): the command text and the cwd (the project path) both
    // go through the same floor — a data-directory reference in a remote URL
    // or argument must not auto-approve either.
    const gitRemoteTouchesDataDir =
      kind === 'git_remote' &&
      (commandTouchesDataDir(
        `git ${String(payload['operation'] ?? '')} ${(Array.isArray(payload['args']) ? (payload['args'] as string[]).join(' ') : '').trim()}`,
        this.#deps.paths.home,
        this.#deps.homeDir,
      ) ||
        commandTouchesDataDir(
          String(payload['cwd'] ?? ''),
          this.#deps.paths.home,
          this.#deps.homeDir,
        ));
    // environment (P06): installs land inside the app's own toolchains dir by
    // construction (catalog-pinned URLs, checksums verified) — nothing to floor.
    // skill_import (P08): design/13 lists it among the auto-approved kinds;
    // the content lands in the app-owned library (deny the data-dir floor is
    // meaningless here — the target IS the data dir), and the scan result is
    // recorded on the card. Nothing escapes the data directory.
    // agent_tool (D72): the external agent's own tools run outside the
    // KepCup sandbox — the same data-directory floor as unsandboxed commands
    // (command text + resolved locations), except the run's workspace and
    // skill directories (`exemptDirs`, filled by the permission bridge).
    const agentToolTouches =
      kind === 'agent_tool' &&
      (agentToolUnattendedRefusal(payload) ||
        agentToolTouchesDataDir(
          payload,
          this.#deps.paths.home,
          this.#deps.homeDir,
          process.platform,
          workspace !== null ? [workspace] : [],
        ));
    // mcp_tool（W5，D65 修订；todo/borrowings-from-personal-agents.md W5
    // 设计 4，已定「自动豁免」）：无人值守下 MCP 工具调用**所有风险档**
    // （read / write / destructive）都自动批准——无人值守是用户开关（D53），
    // 开了即接受自动批准；不拒绝、不排队、不设逐工具无人值守白名单。收紧手段
    // 只有 Bot 详情 MCP 区的常驻风险提示与审计：payload 带 risk（网关写入），
    // approval_auto 审计记风险档，网关的 mcp_tool_call 审计记
    // unattendedAutoApproved（§5 护栏 7）。MCP 工具不经宿主文件系统，数据目录
    // 底线不适用；这一豁免只属于 mcp_tool，不外溢到其他 kind（§5 护栏 2）。
    const mcpToolUnattended = kind === 'mcp_tool';
    const touches = mcpToolUnattended
      ? false
      : touchesDataDir || gitRemoteTouchesDataDir || agentToolTouches;
    const status: ApprovalStatus = touches ? 'denied' : 'approved';
    const approval = this.#insert(identity, kind, payload, {
      status,
      autoApproved: true,
      // Auto-approved access is「仅这一次」(design 13): no grant outlives the mode.
      decision:
        status === 'approved' && (kind === 'access' || kind === 'agent_tool')
          ? { duration: 'once' }
          : null,
    });
    const card = this.#insertCard(approval);
    const withCard = this.#updateRow(approval.id, { messageId: card.id });
    this.#deps.publish('approval.created', {
      conversationId: approval.conversationId,
      approval: withCard,
    });
    this.#deps.publish('approval.resolved', {
      conversationId: approval.conversationId,
      approval: withCard,
    });
    this.#deps.audit(identity, 'approval_auto', {
      approvalId: approval.id,
      kind,
      approved: status === 'approved',
      refused: touches,
      ...(mcpToolUnattended ? { risk: mcpRiskOf(payload) ?? 'unknown' } : {}),
    });
    this.#deps.logger.info(
      { approvalId: approval.id, kind, approved: status === 'approved' },
      'unattended auto decision',
    );
    this.#publishConversation(approval.conversationId);
    if (status === 'denied') {
      return { approval: withCard, decision: 'denied' };
    }
    return { approval: withCard, decision: 'approved' };
  }

  // --- deciding -------------------------------------------------------------

  /** RPC entry: the user's decision on a pending approval. */
  decide(
    id: string,
    approveInput: boolean,
    duration?: 'once' | 'conversation',
    selection?: number[],
  ): Approval {
    const approval = this.get(id);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `审批 ${id} 不存在`);
    if (approval.status !== 'pending') {
      throw new AppError('INVALID_INPUT', '该审批已经处理过了');
    }
    let approve = approveInput;
    let keptSelection: number[] | undefined;
    if (selection !== undefined) {
      if (approval.kind !== 'butler_proposal') {
        throw new AppError('INVALID_INPUT', '只有管家提议卡支持勾选条目');
      }
      if (approve) {
        keptSelection = validateButlerSelection(approval.payload, selection);
        // 一项都不留 = 拒绝（D70）。
        if (keptSelection.length === 0) approve = false;
      }
    }
    if (
      approval.kind === 'access' &&
      approve &&
      duration !== 'once' &&
      duration !== 'conversation'
    ) {
      throw new AppError('INVALID_INPUT', '缺少授权有效期（once / conversation）');
    }
    // agent_tool (D72): commands only ever get「仅这一次」; a conversation-wide
    // decision is honoured only where the card offered it (path requests).
    if (
      approval.kind === 'agent_tool' &&
      duration === 'conversation' &&
      !(
        Array.isArray(approval.payload['durations']) &&
        (approval.payload['durations'] as unknown[]).includes('conversation')
      )
    ) {
      duration = 'once';
    }
    const now = this.#deps.clock.now();
    const decision: ApprovalDecision | null =
      approve && duration !== undefined
        ? { duration }
        : approve && keptSelection !== undefined
          ? { selection: keptSelection }
          : null;
    this.#db
      .prepare('update approvals set status = ?, decision_json = ?, decided_at = ? where id = ?')
      .run(approve ? 'approved' : 'denied', decision ? JSON.stringify(decision) : null, now, id);
    const updated = this.getOrThrow(id);
    const waiter = this.#waiters.get(id);
    if (waiter) {
      this.#waiters.delete(id);
      waiter({ approval: updated, decision: approve ? 'approved' : 'denied' });
    } else {
      const callback = this.#decisionCallbacks.get(id);
      if (callback) {
        this.#decisionCallbacks.delete(id);
        callback({ approval: updated, decision: approve ? 'approved' : 'denied' });
      } else {
        // Nobody waits (e.g. a decision arriving after the run died): finish the
        // lifecycle inline so events and conversation marks stay correct.
        this.#afterResolution({ approval: updated, decision: approve ? 'approved' : 'denied' });
      }
    }
    return this.getOrThrow(id);
  }

  /**
   * Marks a resolved approval as failed because its post-approval action
   * errored (BR-P08-004: a skill import whose finalize threw). The row was
   * already flipped to `approved` by decide() before the callback ran; an
   * honest terminal state beats a card that reads as successfully approved.
   * Not valid for pending rows (those are cancelled, not failed).
   */
  fail(id: string, reason: string): Approval {
    const approval = this.get(id);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `审批 ${id} 不存在`);
    if (approval.status === 'pending') {
      throw new AppError('INVALID_INPUT', '待处理的审批不能标记为失败（应走取消）');
    }
    this.#db
      .prepare(
        "update approvals set status = 'failed', decision_json = ?, decided_at = ? where id = ?",
      )
      .run(JSON.stringify({ error: reason.slice(0, 500) }), this.#deps.clock.now(), id);
    const updated = this.getOrThrow(id);
    this.#deps.publish('approval.resolved', {
      conversationId: updated.conversationId,
      approval: updated,
    });
    this.#publishConversation(updated.conversationId);
    return updated;
  }

  /** Runs after the promise resolves (or inline when no one is waiting). */
  #afterResolution(outcome: ApprovalOutcome): void {
    this.#deps.publish('approval.resolved', {
      conversationId: outcome.approval.conversationId,
      approval: outcome.approval,
    });
    this.#publishConversation(outcome.approval.conversationId);
    if (
      outcome.approval.runId !== null &&
      outcome.approval.status !== 'cancelled' &&
      this.#deps.runs.get(outcome.approval.runId)?.status === 'waiting_approval'
    ) {
      this.#setRunStatus(outcome.approval.runId, 'running');
    }
  }

  // --- cancellation ---------------------------------------------------------

  /**
   * Run ended (cancel/interrupt/…): its pending approvals become cancelled.
   * `environment` approvals (P06) are excluded on purpose: the tool returned
   * immediately and the run usually settles long before the user decides —
   * the request must survive the run (conversation/bot cancellation still
   * applies).
   */
  cancelPendingForRun(runId: string): void {
    // Non-blocking submissions (`submitNonBlocking`, e.g. a supervisor turn's
    // propose_profile_change, D75 审查 M4) never hold the run: the tool
    // returned at once, so the card outlives the run whatever its kind.
    const rows = this.#listPending({ runId }, { excludeKinds: SURVIVES_RUN }).filter(
      (row) => !this.#decisionCallbacks.has(row.id),
    );
    for (const row of rows)
      this.#resolvePending(row.id, {
        approval: this.#markCancelled(row.id),
        decision: 'cancelled',
      });
  }

  cancelPendingForConversation(conversationId: string): void {
    for (const row of this.#listPending({ conversationId })) {
      this.#resolvePending(row.id, {
        approval: this.#markCancelled(row.id),
        decision: 'cancelled',
      });
    }
  }

  cancelPendingForBot(botId: string): void {
    for (const row of this.#listPending({ botId })) {
      this.#resolvePending(row.id, {
        approval: this.#markCancelled(row.id),
        decision: 'cancelled',
      });
    }
  }

  /** Bot removed from one conversation (P05): cancel that pair's pendings only. */
  cancelPendingForBotInConversation(botId: string, conversationId: string): void {
    for (const row of this.#listPending({ botId, conversationId })) {
      this.#resolvePending(row.id, {
        approval: this.#markCancelled(row.id),
        decision: 'cancelled',
      });
    }
  }

  /** Startup recovery: nothing survives a restart (docs: 待确认审批 → cancelled). */
  cancelAllPending(): number {
    const rows = this.#listPending({});
    for (const row of rows) {
      this.#markCancelled(row.id);
      if (row.conversation_id !== null) this.#publishConversation(row.conversation_id);
    }
    return rows.length;
  }

  // --- queries --------------------------------------------------------------

  get(id: string): Approval | null {
    const row = this.#db.prepare('select * from approvals where id = ?').get(id) as
      ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  getOrThrow(id: string): Approval {
    const approval = this.get(id);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `审批 ${id} 不存在`);
    return approval;
  }

  list(conversationId?: string): Approval[] {
    const rows = (
      conversationId !== undefined
        ? this.#db
            .prepare(
              'select * from approvals where conversation_id = ? order by created_at desc limit 200',
            )
            .all(conversationId)
        : this.#db.prepare('select * from approvals order by created_at desc limit 200').all()
    ) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  pendingCount(conversationId: string): number {
    return (
      this.#db
        .prepare(
          "select count(*) as n from approvals where conversation_id = ? and status = 'pending'",
        )
        .get(conversationId) as { n: number }
    ).n;
  }

  /** Pending approvals of one kind in one conversation (butler proposal dedupe, D70). */
  pendingOfKind(conversationId: string, kind: ApprovalKind): Approval[] {
    return (
      this.#db
        .prepare(
          "select * from approvals where status = 'pending' and conversation_id = ? and kind = ? order by created_at",
        )
        .all(conversationId, kind) as ApprovalRow[]
    ).map(rowToApproval);
  }

  /**
   * D72 project-side agent config confirmations the user approved for one
   * bot in one conversation (`agent_tool` subtype `config`), newest first.
   * Targeted by subtype (not capped by other approvals, review L6);
   * unattended auto-approvals never count as remembered (review M2).
   */
  approvedAgentConfigs(conversationId: string, botId: string): Approval[] {
    return (
      this.#db
        .prepare(
          "select * from approvals where kind = 'agent_tool' and status = 'approved' and auto_approved = 0 and conversation_id = ? and bot_id = ? and json_extract(payload_json, '$.kind') = 'config' order by created_at desc limit 50",
        )
        .all(conversationId, botId) as ApprovalRow[]
    ).map(rowToApproval);
  }

  /**
   * P06 dedupe: the still-pending environment approval for one catalog item,
   * or null. A second request for the same item while the first card is
   * undecided must reuse it instead of stacking cards.
   */
  pendingEnvironmentFor(item: string): Approval | null {
    const rows = this.#db
      .prepare(
        "select * from approvals where status = 'pending' and kind = 'environment' order by created_at desc",
      )
      .all() as ApprovalRow[];
    for (const row of rows) {
      const approval = rowToApproval(row);
      if (String(approval.payload['item'] ?? '') === item) return approval;
    }
    return null;
  }

  /** One-line description for context rendering, notifications and summaries. */
  describe(approval: Approval): string {
    const botName =
      approval.botId !== null ? (this.#deps.bots.get(approval.botId)?.name ?? approval.botId) : '';
    switch (approval.kind) {
      case 'access': {
        const payload = accessApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return '访问授权请求';
        const verb = payload.data.access === 'write' ? '写入' : '读取';
        return `${botName} 申请${verb} ${payload.data.path}`;
      }
      case 'unsandboxed':
        return `${botName} 申请在沙箱外执行命令：${String(approval.payload['command'] ?? '')}`;
      case 'command':
        return `${botName} 申请执行命令（逐条确认模式）：${String(approval.payload['command'] ?? '')}`;
      case 'git_remote': {
        const op = String(approval.payload['operation'] ?? '');
        const args = Array.isArray(approval.payload['args'])
          ? (approval.payload['args'] as string[]).join(' ')
          : '';
        return `${botName} 申请执行 git ${op}${args.length > 0 ? ` ${args}` : ''}（沙箱外，需确认）`;
      }
      case 'environment': {
        const payload = environmentApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return `${botName} 申请安装环境`;
        const data = payload.data;
        const size =
          data.sizeBytes > 0
            ? `，约 ${Math.max(1, Math.round(data.sizeBytes / 1024 / 1024))}MB`
            : '';
        return `${botName} 申请安装 ${data.displayName || data.item} ${data.version}${size}（${data.reason || '未说明原因'}）`;
      }
      case 'profile_change': {
        const payload = profileChangeApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return `${botName} 建议修改自己的 Profile`;
        const fields = payload.data.changes.map((change) => change.field).join('、');
        return `${botName} 建议修改自己的 Profile（${fields}）：${payload.data.reason || '未说明原因'}`;
      }
      case 'skill_import': {
        const payload = skillImportApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return '技能导入请求';
        const data = payload.data;
        const compat =
          data.scan.compatibility === 'compatible'
            ? '兼容'
            : data.scan.compatibility === 'partial'
              ? '部分兼容'
              : '不兼容';
        return `导入技能 ${data.name}（来源 ${data.sourceUrl}，commit ${data.commitOid.slice(0, 10)}；${compat}${data.missingDeps.length > 0 ? `，缺少依赖 ${data.missingDeps.join('、')}` : ''}）`;
      }
      case 'skill_preset': {
        const payload = skillPresetApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return '技能安装请求';
        const data = payload.data;
        return `安装技能 ${data.displayName}（应用内置推荐，v${data.version}${data.missingDeps.length > 0 ? `，缺少依赖 ${data.missingDeps.join('、')}` : ''}）：${data.summary}`;
      }
      case 'butler_proposal':
        return `${botName} ${describeButlerProposal(approval.payload)}`;
      case 'mcp_tool': {
        const payload = mcpToolApprovalPayloadSchema.safeParse(approval.payload);
        if (!payload.success) return 'MCP 工具调用请求';
        const data = payload.data;
        const args = data.argsSummary.length > 0 ? `，参数 ${data.argsSummary}` : '';
        const risk = data.risk !== undefined ? `，${MCP_RISK_LABELS[data.risk]}` : '';
        return `调用 MCP 工具 ${data.toolName}（服务器「${data.serverName}」${risk}${args}）`;
      }
      case 'agent_tool':
        return `${botName} ${describeAgentTool(approval.payload)}`;
      default:
        return `${botName} 请求确认（${approval.kind}）`;
    }
  }

  /** Renders the folded card line shown in the conversation context. */
  renderContextLine(approval: Approval): string {
    const botName =
      approval.botId !== null ? (this.#deps.bots.get(approval.botId)?.name ?? approval.botId) : '';
    if (approval.kind === 'access') {
      const parsed = accessApprovalPayloadSchema.safeParse(approval.payload);
      const verb = parsed.success ? (parsed.data.access === 'write' ? '写入' : '读取') : '访问';
      const target = parsed.success ? parsed.data.path : String(approval.payload['path'] ?? '');
      const actor = botName.length > 0 ? `${botName} ` : '';
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${actor}申请${verb} ${target}`;
        case 'approved': {
          const duration = approval.decision?.duration;
          const suffix =
            approval.autoApproved === true
              ? '（无人值守模式自动批准，仅这一次）'
              : duration === 'conversation'
                ? '（本对话内一直允许）'
                : '（仅这一次）';
          return `[系统] 用户允许${actor}${verb} ${target}${suffix}`;
        }
        case 'denied':
          return `[系统] 用户拒绝${actor}${verb} ${target}`;
        case 'cancelled':
          return `[系统] 已取消：${actor}申请${verb} ${target}`;
        case 'failed':
          return `[系统] 处理失败：${actor}申请${verb} ${target}${failureSuffix(approval)}`;
      }
    }
    const command = String(approval.payload['command'] ?? '');
    if (approval.kind === 'environment') {
      const parsed = environmentApprovalPayloadSchema.safeParse(approval.payload);
      const target = parsed.success
        ? parsed.data.displayName || parsed.data.item
        : String(approval.payload['item'] ?? '环境');
      const label = `安装 ${target}`;
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${botName} 申请${label}`;
        case 'approved':
          return approval.autoApproved
            ? `[系统] 用户批准${label}（无人值守模式自动批准）`
            : `[系统] 用户批准${label}`;
        case 'denied':
          return `[系统] 用户拒绝${label}`;
        case 'cancelled':
          return `[系统] 已取消：${botName} 申请${label}`;
        case 'failed':
          return `[系统] 处理失败：${botName} 申请${label}${failureSuffix(approval)}`;
      }
    }
    if (approval.kind === 'profile_change') {
      const parsed = profileChangeApprovalPayloadSchema.safeParse(approval.payload);
      const fields = parsed.success
        ? parsed.data.changes.map((c) => c.field).join('、')
        : 'Profile';
      const label = `修改自己的 Profile（${fields}）`;
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${botName} 建议${label}`;
        case 'approved':
          return approval.autoApproved
            ? `[系统] 用户批准${label}（无人值守模式自动批准）`
            : `[系统] 用户批准${label}`;
        case 'denied':
          return `[系统] 用户拒绝${label}`;
        case 'cancelled':
          return `[系统] 已取消：${botName} 建议${label}`;
        case 'failed':
          return `[系统] 处理失败：${botName} 建议${label}${failureSuffix(approval)}`;
      }
    }
    if (approval.kind === 'skill_import') {
      const parsed = skillImportApprovalPayloadSchema.safeParse(approval.payload);
      const name = parsed.success ? parsed.data.name : String(approval.payload['name'] ?? '技能');
      const label = `导入技能 ${name}`;
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${label}`;
        case 'approved':
          return approval.autoApproved
            ? `[系统] 用户批准${label}（无人值守模式自动批准）`
            : `[系统] 用户批准${label}，技能已入技能库并启用`;
        case 'denied':
          return `[系统] 用户拒绝${label}`;
        case 'cancelled':
          return `[系统] 已取消：${label}`;
        case 'failed':
          return `[系统] 处理失败：${label}${failureSuffix(approval)}（内容未安装）`;
      }
    }
    if (approval.kind === 'butler_proposal') {
      const label = describeButlerProposal(approval.payload);
      const kept = approval.decision?.selection;
      const keptNote =
        kept !== undefined ? `（用户保留了第 ${kept.map((i) => i + 1).join('、')} 项）` : '';
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${botName} ${label}`;
        case 'approved':
          return `[系统] 用户确认了${label}${keptNote}`;
        case 'denied':
          return `[系统] 用户拒绝了${label}`;
        case 'cancelled':
          return `[系统] 已取消：${botName} ${label}`;
        case 'failed':
          return `[系统] 处理失败：${label}${failureSuffix(approval)}`;
      }
    }
    if (approval.kind === 'agent_tool') {
      const label = describeAgentTool(approval.payload, true);
      const actor = botName.length > 0 ? `${botName} ` : '';
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${actor}${label}`;
        case 'approved': {
          const suffix =
            approval.autoApproved === true
              ? '（无人值守模式自动批准，仅这一次）'
              : approval.decision?.duration === 'conversation'
                ? '（本对话内一直允许）'
                : '（仅这一次）';
          return `[系统] 用户允许${actor}${label}${suffix}`;
        }
        case 'denied':
          return approval.autoApproved === true
            ? `[系统] 已拒绝${actor}${label}（无人值守模式：触及应用数据目录）`
            : `[系统] 用户拒绝${actor}${label}`;
        case 'cancelled':
          return `[系统] 已取消：${actor}${label}`;
        case 'failed':
          return `[系统] 处理失败：${actor}${label}${failureSuffix(approval)}`;
      }
    }
    if (approval.kind === 'mcp_tool') {
      const parsed = mcpToolApprovalPayloadSchema.safeParse(approval.payload);
      const toolName = parsed.success
        ? parsed.data.toolName
        : String(approval.payload['toolName'] ?? '');
      const serverName = parsed.success ? parsed.data.serverName : '';
      const risk = parsed.success && parsed.data.risk !== undefined ? parsed.data.risk : null;
      const label = `调用 MCP 工具 ${toolName}${serverName.length > 0 ? `（服务器「${serverName}」）` : ''}`;
      const riskNote = risk !== null ? MCP_RISK_LABELS[risk] : null;
      const actor = botName.length > 0 ? `${botName} ` : '';
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${actor}${label}${riskNote !== null ? `（${riskNote}）` : ''}`;
        case 'approved':
          return approval.autoApproved === true
            ? `[系统] 无人值守自动批准${riskNote !== null ? `（${riskNote}）` : ''}：${actor}${label}`
            : `[系统] 用户允许${actor}${label}${riskNote !== null ? `（${riskNote}）` : ''}`;
        case 'denied':
          return `[系统] 用户拒绝${actor}${label}`;
        case 'cancelled':
          return `[系统] 已取消：${actor}${label}`;
        case 'failed':
          return `[系统] 处理失败：${actor}${label}${failureSuffix(approval)}`;
      }
    }
    if (approval.kind === 'skill_preset') {
      const parsed = skillPresetApprovalPayloadSchema.safeParse(approval.payload);
      const name = parsed.success
        ? parsed.data.displayName || parsed.data.name
        : String(approval.payload['name'] ?? '技能');
      const label = `安装技能 ${name}`;
      switch (approval.status) {
        case 'pending':
          return `[系统] 等待用户确认：${label}`;
        case 'approved':
          return approval.autoApproved
            ? `[系统] 用户批准${label}（无人值守模式自动批准）`
            : `[系统] 用户批准${label}，技能已安装并启用`;
        case 'denied':
          return `[系统] 用户拒绝${label}`;
        case 'cancelled':
          return `[系统] 已取消：${label}`;
        case 'failed':
          return `[系统] 处理失败：${label}${failureSuffix(approval)}（未安装）`;
      }
    }
    const label =
      approval.kind === 'unsandboxed'
        ? '在沙箱外执行'
        : approval.kind === 'git_remote'
          ? `执行 git ${String(approval.payload['operation'] ?? '')}`
          : '执行';
    const display =
      approval.kind === 'git_remote' && Array.isArray(approval.payload['args'])
        ? (approval.payload['args'] as string[]).join(' ')
        : command;
    switch (approval.status) {
      case 'pending':
        return `[系统] 等待用户确认：${label} ${display}`;
      case 'approved':
        return `[系统] 用户批准${label}：${display}`;
      case 'denied':
        return `[系统] 用户拒绝${label}：${display}`;
      case 'cancelled':
        return `[系统] 已取消${label}：${display}`;
      case 'failed':
        return `[系统] 处理失败${label}：${display}${failureSuffix(approval)}`;
    }
  }

  /** Auto-approvals for the unattended summary dialog. */
  summary(since?: number): Array<{
    approvalId: string;
    kind: string;
    conversationId: string | null;
    botId: string | null;
    detail: string;
    createdAt: number;
  }> {
    const rows = (
      since !== undefined
        ? this.#db
            .prepare(
              'select * from approvals where auto_approved = 1 and created_at > ? order by created_at desc limit 500',
            )
            .all(since)
        : this.#db
            .prepare(
              'select * from approvals where auto_approved = 1 order by created_at desc limit 500',
            )
            .all()
    ) as ApprovalRow[];
    return rows.map((row) => {
      const approval = rowToApproval(row);
      return {
        approvalId: approval.id,
        kind: approval.kind,
        conversationId: approval.conversationId,
        botId: approval.botId,
        detail: this.describe(approval),
        createdAt: approval.createdAt,
      };
    });
  }

  /** Called by the gateway when a file access was satisfied by a grant. */
  noteGrantUsed(grantId: string, identity: RunIdentity): void {
    const key = `${identity.runId}:${grantId}`;
    if (this.#grantUsedLogged.has(key)) return;
    this.#grantUsedLogged.add(key);
    this.#deps.audit(identity, 'grant_used', { grantId });
  }

  /** Generic event emission for permission-adjacent core events. */
  publishEvent(event: string, payload: unknown): void {
    this.#deps.publish(event, payload);
  }

  // --- internals ------------------------------------------------------------

  #resolvePending(id: string, outcome: ApprovalOutcome): void {
    const waiter = this.#waiters.get(id);
    if (waiter) {
      this.#waiters.delete(id);
      waiter(outcome);
      return;
    }
    const callback = this.#decisionCallbacks.get(id);
    if (callback) {
      this.#decisionCallbacks.delete(id);
      callback(outcome);
    }
  }

  #markCancelled(id: string): Approval {
    const current = this.get(id);
    if (!current || current.status !== 'pending') return current ?? this.getOrThrow(id);
    this.#db
      .prepare("update approvals set status = 'cancelled', decided_at = ? where id = ?")
      .run(this.#deps.clock.now(), id);
    const updated = this.getOrThrow(id);
    this.#deps.publish('approval.resolved', {
      conversationId: updated.conversationId,
      approval: updated,
    });
    return updated;
  }

  #cancelledOutcome(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
    _why: string,
  ): ApprovalOutcome {
    void _why;
    const stub = {
      id: '',
      kind,
      botId: identity.botId,
      conversationId: identity.conversationId,
      runId: identity.runId,
      payload,
      status: 'cancelled' as ApprovalStatus,
      decision: null,
      autoApproved: false,
      messageId: null,
      createdAt: this.#deps.clock.now(),
      decidedAt: this.#deps.clock.now(),
    } satisfies Approval;
    return { approval: stub, decision: 'cancelled' };
  }

  #insert(
    identity: RunIdentity,
    kind: ApprovalKind,
    payload: Record<string, unknown>,
    opts: { status: ApprovalStatus; autoApproved?: boolean; decision?: ApprovalDecision | null },
  ): Approval {
    const id = newId('apr');
    this.#db
      .prepare(
        'insert into approvals (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        kind,
        identity.botId,
        identity.conversationId,
        identity.runId,
        JSON.stringify(payload),
        opts.status,
        opts.decision ? JSON.stringify(opts.decision) : null,
        opts.autoApproved === true ? 1 : 0,
        this.#deps.clock.now(),
      );
    // W2: the effect ledger links the calling tool call's row to its approval.
    activeEffectHooks()?.noteApproval(id, identity.runId);
    return this.getOrThrow(id);
  }

  #updateRow(id: string, patch: { messageId?: string | null }): Approval {
    const current = this.getOrThrow(id);
    this.#db
      .prepare('update approvals set message_id = ? where id = ?')
      .run(patch.messageId ?? current.messageId, id);
    return this.getOrThrow(id);
  }

  /** Card message: content links to the approval; payload stays in the row. */
  #insertCard(approval: Approval) {
    const card = this.#deps.messages.append({
      conversationId: approval.conversationId ?? '',
      senderType: 'system',
      kind: 'card',
      event: 'approval',
      text: '',
      runId: approval.runId,
      approvalId: approval.id,
      cardType: approval.kind,
    });
    // The message flow renders the card (folded after resolution) — announce
    // it like any other message.
    this.#deps.publish('message.created', {
      conversationId: card.conversationId,
      message: card,
    });
    return card;
  }

  #setRunStatus(runId: string, status: Run['status']): void {
    const run = this.#deps.runs.get(runId);
    if (!run) return;
    if (status === 'waiting_approval' && run.status !== 'running') return;
    if (status === 'running' && run.status !== 'waiting_approval') return;
    const updated = this.#deps.runs.update(runId, { status });
    this.#deps.publish('run.status', { run: updated });
  }

  #publishConversation(conversationId: string | null): void {
    if (conversationId === null) return;
    const conversation = this.#deps.conversations.get(conversationId);
    if (conversation) this.#deps.publish('conversation.updated', { conversation });
  }

  #listPending(
    filter: { runId?: string; conversationId?: string; botId?: string },
    options: { excludeKinds?: ApprovalKind[] } = {},
  ): ApprovalRow[] {
    const clauses = ["status = 'pending'"];
    const params: string[] = [];
    if (filter.runId !== undefined) {
      clauses.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    if (filter.botId !== undefined) {
      clauses.push('bot_id = ?');
      params.push(filter.botId);
    }
    for (const kind of options.excludeKinds ?? []) {
      clauses.push('kind != ?');
      params.push(kind);
    }
    return this.#db
      .prepare(`select * from approvals where ${clauses.join(' and ')}`)
      .all(...params) as ApprovalRow[];
  }
}

/** One-line summary of a butler proposal payload (D70). */
function describeButlerProposal(payload: Record<string, unknown>): string {
  const parsed = butlerProposalPayloadSchema.safeParse(payload);
  if (!parsed.success) return '提议';
  const data = parsed.data;
  if (data.proposalType === 'group') {
    return `提议建群「${data.title}」（${data.memberBotIds.length} 位成员）`;
  }
  const names = data.bots.map((bot) => bot.name).join('、');
  return data.proposalType === 'team' ? `提议组建团队：${names}` : `提议新建 Bot：${names}`;
}

/**
 * One-line summary of an agent_tool payload (D72): action + target. With
 * `untrusted` (conversation context, review L1) the agent-supplied parts —
 * title, command, paths — are wrapped in `<untrusted>` like tool output.
 */
function describeAgentTool(payload: Record<string, unknown>, untrusted = false): string {
  const parsed = agentToolApprovalPayloadSchema.safeParse(payload);
  if (!parsed.success) return '外部智能体权限请求';
  const data = parsed.data;
  const wrap = (text: string) =>
    untrusted && text.length > 0 ? `<untrusted>${neutralizeUntrusted(text)}</untrusted>` : text;
  const agent = data.agentName.length > 0 ? data.agentName : data.agentId;
  const where = wrap(data.locations.join('、'));
  const title = wrap(data.title);
  switch (data.kind) {
    case 'config':
      return `在此项目中运行智能体「${agent}」（将加载项目内的智能体配置：${where}）`;
    case 'execute':
      return `经智能体「${agent}」执行命令：${data.command !== undefined ? wrap(data.command) : title}`;
    case 'read':
      return `经智能体「${agent}」读取 ${where.length > 0 ? where : title}`;
    case 'write':
      return `经智能体「${agent}」写入 ${where.length > 0 ? where : title}`;
    default:
      return `经智能体「${agent}」使用工具：${title}${where.length > 0 ? `（${where}）` : ''}`;
  }
}

/**
 * Unattended floor for agent_tool (D72; security review H3 / L5): refused when
 * - a location lies in the data directory outside the exempt directories (the
 *   run's workspace and skill directories), or covers the data home;
 * - the command's working directory (`payload.cwd`) lies in the data
 *   directory outside the exempt directories;
 * - the command text reaches the data directory: absolute tokens, `~` /
 *   home-variable forms and tokens **relative to the command's cwd** (so
 *   `../../../skills` from the workspace counts), `--opt=value` values,
 *   `~user` forms and (Windows) 8.3 short names fail closed.
 * Comparisons are case-insensitive on macOS / Windows.
 */
export function agentToolTouchesDataDir(
  payload: Record<string, unknown>,
  dataHome: string,
  homeDir: string,
  platform: string = process.platform,
  /**
   * Directories a *command* may touch (round 2: only the run's writable
   * workspace — skill directories are read-only for path requests and must
   * not become deletable through a command). Defaults to `exemptDirs`.
   */
  commandExemptDirs?: readonly string[],
): boolean {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const fold = platform === 'darwin' || platform === 'win32';
  const norm = (p: string) => {
    const posix = path.posix.normalize(p.replaceAll('\\', '/'));
    return fold ? posix.toLowerCase() : posix;
  };
  const exempt = strings(payload['exemptDirs']).map(norm);
  const home = norm(dataHome);
  const outsideExempt = (candidate: string) =>
    isInsidePath(candidate, home) && !exempt.some((dir) => isInsidePath(candidate, dir));
  for (const location of strings(payload['locations']).map(norm)) {
    if (isInsidePath(home, location) || outsideExempt(location)) return true;
  }
  const command = typeof payload['command'] === 'string' ? payload['command'] : '';
  if (command.length === 0) return false;
  const rawCwd =
    typeof payload['cwd'] === 'string' && payload['cwd'].length > 0 ? payload['cwd'] : null;
  if (rawCwd !== null && outsideExempt(norm(rawCwd))) return true;
  // Round 2: fail closed — only a statically analyzable command passes.
  return !unattendedCommandVerdict(command, {
    dataHome,
    homeDir,
    cwd: rawCwd,
    exemptDirs: commandExemptDirs ?? strings(payload['exemptDirs']),
    platform,
  }).safe;
}

/** Commands that change the directory or run another command line (round 2). */
const CONTEXT_COMMANDS = new Set([
  'cd',
  'pushd',
  'popd',
  'chdir',
  'env',
  'eval',
  'source',
  '.',
  'exec',
  'xargs',
  'sudo',
  'su',
  'doas',
  'chroot',
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'set-location',
  'push-location',
  'invoke-expression',
  'iex',
  'start-process',
]);
/** Commands whose `-C <dir>` switches the working directory. */
const DASH_C_COMMANDS = new Set([
  'git',
  'make',
  'gmake',
  'tar',
  'gtar',
  'ninja',
  'pnpm',
  'cargo',
  'cmake',
]);
const CHDIR_OPTION =
  /^-{1,2}(chdir|directory|cwd|dir|work-tree|git-dir|prefix|manifest-path|exec-path)(=|$)/i;

export interface UnattendedCommandVerdict {
  safe: boolean;
  /** Why it cannot be vouched for (shown on cards / audit). */
  reason?: string;
}

/**
 * Fail-closed static analysis of a command for unattended auto-approval
 * (security review round 2: text matching cannot follow an arbitrary shell).
 * Safe only when ALL hold:
 * - it parses (POSIX; on Windows a plain word list without shell
 *   metacharacters) into simple commands whose words are plain literals —
 *   no expansion, glob, brace expansion, `~user`, assignment prefix,
 *   subshell / compound command;
 * - nothing changes the directory or runs another command line (`cd`,
 *   `pushd`, `env`, `eval`, `source`, `exec`, `xargs`, shells, `git -C`,
 *   `make -C`, `--chdir` / `--directory` …);
 * - the cwd is known and not in the data directory outside `exemptDirs`; a
 *   cwd inside the data directory forbids any `..` token;
 * - every word (and option value) resolved against the cwd and canonicalized
 *   (realpath of the longest existing prefix — symlinks followed) is neither
 *   inside the data directory (exempt dirs excepted) nor an ancestor of it.
 */
export function unattendedCommandVerdict(
  command: string,
  options: {
    dataHome: string;
    homeDir: string;
    cwd: string | null;
    exemptDirs: readonly string[];
    platform?: string;
  },
): UnattendedCommandVerdict {
  const platform = options.platform ?? process.platform;
  const fold = platform === 'darwin' || platform === 'win32';
  const norm = (p: string) => (fold ? p.toLowerCase() : p);
  const unsafe = (reason: string): UnattendedCommandVerdict => ({ safe: false, reason });
  if (options.cwd === null) return unsafe('命令的工作目录未知');
  const home = norm(canonicalPath(options.dataHome));
  const exempt = options.exemptDirs.map((dir) => norm(canonicalPath(dir)));
  const inExempt = (candidate: string) => exempt.some((dir) => isInsidePath(candidate, dir));
  const cwd = canonicalPath(options.cwd);
  const cwdNorm = norm(cwd);
  if (isInsidePath(cwdNorm, home) && !inExempt(cwdNorm))
    return unsafe('工作目录位于应用数据目录内');
  const cwdInHome = isInsidePath(cwdNorm, home);

  let segments: string[][];
  if (platform === 'win32') {
    if (/[`$%;|&<>(){}*?[\]\n^!]/.test(command)) return unsafe('命令包含无法静态分析的结构');
    const words = command
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => word.replace(/^"(.*)"$/, '$1'));
    if (words.length === 0 || words.some((word) => word.includes('"'))) {
      return unsafe('命令包含无法静态分析的引号');
    }
    segments = [words];
  } else {
    const parsed = literalCommandSegments(command);
    if (parsed === null) return unsafe('命令包含展开、通配、子 shell 等无法静态分析的结构');
    segments = parsed.map((segment) => segment.words);
  }

  for (const words of segments) {
    const name = path
      .basename(words[0] ?? '')
      .toLowerCase()
      .replace(/\.exe$/, '');
    if (CONTEXT_COMMANDS.has(name)) return unsafe(`命令 ${name} 会切换目录或执行其他命令`);
    for (const word of words.slice(1)) {
      if (CHDIR_OPTION.test(word) || /^-chdir/i.test(word)) {
        return unsafe(`参数 ${word} 会切换工作目录`);
      }
      if (DASH_C_COMMANDS.has(name) && word.startsWith('-C')) {
        return unsafe(`参数 ${word} 会切换工作目录`);
      }
    }
    for (const word of words) {
      const candidates = word.startsWith('-')
        ? [optionValuePath(word)].filter((value): value is string => value !== null)
        : [word];
      for (const raw of candidates) {
        if (/^~[^/\\]/.test(raw)) return unsafe('参数使用了 ~user 形式');
        if (cwdInHome && raw.split(/[/\\]/).includes('..')) {
          return unsafe('工作目录在应用数据目录内时不允许 .. 路径');
        }
        const expanded =
          raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
            ? path.join(options.homeDir, raw.slice(1))
            : raw;
        const resolved = norm(
          canonicalPath(path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)),
        );
        if (inExempt(resolved)) continue;
        if (isInsidePath(resolved, home) || isInsidePath(home, resolved)) {
          return unsafe(`参数 ${raw} 指向应用数据目录`);
        }
      }
    }
  }
  return { safe: true };
}

/**
 * Unattended mode never auto-approves what it cannot judge (review M1): an
 * unrecognized agent tool request (`kind: 'other'`) or a write without any
 * location.
 */
export function agentToolUnattendedRefusal(payload: Record<string, unknown>): boolean {
  // Judged on the schema-parsed fields; a payload that does not parse is
  // refused (fail closed).
  const parsed = AGENT_TOOL_FLOOR_FIELDS.safeParse(payload);
  if (!parsed.success) return true;
  const { kind, locations, targetUncertain } = parsed.data;
  return (
    kind === 'other' ||
    (kind === 'write' && locations.length === 0) ||
    // Round 2: the agent only asks for writes its sandbox refuses and the
    // real target may differ from the shown paths (Codex move targets).
    targetUncertain === true
  );
}

/** The agent_tool payload fields the unattended floor reads (shared schema). */
const AGENT_TOOL_FLOOR_FIELDS = agentToolApprovalPayloadSchema.pick({
  kind: true,
  locations: true,
  targetUncertain: true,
});

/**
 * `approvals.decide` selection of a butler proposal (D70): indexes into
 * payload.bots, deduplicated and sorted; any index outside the proposal is
 * rejected. Group proposals have nothing to pick.
 */
function validateButlerSelection(payload: Record<string, unknown>, selection: number[]): number[] {
  const parsed = butlerProposalPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new AppError('INVALID_INPUT', '提议内容无效');
  if (parsed.data.proposalType === 'group') {
    throw new AppError('INVALID_INPUT', '建群提议不支持勾选条目');
  }
  const count = parsed.data.bots.length;
  const kept = [...new Set(selection)].sort((a, b) => a - b);
  if (kept.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new AppError('INVALID_INPUT', '勾选的条目不在提议之中');
  }
  return kept;
}

/** W5: MCP risk tiers as shown in context lines, summaries and audit notes. */
const MCP_RISK_LABELS: Record<McpToolRisk, string> = {
  read: '只读',
  write: '写入',
  destructive: '破坏性',
};

function mcpRiskOf(payload: Record<string, unknown>): McpToolRisk | null {
  const parsed = mcpToolRiskSchema.safeParse(payload['risk']);
  return parsed.success ? parsed.data : null;
}

/** Failure reason suffix for `renderContextLine` (BR-P08-004). */
function failureSuffix(approval: Approval): string {
  const error = approval.decision?.error;
  return error !== undefined && error.length > 0 ? `（${error}）` : '';
}

/**
 * Shell forms that expand to the user's home directory, across POSIX shells,
 * PowerShell and cmd (BR-P03-001): `$HOME`, `${HOME}`, `$env:HOME`,
 * `$env:USERPROFILE`, `%HOME%`, `%USERPROFILE%`. Case-insensitive on purpose —
 * the POSIX spellings are case-sensitive but failing closed is cheaper here.
 */
export function replaceHomeVariables(token: string, homeDir: string): string {
  return token
    .replace(/\$\{HOME\}/gi, homeDir)
    .replace(/\$HOME/gi, homeDir)
    .replace(/\$env:HOME\b/gi, homeDir)
    .replace(/\$env:USERPROFILE\b/gi, homeDir)
    .replace(/%HOME%/gi, homeDir)
    .replace(/%USERPROFILE%/gi, homeDir);
}

/**
 * Best-effort data-directory detection for the unattended floor: literal home
 * paths, `~`-expanded tokens and home-directory variables (`$HOME`,
 * `${HOME}`, `%USERPROFILE%`, …). A token that is an ancestor of the data
 * home (a bare `~`/`$HOME`) also counts, so `cd ~ && cat .kepcup/main.db`
 * cannot slip through as a relative tail. Unresolvable indirection (`$D`,
 * `$(cmd)`) cannot be judged from text — the audited auto-decision plus the
 * confirm-mode card remain the visible controls (known limit, see PROGRESS).
 */
export function commandTouchesDataDir(
  command: string,
  dataHome: string,
  homeDir: string,
  /**
   * D72 agent_tool: data-directory subtrees a token may point into (the run's
   * workspace / skill directories, normalized POSIX form). Only a token whose
   * path resolves inside one of them is exempt (`..` normalized first).
   */
  exemptDirs: readonly string[] = [],
  options: {
    /**
     * D72 agent_tool: the command's working directory — relative tokens are
     * resolved against it (without it they are not judged as paths; they
     * would otherwise resolve against the core process' own cwd).
     */
    cwd?: string;
    /** Case-insensitive comparison on macOS / Windows (review L5). */
    platform?: string;
  } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const fold = platform === 'darwin' || platform === 'win32';
  const caseFold = (text: string) => (fold ? text.toLowerCase() : text);
  // Expand home variables over the whole text, then normalize Windows
  // separators so `%USERPROFILE%\.kepcup` matches the canonical form.
  const normalizedDataHome = caseFold(dataHome.replaceAll('\\', '/'));
  const exempt = exemptDirs.map((dir) => caseFold(dir.replaceAll('\\', '/')));
  const cwd =
    options.cwd !== undefined
      ? caseFold(path.posix.normalize(options.cwd.replaceAll('\\', '/')))
      : null;
  const expanded = expandTilde(replaceHomeVariables(command, homeDir).replaceAll('\\', '/'));
  const tokens = caseFold(expanded)
    .split(/[\s'"|;&()<>()]+/)
    .filter((t) => t.length > 0);
  const homeTilde = caseFold(expandTilde('~').replaceAll('\\', '/'));
  for (const token of tokens) {
    // `~user/...` names another home we cannot resolve: fail closed (L5).
    if (/^~[^/~\s]/.test(token)) return true;
    // Windows 8.3 short names (`KEPCUP~1`) inside a path: fail closed (L5).
    if (platform === 'win32' && /(^|[/:])[^/]{1,8}~\d/.test(token) && token.includes('/')) {
      return true;
    }
    // The token itself and, for `--opt=value`, its value.
    const eq = token.indexOf('=');
    const candidates = eq > 0 ? [token, token.slice(eq + 1)] : [token];
    for (const raw of candidates) {
      if (raw.length === 0) continue;
      const tilde = raw === '~' || raw.startsWith('~/') ? homeTilde + raw.slice(1) : raw;
      let resolved: string | null = null;
      if (path.posix.isAbsolute(tilde)) resolved = path.posix.normalize(tilde);
      else if (cwd !== null && !raw.startsWith('-')) resolved = path.posix.resolve(cwd, tilde);
      if (resolved !== null) {
        if (exempt.some((dir) => isInsidePath(resolved, dir))) continue;
        if (isInsidePath(resolved, normalizedDataHome)) return true;
        // An ancestor of (or equal to) the data home — e.g. a bare `~` /
        // `$HOME`, or `..` climbing out of the workspace.
        if (isInsidePath(normalizedDataHome, resolved)) return true;
      }
      if (raw.includes(normalizedDataHome)) {
        // `prefix/home/u/.kepcup/…` glued to something else: judge the path part.
        const at = raw.indexOf(normalizedDataHome);
        const part = path.posix.normalize(raw.slice(at));
        if (!exempt.some((dir) => isInsidePath(part, dir))) return true;
      }
    }
  }
  return false;
}
