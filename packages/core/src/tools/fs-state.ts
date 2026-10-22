import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Upper bound per run: file cards stay useful and the message JSON stays small. */
export const RUN_FILE_CHANGES_MAX = 100;

/** One file a run produced or edited (absolute path, deduped per run). */
export interface RunFileChange {
  path: string;
  change: 'created' | 'modified';
  size?: number;
}

/**
 * Staleness detection (docs/design/08-workdir.md "过期检测"): file tools
 * record the content hash of every file they read; write/edit compares the
 * on-disk hash before writing and fails with STALE_FILE when the file changed
 * underneath (e.g. the user edited it in an external editor). Files never
 * read before are not checked (fresh creation).
 *
 * The same per-run map also carries the files a run wrote, so the orchestration
 * layer can turn them into the message's file cards (see RunFileChange).
 */
export class FileReadState {
  readonly #byRun = new Map<string, Map<string, string>>();
  readonly #changes = new Map<string, Map<string, RunFileChange>>();

  /** Records the hash of a file the run has just read. */
  record(runId: string, resolvedPath: string, content: Buffer): void {
    let map = this.#byRun.get(runId);
    if (map === undefined) {
      map = new Map();
      this.#byRun.set(runId, map);
    }
    map.set(resolvedPath, hashOf(content));
  }

  /**
   * True when the run read this file earlier and the disk content has changed
   * since. Files not read before return false (no staleness for new files).
   */
  isStale(runId: string, resolvedPath: string): boolean {
    const recorded = this.#byRun.get(runId)?.get(resolvedPath);
    if (recorded === undefined) return false;
    let current: Buffer;
    try {
      current = readFileSync(resolvedPath);
    } catch {
      // Vanished since the read: treat as changed.
      return true;
    }
    return hashOf(current) !== recorded;
  }

  /** After a successful write the run's own content becomes the baseline. */
  recordWrite(runId: string, resolvedPath: string, content: string | Buffer): void {
    const map = this.#byRun.get(runId);
    if (map === undefined) return;
    map.set(
      resolvedPath,
      hashOf(typeof content === 'string' ? Buffer.from(content, 'utf8') : content),
    );
  }

  /**
   * Remembers that the run wrote this file. A path written twice keeps its
   * first change kind (created stays created); the newest size wins.
   */
  recordChange(runId: string, change: RunFileChange): void {
    let map = this.#changes.get(runId);
    if (map === undefined) {
      map = new Map();
      this.#changes.set(runId, map);
    }
    const existing = map.get(change.path);
    if (existing === undefined && map.size >= RUN_FILE_CHANGES_MAX) return;
    map.set(
      change.path,
      existing === undefined ? change : { ...existing, size: change.size ?? existing.size },
    );
  }

  /** Files the run wrote, in first-write order. */
  changesOf(runId: string): RunFileChange[] {
    return [...(this.#changes.get(runId)?.values() ?? [])];
  }

  release(runId: string): void {
    this.#byRun.delete(runId);
    this.#changes.delete(runId);
  }
}

function hashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
