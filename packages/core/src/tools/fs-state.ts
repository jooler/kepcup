import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Staleness detection (docs/design/08-project.md "过期检测"): file tools
 * record the content hash of every file they read; write/edit compares the
 * on-disk hash before writing and fails with STALE_FILE when the file changed
 * underneath (e.g. the user edited it in an external editor). Files never
 * read before are not checked (fresh creation).
 */
export class FileReadState {
  readonly #byRun = new Map<string, Map<string, string>>();

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
    map.set(resolvedPath, hashOf(typeof content === 'string' ? Buffer.from(content, 'utf8') : content));
  }

  release(runId: string): void {
    this.#byRun.delete(runId);
  }
}

function hashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
