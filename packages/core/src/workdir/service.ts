import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { rmSync } from '../infra/fs-rm.js';
import path from 'node:path';

import {
  AppError,
  CHECKPOINT_RETENTION_DAYS,
  newId,
  newUlid,
  type LoopType as SharedLoopType,
  type Workdir,
  type Run,
  type RunChangeFile,
} from '@kepcup/shared';
import { isInsidePath } from '../sandbox/sensitive-paths.js';
import type { RunIdentity } from '../agent/types.js';
import type { LeaseHolder, LeaseService } from './lease.js';
import { encodeWriteDomainKey, absolutePatterns, formatWriteDomain, type AbsDomain } from './domains.js';
import type { CheckpointService } from './checkpoints.js';
import { buildWorkdirSection, WORKDIR_SECTION_BUDGET } from './context.js';
import { gitCliAvailable, runGitRemote, type GitRemoteOperation } from './git-remote.js';
import type { WorkdirsService } from '../domain/workdirs.js';
import type { ConversationsService } from '../domain/conversations.js';
import { projectScopeOf } from '../domain/project-scope.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { BotsService } from '../domain/bots.js';
import type { GrantsService } from '../permissions/grants.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import { canonicalPath, workspacePathFor, type AppPaths } from '../infra/paths.js';
import type { CoreEventsMap } from '../start-types.js';

export interface WorkdirRuntimeDeps {
  db: SqliteDatabase;
  paths: AppPaths;
  clock: Clock;
  logger: CoreLogger;
  workdirs: WorkdirsService;
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
  /**
   * 62.11 C9 workdir root constraint (`CoreServicesOptions.workdirRoots`): when
   * set, only paths under one of these roots can be bound (`select`) or used
   * as a task cwd; anything else fails with `PATH_OUT_OF_SCOPE`. The roots are
   * canonicalized (realpath) once here; member paths are compared segment-wise
   * so `/a/b` never covers `/a/bc`. Absent / empty = unrestricted (status quo).
   * The first root is also where {@link provisionWorkdir} creates directories.
   */
  roots?: string[];
}

export interface LeaseTarget {
  /**
   * The bound workdir root, an authorized directory, or the workspace key
   * `ws:{botId}:{conversationId}` (D75 §5.2, see workspaceLeaseKey).
   */
  key: string;
  /** Set when the lease key is the bound workdir (checkpoints apply). */
  workdir: Workdir | null;
}

/**
 * D75 §5.2: lease key of a bot's workspace in one conversation
 * (`bots/{botId}/workspaces/{conversationId}/`). Not a path, so it never
 * collides with workdir / grant keys in leaseKeysConflict; workspaces have
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
/** A sub run (delegate_task) whose owning run cannot be resolved fails closed. */
export const SUBAGENT_UNRESOLVED_READ_ONLY_REASON =
  '无法确认这个子代理所属的执行是否允许写入，按只读处理：不能写文件、执行会改动文件的命令或申请写入';
/** A write task's sub run that outlives the task (its pinned lease is gone). */
export const SUBAGENT_PARENT_ENDED_READ_ONLY_REASON =
  '这个子代理所属的写任务已经结束（写入租约已释放），子代理不能再写文件或执行会改动文件的命令';

/**
 * Design 30 §5.1: the user force-revoked the lease a pinned write task held —
 * the task lost its write permission for the rest of its execution.
 */
export const LEASE_REVOKED_READ_ONLY_REASON =
  '写入租约已被用户收回：这个任务不能再写文件、执行会改动文件的命令或申请写入。请在结果里说明已完成的改动与还没做的部分';

/** Bound on the set of revoked pinned runs remembered (oldest forgotten first). */
const REVOKED_RUNS_REMEMBERED = 512;

/** Bound on the sub run → parent run walk (sub runs do not nest today). */
const SUBAGENT_PARENT_MAX_DEPTH = 4;

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

interface RunLeaseState {
  key: string;
  workdir: Workdir | null;
  beforeOid: string | null;
  /**
   * D72（安全审查 M6）：外部智能体 run 开工前取得、整 run 持有的租约——
   * 该 run 内不能被别的租约目标替换（否则原 workdir 的「后」快照过早，而
   * Agent 仍在写它）。
   */
  pinned?: boolean;
  /**
   * D140-1：内置引擎写任务取共享租约（同根多任务并存）；独占为缺省——
   * 外部智能体 run、宿主操作与非任务的 acquire_workdir_write。
   */
  shared?: boolean;
}

/**
 * D140-1 per-run shadow-snapshot window: opened when a write task starts (a
 * `before` snapshot while it holds the lease) and closed at its release point
 * (an `after` snapshot + the run's `run_changes` row, with files another
 * parallel task also changed marked `interleaved`).
 */
interface TaskWindowState {
  workdirId: string;
  beforeOid: string;
  /**
   * Relative paths written by other task windows that overlapped this one (a
   * peer that closed while ours was open). They are excluded from our span
   * diff (the peer's own row owns them) and mark our own writes interleaved.
   */
  otherFiles: Set<string>;
}

/** What one run's file tools actually wrote (attribution for run_changes). */
export interface RunWriteAttribution {
  /** Absolute paths this run wrote through the gateway's file tools. */
  own: ReadonlyArray<{ path: string; change: 'created' | 'modified' | 'deleted' }>;
  /** Absolute paths other still-running tasks wrote (interleaved marking). */
  others: ReadonlySet<string>;
}

/** fs-state's per-file change kind → run_changes spelling. */
const toChangeKind = (change: 'created' | 'modified' | 'deleted'): RunChangeFile['change'] =>
  change === 'created' ? 'added' : change;

/**
 * Workdir runtime (docs/dev/phases/P04-project.md): binding lifecycle, write
 * leases with waiting/running state transitions, and git remote execution.
 * D140-1: write tasks open a per-run shadow-snapshot window whose close records
 * `run_changes` (file list + `interleaved` marks) on the task detail page; the
 * chat-side change card and whole-run revert UX stay retired. The gateway
 * consults it for path decisions and sandbox policy input; RPC binds user
 * actions here.
 */
