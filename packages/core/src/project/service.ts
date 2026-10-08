import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  AppError,
  CHECKPOINT_RETENTION_DAYS,
  newId,
  type Project,
  type RunChangeFile,
} from '@kepcup/shared';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import type { RunIdentity } from '../agent/types.js';
import type { LeaseHolder, LeaseService } from './lease.js';
import type { CheckpointService } from './checkpoints.js';
import { buildProjectSection, PROJECT_SECTION_BUDGET } from './context.js';
import { gitCliAvailable, runGitRemote, type GitRemoteOperation } from './git-remote.js';
import type { ProjectsService } from '../domain/projects.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { BotsService } from '../domain/bots.js';
import type { GrantsService } from '../permissions/grants.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { canonicalPath, workspacePathFor, type AppPaths } from '../infra/paths.js';
import type { CoreEventsMap } from '../start-types.js';

export interface ProjectRuntimeDeps {
  db: SqliteDatabase;
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  projects: ProjectsService;
  conversations: ConversationsService;
  messages: MessagesService;
  runs: RunsService;
  bots: BotsService;
  grants: GrantsService;
  leases: LeaseService;
  checkpoints: CheckpointService;
  publish: <K extends keyof CoreEventsMap>(event: K, payload: CoreEventsMap[K]) => void;
  /**
   * P11: pushes the new loopback policy to the conversation's already-open
   * browser pages right after select/unbind (best-effort; pages that are not
   * open have nothing to update, and tools re-send the context on every call).
   */
  onBindingChanged?: (conversationId: string, allowLoopback: boolean) => void;
}

export interface LeaseTarget {
  /**
   * The bound project root, an authorized directory, or the workspace key
   * `ws:{botId}:{conversationId}` (D75 §5.2, see workspaceLeaseKey).
   */
  key: string;
  /** Set when the lease key is the bound project (checkpoints apply). */
  project: Project | null;
}

/**
 * D75 §5.2: lease key of a bot's workspace in one conversation
 * (`bots/{botId}/workspaces/{conversationId}/`). Not a path, so it never
 * collides with project / grant keys in leaseKeysConflict; workspaces have
 * no shadow-repo checkpoints (no `before`/`after`, no revert).
 */
export function workspaceLeaseKey(botId: string, conversationId: string): string {
  return `ws:${botId}:${conversationId}`;
}

/** D75 §2.1: why a supervisor turn may not write (tool error text). */
export const TURN_READ_ONLY_REASON =
  '对话轮是只读的：不能写文件、执行会改动文件的命令或申请写入。需要改动时请用 start_task 派出写任务（writes: true）';
/** D75 §5.1: why a read-only task may not write (tool error text). */
export const TASK_READ_ONLY_REASON =
  '这是只读任务（派出时未声明写入）：不能写文件、执行会改动文件的命令或申请写入。请在结果中说明需要的改动，由对话轮另派写任务';

interface RunLeaseState {
  key: string;
  project: Project | null;
  beforeOid: string | null;
  /**
   * D72（安全审查 M6）：外部智能体 run 开工前取得、整 run 持有的租约——
   * 该 run 内不能被别的租约目标替换（否则原 project 的「后」快照过早，而
   * Agent 仍在写它）。
   */
  pinned?: boolean;
}

/**
 * Project runtime (docs/dev/phases/P04-project.md): binding lifecycle, write
 * leases with waiting/running state transitions, checkpoint bookkeeping
 * (before at acquire / after at release → run_changes + summary card),
 * diff/revert and git remote execution. The gateway consults it for path
 * decisions and sandbox policy input; RPC binds user actions here.
 */
export class ProjectRuntime {
  readonly #deps: ProjectRuntimeDeps;
  /** Lease window currently tracked per run (one entry per acquire). */
  readonly #runLeases = new Map<string, RunLeaseState>();

  constructor(deps: ProjectRuntimeDeps) {
    this.#deps = deps;
  }

  // --- lookups ---------------------------------------------------------------

  /** The conversation's bound project with status refreshed from disk. */
  boundProject(conversationId: string | null): Project | null {
    if (conversationId === null) return null;
    const conv = this.#deps.conversations.get(conversationId);
    if (conv === null || conv.projectId === null) return null;
    const project = this.#deps.projects.get(conv.projectId);
    if (project === null) return null;
    const refreshed = this.#deps.projects.refreshStatus(project.id);
    if (refreshed.status !== project.status) {
      this.#deps.publish('project.updated', { project: refreshed });
    }
    return refreshed;
  }

