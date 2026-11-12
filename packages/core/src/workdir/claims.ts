import { pathMatchesPatterns } from './service.js';

/** A task's in-memory path claim (D123, docs/design/59 §5). */
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

/**
 * D123 runtime claims: a task reserves a path subset inside its own write
 * domain so other tasks of the same (bot, conversation) are refused with
 * WRITE_CLAIMED. Pure in-memory coordination state — it does not outlive the
 * task and is never a source of truth (design §5).
 */
export class TaskClaimRegistry {
  readonly #claims = new Map<string, TaskClaim>();

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
      return [...claim.paths];
    }
    const drop = new Set(paths);
    const released = claim.paths.filter((path) => drop.has(path));
    claim.paths = claim.paths.filter((path) => !drop.has(path));
    if (claim.paths.length === 0) this.#claims.delete(taskId);
    return released;
  }

  /** settle / cancel / interrupt: the claim dies with the task. */
  clear(taskId: string): void {
    this.#claims.delete(taskId);
  }

  /** The WRITE_CLAIMED reason when another task of the same bot+conversation holds the path. */
  denial(
    writerTaskId: string,
    botId: string,
    conversationId: string,
    resolvedPath: string,
  ): string | null {
    for (const claim of this.#claims.values()) {
      if (claim.taskId === writerTaskId) continue;
      if (claim.botId !== botId || claim.conversationId !== conversationId) continue;
      if (!pathMatchesPatterns(claim.root, claim.paths, resolvedPath)) continue;
      return (
        `该路径被任务 ${claim.taskId}「${claim.title}」认领（${claim.reason}）：` +
        '先用 send_to_task 与它协商，或换一块区域；它结束或 release 后即可写入'
      );
    }
    return null;
  }
}