export class WorkdirRuntime {
  readonly #deps: WorkdirRuntimeDeps;
  /** Lease window currently tracked per run (one entry per acquire). */
  readonly #runLeases = new Map<string, RunLeaseState>();
  /**
   * Pinned runs (D75 write tasks, D72 agent runs) whose lease the user
   * force-revoked: they lost write permission (design 30 §5.1) and never
   * silently re-take the lease.
   */
  readonly #revokedPinned = new Set<string>();
  /**
   * Acquisitions in flight per run: parallel tool calls of one run asking for
   * the same key join the first instead of releasing + cancelling it.
   */
  readonly #acquiring = new Map<string, { key: string; promise: Promise<LeaseTarget> }>();
  /** D140-1: open per-task shadow-snapshot windows (run id → window). */
  readonly #taskWindows = new Map<string, TaskWindowState>();
  /**
   * Closes in flight per workdir: closing windows one at a time lets the peer
   * still open hand its files over (exclusion + interleaved marks) instead of
   * two concurrent closes each claiming the other's writes.
   */
  readonly #windowClosings = new Map<string, Promise<void>>();
  /** Run windows currently closing (a second release waits for the first). */
  readonly #closingWindows = new Map<string, Promise<void>>();
  /** Releases in flight per run (a re-acquire waits for the old release). */
  readonly #releasing = new Map<string, Promise<void>>();
  /** C9: canonicalized root paths (empty = unrestricted). */
  readonly #roots: readonly string[];

  constructor(deps: WorkdirRuntimeDeps) {
    this.#deps = deps;
    this.#roots = (deps.roots ?? []).map((root) => canonicalPath(root));
  }

  // --- lookups ---------------------------------------------------------------

  /** The conversation's bound workdir with status refreshed from disk. */
  boundWorkdir(conversationId: string | null): Workdir | null {
    if (conversationId === null) return null;
    const conv = this.#deps.conversations.get(conversationId);
    if (conv === null) return null;
    // A card chat does not copy the workdir; it uses the parent project's.
    const scoped =
      conv.type === 'card'
        ? (() => {
            const projectId = projectScopeOf(conv);
            return projectId === null ? null : this.#deps.conversations.get(projectId);
          })()
        : conv;
    if (scoped === null || scoped.workdirId === null) return null;
    const workdir = this.#deps.workdirs.get(scoped.workdirId);
    if (workdir === null) return null;
    const refreshed = this.#deps.workdirs.refreshStatus(workdir.id);
    if (refreshed.status !== workdir.status) {
      this.#deps.publish('workdir.updated', { workdir: refreshed });
    }
    return refreshed;
  }