  /**
   * D75 §2.1 / §5.1 execution-time read-only rule: null when the identity may
   * write, else the readable reason. A supervisor turn never writes; a task
   * writes only when it was created with `task_writes = true` (a missing run
   * row or null fails closed). Every other loop type is unaffected.
   */
  writeDenial(identity: RunIdentity): string | null {
    if (identity.loopType === 'turn') return TURN_READ_ONLY_REASON;
    if (identity.loopType === 'task') {
      return this.#deps.runs.get(identity.runId)?.taskWrites === true ? null : TASK_READ_ONLY_REASON;
    }
    return null;
  }

  /** True when the run currently holds the given project's write lease. */
  holdsLease(identity: RunIdentity, projectPath: string): boolean {
    return this.#deps.leases.heldKey(identity.runId, [projectPath]) !== null;
  }

  /** Sandbox policy input for the executing identity (null = no project). */
  policyInfo(identity: RunIdentity): {
    path: string;
    hasLease: boolean;
    allowedPorts: Project['allowedPorts'];
    denyReadGlobs: string[];
  } | null {
    const project = this.boundProject(identity.conversationId);
    if (project === null || project.status === 'missing') return null;
    return {
      path: project.path,
      hasLease: this.holdsLease(identity, project.path),
      allowedPorts: project.allowedPorts,
      denyReadGlobs: this.denyReadGlobs(project),
    };
  }

  /** Absolute glob patterns of the project's deny-read rules (policy denyRead). */
  denyReadGlobs(project: Project): string[] {
    const patterns: string[] = [];
    for (const pattern of project.protectRules.denyRead) {
      if (pattern.includes('/')) {
        patterns.push(`${project.path}/${pattern}`);
      } else {
        // Slash-less patterns match the file name at any depth.
        patterns.push(`${project.path}/${pattern}`);
        patterns.push(`${project.path}/**/${pattern}`);
      }
    }
    return patterns;
  }

  /** True when `resolvedPath` hits a protection rule of the project. */
  matchesProtectRule(project: Project, resolvedPath: string, mode: 'read' | 'write'): boolean {
    return matchProtectRule(project.protectRules, project.path, resolvedPath, mode);
  }

  // --- lease orchestration ---------------------------------------------------

