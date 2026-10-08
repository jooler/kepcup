import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { initRepository, openRepository, type Repository } from 'es-git';
import type { RunChangeFile } from '@kepcup/shared';

import type { Project } from '@kepcup/shared';
import type { AppPaths } from '../infra/paths.js';
import { projectCheckpointsPath } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';

const SIGNATURE = { name: 'kepcup', email: 'checkpoints@localhost' } as const;

/** Delta status strings reported by es-git's diff deltas. */
const DELTA_STATUS = { ADDED: 'added', MODIFIED: 'modified', DELETED: 'deleted' } as const;

/** Drains an es-git Iterator subclass (typed without Symbol.iterator). */
function iterate<T>(iterator: { next(): IteratorResult<T, unknown> }): Generator<T> {
  return {
    *[Symbol.iterator]() {
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        yield next.value;
      }
    },
  }[Symbol.iterator]();
}

/**
 * Checkpoint snapshots (docs/design/08-project.md "检查点与回退"): one shadow
 * repository per project under the data directory, its `core.worktree` aimed
 * at the project. Nothing is ever written inside the project itself —
 * initialization goes through the repo's own config, never a `.git` gitlink.
 */
export class CheckpointService {
  readonly #paths: AppPaths;
  readonly #logger: CoreLogger;
  /** Opens/init/commits are serialized per project (index state is shared). */
  readonly #mutexes = new Map<string, Promise<unknown>>();

  constructor(deps: { paths: AppPaths; logger: CoreLogger }) {
    this.#paths = deps.paths;
    this.#logger = deps.logger;
  }

  checkpointsPath(projectId: string): string {
    return projectCheckpointsPath(this.#paths, projectId);
  }

  exists(projectId: string): boolean {
    return existsSync(this.checkpointsPath(projectId));
  }

  /** Opens (or lazily creates) the shadow repo; keeps `core.worktree` current. */
  async #repo(project: Project): Promise<Repository> {
    const dir = this.checkpointsPath(project.id);
    if (!existsSync(dir)) {
      mkdirSync(path.dirname(dir), { recursive: true });
      // Bare init at `checkpoints.git` (noDotgitDir keeps the gitdir exactly
      // there — libgit2 would otherwise append `/.git/`); core.bare=false +
      // core.worktree then aim it at the project. No `.git` gitlink is ever
      // created inside the project (docs/dev/phases/P04-project.md 底线).
      const created = await initRepository(dir, { bare: true, noDotgitDir: true });
      created.config().setString('core.bare', 'false');
      created.config().setString('core.worktree', project.path);
      this.#logger.info({ projectId: project.id }, 'checkpoint repo initialized');
    }
    const repo = await openRepository(dir);
    if (repo.workdir()?.replace(/\/+$/, '') !== project.path) {
      repo.config().setString('core.worktree', project.path);
    }
    return repo;
  }

