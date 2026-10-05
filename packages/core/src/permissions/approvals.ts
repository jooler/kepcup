import {
  accessApprovalPayloadSchema,
  environmentApprovalPayloadSchema,
  profileChangeApprovalPayloadSchema,
  skillImportApprovalPayloadSchema,
  skillPresetApprovalPayloadSchema,
  type Approval,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalStatus,
  type Run,
} from '@kepcup/shared';
import { AppError, newId } from '@kepcup/shared';
import { expandTilde, type AppPaths } from '../infra/paths.js';
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
    if (unattended.enabled) {
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
    if (this.#deps.unattended.effective().enabled) {
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
    const touchesDataDir =
      (kind === 'command' || kind === 'unsandboxed') &&
      commandTouchesDataDir(
        String(payload['command'] ?? ''),
        this.#deps.paths.home,
        this.#deps.homeDir,
      );
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
    const touches = touchesDataDir || gitRemoteTouchesDataDir;
    const status: ApprovalStatus = touches ? 'denied' : 'approved';
    const approval = this.#insert(identity, kind, payload, {
      status,
      autoApproved: true,
      decision: status === 'approved' && kind === 'access' ? { duration: 'once' } : null,
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
  decide(id: string, approve: boolean, duration?: 'once' | 'conversation'): Approval {
    const approval = this.get(id);
    if (!approval) throw new AppError('APPROVAL_NOT_FOUND', `审批 ${id} 不存在`);
    if (approval.status !== 'pending') {
      throw new AppError('INVALID_INPUT', '该审批已经处理过了');
    }
    if (
      approval.kind === 'access' &&
      approve &&
      duration !== 'once' &&
      duration !== 'conversation'
    ) {
      throw new AppError('INVALID_INPUT', '缺少授权有效期（once / conversation）');
    }
    const now = this.#deps.clock.now();
    const decision: ApprovalDecision | null =
      approve && duration !== undefined ? { duration } : null;
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
    const rows = this.#listPending({ runId }, { excludeKinds: ['environment'] });
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
export function commandTouchesDataDir(command: string, dataHome: string, homeDir: string): boolean {
  // Expand home variables over the whole text, then normalize Windows
  // separators so `%USERPROFILE%\.kepcup` matches the canonical form.
  const normalizedDataHome = dataHome.replaceAll('\\', '/');
  const expanded = expandTilde(replaceHomeVariables(command, homeDir).replaceAll('\\', '/'));
  const tokens = expanded.split(/[\s'"|;&()<>()]+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (token.includes(normalizedDataHome)) return true;
    const tildeExpanded = expandTilde(token);
    if (isInsidePath(tildeExpanded, normalizedDataHome)) return true;
    // The token is an ancestor of (or equal to) the data home — e.g. a bare
    // `~`/`$HOME` followed by relative segments elsewhere in the command.
    if (isInsidePath(normalizedDataHome, tildeExpanded)) return true;
  }
  return false;
}