  /**
   * Acquires the write lease covering `resolvedPath`: the bound project root,
   * the identity's own workspace (`ws:{botId}:{conversationId}`, D75 §5.2),
   * or the longest covering write grant outside both. Parks the run in
   * `waiting_lease` (publishing `lease.waiting`) while queued; snapshots the
   * project `before` once the lease is granted (workspace / grant targets
   * have no checkpoint). Aborting the signal leaves the queue cleanly.
   * Read-only identities (writeDenial) are refused with RUN_READ_ONLY.
   *
   * Workspace writes never *require* the lease (the gateway allows them
   * outright); only callers that ask for it — D75 write tasks, pinned for the
   * whole task — take it, so they serialize among themselves.
   */
  async ensureWriteLease(
    identity: RunIdentity,
    resolvedPath: string,
    options: {
      signal?: AbortSignal;
      reason?: string;
      /** D72：整 run 持有、不可被替换（外部智能体 run，见 RunLeaseState.pinned）。 */
      pin?: boolean;
    } = {},
  ): Promise<LeaseTarget> {
    const denial = this.writeDenial(identity);
    if (denial !== null) throw new AppError('RUN_READ_ONLY', denial);
    const target = this.#leaseTarget(identity, resolvedPath);
    if (target === null) {
      throw new AppError('INVALID_INPUT', '该路径不涉及 project 或 workspace，无需写入租约');
    }
    if (this.#deps.leases.heldKey(identity.runId, [target.key]) === target.key) {
      return target;
    }
    const current = this.#runLeases.get(identity.runId);
    if (current?.pinned === true && current.key !== target.key) {
      throw new AppError(
        'PATH_OUT_OF_SCOPE',
        `本次执行整体持有 ${current.key} 的写入租约，不能再写入其他租约目标：${resolvedPath}`,
      );
    }

    // One lease per run: close out the previous window first (after snapshot).
    await this.releaseRun(identity.runId);

    await this.#deps.leases.acquire(identity, target.key, {
      signal: options.signal,
      onWaiting: (holder) => {
        this.#setRunStatus(identity.runId, 'waiting_lease');
        this.#deps.publish('lease.waiting', {
          runId: identity.runId,
          conversationId: identity.conversationId,
          botId: identity.botId,
          path: target.key,
          holder,
        });
      },
    });
    // A cancelled run leaves the queue without ever being granted.
    if (this.#deps.leases.heldKey(identity.runId, [target.key]) !== target.key) {
      throw new AppError('APPROVAL_DENIED', '执行已取消，未取得写入租约');
    }

    if (target.project !== null) {
      const before = await this.#deps.checkpoints.snapshot(target.project);
      this.#runLeases.set(identity.runId, {
        key: target.key,
        project: target.project,
        beforeOid: before.oid,
        ...(options.pin === true ? { pinned: true } : {}),
      });
    } else {
      this.#runLeases.set(identity.runId, {
        key: target.key,
        project: null,
        beforeOid: null,
        ...(options.pin === true ? { pinned: true } : {}),
      });
    }

    this.#setRunStatus(identity.runId, 'running');
    return target;
  }

  /**
   * Ends the run's lease window: cancels queued waits, releases the lease and
   * (for project leases) commits the `after` snapshot, records run_changes
   * and appends the changes summary card when files actually changed.
   * Idempotent; safe to call from every settle path.
   */
  async releaseRun(runId: string): Promise<void> {
    this.#deps.leases.cancelWaitersOfRun(runId);
    this.#deps.leases.release(runId);
    const state = this.#runLeases.get(runId);
    if (state === undefined) return;
    this.#runLeases.delete(runId);
    if (state.project === null || state.beforeOid === null) return;
    try {
      const after = await this.#deps.checkpoints.snapshot(state.project);
      const files = await this.#deps.checkpoints.diffFiles(state.project.id, state.beforeOid, after.oid);
      const conv = this.#deps.runs.get(runId);
      const change = this.#deps.projects.recordChange({
        runId,
        projectId: state.project.id,
        conversationId: conv?.conversationId ?? null,
        beforeOid: state.beforeOid,
        afterOid: after.oid,
        files,
      });
      if (files.length > 0 && change.conversationId !== null) {
        this.#insertChangesCard(change.conversationId, runId);
      }
    } catch (error) {
      this.#deps.logger.error(
        { runId, error: error instanceof Error ? error.message : String(error) },
        'checkpoint after-snapshot failed',
      );
    }
  }

  // --- binding (RPC) -----------------------------------------------------------

  select(conversationId: string, dir: string): Project {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    this.#assertNoActiveRuns(conversationId);
    const project = this.#deps.projects.ensureByPath(dir, this.#deps.paths.home);
    const previousId = conv.projectId;
    this.#deps.conversations.setProject(conversationId, project.id);
    const previous = previousId !== null ? this.#deps.projects.get(previousId) : null;
    const label = `${project.name}（${project.path}）`;
    if (previousId === project.id) {
      this.#systemMessage(conversationId, `项目已确认为 ${label}`);
    } else if (previousId === null) {
      this.#systemMessage(conversationId, `项目已绑定为 ${label}`);
      this.#systemMessage(
        conversationId,
        '授权范围：此对话中的所有 Bot 都可以读写该目录；写入按租约串行执行，每次执行的改动可以在对话中查看 diff 或整次回退。目录中的 .env、*.pem 等敏感文件默认不可读，可在权限设置中调整。',
      );
    } else {
      this.#systemMessage(conversationId, `项目已从 ${previous?.name ?? previousId} 切换为 ${label}`);
    }
    this.#deps.logger.info({ conversationId, projectId: project.id }, 'project bound');
    this.#deps.onBindingChanged?.(conversationId, true);
    return project;
  }

  unbind(conversationId: string): void {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.projectId === null) return;
    this.#assertNoActiveRuns(conversationId);
    const project = this.#deps.projects.get(conv.projectId);
    this.#deps.conversations.setProject(conversationId, null);
    this.#systemMessage(conversationId, `已取消项目绑定（${project?.name ?? conv.projectId}）`);
    // Open pages lose loopback access immediately (P11 setNetworkContext).
    this.#deps.onBindingChanged?.(conversationId, false);
  }

  update(projectId: string, patch: Parameters<ProjectsService['update']>[1]): Project {
    const project = this.#deps.projects.update(projectId, patch);
    this.#deps.publish('project.updated', { project });
    return project;
  }

  /** Remove-from-recent cascade (docs/dev/03-data-model.md): records, checkpoints, bindings. */
  async remove(projectId: string): Promise<void> {
    const project = this.#deps.projects.getOrThrow(projectId);
    const bound = this.#deps.projects.conversationsBound(projectId);
    // 与绑定切换同一门闩：执行中的对话不能移除 project（BR-P04-002）——
    // 否则进行中写入失去策略、影子仓被删导致 after 快照失败。
    for (const conversationId of bound) {
      this.#assertNoActiveRuns(conversationId);
    }
    for (const conversationId of bound) {
      this.#deps.conversations.setProject(conversationId, null);
      this.#systemMessage(conversationId, `项目 ${project.name} 已从最近列表移除，绑定已取消`);
      this.#deps.publish('conversation.updated', {
        conversation: this.#deps.conversations.getOrThrow(conversationId),
      });
    }
    await this.#deps.checkpoints.forget(projectId);
    this.#deps.projects.remove(projectId);
    this.#deps.publish('project.removed', { id: projectId });
    this.#deps.logger.info({ projectId }, 'project removed');
  }

  /**
   * User force-revoke of the lease held on the conversation's project. The
   * holder's lease window is closed first (its `after` snapshot records its
   * own changes and drops the run's bookkeeping), so a later settle of the
   * revoked run can never fold other holders' changes into its run_changes
   * (BR-P04-001).
   */
  async revokeLease(conversationId: string): Promise<boolean> {
    const project = this.boundProject(conversationId);
    if (project === null) return false;
    const holder = this.#deps.leases.holderOf(project.path);
    if (holder === null) return false;
    await this.releaseRun(holder.runId);
    return true;
  }

  // --- diff / revert (RPC) ------------------------------------------------------

  /** Run-change record for context rendering; null when absent. */
  changesOf(runId: string) {
    return this.#deps.projects.getChange(runId);
  }

  async diff(runId: string): Promise<{ change: ReturnType<ProjectsService['getChange']>; diffText: string }> {
    const change = this.#deps.projects.getChange(runId);
    if (change === null) return { change: null, diffText: '' };
    if (change.revertedAt !== null || change.afterOid === null) {
      return { change, diffText: '' };
    }
    return {
      change,
      diffText: await this.#deps.checkpoints.diffText(change.projectId, change.beforeOid, change.afterOid),
    };
  }

  async revert(runId: string, force: boolean): Promise<{ ok: boolean; conflicts: string[]; reverted: string[] }> {
    const change = this.#deps.projects.getChange(runId);
    if (change === null || change.afterOid === null) {
      throw new AppError('NOT_FOUND', '该执行没有可回退的改动记录');
    }
    if (change.revertedAt !== null) {
      throw new AppError('INVALID_INPUT', '该执行的改动已经回退过');
    }
    const project = this.#deps.projects.getOrThrow(change.projectId);
    if (!existsSync(project.path)) {
      throw new AppError('PROJECT_MISSING', `项目目录不存在：${project.path}`);
    }

    const conflicts = await this.#revertConflicts(project.id, change.files, change.afterOid);
    if (conflicts.length > 0 && !force) {
      return { ok: false, conflicts, reverted: [] };
    }

    // Reverting mutates the project: it needs the write lease.
    const identity: RunIdentity = {
      runId: `revert_${newId('run').slice(4)}`,
      botId: null,
      conversationId: change.conversationId,
      loopType: 'response',
    };
    const holder = this.#deps.leases.holderOf(project.path);
    if (holder !== null) {
      throw new AppError('LEASE_HELD', 'Bot 正在修改该项目，请先取消或等待其完成');
    }
    await this.#deps.leases.acquire(identity, project.path);

    const reverted: string[] = [];
    try {
      for (const file of change.files) {
        const absolute = path.join(project.path, file.path);
        if (file.change === 'added') {
          rmSync(absolute, { force: true });
        } else {
          const content = await this.#deps.checkpoints.readFileAt(project.id, change.beforeOid, file.path);
          if (content === null) {
            rmSync(absolute, { force: true });
          } else {
            mkdirSync(path.dirname(absolute), { recursive: true });
            writeFileSync(absolute, content);
          }
        }
        reverted.push(file.path);
      }
    } finally {
      const after = await this.#deps.checkpoints.snapshot(project);
      this.#deps.leases.release(identity.runId);
      this.#deps.projects.recordChange({
        runId: identity.runId,
        projectId: project.id,
        conversationId: change.conversationId,
        beforeOid: change.afterOid,
        afterOid: after.oid,
        files: change.files.map((f) => ({
          path: f.path,
          change: f.change === 'added' ? 'deleted' : f.change === 'deleted' ? 'added' : 'modified',
        })),
      });
    }
    this.#deps.projects.markReverted(runId);
    if (change.conversationId !== null) {
      this.#systemMessage(
        change.conversationId,
        `已整次回退执行 ${runId} 的 ${reverted.length} 处改动${conflicts.length > 0 ? `（已强制覆盖 ${conflicts.length} 个冲突文件）` : ''}`,
      );
    }
    return { ok: true, conflicts: [], reverted };
  }

  async #revertConflicts(
    projectId: string,
    files: RunChangeFile[],
    afterOid: string,
  ): Promise<string[]> {
    const projectPath = this.#deps.projects.getOrThrow(projectId).path;
    const conflicts: string[] = [];
    for (const file of files) {
      const absolute = path.join(projectPath, file.path);
      const current = existsSync(absolute) ? readFileSync(absolute) : null;
      const after = await this.#deps.checkpoints.readFileAt(projectId, afterOid, file.path);
      if (!((current === null && after === null) || (current !== null && after !== null && current.equals(after)))) {
        conflicts.push(file.path);
      }
    }
    return conflicts;
  }

  // --- git remote --------------------------------------------------------------

  async gitRemote(
    identity: RunIdentity,
    input: { operation: GitRemoteOperation; args: string[]; reason: string },
    options: { signal?: AbortSignal; requestApproval: (payload: Record<string, unknown>) => Promise<'approved' | 'denied' | 'cancelled'> },
  ): Promise<{ exitCode: number | null; output: string }> {
    const project = this.boundProject(identity.conversationId);
    if (project === null) {
      throw new AppError('INVALID_INPUT', '当前对话未绑定 project，无法执行 git 远程操作');
    }
    if (project.status === 'missing') {
      throw new AppError('PROJECT_MISSING', `项目目录不存在：${project.path}`);
    }
    if (!gitCliAvailable()) {
      throw new AppError('GIT_CLI_MISSING', '系统未安装 git 命令行，无法执行远程操作');
    }
    const outcome = await options.requestApproval({
      operation: input.operation,
      args: input.args,
      cwd: project.path,
      reason: input.reason,
    });
    if (outcome !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户未批准该 git 远程操作');
    }
    const result = await runGitRemote({
      cwd: project.path,
      operation: input.operation,
      args: input.args,
      signal: options.signal,
    });
    return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  // --- prompt --------------------------------------------------------------------

  /** `<project>` system prompt section (null when nothing bound). */
  async promptSection(
    conversationId: string | null,
    options: { skipGuideFiles?: readonly string[] } = {},
  ): Promise<string | null> {
    const project = this.boundProject(conversationId);
    if (project === null || project.status !== 'available') return null;
    // Ignore verdicts come from the shadow repo (libgit2, exact semantics);
    // it is created lazily here — it lives in the data directory only.
    const repo = await this.#deps.checkpoints.ensureOpen(project);
    const isIgnored =
      repo !== null && project.path === (repo.workdir()?.replace(/\/+$/, '') ?? project.path)
        ? (relative: string) => repo.isPathIgnored(relative)
        : null;
    const section = await buildProjectSection({
      path: project.path,
      budget: PROJECT_SECTION_BUDGET,
      isIgnored,
      ...(options.skipGuideFiles !== undefined ? { skipGuideFiles: options.skipGuideFiles } : {}),
    });
    return section?.body ?? null;
  }

  // --- retention ----------------------------------------------------------------

  /** Background sweep of over-retained checkpoint repos (startup task). */
  applyRetention(): Promise<string[]> {
    return this.#deps.checkpoints.applyRetention(
      this.#deps.clock.now(),
      CHECKPOINT_RETENTION_DAYS,
    );
  }

  // --- internals -----------------------------------------------------------------

  #leaseTarget(identity: RunIdentity, resolvedPath: string): LeaseTarget | null {
    const project = this.boundProject(identity.conversationId);
    if (
      project !== null &&
      project.status === 'available' &&
      isInsidePath(resolvedPath, project.path)
    ) {
      return { key: project.path, project };
    }
    // D75 §5.2: the identity's own workspace (realpath-normalized on both
    // sides; the data home is canonical already, the workspace may not exist).
    if (identity.botId !== null && identity.conversationId !== null) {
      const workspace = canonicalPath(
        workspacePathFor(this.#deps.paths, identity.botId, identity.conversationId),
      );
      if (isInsidePath(canonicalPath(resolvedPath), workspace)) {
        return { key: workspaceLeaseKey(identity.botId, identity.conversationId), project: null };
      }
    }
    // Outside the project: the longest covering write grant defines the key.
    const grants = this.#deps.grants
      .listEffective(identity)
      .filter((g) => g.access === 'write' && isInsidePath(resolvedPath, g.path))
      .sort((a, b) => b.path.length - a.path.length);
    const grant = grants[0];
    return grant !== undefined ? { key: grant.path, project: null } : null;
  }

  #assertNoActiveRuns(conversationId: string): void {
    // P07 起：响应 run 之外还有后台反思 run（轻量模型、无工具、不触碰
    // project）——只有响应 loop 应阻止切换/移除 project。D75：对话轮与任务
    // 同理（任务可能正写 project）。
    const active = this.#deps.runs
      .listActiveByConversation(conversationId)
      .filter(
        (run) => run.loopType === 'response' || run.loopType === 'turn' || run.loopType === 'task',
      );
    if (active.length > 0) {
      throw new AppError(
        'PROJECT_SWITCH_BLOCKED',
        '有 Bot 正在执行，无法切换 project；请等待执行结束或先取消',
      );
    }
  }

  #systemMessage(conversationId: string, text: string): void {
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: 'project',
      text,
    });
    this.#deps.publish('message.created', { conversationId, message });
  }

  #insertChangesCard(conversationId: string, runId: string): void {
    const card = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'card',
      cardType: 'run_changes',
      cardRunId: runId,
      runId,
    });
    this.#deps.publish('message.created', { conversationId, message: card });
  }

  #setRunStatus(runId: string, status: 'waiting_lease' | 'running'): void {
    const run = this.#deps.runs.get(runId);
    if (!run) return;
    if (status === 'waiting_lease' && run.status !== 'running') return;
    if (status === 'running' && run.status !== 'waiting_lease') return;
    const updated = this.#deps.runs.update(runId, { status });
    this.#deps.publish('run.status', { run: updated });
  }
}