  /**
   * D75 §2.1 / §5.1 execution-time read-only rule: null when the identity may
   * write, else the readable reason. A supervisor turn never writes; a task
   * writes only when it was created with `task_writes = true` (a missing run
   * row or null fails closed). A sub run (`delegate_task`, loop type
   * `subagent`) follows the rule of the run that owns it — resolved through
   * `parent_run_id` up to the root, bounded and failing closed when the chain
   * breaks — so a read-only task cannot write through a delegated `bash`, and
   * a write task's sub run writes only while the task holds its pinned lease
   * — it stops once the task ended, or released the lease while its
   * settlement is still pending (审查 round 2 #6). Every other loop type is
   * unaffected.
   */
  writeDenial(identity: RunIdentity): string | null {
    // Identity and run rows use two LoopType unions (core vs shared); this walks both.
    let loopType: RunIdentity['loopType'] | SharedLoopType = identity.loopType;
    let runId = identity.runId;
    for (let depth = 0; loopType === 'subagent'; depth += 1) {
      const parentId =
        depth < SUBAGENT_PARENT_MAX_DEPTH ? (this.#deps.runs.get(runId)?.parentRunId ?? null) : null;
      const parent = parentId !== null ? this.#deps.runs.get(parentId) : null;
      if (parent === null) return SUBAGENT_UNRESOLVED_READ_ONLY_REASON;
      loopType = parent.loopType;
      runId = parent.id;
    }
    if (loopType === 'turn') return TURN_READ_ONLY_REASON;
    if (this.#revokedPinned.has(runId)) return LEASE_REVOKED_READ_ONLY_REASON;
    if (loopType === 'task') {
      const task = this.#deps.runs.get(runId);
      if (task?.taskWrites !== true) return TASK_READ_ONLY_REASON;
      if (
        runId !== identity.runId &&
        (TERMINAL_RUN_STATUSES.has(task.status) || this.#deps.leases.keyOf(runId) === null)
      ) {
        return SUBAGENT_PARENT_ENDED_READ_ONLY_REASON;
      }
    }
    return null;
  }

  /** True when the run currently holds the given workdir's write lease. */
  holdsLease(identity: RunIdentity, workdirPath: string): boolean {
    return this.#deps.leases.heldKey(identity.runId, [workdirPath]) !== null;
  }

  /**
   * D123 §3.6: null when the writing task's resolved path stays inside its
   * declared write domain, else the refusal reason. Read-only identities and
   * undeclared domains (`writes: true`) always pass. Fail-closed: a missing
   * run row, an unresolved subagent parent, a missing cwd or an unparseable
   * declaration denies the write.
   */
  writeOutOfDomain(identity: RunIdentity, resolvedPath: string): string | null {
    const task = this.#writingTask(identity);
    if (task === 'missing') return '无法确认写入任务的写域，已拒绝写入';
    if (task === null || task.taskWrites !== true) return null;
    if (task.taskWriteDomainsCorrupt === true) {
      return '任务写域声明无法解析，已拒绝写入（需要越域请用 ask_user 说明缘由，由对话轮改派）';
    }
    const patterns = task.taskWriteDomains;
    if (patterns === null || patterns === undefined) return null;
    if (patterns.length === 0) return '任务写域为空，已拒绝写入';
    if (patterns.length === 1 && patterns[0] === '**') return null;
    if (task.taskCwd === null) return '任务写域缺少工作目录，已拒绝写入';
    return pathMatchesPatterns(task.taskCwd, patterns, resolvedPath)
      ? null
      : `写域之外的路径：${resolvedPath}。本任务的写域：${formatWriteDomain(patterns)}` +
          '。需要越域请用 ask_user 说明缘由，由对话轮改派或换域后重派';
  }

  /** D123: the task row that writes for `identity` (subagent → owning task). */
  owningTask(identity: RunIdentity): Run | null {
    const task = this.#writingTask(identity);
    return task === 'missing' ? null : task;
  }

  /** D123 §3.6 sandbox input: the declared write domain, null when undeclared. */
  writeDomain(identity: RunIdentity): AbsDomain | null {
    const task = this.#writingTask(identity);
    if (task === 'missing' || task === null || task.taskWrites !== true) return null;
    // A declaration we cannot read must not widen the sandbox: empty patterns
    // are expressible (nothing writable) and leave the task read-only.
    if (task.taskWriteDomainsCorrupt === true) {
      return { root: task.taskCwd ?? '/', patterns: [] };
    }
    const patterns = task.taskWriteDomains;
    if (patterns === null || patterns === undefined) return null;
    if (patterns.length === 0) return { root: task.taskCwd ?? '/', patterns: [] };
    if (patterns.length === 1 && patterns[0] === '**') return null;
    if (task.taskCwd === null) return null;
    return { root: task.taskCwd, patterns };
  }

  /**
   * The task row that writes for `identity` (subagent → owning task), or
   * `'missing'` when the subagent chain cannot be resolved.
   */
  #writingTask(identity: RunIdentity): Run | null | 'missing' {
    let loopType: RunIdentity['loopType'] | SharedLoopType = identity.loopType;
    let runId = identity.runId;
    for (let depth = 0; loopType === 'subagent'; depth += 1) {
      const parentId =
        depth < SUBAGENT_PARENT_MAX_DEPTH
          ? (this.#deps.runs.get(runId)?.parentRunId ?? null)
          : null;
      const parent = parentId !== null ? this.#deps.runs.get(parentId) : null;
      if (parent === null) return 'missing';
      loopType = parent.loopType;
      runId = parent.id;
    }
    if (loopType !== 'task') return null;
    return this.#deps.runs.get(runId) ?? 'missing';
  }

  /** Sandbox policy input for the executing identity (null = no workdir). */
  policyInfo(identity: RunIdentity): {
    path: string;
    hasLease: boolean;
    allowedPorts: Workdir['allowedPorts'];
    denyReadGlobs: string[];
  } | null {
    const workdir = this.boundWorkdir(identity.conversationId);
    if (workdir === null || workdir.status === 'missing') return null;
    return {
      path: workdir.path,
      hasLease: this.holdsLease(identity, workdir.path),
      allowedPorts: workdir.allowedPorts,
      denyReadGlobs: this.denyReadGlobs(workdir),
    };
  }

  /** Absolute glob patterns of the workdir's deny-read rules (policy denyRead). */
  denyReadGlobs(workdir: Workdir): string[] {
    const patterns: string[] = [];
    for (const pattern of workdir.protectRules.denyRead) {
      if (pattern.includes('/')) {
        patterns.push(`${workdir.path}/${pattern}`);
      } else {
        // Slash-less patterns match the file name at any depth.
        patterns.push(`${workdir.path}/${pattern}`);
        patterns.push(`${workdir.path}/**/${pattern}`);
      }
    }
    return patterns;
  }

  /** True when `resolvedPath` hits a protection rule of the workdir. */
  matchesProtectRule(workdir: Workdir, resolvedPath: string, mode: 'read' | 'write'): boolean {
    return matchProtectRule(workdir.protectRules, workdir.path, resolvedPath, mode);
  }

  // --- lease orchestration ---------------------------------------------------

  /**
   * Acquires the write lease covering `resolvedPath`: the bound workdir root,
   * the identity's own workspace (`ws:{botId}:{conversationId}`, D75 §5.2),
   * or the longest covering write grant outside both. Parks the run in
   * `waiting_lease` (publishing `lease.waiting`) while queued. Aborting the
   * signal leaves the queue cleanly. Read-only identities (writeDenial) are
   * refused with RUN_READ_ONLY. D140-1: `shared` requests coexist with other
   * shared holders (built-in write tasks); the default is exclusive.
   *
   * Workspace writes never *require* the lease (the gateway allows them
   * outright); only callers that ask for it — D75 write tasks, pinned for the
   * whole task — take it. The per-run shadow window is opened separately by
   * `beginTaskWindow` once the lease is held.
   */
  async ensureWriteLease(
    identity: RunIdentity,
    resolvedPath: string,
    options: {
      signal?: AbortSignal;
      reason?: string;
      /** D72：整 run 持有、不可被替换（外部智能体 run，见 RunLeaseState.pinned）。 */
      pin?: boolean;
      /**
       * D140-1：取共享租约（同根多任务并存，内置引擎写任务）。缺省独占——
       * 外部智能体 run、宿主操作与非任务的 acquire_workdir_write 不共享。
       */
      shared?: boolean;
      /**
       * D123: declared write-domain globs of a pinned write task. Encoded into
       * the lease key so two tasks on one root with disjoint domains coexist.
       * Null / omitted = the whole root (`['**']`, today's behavior).
       */
      domains?: string[] | null;
    } = {},
  ): Promise<LeaseTarget> {
    const denial = this.writeDenial(identity);
    if (denial !== null) throw new AppError('RUN_READ_ONLY', denial);
    // A retried run may still be releasing its previous lease/window (the
    // settle path is fire-and-forget): joining it here keeps the early
    // "already held" return from handing the task a lease that is about to be
    // released under it.
    const releasing = this.#releasing.get(identity.runId);
    if (releasing !== undefined) await releasing.catch(() => {});
    const target = this.#leaseTarget(identity, resolvedPath, options.domains ?? null);
    if (target === null) {
      throw new AppError('INVALID_INPUT', '该路径不涉及 workdir 或 workspace，无需写入租约');
    }
    // Same run, same key, already being acquired (parallel write / edit
    // calls): join it. A second acquisition would release the run's lease
    // window and cancel the first wait. Another key still replaces the run's
    // one lease (cancelling it).
    const inflight = this.#acquiring.get(identity.runId);
    if (inflight !== undefined && inflight.key === target.key) {
      return joinUnlessAborted(inflight.promise, options.signal);
    }
    if (this.#deps.leases.heldKey(identity.runId, [target.key]) === target.key) {
      return target;
    }
    // A task pinned to a domain key already holds a conflicting lease on the
    // same root. Asking for the bare root (acquire_workdir_write) must not
    // widen or fail: the gateway still enforces the domain per path.
    const held = this.#deps.leases.heldKey(identity.runId, [target.key]);
    if (held !== null && options.domains == null) {
      return { key: held, workdir: target.workdir };
    }
    const current = this.#runLeases.get(identity.runId);
    if (current?.pinned === true && current.key !== target.key) {
      throw new AppError(
        'PATH_OUT_OF_SCOPE',
        `本次执行整体持有 ${current.key} 的写入租约，不能再写入其他租约目标：${resolvedPath}`,
      );
    }

    const promise = this.#acquireLease(identity, target, options);
    this.#acquiring.set(identity.runId, { key: target.key, promise });
    try {
      return await promise;
    } finally {
      if (this.#acquiring.get(identity.runId)?.promise === promise) {
        this.#acquiring.delete(identity.runId);
      }
    }
  }

  async #acquireLease(
    identity: RunIdentity,
    target: LeaseTarget,
    options: { signal?: AbortSignal; pin?: boolean; shared?: boolean },
  ): Promise<LeaseTarget> {
    // One lease per run: close out the previous window first.
    await this.releaseRun(identity.runId);

    await this.#deps.leases.acquire(identity, target.key, {
      signal: options.signal,
      shared: options.shared === true,
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

    // Track the lease window for revoke / pin only. D140-1's before snapshot is
    // the per-task shadow window (`beginTaskWindow`), opened by the executor
    // after this lease is held.
    this.#runLeases.set(identity.runId, {
      key: target.key,
      workdir: target.workdir,
      beforeOid: null,
      ...(options.pin === true ? { pinned: true } : {}),
      ...(options.shared === true ? { shared: true } : {}),
    });

    this.#setRunStatus(identity.runId, 'running');
    return target;
  }