  /**
   * Commits the current worktree state. Respects the project's `.gitignore`
   * (libgit2) and never includes the project's own `.git/`. Cost note: the
   * first snapshot of a huge project is O(files); later ones only re-stat
   * (measured 15s first vs 0.2s repeat on 50k files, see PROGRESS P04).
   */
  async snapshot(project: Project): Promise<{ oid: string; treeId: string }> {
    const run = this.#chain(project.id, async () => {
      const repo = await this.#repo(project);
      const index = repo.index();
      index.addAll(['.']);
      index.write();
      const treeId = index.writeTree();
      let parent: string | null = null;
      try {
        parent = repo.head().target();
      } catch {
        // Unborn HEAD (first snapshot).
      }
      const tree = repo.getTree(treeId);
      const oid = repo.commit(tree, 'checkpoint', {
        updateRef: 'HEAD',
        author: SIGNATURE,
        committer: SIGNATURE,
        parents: parent !== null ? [parent] : [],
      });
      return { oid, treeId };
    });
    return run;
  }

  /** Files changed between two snapshot commits, sorted by path. */
  async diffFiles(projectId: string, beforeOid: string, afterOid: string): Promise<RunChangeFile[]> {
    const repo = await this.#repoForRead(projectId);
    if (repo === null) return [];
    const diff = repo.diffTreeToTree(this.#commitTree(repo, beforeOid), this.#commitTree(repo, afterOid));
    const files: RunChangeFile[] = [];
    for (const delta of iterate(diff.deltas())) {
      const status = delta.status();
      const change =
        status === 'Added'
          ? DELTA_STATUS.ADDED
          : status === 'Deleted'
            ? DELTA_STATUS.DELETED
            : DELTA_STATUS.MODIFIED;
      files.push({ path: delta.newFile().path() ?? delta.oldFile().path() ?? '', change });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Unified diff text between two snapshot commits (empty when unavailable);
   * `filePath` limits it to one file.
   */
  async diffText(
    projectId: string,
    beforeOid: string,
    afterOid: string,
    filePath?: string,
  ): Promise<string> {
    const dir = this.checkpointsPath(projectId);
    if (!existsSync(dir)) return '';
    // es-git's diff.print() drops the +/-/space line prefixes (verified on
    // 0.7.0, see PROGRESS P04), so the patch text comes from the system git
    // CLI against our own shadow repository. The shadow repo is app-owned;
    // external diff drivers are disabled.
    const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
    if (probe.error !== undefined) {
      this.#logger.warn({ error: String(probe.error) }, 'checkpoint diff: git probe failed');
      return '';
    }
    const result = spawnSync(
      'git',
      [
        '--git-dir',
        dir,
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        beforeOid,
        afterOid,
        ...(filePath !== undefined ? ['--', filePath] : []),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error !== undefined || result.status !== 0) {
      this.#logger.warn(
        {
          status: result.status,
          error: result.error !== undefined ? String(result.error) : '',
          stderr: result.stderr?.slice(0, 200) ?? '',
          beforeOid,
          afterOid,
        },
        'checkpoint diff: git diff failed',
      );
      return '';
    }
    return result.stdout;
  }

  /** Content of `filePath` inside a snapshot commit; null when absent. */
  async readFileAt(projectId: string, oid: string, filePath: string): Promise<Buffer | null> {
    const repo = await this.#repoForRead(projectId);
    if (repo === null) return null;
    const entry = this.#commitTree(repo, oid).getPath(filePath);
    if (entry === null || entry.type() !== 'Blob') return null;
    return Buffer.from(entry.toObject(repo).peelToBlob().content());
  }

  /** True when the commit exists in the shadow repo (retention may drop it). */
  async hasCommit(projectId: string, oid: string): Promise<boolean> {
    const repo = await this.#repoForRead(projectId);
    if (repo === null) return false;
    try {
      repo.getCommit(oid);
      return true;
    } catch {
      return false;
    }
  }

  /** Opens the shadow repo read-only, creating nothing (null when absent). */
  async openForRead(projectId: string): Promise<Repository | null> {
    return this.#repoForRead(projectId);
  }

  /** Opens (creating if needed) the shadow repo — used for ignore verdicts. */
  async ensureOpen(project: Project): Promise<Repository | null> {
    try {
      return await this.#repo(project);
    } catch (error) {
      this.#logger.warn(
        { projectId: project.id, error: error instanceof Error ? error.message : String(error) },
        'checkpoint repo open failed',
      );
      return null;
    }
  }

  /**
   * Retention (CHECKPOINT_RETENTION_DAYS): recreating the repo is measurably
   * cheaper than rewriting history (~11ms, see PROGRESS P04), so a sweep that
   * finds an over-retained HEAD simply rebuilds an empty one. Old run_changes
   * rows keep their oids but revert/diff of dropped checkpoints reports
   * unavailable.
   */
  async applyRetention(now: number, retentionDays: number): Promise<string[]> {
    const swept: string[] = [];
    const root = path.join(this.#paths.home, 'projects');
    if (!existsSync(root)) return swept;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = this.checkpointsPath(entry.name);
      if (!existsSync(dir)) continue;
      try {
        const repo = await openRepository(dir);
        const target = repo.head().target();
        if (target === null) continue;
        const commit = repo.getCommit(target);
        if (commit.time().getTime() < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          swept.push(entry.name);
        }
      } catch {
        // Unreadable repo (unborn HEAD with only workdir) — leave it alone.
      }
    }
    return swept;
  }

  async forget(projectId: string): Promise<void> {
    // Remove the whole per-project directory ({home}/projects/{projectId});
    // checkpoints.git is its only content.
    rmSync(path.dirname(this.checkpointsPath(projectId)), { recursive: true, force: true });
    this.#mutexes.delete(projectId);
  }

  // --- internals -------------------------------------------------------------

  /**
   * The snapshot oids stored in run_changes are COMMIT ids ("影子仓库中的提交");
   * diff and file readers work on trees, so peel once here.
   */
  #commitTree(repo: Repository, commitOid: string) {
    return repo.getTree(repo.getCommit(commitOid).tree().id());
  }

  /** Read-only open: null when the shadow repo does not exist. */
  async #repoForRead(projectId: string): Promise<Repository | null> {
    const dir = this.checkpointsPath(projectId);
    if (!existsSync(dir)) return null;
    return openRepository(dir);
  }

  #chain<T>(projectId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#mutexes.get(projectId) ?? Promise.resolve();
    const next = previous.then(body, body);
    this.#mutexes.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }
}
