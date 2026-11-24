import { TASK_AUTO_CLAIM_MAX } from '@kepcup/shared';
import { leaseKeysConflict } from './lease.js';
import { pathMatchesPatterns } from './service.js';

/** A task's in-memory path claim (D123, docs/design/59 §5; D140-1 auto-claim). */
export interface TaskClaim {
  taskId: string;
  botId: string;
  conversationId: string;
  title: string;
  /** The claiming task's resolved cwd: claim paths are relative to it. */
  root: string;
  paths: string[];
  reason: string;
  since: number;
}

export interface TaskClaimEntry {
  paths: string[];
  reason: string;
  since: number;
}

/** Why an auto-claimed path got merged (or not). */
export type AutoClaimOutcome = 'registered' | 'duplicate' | 'capped';

/**
 * D123 runtime claims: a task reserves a path subset inside its own write
 * domain so other tasks are refused with WRITE_CLAIMED. D140-1: the refusal
 * covers **every task on an overlapping root** (not just the same bot +
 * conversation — parallel write tasks share a workdir across conversations),
 * and the first successful gateway write of a path auto-claims it
 * (first-writer-wins, capped at TASK_AUTO_CLAIM_MAX). Pure in-memory
 * coordination state — it does not outlive the task and is never a source of
 * truth (design §5).
 */
export class TaskClaimRegistry {
  readonly #claims = new Map<string, TaskClaim>();
  /** Task ids whose auto-claim cap was already reported once (log-once). */
  readonly #autoCapNotified = new Set<string>();

  set(claim: TaskClaim): void {
    this.#claims.set(claim.taskId, { ...claim, paths: [...claim.paths] });
  }

  get(taskId: string): TaskClaim | null {
    return this.#claims.get(taskId) ?? null;
  }

  entryOf(taskId: string): TaskClaimEntry | null {
    const claim = this.#claims.get(taskId);
    return claim === undefined
      ? null
      : { paths: [...claim.paths], reason: claim.reason, since: claim.since };
  }

  /** Releases the whole claim, or the named paths only. */
  release(taskId: string, paths?: string[]): string[] {
    const claim = this.#claims.get(taskId);
    if (claim === undefined) return [];
    if (paths === undefined || paths.length === 0) {
      this.#claims.delete(taskId);
      this.#autoCapNotified.delete(taskId);
      return [...claim.paths];
    }
    const drop = new Set(paths);
    const released = claim.paths.filter((path) => drop.has(path));
    claim.paths = claim.paths.filter((path) => !drop.has(path));
    if (claim.paths.length === 0) {
      this.#claims.delete(taskId);
      this.#autoCapNotified.delete(taskId);
    }
    return released;
  }

  /** settle / cancel / interrupt: the claim dies with the task. */
  clear(taskId: string): void {
    this.#claims.delete(taskId);
    this.#autoCapNotified.delete(taskId);
  }

  /**
   * D140-1 auto-claim: merges one successfully written path into the task's
   * claim. `capped` is returned (and reported once per task via
   * {@link consumeCapNotice}) after TASK_AUTO_CLAIM_MAX paths — further paths
   * stop registering but the existing claim stays.
   */
  autoClaim(entry: Omit<TaskClaim, 'paths' | 'reason' | 'since'> & { path: string }): AutoClaimOutcome {
    const existing = this.#claims.get(entry.taskId);
    if (existing !== undefined && existing.paths.includes(entry.path)) return 'duplicate';
    const paths = existing?.paths ?? [];
    if (paths.length >= TASK_AUTO_CLAIM_MAX) return 'capped';
    if (existing !== undefined) {
      existing.paths.push(entry.path);
      return 'registered';
    }
    this.#claims.set(entry.taskId, {
      ...entry,
      paths: [entry.path],
      reason: '首次写入后自动认领（先到先得）',
      since: Date.now(),
    });
    return 'registered';
  }

  /** True once per task after the auto-claim cap was hit (caller logs it once). */
  consumeCapNotice(taskId: string): boolean {
    if (this.#autoCapNotified.has(taskId)) return false;
    this.#autoCapNotified.add(taskId);
    return true;
  }

  /**
   * The WRITE_CLAIMED reason when a task on an overlapping root holds the
   * path (D140-1: any task, across bots and conversations — two write tasks
   * of one workdir may belong to different conversations). Claims held by the
   * writing task itself never block it.
   */
  denial(writerTaskId: string, resolvedPath: string, writerRoot: string | null): string | null {
    for (const claim of this.#claims.values()) {
      if (claim.taskId === writerTaskId) continue;
      if (writerRoot !== null && !leaseKeysConflict(claim.root, writerRoot)) continue;
      if (!pathMatchesPatterns(claim.root, claim.paths, resolvedPath)) continue;
      return (
        `该路径被任务 ${claim.taskId}「${claim.title}」认领（${claim.reason}）：` +
        '先用 send_to_task 与它协商，或换一块区域；它结束或 release 后即可写入'
      );
    }
    return null;
  }
}