  /**
   * Ends the run's lease window: cancels queued waits, closes the D140-1
   * shadow-snapshot window (after-snapshot + run_changes), and releases the
   * lease. The after-snapshot is taken while the lease is still held — a
   * promoted waiter (the next writer) must not be able to start before the
   * span ends, or its writes would pollute this run's diff. Idempotent and
   * concurrency-safe: a second caller waits for the in-flight close (the lease
   * is released only after the snapshot, on every path).
   */
  async releaseRun(runId: string, writes?: RunWriteAttribution): Promise<void> {
    const inFlight = this.#releasing.get(runId);
    if (inFlight !== undefined) {
      await inFlight.catch(() => {});
      return;
    }
    const release = this.#doReleaseRun(runId, writes);
    this.#releasing.set(runId, release);
    try {
      await release;
    } finally {
      if (this.#releasing.get(runId) === release) this.#releasing.delete(runId);
    }
  }

  async #doReleaseRun(runId: string, writes?: RunWriteAttribution): Promise<void> {
    this.#deps.leases.cancelWaitersOfRun(runId);
    try {
      // A close in flight is awaited first; a retried run may already have a
      // NEW window by then (same run id), so re-check instead of skipping it.
      // The bound keeps a pathological retry loop from hanging the release.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const closing = this.#closingWindows.get(runId);
        if (closing !== undefined) {
          await closing.catch(() => {});
          if (this.#closingWindows.get(runId) === closing) this.#closingWindows.delete(runId);
          continue;
        }
        if (!this.#taskWindows.has(runId)) break;
        let attribution = writes;
        if (attribution === undefined && this.#attributionOf !== null) {
          try {
            attribution = this.#attributionOf(runId);
          } catch (error) {
            this.#deps.logger.warn(
              { runId, error: error instanceof Error ? error.message : String(error) },
              'task window write attribution failed',
            );
          }
        }
        const closingPromise = this.#endTaskWindow(runId, attribution);
        this.#closingWindows.set(runId, closingPromise);
        try {
          await closingPromise;
        } finally {
          if (this.#closingWindows.get(runId) === closingPromise) {
            this.#closingWindows.delete(runId);
          }
        }
      }
    } finally {
      // The lease is always released, even when the snapshot bookkeeping failed.
      this.#deps.leases.release(runId);
      this.#runLeases.delete(runId);
    }
  }

  /**
   * D140-1: the orchestrator's per-run write attribution (its own file-tool
   * writes and those of parallel open-window tasks). Release paths without
   * executor context (the revoke RPC, eviction) fall back to it so a window
   * closed outside the executor still attributes files correctly.
   */
  setWriteAttributionSource(source: ((runId: string) => RunWriteAttribution) | null): void {
    this.#attributionOf = source;
  }

  #attributionOf: ((runId: string) => RunWriteAttribution) | null = null;

  // --- per-task shadow window (D140-1) ----------------------------------------