/**
 * Protect-rule matching (docs/dev/phases/P04-project.md): a rule without `/`
 * matches the file name at any depth (`*.pem`); a rule with `/` is anchored
 * to the project root and also covers everything beneath a matching
 * directory (`.git/hooks`).
 */
export function matchProtectRule(
  rules: Project['protectRules'],
  projectPath: string,
  resolvedPath: string,
  mode: 'read' | 'write',
): boolean {
  const patterns = mode === 'read' ? rules.denyRead : rules.denyWrite;
  if (patterns.length === 0) return false;
  const rel = path.relative(projectPath, resolvedPath).replaceAll('\\', '/');
  if (rel.length === 0 || rel.startsWith('..')) return false;
  const name = rel.split('/').pop() ?? rel;
  for (const pattern of patterns) {
    if (pattern.includes('/')) {
      const dirPrefix = pattern.replace(/\/+$/, '');
      if (globMatch(pattern, rel) || rel.startsWith(`${dirPrefix}/`)) return true;
    } else if (globMatch(pattern, name)) {
      return true;
    }
  }
  return false;
}

/** Minimal glob: `*` within a segment, `**` across segments, `?` single char. */
export function globMatch(pattern: string, value: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more segments; a bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          source += '.*';
          i++;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(value);
}

export type { LeaseHolder };