  /** The open task windows (run id + workdir), for interleaved attribution. */
  openTaskWindows(): Array<{ runId: string; workdirId: string }> {
    return [...this.#taskWindows.entries()].map(([runId, window]) => ({
      runId,
      workdirId: window.workdirId,
    }));
  }

  /**
   * D140-1: opens the task's shadow-snapshot window — a `before` snapshot of
   * the workdir taken while the task holds its lease. Write tasks on a bound
   * workdir only (workspace / read-only tasks and turns never open one); an
   * external agent's write task opens it too (its exclusive lease still
   * serializes it, but run_changes is still recorded).
   */
  async beginTaskWindow(task: Run): Promise<void> {
    if (task.taskWrites !== true || task.conversationId === null) return;
    const workdir = this.boundWorkdir(task.conversationId);
    if (workdir === null || workdir.status !== 'available') return;
    if (task.taskCwd === null || !isInsidePath(task.taskCwd, workdir.path)) return;
    try {
      const before = await this.#deps.checkpoints.snapshot(workdir);
      this.#taskWindows.set(task.id, {
        workdirId: workdir.id,
        beforeOid: before.oid,
        otherFiles: new Set(),
      });
    } catch (error) {
      // A missing git / broken shadow repo must not fail the task: the window
      // is bookkeeping, run_changes is simply absent for it.
      this.#deps.logger.warn(
        { taskId: task.id, workdirId: workdir.id, error: error instanceof Error ? error.message : String(error) },
        'task window begin snapshot failed',
      );
    }
  }

  /**
   * D140-1: closes the window — after-snapshot, then the run's `run_changes`:
   * files are the task's own gateway-recorded writes (exact attribution) plus
   * span-diff files no other overlapping task wrote (bash writes; marked
   * `interleaved` when another window was open — a parallel task may have
   * written them). A file another overlapping task also wrote is marked
   * `interleaved`; files of a task whose window already closed while ours was
   * open are excluded too (their own row owns them), so a finished parallel
   * task's work is never attributed to this one.
   *
   * Closes run one at a time per workdir (windows stay registered until their
   * turn), which is what makes the hand-over deterministic. A retried run
   * re-opens a window with the same run id: its new files merge into the row
   * instead of replacing the earlier attempt's.
   */
  async #endTaskWindow(runId: string, writes?: RunWriteAttribution): Promise<void> {
    const window = this.#taskWindows.get(runId);
    if (window === undefined) return;
    const workdirId = window.workdirId;
    const previous = this.#windowClosings.get(workdirId) ?? Promise.resolve();
    const closing = previous
      .catch(() => {})
      .then(() => this.#closeTaskWindow(runId, window, writes));
    this.#windowClosings.set(workdirId, closing);
    try {
      await closing;
    } finally {
      if (this.#windowClosings.get(workdirId) === closing) this.#windowClosings.delete(workdirId);
    }
  }

  async #closeTaskWindow(
    runId: string,
    window: TaskWindowState,
    writes?: RunWriteAttribution,
  ): Promise<void> {
    // A retried run may have opened a NEW window under the same id while this
    // close was queued: only this exact window is closed/removed.
    if (this.#taskWindows.get(runId) === window) this.#taskWindows.delete(runId);
    const overlapping = [...this.#taskWindows.entries()].filter(
      ([id, other]) => id !== runId && other.workdirId === window.workdirId,
    );
    let workdirForLog: string = window.workdirId;
    try {
      const task = this.#deps.runs.get(runId);
      const workdir = this.#deps.workdirs.get(window.workdirId);
      if (workdir === null) return;
      workdirForLog = workdir.id;
      const after = await this.#deps.checkpoints.snapshot(workdir);
      const span = await this.#deps.checkpoints.diffFiles(workdir.id, window.beforeOid, after.oid);
      const own = new Map<string, RunChangeFile['change']>();
      for (const file of writes?.own ?? []) {
        const rel = path.relative(workdir.path, file.path).replaceAll('\\', '/');
        if (rel.length === 0 || rel.startsWith('../')) continue;
        own.set(rel, toChangeKind(file.change));
      }
      const others = new Set<string>(window.otherFiles);
      for (const absolute of writes?.others ?? []) {
        const rel = path.relative(workdir.path, absolute).replaceAll('\\', '/');
        if (rel.length > 0 && !rel.startsWith('../')) others.add(rel);
      }
      // A task that started while the snapshot was running overlaps too.
      const laterOpen = [...this.#taskWindows.entries()].filter(
        ([id, other]) => id !== runId && other.workdirId === window.workdirId,
      );
      const parallel = new Map<string, TaskWindowState>([...overlapping, ...laterOpen]);
      const files: RunChangeFile[] = [];
      for (const [rel, change] of own) {
        const interleaved = others.has(rel);
        files.push({ path: rel, change, ...(interleaved ? { interleaved: true } : {}) });
      }
      for (const file of span) {
        if (own.has(file.path) || others.has(file.path)) continue;
        // Not attributed to any overlapping task's file tools: a bash write of
        // this run (or, when a parallel writer was open, possibly theirs).
        files.push({
          path: file.path,
          change: file.change,
          ...(parallel.size > 0 ? { interleaved: true } : {}),
        });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      // A retried run (same run id) keeps the union of its attempts' files: the
      // previous row's before-oid stays the earliest, the after-oid advances.
      const previous = this.#deps.workdirs.getChange(runId);
      const merged = new Map<string, RunChangeFile>();
      for (const file of previous?.files ?? []) merged.set(file.path, file);
      for (const file of files) merged.set(file.path, file);
      const allFiles = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
      if (allFiles.length > 0) {
        this.#deps.workdirs.recordChange({
          runId,
          workdirId: workdir.id,
          conversationId: task?.conversationId ?? null,
          beforeOid: previous?.beforeOid ?? window.beforeOid,
          afterOid: after.oid,
          files: allFiles,
        });
      }
      // Overlapping windows exclude this run's files from their own span diffs
      // and mark them interleaved: whoever closes last must not claim the other.
      for (const other of parallel.values()) {
        for (const file of allFiles) other.otherFiles.add(file.path);
      }
    } catch (error) {
      this.#deps.logger.warn(
        { runId, workdirId: workdirForLog, error: error instanceof Error ? error.message : String(error) },
        'task window end snapshot failed',
      );
    }
  }

  // --- binding -----------------------------------------------------------------

  /**
   * C9: whether the canonical `candidate` sits at or below one of the
   * configured roots. Segment-wise comparison: `/a/b` must not cover `/a/bc`,
   * so the prefix is always a root plus a path separator (or the root itself).
   */
  #inRoots(candidate: string): boolean {
    if (this.#roots.length === 0) return true;
    return this.#roots.some((root) => {
      if (candidate === root) return true;
      const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      return candidate.startsWith(prefix);
    });
  }

  /**
   * C9: throws `PATH_OUT_OF_SCOPE` when workdir roots are configured and
   * `candidate` is not under any of them (no-op when unrestricted).
   */
  assertInRoots(candidate: string): void {
    if (this.#inRoots(canonicalPath(candidate))) return;
    throw new AppError(
      'PATH_OUT_OF_SCOPE',
      `路径不在允许的工作目录根之下：${candidate}（本环境只允许在配置的 workdir 根目录内选择工作目录）`,
    );
  }

  /**
   * Binds the conversation to `dir` (RPC `workdirs.select` and the interview
   * directory card both land here). This is the one place that broadcasts the
   * binding: the renderer's `workdirs.recent` feeds every workdir row
   * (`workdirs.boundOf`), so a binding that only publishes
   * `conversation.updated` leaves the right-panel Bot detail showing
   * 「未设置」 until a full refresh re-lists the workdirs.
   */
  select(conversationId: string, dir: string): Workdir {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    this.#assertNoActiveRuns(conversationId);
    // C9: validate the canonical path BEFORE the (row-creating) registration
    // so an out-of-scope path leaves no workdirs row behind.
    this.assertInRoots(dir);
    const workdir = this.#deps.workdirs.ensureByPath(dir, this.#deps.paths.home);
    const previousId = conv.workdirId;
    this.#deps.conversations.setWorkdir(conversationId, workdir.id);
    const previous = previousId !== null ? this.#deps.workdirs.get(previousId) : null;
    const label = `${workdir.name}（${workdir.path}）`;
    if (previousId === workdir.id) {
      this.#systemMessage(conversationId, `工作目录已确认为 ${label}`);
    } else if (previousId === null) {
      // 只落绑定通知。授权范围（成员可读写、写入按租约串行、敏感文件默认保护）
      // 属于对话配置说明，Bot 无需感知，不再发进消息列表（docs/design/08-workdir.md）。
      this.#systemMessage(conversationId, `工作目录已绑定为 ${label}`);
    } else {
      this.#systemMessage(conversationId, `工作目录已从 ${previous?.name ?? previousId} 切换为 ${label}`);
    }
    this.#deps.logger.info({ conversationId, workdirId: workdir.id }, 'workdir bound');
    this.#deps.onBindingChanged?.(conversationId, true);
    this.#deps.publish('workdir.updated', { workdir });
    this.#deps.publish('conversation.updated', {
      conversation: this.#deps.conversations.getOrThrow(conversationId),
    });
    return workdir;
  }

  unbind(conversationId: string): void {
    const conv = this.#deps.conversations.getOrThrow(conversationId);
    if (conv.workdirId === null) return;
    this.#assertNoActiveRuns(conversationId);
    const workdir = this.#deps.workdirs.get(conv.workdirId);
    this.#deps.conversations.setWorkdir(conversationId, null);
    this.#systemMessage(conversationId, `已取消工作目录绑定（${workdir?.name ?? conv.workdirId}）`);
    // Open pages lose loopback access immediately (P11 setNetworkContext).
    this.#deps.onBindingChanged?.(conversationId, false);
    // Same broadcast contract as select() — see the note there.
    this.#deps.publish('conversation.updated', {
      conversation: this.#deps.conversations.getOrThrow(conversationId),
    });
  }

  update(workdirId: string, patch: Parameters<WorkdirsService['update']>[1]): Workdir {
    const workdir = this.#deps.workdirs.update(workdirId, patch);
    this.#deps.publish('workdir.updated', { workdir });
    return workdir;
  }

  /**
   * C15 host write entry (`principalOps.provisionWorkdir`): creates a fresh
   * directory under the first configured root (`<slug>-<ulid tail>`), binds it
   * to the conversation and returns it. Throws `INVALID_INPUT` when no roots
   * are configured (the host must opt in to directory provisioning). The bind
   * goes through {@link select} — the C9 root check passes by construction.
   */
  provisionWorkdir(conversationId: string, name: string): Workdir {
    const root = this.#roots[0];
    if (root === undefined) {
      throw new AppError(
        'INVALID_INPUT',
        '本环境没有配置工作目录根（workdirRoots），无法自动创建工作目录',
      );
    }
    // Filesystem-safe slug of the human name, bounded so the tail stays visible.
    const slug =
      name
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/g, '') || 'workdir';
    const dir = path.join(root, `${slug}-${newUlid().slice(-6)}`);
    mkdirSync(dir, { recursive: true });
    return this.select(conversationId, dir);
  }

  /** Remove-from-recent cascade (docs/dev/03-data-model.md): records, checkpoints, bindings. */
  async remove(workdirId: string): Promise<void> {
    const workdir = this.#deps.workdirs.getOrThrow(workdirId);
    const bound = this.#deps.workdirs.conversationsBound(workdirId);
    // 与绑定切换同一门闩：执行中的对话不能移除 workdir（BR-P04-002）——
    // 否则进行中写入失去策略、影子仓被删导致 after 快照失败。
    for (const conversationId of bound) {
      this.#assertNoActiveRuns(conversationId);
    }
    for (const conversationId of bound) {
      this.#deps.conversations.setWorkdir(conversationId, null);
      this.#systemMessage(conversationId, `工作目录 ${workdir.name} 已从最近列表移除，绑定已取消`);
      this.#deps.publish('conversation.updated', {
        conversation: this.#deps.conversations.getOrThrow(conversationId),
      });
    }
    await this.#deps.checkpoints.forget(workdirId);
    this.#deps.workdirs.remove(workdirId);
    this.#deps.publish('workdir.removed', { id: workdirId });
    this.#deps.logger.info({ workdirId }, 'workdir removed');
  }

  /**
   * User force-revoke on the conversation's workdir (D140-1 semantics): with
   * shared leases several write tasks hold the same root, so the revoke picks
   * a **built-in write task of this conversation** among the shared holders —
   * only that task loses its write permission (`#revokedPinned`, design 30
   * §5.1); other tasks on the directory continue. No such holder (the waiter
   * is blocked by an exclusive holder — an external agent run, a host
   * operation): fall back to revoking that holder outright. The released
   * window is closed first so a later settle of the revoked run cannot re-take
   * a pinned lease (BR-P04-001).
   */
  async revokeLease(conversationId: string): Promise<boolean> {
    const workdir = this.boundWorkdir(conversationId);
    if (workdir === null) return false;
    const holders = this.#deps.leases.conflictingHolders(workdir.path);
    if (holders.length === 0) return false;
    const sharedTask = holders.find((holder) => {
      if (!holder.shared) return false;
      const run = this.#deps.runs.get(holder.runId);
      return (
        run !== null &&
        run.loopType === 'task' &&
        run.taskWrites === true &&
        run.conversationId === conversationId
      );
    });
    // No own write task holds the root: the waiter is blocked by an EXCLUSIVE
    // holder (external agent run, host operation). Never pick another
    // conversation's shared task here — shared waiters are not blocked by
    // shared holders, so stopping one would be an unrelated user's task.
    const exclusive = holders.find((holder) => !holder.shared);
    const holder = sharedTask ?? exclusive;
    if (holder === undefined) return false;
    // A pinned holder (a write task — shared or exclusive alike) loses its
    // write permission for good (design 30 §5.1): its next write fails instead
    // of re-taking the lease as a new window — otherwise the revoke would not
    // take effect.
    if (sharedTask !== undefined || this.#runLeases.get(holder.runId)?.pinned === true) {
      if (this.#revokedPinned.size >= REVOKED_RUNS_REMEMBERED) {
        const oldest = this.#revokedPinned.values().next().value;
        if (oldest !== undefined) this.#revokedPinned.delete(oldest);
      }
      this.#revokedPinned.add(holder.runId);
    }
    await this.releaseRun(holder.runId);
    return true;
  }

  // --- diff / revert (RPC) ------------------------------------------------------

  /** Run-change record for context rendering; null when absent. */
  changesOf(runId: string) {
    return this.#deps.workdirs.getChange(runId);
  }

  async diff(runId: string): Promise<{ change: ReturnType<WorkdirsService['getChange']>; diffText: string }> {
    const change = this.#deps.workdirs.getChange(runId);
    if (change === null) return { change: null, diffText: '' };
    if (change.revertedAt !== null || change.afterOid === null) {
      return { change, diffText: '' };
    }
    if (change.files.some((file) => file.beforeOid !== undefined)) {
      // Several lease windows: each file's own span (before the run first
      // changed it → after it last did) — never what others changed in between.
      const parts: string[] = [];
      for (const file of change.files) {
        parts.push(
          await this.#deps.checkpoints.diffText(
            change.workdirId,
            file.beforeOid ?? change.beforeOid,
            file.afterOid ?? change.afterOid,
            file.path,
          ),
        );
      }
      return { change, diffText: parts.filter((part) => part.length > 0).join('') };
    }
    return {
      change,
      diffText: await this.#deps.checkpoints.diffText(change.workdirId, change.beforeOid, change.afterOid),
    };
  }

  async revert(runId: string, force: boolean): Promise<{ ok: boolean; conflicts: string[]; reverted: string[] }> {
    const change = this.#deps.workdirs.getChange(runId);
    if (change === null || change.afterOid === null) {
      throw new AppError('NOT_FOUND', '该执行没有可回退的改动记录');
    }
    if (change.revertedAt !== null) {
      throw new AppError('INVALID_INPUT', '该执行的改动已经回退过');
    }
    const workdir = this.#deps.workdirs.getOrThrow(change.workdirId);
    if (!existsSync(workdir.path)) {
      throw new AppError('WORKDIR_MISSING', `工作目录不存在：${workdir.path}`);
    }

    const conflicts = await this.#revertConflicts(workdir.id, change.files, change.afterOid);
    // Changed by someone else between two of this run's lease windows:
    // restoring the run's `before` would undo theirs too.
    for (const file of change.files) {
      if (file.interleaved === true && !conflicts.includes(file.path)) conflicts.push(file.path);
    }
    if (conflicts.length > 0 && !force) {
      return { ok: false, conflicts, reverted: [] };
    }

    // Reverting mutates the workdir: it needs the write lease.
    const identity: RunIdentity = {
      runId: `revert_${newId('run').slice(4)}`,
      botId: null,
      conversationId: change.conversationId,
      loopType: 'host',
    };
    const holder = this.#deps.leases.conflictingHolder(workdir.path);
    if (holder !== null) {
      throw new AppError('LEASE_HELD', 'Bot 正在修改该工作目录，请先取消或等待其完成');
    }
    await this.#deps.leases.acquire(identity, workdir.path);

    const reverted: string[] = [];
    try {
      for (const file of change.files) {
        const absolute = path.join(workdir.path, file.path);
        if (file.change === 'added') {
          rmSync(absolute, { force: true });
        } else {
          const content = await this.#deps.checkpoints.readFileAt(
            workdir.id,
            file.beforeOid ?? change.beforeOid,
            file.path,
          );
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
      const after = await this.#deps.checkpoints.snapshot(workdir);
      this.#deps.leases.release(identity.runId);
      this.#deps.workdirs.recordChange({
        runId: identity.runId,
        workdirId: workdir.id,
        conversationId: change.conversationId,
        beforeOid: change.afterOid,
        afterOid: after.oid,
        files: change.files.map((f) => ({
          path: f.path,
          change: f.change === 'added' ? 'deleted' : f.change === 'deleted' ? 'added' : 'modified',
        })),
      });
    }
    this.#deps.workdirs.markReverted(runId);
    if (change.conversationId !== null) {
      this.#systemMessage(
        change.conversationId,
        `已整次回退执行 ${runId} 的 ${reverted.length} 处改动${conflicts.length > 0 ? `（已强制覆盖 ${conflicts.length} 个冲突文件）` : ''}`,
      );
    }
    return { ok: true, conflicts: [], reverted };
  }

  async #revertConflicts(
    workdirId: string,
    files: RunChangeFile[],
    afterOid: string,
  ): Promise<string[]> {
    const workdirPath = this.#deps.workdirs.getOrThrow(workdirId).path;
    const conflicts: string[] = [];
    for (const file of files) {
      const absolute = path.join(workdirPath, file.path);
      const current = existsSync(absolute) ? readFileSync(absolute) : null;
      const after = await this.#deps.checkpoints.readFileAt(workdirId, file.afterOid ?? afterOid, file.path);
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
    const workdir = this.boundWorkdir(identity.conversationId);
    if (workdir === null) {
      throw new AppError('INVALID_INPUT', '当前对话未绑定 workdir，无法执行 git 远程操作');
    }
    if (workdir.status === 'missing') {
      throw new AppError('WORKDIR_MISSING', `工作目录不存在：${workdir.path}`);
    }
    if (!gitCliAvailable()) {
      throw new AppError('GIT_CLI_MISSING', '系统未安装 git 命令行，无法执行远程操作');
    }
    const outcome = await options.requestApproval({
      operation: input.operation,
      args: input.args,
      cwd: workdir.path,
      reason: input.reason,
    });
    if (outcome !== 'approved') {
      throw new AppError('APPROVAL_DENIED', '用户未批准该 git 远程操作');
    }
    const result = await runGitRemote({
      cwd: workdir.path,
      operation: input.operation,
      args: input.args,
      signal: options.signal,
    });
    return { exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  // --- prompt --------------------------------------------------------------------

  /** `<workdir>` system prompt section (null when nothing bound). */
  async promptSection(
    conversationId: string | null,
    options: { skipGuideFiles?: readonly string[] } = {},
  ): Promise<string | null> {
    const workdir = this.boundWorkdir(conversationId);
    if (workdir === null || workdir.status !== 'available') return null;
    // Ignore verdicts come from the shadow repo (libgit2, exact semantics);
    // it is created lazily here — it lives in the data directory only.
    const repo = await this.#deps.checkpoints.ensureOpen(workdir);
    const isIgnored =
      repo !== null && workdir.path === (repo.workdir()?.replace(/\/+$/, '') ?? workdir.path)
        ? (relative: string) => repo.isPathIgnored(relative)
        : null;
    const section = await buildWorkdirSection({
      path: workdir.path,
      budget: WORKDIR_SECTION_BUDGET,
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

  #leaseTarget(
    identity: RunIdentity,
    resolvedPath: string,
    domains: string[] | null = null,
  ): LeaseTarget | null {
    const keyOf = (base: string): string =>
      domains !== null ? encodeWriteDomainKey(base, domains) : base;
    const workdir = this.boundWorkdir(identity.conversationId);
    if (
      workdir !== null &&
      workdir.status === 'available' &&
      isInsidePath(resolvedPath, workdir.path)
    ) {
      return { key: keyOf(workdir.path), workdir };
    }
    // D75 §5.2: the identity's own workspace (realpath-normalized on both
    // sides; the data home is canonical already, the workspace may not exist).
    if (identity.botId !== null && identity.conversationId !== null) {
      const workspace = canonicalPath(
        workspacePathFor(this.#deps.paths, identity.botId, identity.conversationId),
      );
      if (isInsidePath(canonicalPath(resolvedPath), workspace)) {
        return {
          key: keyOf(workspaceLeaseKey(identity.botId, identity.conversationId)),
          workdir: null,
        };
      }
    }
    // Outside the workdir: the longest covering write grant defines the key.
    const grants = this.#deps.grants
      .listEffective(identity)
      .filter((g) => g.access === 'write' && isInsidePath(resolvedPath, g.path))
      .sort((a, b) => b.path.length - a.path.length);
    const grant = grants[0];
    return grant !== undefined ? { key: keyOf(grant.path), workdir: null } : null;
  }

  #assertNoActiveRuns(conversationId: string): void {
    // P07 起：对话 run 之外还有后台反思 run（轻量模型、无工具、不触碰
    // workdir）——只有对话轮与任务（D75，任务可能正写 workdir）应阻止切换 /
    // 移除 workdir。
    const active = this.#deps.runs
      .listActiveByConversation(conversationId)
      .filter(
        (run) => run.loopType === 'turn' || run.loopType === 'task',
      );
    if (active.length > 0) {
      throw new AppError(
        'WORKDIR_SWITCH_BLOCKED',
        '有 Bot 正在执行，无法切换 workdir；请等待执行结束或先取消',
      );
    }
  }

  #systemMessage(conversationId: string, text: string): void {
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: 'workdir',
      text,
    });
    this.#deps.publish('message.created', { conversationId, message });
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
 * to the workdir root and also covers everything beneath a matching
 * directory (`.git/hooks`).
 */
export function matchProtectRule(
  rules: Workdir['protectRules'],
  workdirPath: string,
  resolvedPath: string,
  mode: 'read' | 'write',
): boolean {
  const patterns = mode === 'read' ? rules.denyRead : rules.denyWrite;
  if (patterns.length === 0) return false;
  const rel = path.relative(workdirPath, resolvedPath).replaceAll('\\', '/');
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

/** A joined acquisition still honours the joiner's own abort signal. */
function joinUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  const denied = () => new AppError('APPROVAL_DENIED', '执行已取消，未取得写入租约');
  if (signal.aborted) return Promise.reject(denied());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(denied());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * D123: case/separator normalization for write-domain path matching. Only
 * Windows is folded unconditionally: on a case-sensitive macOS volume `src`
 * and `SRC` are distinct directories, and folding would let a domain write
 * escape into the other one (a denial on a case-insensitive volume is the
 * conservative direction).
 */
function comparableDomainPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * D123: true when `resolvedPath` matches one of the root-relative patterns.
 * A fully literal pattern denotes that directory and its subtree (the sandbox
 * policy mounts it the same way), and a glob's literal directory prefix
 * (e.g. `<cwd>/docs` for `docs/**`) also matches so the write can create it.
 */
export function pathMatchesPatterns(
  root: string,
  patterns: string[],
  resolvedPath: string,
): boolean {
  const target = comparableDomainPath(resolvedPath);
  const clauses = absolutePatterns(root, patterns);
  return clauses.some((absolute, index) => {
    const pattern = comparableDomainPath(absolute);
    if (globMatch(pattern, target)) return true;
    const relative = patterns[index] ?? '';
    if (!/[*?[\]]/.test(relative)) {
      return target === pattern || target.startsWith(`${pattern}/`);
    }
    return literalDirPrefix(pattern) === target;
  });
}

/** The directory part of a pattern before its first glob segment, if any. */
function literalDirPrefix(pattern: string): string | null {
  const segments = pattern.split('/');
  const index = segments.findIndex((segment) => /[*?[]/.test(segment));
  if (index < 0) return null;
  const prefix = segments.slice(0, index).join('/');
  return prefix.length > 0 ? prefix : null;
}
