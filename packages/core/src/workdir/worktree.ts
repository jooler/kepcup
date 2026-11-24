import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isInsidePath } from '../sandbox/sensitive-paths.js';

import {
  AppError,
  WORKTREE_DIR_NAME,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_PATH_MAX,
  WORKTREE_RETENTION_MS,
  type Run,
  type TaskApplyState,
} from '@kepcup/shared';

import { canonicalPath } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * D140-4 worktree isolation (docs/design/30-supervisor-and-tasks.md §9.1,
 * todo/agent-autonomy-and-parallel-tasks.md §3.6). The host (outside the
 * sandbox) creates one `git worktree` per task in `<workdir parent>/.worktree/`
 * and applies its changes back with a three-way merge on user approval.
 *
 * Constraints:
 * - Only the worktree's own metadata directory and the shared object store are
 *   writable inside the sandbox; `.git/config`, `.git/hooks` and the rest of
 *   `.git` stay closed (the object store is required for `git add` / `commit`
 *   inside the linked worktree — see DEV-152).
 * - A failed apply restores the touched files byte-for-byte and never writes
 *   the user's index: a conflict must not leave merge markers in the workdir.
 *   The three-way merge runs against a private index that mirrors what is on
 *   disk (see `apply`), so the user's unstaged edits are merged, not refused.
 * - The apply carries tracked files plus non-ignored untracked files only
 *   (`add -A -N` honours `.gitignore`): build outputs and other ignored files
 *   created in the tree stay there (DEV-153 ②).
 * - Delete / conversation removal never deletes a worktree: the changes are
 *   the user's asset. Only the daily reaper removes aged orphans.
 */

export interface WorktreeInfo {
  /** The worktree root (the task's execution root). */
  path: string;
  /** Commit the worktree started from (stash-create oid, else HEAD). */
  baseOid: string;
  /** The main repository's git directory (`<workdir>/.git`, or its commondir). */
  gitCommonDir: string;
  /** `<gitCommonDir>/worktrees/<name>` — the only precise `.git` subtree opened for writes. */
  gitWorktreeMeta: string;
  /** `<gitCommonDir>/objects` — git add / commit inside a linked worktree writes here. */
  gitObjectsDir: string;
  /** `.worktreeinclude` entries copied into the worktree (gitignore syntax). */
  copied: string[];
}

export interface WorktreeDiffSummary {
  files: string[];
  fileCount: number;
  insertions: number;
  deletions: number;
}

export type WorktreeApplyOutcome =
  | { ok: true; empty: boolean }
  | { ok: false; conflicts: string[]; reason: string; worktreeKept: true };

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Files listed in the apply card / summary (the rest is only counted). */
const WORKTREE_SUMMARY_FILES_MAX = 20;
/** Bounded per-run apply-state memory (the card is the source of truth). */
const WORKTREE_APPLY_STATE_MAX = 512;
/**
 * Workdir paths the three-way fallback materializes into its private index.
 * Past it the fallback degrades to git's own `--index` refusal (a reported
 * conflict, never a silent partial merge) instead of spawning thousands of
 * processes under the host's exclusive write lease.
 */
const WORKTREE_MERGE_INDEX_MAX_PATHS = 512;

/** `<workdir parent>/.worktree` — the isolated-trees home (D140-4 naming). */
export function worktreeDirFor(workdirPath: string): string {
  return path.join(path.dirname(workdirPath), WORKTREE_DIR_NAME);
}

function safeName(workdirPath: string): string {
  const base = path.basename(workdirPath);
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'workdir';
}

/** `<workdir parent>/.worktree/<basename>-<runId tail>`. */
export function worktreePathFor(workdirPath: string, runId: string): string {
  const tail = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'run';
  return path.join(worktreeDirFor(workdirPath), `${safeName(workdirPath)}-${tail}`);
}

/**
 * C9: whether `candidate` is a tree owned by `root` or at its worktree home.
 * The home is shared with the siblings of `root`, so only names carrying this
 * root's prefix are accepted (a configured root must never unlock another
 * root's trees under the same parent).
 */
export function isWorktreePathOf(root: string, candidate: string): boolean {
  const home = worktreeDirFor(root);
  if (candidate === home) return true;
  const rel = path.relative(home, candidate);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0] ?? '';
  return first.startsWith(`${safeName(root)}-`);
}

/**
 * Reads a linked worktree's metadata from its `.git` pointer file (cheap,
 * synchronous — used on every gateway write check). Null when `worktreePath`
 * is not a linked worktree of a repository.
 *
 * The pointer file lives INSIDE the sandbox-writable tree, so its content is
 * untrusted: every field is checked structurally before it may steer the
 * sandbox mounts. A real linked worktree's metadata is always
 * `<common>/worktrees/<name>/`, its optional `commondir` resolves back to
 * `<common>`, and its `gitdir` names this tree's `.git` file. A forged
 * pointer therefore yields null (the task loses its write mount instead of
 * gaining one elsewhere).
 */
export function readWorktreeMeta(worktreePath: string): {
  gitCommonDir: string;
  gitWorktreeMeta: string;
} | null {
  const pointer = path.join(worktreePath, '.git');
  let stat;
  try {
    stat = lstatSync(pointer);
  } catch {
    return null;
  }
  // A real directory is a main checkout, not a linked worktree.
  if (!stat.isFile()) return null;
  let content: string;
  try {
    content = readFileSync(pointer, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content);
  if (match === null) return null;
  const raw = match[1]!.trim();
  if (raw.length === 0) return null;
  const metaDir = canonicalPath(path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw));
  // `<common>/worktrees/<name>` is the only shape a linked worktree has.
  if (path.basename(path.dirname(metaDir)) !== 'worktrees') return null;
  try {
    if (!statSync(metaDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const structuralCommon = canonicalPath(path.dirname(path.dirname(metaDir)));
  let common = structuralCommon;
  try {
    const commondir = readFileSync(path.join(metaDir, 'commondir'), 'utf8').trim();
    if (commondir.length > 0) {
      const resolved = canonicalPath(
        path.isAbsolute(commondir) ? commondir : path.join(metaDir, commondir),
      );
      if (resolved !== structuralCommon) return null;
      common = resolved;
    }
  } catch {
    // Older / foreign layouts: the structural grandparent stands.
  }
  // The backlink names this tree's `.git`; a forged pointer cannot provide it
  // (the file would have to exist outside the sandbox).
  let backlink: string;
  try {
    backlink = readFileSync(path.join(metaDir, 'gitdir'), 'utf8').trim();
  } catch {
    return null;
  }
  if (backlink.length === 0) return null;
  const expected = canonicalPath(pointer);
  const named = canonicalPath(path.isAbsolute(backlink) ? backlink : path.resolve(metaDir, backlink));
  if (named !== expected) return null;
  return { gitCommonDir: common, gitWorktreeMeta: metaDir };
}

/** Runs git without a shell; stdout/stderr are captured (bounded). */
function git(
  args: string[],
  cwd?: string,
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      ...(cwd !== undefined ? { cwd } : {}),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '1',
        ...(options.env ?? {}),
      },
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // A child that exited before reading stdin must not surface EPIPE.
      });
      child.stdin?.end(options.stdin);
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, GIT_TIMEOUT_MS);
    timeout.unref?.();
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < GIT_MAX_BUFFER) stdout += data.toString('utf8');
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < GIT_MAX_BUFFER) stderr += data.toString('utf8');
    });
    child.on('error', (error: Error) =>
      finish({ code: 127, stdout, stderr: `${stderr}\n${String(error)}` }),
    );
    child.on('exit', (code) => finish({ code, stdout, stderr }));
  });
}

/** Last non-empty lines of a git failure (the task's error message). */
function gitFailure(result: GitResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (text.length === 0) return `git exited with ${String(result.code)}`;
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-4).join(' / ');
}

export class WorktreeService {
  readonly #logger: CoreLogger | undefined;
  /** Per-run apply lifecycle (process memory; see `applyStateOf`). */
  readonly #applyStates = new Map<string, TaskApplyState>();

  constructor(deps: { logger?: CoreLogger } = {}) {
    this.#logger = deps.logger;
  }

  /**
   * Creates the task's worktree from the workdir's current state (tracked
   * changes included via `git stash create`; untracked ignored files only
   * through `.worktreeinclude`). Every failure cleans up the half-created
   * tree and surfaces as WORKTREE_CREATE_FAILED with the git output tail.
   */
  async create(input: { workdirPath: string; runId: string }): Promise<WorktreeInfo> {
    const workdirPath = canonicalPath(input.workdirPath);
    const parent = path.dirname(workdirPath);
    if (!existsSync(parent)) {
      throw new AppError('WORKTREE_CREATE_FAILED', `工作目录的父目录不存在：${parent}`);
    }
    const gitDir = await git(['-C', workdirPath, 'rev-parse', '--git-dir']);
    if (gitDir.code !== 0) {
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `工作目录不是 git 仓库，无法创建隔离目录：${gitFailure(gitDir)}`,
      );
    }
    const bare = await git(['-C', workdirPath, 'rev-parse', '--is-bare-repository']);
    if (bare.code === 0 && bare.stdout.trim() === 'true') {
      throw new AppError('WORKTREE_CREATE_FAILED', '工作目录是 bare 仓库，无法创建隔离目录');
    }
    // An unborn HEAD has no tree to check out — say so instead of surfacing
    // git's stash-create wording.
    const headProbe = await git(['-C', workdirPath, 'rev-parse', '--verify', '--quiet', 'HEAD']);
    if (headProbe.code !== 0) {
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        '仓库还没有提交，无法创建隔离目录（先提交一次再派任务）',
      );
    }
    const target = this.#uniquePath(workdirPath, input.runId);
    this.#ensureWorktreeHome(workdirPath);
    // Start point: the user's working state (tracked changes) when there is
    // one; `stash create` prints the commit oid and writes nothing.
    const stash = await git(['-C', workdirPath, 'stash', 'create']);
    if (stash.code !== 0) {
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `读取工作区当前状态失败：${gitFailure(stash)}`,
      );
    }
    let baseOid = stash.stdout.trim();
    if (baseOid.length === 0) {
      const head = await git(['-C', workdirPath, 'rev-parse', 'HEAD']);
      if (head.code !== 0) {
        throw new AppError(
          'WORKTREE_CREATE_FAILED',
          `仓库还没有提交，无法创建隔离目录：${gitFailure(head)}`,
        );
      }
      baseOid = head.stdout.trim();
    }
    const added = await git(['-C', workdirPath, 'worktree', 'add', '--detach', target, baseOid]);
    if (added.code !== 0) {
      await this.#cleanupFailed(workdirPath, target);
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `创建 git worktree 失败：${gitFailure(added)}`,
      );
    }
    let meta: { gitCommonDir: string; gitWorktreeMeta: string } | null;
    try {
      meta = readWorktreeMeta(target);
      if (meta === null) throw new Error('worktree .git pointer missing');
      const copied = this.#copyIncludes(workdirPath, target);
      const info: WorktreeInfo = {
        path: target,
        baseOid,
        gitCommonDir: meta.gitCommonDir,
        gitWorktreeMeta: meta.gitWorktreeMeta,
        gitObjectsDir: path.join(meta.gitCommonDir, 'objects'),
        copied,
      };
      this.#logger?.info(
        { worktreePath: target, baseOid, copied: copied.length },
        'task worktree created',
      );
      return info;
    } catch (error) {
      await this.#cleanupFailed(workdirPath, target);
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `创建隔离目录失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** `git worktree remove --force` + prune; a missing tree is already removed. */
  async remove(workdirPath: string, worktreePath: string): Promise<void> {
    if (!existsSync(worktreePath)) return;
    const removed = await git(['-C', workdirPath, 'worktree', 'remove', '--force', worktreePath]);
    if (removed.code !== 0) {
      // The workdir may be gone (the tree's main repo no longer resolvable):
      // drop the directory and let the next prune collect the metadata.
      this.#logger?.warn(
        { worktreePath, error: gitFailure(removed) },
        'git worktree remove failed; removing the directory',
      );
      rmSync(worktreePath, { recursive: true, force: true });
    }
    await this.prune(workdirPath);
  }

  async prune(workdirPath: string): Promise<void> {
    if (!existsSync(workdirPath)) return;
    const result = await git(['-C', workdirPath, 'worktree', 'prune']);
    if (result.code !== 0) {
      this.#logger?.warn({ workdirPath, error: gitFailure(result) }, 'git worktree prune failed');
    }
  }

  /** Changed files + line counts of the worktree against its start point. */
  async summary(worktreePath: string, baseOid: string): Promise<WorktreeDiffSummary | null> {
    if (!existsSync(worktreePath)) return null;
    // Host-side git runs in the tree: a rewritten `.git` pointer must not
    // steer them at another repository (the pointer is sandbox-writable).
    if (readWorktreeMeta(worktreePath) === null) {
      this.#logger?.warn({ worktreePath }, 'worktree metadata invalid; summary skipped');
      return null;
    }
    // Intent-to-add makes untracked files visible to `git diff` (they were
    // never in baseOid). No commit is created. A failed intent-to-add (locked
    // or unreadable tree index) must not silently drop the untracked files
    // from the summary — the card would understate the task's work.
    const staged = await git(['-C', worktreePath, 'add', '-A', '-N']);
    if (staged.code !== 0) {
      this.#logger?.warn(
        { worktreePath, error: gitFailure(staged) },
        'worktree intent-to-add failed; summary skipped',
      );
      return null;
    }
    const numstat = await git([
      '-C',
      worktreePath,
      'diff',
      '--numstat',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      baseOid,
      '--',
    ]);
    if (numstat.code !== 0) {
      this.#logger?.warn(
        { worktreePath, error: gitFailure(numstat) },
        'worktree diff summary failed',
      );
      return null;
    }
    const entries = parseNumstat(numstat.stdout);
    let insertions = 0;
    let deletions = 0;
    for (const entry of entries) {
      insertions += entry.insertions;
      deletions += entry.deletions;
    }
    const files = entries.map((entry) => entry.file).sort((a, b) => a.localeCompare(b));
    return {
      files: files.slice(0, WORKTREE_SUMMARY_FILES_MAX),
      fileCount: files.length,
      insertions,
      deletions,
    };
  }

  /**
   * Applies the worktree's changes to the main workdir with a three-way merge.
   * A clean plain apply is attempted first (git apply is atomic on failure).
   * The fallback merges against a PRIVATE copy of the workdir's index: `git
   * apply --3way` implies `--index` and refuses ("does not match index") — or
   * would merge against a stale base — whenever the user has unstaged edits on
   * a touched file, which is the normal state of a user's checkout. The copy
   * has the current workdir content of every dirty / untracked / deleted
   * touched path, so "ours" is what is on disk; the user's real index is never
   * rewritten (a failed merge leaves it byte-for-byte as it was).
   *
   * Rename detection is off in the patch: a rename becomes delete + add, so
   * the patch's path set equals the restore point's and the merge's — a
   * rename the user has edited on one side degrades to an honest conflict
   * instead of an unreproducible partial write.
   */
  async apply(input: {
    workdirPath: string;
    worktreePath: string;
    baseOid: string;
  }): Promise<WorktreeApplyOutcome> {
    const { workdirPath, worktreePath, baseOid } = input;
    if (!existsSync(worktreePath)) {
      throw new AppError('WORKTREE_NOT_AVAILABLE', `隔离目录不存在：${worktreePath}`);
    }
    // The tree's `.git` pointer is sandbox-writable: never let a rewritten
    // pointer point host-side git at a different repository.
    if (readWorktreeMeta(worktreePath) === null) {
      throw new AppError(
        'WORKTREE_NOT_AVAILABLE',
        `隔离目录的 git 元数据不可用（.git 指针缺失或被改写）：${worktreePath}`,
      );
    }
    // Untracked files enter the diff through intent-to-add; a failed intent
    // must fail the apply, not silently drop them from the patch.
    const staged = await git(['-C', worktreePath, 'add', '-A', '-N']);
    if (staged.code !== 0) {
      throw new AppError(
        'WORKTREE_NOT_AVAILABLE',
        `读取隔离目录的改动索引失败：${gitFailure(staged)}`,
      );
    }
    const patch = await git([
      '-C',
      worktreePath,
      'diff',
      '--binary',
      '--no-color',
      // See the doc comment: the fallback's path set must equal the patch's.
      '--no-renames',
      '--no-ext-diff',
      // A user diff driver's textconv would execute its configured program
      // inside the host process; the patch only needs the raw bytes.
      '--no-textconv',
      baseOid,
      '--',
    ]);
    if (patch.code !== 0) {
      throw new AppError(
        'WORKTREE_NOT_AVAILABLE',
        `读取隔离目录改动失败：${gitFailure(patch)}`,
      );
    }
    if (patch.stdout.trim().length === 0) return { ok: true, empty: true };
    // A private directory (0700, random name) keeps a local attacker from
    // pre-planting a symlink where the host writes the patch.
    const patchDir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-worktree-patch-'));
    const patchFile = path.join(patchDir, 'changes.patch');
    writeFileSync(patchFile, patch.stdout, { mode: 0o600 });
    try {
      const check = await git([
        '-C',
        workdirPath,
        'apply',
        '--check',
        '--binary',
        '--whitespace=nowarn',
        patchFile,
      ]);
      if (check.code === 0) {
        const applied = await git([
          '-C',
          workdirPath,
          'apply',
          '--binary',
          '--whitespace=nowarn',
          patchFile,
        ]);
        if (applied.code === 0) return { ok: true, empty: false };
        return {
          ok: false,
          conflicts: [],
          reason: `写入工作目录失败：${gitFailure(applied)}`,
          worktreeKept: true,
        };
      }
      // Plain apply would fail: merge three-way with a restore point.
      const touched = await git([
        '-C',
        worktreePath,
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        baseOid,
        '--',
      ]);
      const files = touched.code === 0 ? splitNul(touched.stdout) : [];
      const backup = createRestorePoint(workdirPath, files);
      const mergeIndex = await this.#mergeIndexFor(workdirPath, files);
      const mergeEnv = mergeIndex !== null ? { GIT_INDEX_FILE: mergeIndex.indexFile } : null;
      try {
        const merged = await git(
          ['-C', workdirPath, 'apply', '--3way', '--binary', '--whitespace=nowarn', patchFile],
          undefined,
          mergeEnv !== null ? { env: mergeEnv } : {},
        );
        if (merged.code === 0) {
          return { ok: true, empty: false };
        }
        const unmerged = await git(
          ['-C', workdirPath, 'diff', '--name-only', '--diff-filter=U', '-z'],
          undefined,
          mergeEnv !== null ? { env: mergeEnv } : {},
        );
        const conflicts =
          unmerged.code === 0 && unmerged.stdout.length > 0 ? splitNul(unmerged.stdout) : files;
        backup.restore();
        return {
          ok: false,
          conflicts,
          reason: `三方合并冲突：${gitFailure(merged)}`,
          worktreeKept: true,
        };
      } finally {
        mergeIndex?.dispose();
        backup.dispose();
      }
    } finally {
      try {
        rmSync(patchDir, { recursive: true, force: true });
      } catch {
        // temp file cleanup is best effort
      }
    }
  }

  /**
   * Private index for the three-way fallback: a copy of the workdir's index in
   * which every touched path that disagrees with the workdir (unstaged edit,
   * deletion, untracked file) is replaced by what is actually on disk. `git
   * apply --index` then sees a clean, truthful "ours" and the merge no longer
   * refuses or silently drops the user's edits. Null = no usable index (the
   * caller falls back to git's own refusal, reported as a conflict).
   */
  async #mergeIndexFor(
    workdirPath: string,
    files: readonly string[],
  ): Promise<{ indexFile: string; dispose(): void } | null> {
    const realIndex = gitPathSync(workdirPath, 'index');
    if (realIndex === null || !existsSync(realIndex)) return null;
    // Only paths where the workdir disagrees with the index need materializing.
    const changed = await git([
      '-C',
      workdirPath,
      'diff-files',
      '--name-only',
      '-z',
      '--no-ext-diff',
      '--',
    ]);
    const untracked = await git([
      '-C',
      workdirPath,
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
    ]);
    if (changed.code !== 0 || untracked.code !== 0) return null;
    const dirty = new Set([...splitNul(changed.stdout), ...splitNul(untracked.stdout)]);
    const targets = files.filter((file) => dirty.has(file) && isRepoRelativePath(file));
    if (targets.length === 0) return null;
    if (targets.length > WORKTREE_MERGE_INDEX_MAX_PATHS) {
      this.#logger?.warn(
        { workdirPath, paths: targets.length, max: WORKTREE_MERGE_INDEX_MAX_PATHS },
        'too many dirty paths for the merge index; the apply reports a conflict',
      );
      return null;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-worktree-merge-index-'));
    const indexFile = path.join(dir, 'index');
    const dispose = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best effort
      }
    };
    try {
      copyFileSync(realIndex, indexFile);
      chmodSync(indexFile, 0o600);
    } catch (error) {
      this.#logger?.warn(
        { workdirPath, error: error instanceof Error ? error.message : String(error) },
        'merge index copy failed',
      );
      dispose();
      return null;
    }
    const env = { GIT_INDEX_FILE: indexFile };
    for (const rel of targets) {
      if (!(await this.#materializeIndexEntry(workdirPath, rel, env))) {
        dispose();
        return null;
      }
    }
    // Stat information for the entries just written (git refuses `--index`
    // otherwise). Exit 1 only means some OTHER path still differs — the merge
    // checks the patched paths alone.
    await git(['-C', workdirPath, 'update-index', '-q', '--refresh'], undefined, { env });
    return { indexFile, dispose };
  }

  /** Writes the workdir's current state of one path into the private index. */
  async #materializeIndexEntry(
    workdirPath: string,
    rel: string,
    env: Record<string, string>,
  ): Promise<boolean> {
    const source = path.join(workdirPath, rel);
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      // "ours" deleted it: the index must say so, or `--3way` sees the old blob.
      const removed = await git(
        ['-C', workdirPath, 'update-index', '--force-remove', '--', rel],
        undefined,
        { env },
      );
      return removed.code === 0;
    }
    // Directories (submodules) and special files cannot be reproduced here:
    // leave the entry alone and let git report the conflict.
    if (!stat.isFile() && !stat.isSymbolicLink()) return true;
    let mode: string;
    let hashed: GitResult;
    if (stat.isSymbolicLink()) {
      mode = '120000';
      let target: string;
      try {
        target = readlinkSync(source);
      } catch {
        return false;
      }
      hashed = await git(['-C', workdirPath, 'hash-object', '-w', '--no-filters', '--stdin'], undefined, {
        env,
        stdin: target,
      });
    } else {
      mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
      hashed = await git(
        ['-C', workdirPath, 'hash-object', '-w', '--no-filters', '--', rel],
        undefined,
        { env },
      );
    }
    const oid = hashed.stdout.trim();
    if (hashed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) return false;
    const updated = await git(
      ['-C', workdirPath, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${rel}`],
      undefined,
      { env },
    );
    return updated.code === 0;
  }

  /** Records the outcome of a `worktree_apply` decision (process memory). */
  setApplyState(runId: string, state: TaskApplyState): void {
    this.#applyStates.delete(runId);
    this.#applyStates.set(runId, state);
    // Bounded like the other per-run maps: settled tasks are never evicted by
    // anything else, and a long-lived process would grow forever.
    if (this.#applyStates.size > WORKTREE_APPLY_STATE_MAX) {
      const oldest = this.#applyStates.keys().next().value;
      if (oldest !== undefined) this.#applyStates.delete(oldest);
    }
  }

  applyStateFor(run: Run, isTerminal: boolean): TaskApplyState {
    if (run.isolation !== 'worktree') return 'none';
    const recorded = this.#applyStates.get(run.id);
    if (recorded !== undefined) return recorded;
    if (run.worktreePath === null) return 'none';
    // Not recorded in this process (restart): a surviving tree is `kept`
    // (denied / timed out / interrupted), a vanished one was applied.
    if (!existsSync(run.worktreePath)) return 'applied';
    return isTerminal ? 'kept' : 'none';
  }

  /**
   * Daily orphan reaper: `.worktree/<name>-<short>/` directories with no
   * non-terminal task and an mtime past the retention window. A directory
   * that is (or contains) a registered mount is never touched — deleting
   * user-visible data is worse than keeping a stale tree.
   */
  async reap(input: {
    workdirs: readonly string[];
    activeTasks: readonly Run[];
    isMounted: (candidate: string) => boolean;
    now: number;
    retentionMs?: number;
  }): Promise<string[]> {
    const retention = input.retentionMs ?? WORKTREE_RETENTION_MS;
    const active = new Set(
      input.activeTasks
        .filter((run) => run.worktreePath !== null)
        .map((run) => canonicalPath(run.worktreePath!)),
    );
    const homes = new Set<string>();
    for (const workdir of input.workdirs) {
      const dir = worktreeDirFor(workdir);
      if (existsSync(dir)) homes.add(dir);
    }
    const reaped: string[] = [];
    for (const home of homes) {
      let entries: string[];
      try {
        entries = await readdir(home);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(home, entry);
        let stat;
        try {
          // lstat: a symlink planted in the home must never be followed into
          // a removal target outside it.
          stat = lstatSync(candidate);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const canonical = canonicalPath(candidate);
        if (input.now - stat.mtimeMs < retention) continue;
        if (active.has(canonical)) continue;
        if (input.isMounted(canonical)) continue;
        // Only our own layout: `<basename>-<run tail>`, optionally with the
        // collision suffix (`-<6 chars>`) appended by #uniquePath.
        if (!/^[^/]+-[A-Za-z0-9]{4,8}(?:-[A-Za-z0-9]{4,8})?$/.test(entry)) continue;
        try {
          await this.#removeOrphan(canonical);
          reaped.push(canonical);
        } catch (error) {
          this.#logger?.warn(
            { worktreePath: canonical, error: error instanceof Error ? error.message : String(error) },
            'orphan worktree removal failed',
          );
        }
      }
    }
    return reaped;
  }

  async #removeOrphan(worktreePath: string): Promise<void> {
    const meta = readWorktreeMeta(worktreePath);
    if (meta !== null) {
      const mainWorkdir = path.dirname(meta.gitCommonDir);
      const removed = await git([
        '-C',
        mainWorkdir,
        'worktree',
        'remove',
        '--force',
        worktreePath,
      ]);
      if (removed.code !== 0) {
        // The main checkout may be gone / renamed: remove by metadata path.
        const byGitDir = await git([
          `--git-dir=${meta.gitCommonDir}`,
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]);
        if (byGitDir.code !== 0) rmSync(worktreePath, { recursive: true, force: true });
      }
      await git([`--git-dir=${meta.gitCommonDir}`, 'worktree', 'prune']);
      return;
    }
    rmSync(worktreePath, { recursive: true, force: true });
  }

  #uniquePath(workdirPath: string, runId: string): string {
    const base = worktreePathFor(workdirPath, runId);
    // Canonicalize before checking: a pre-existing `.worktree` home may be a
    // symlink, and the recorded tree path must be the one every resolver
    // (gateway / sandbox) computes — not the link spelling.
    const free = (candidate: string): string | null => {
      const resolved = canonicalPath(candidate);
      return existsSync(resolved) ? null : resolved;
    };
    let resolved = free(base);
    for (let index = 0; index < 6 && resolved === null; index += 1) {
      resolved = free(`${base}-${Math.random().toString(36).slice(2, 8)}`);
    }
    if (resolved === null) {
      throw new AppError('WORKTREE_CREATE_FAILED', `隔离目录路径已被占用：${base}`);
    }
    if (resolved.length > WORKTREE_PATH_MAX) {
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `隔离目录路径过长（${resolved.length} > ${WORKTREE_PATH_MAX}）：${resolved}`,
      );
    }
    return resolved;
  }

  #ensureWorktreeHome(workdirPath: string): void {
    const dir = worktreeDirFor(workdirPath);
    // `首次创建` only: a pre-existing directory may be the user's own (another
    // tool's worktree home). Never chmod it and never drop a `.gitignore`
    // into it — both would rewrite data this feature does not own.
    const fresh = !existsSync(dir);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fresh) chmodSync(dir, 0o700);
    } catch (error) {
      throw new AppError(
        'WORKTREE_CREATE_FAILED',
        `无法创建隔离目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!fresh) return;
    const ignore = path.join(dir, '.gitignore');
    try {
      writeFileSync(ignore, '*\n', { mode: 0o600 });
    } catch {
      // Best effort: the parent being a repository would show the trees as
      // untracked; the worktree itself is unaffected.
    }
  }

  /**
   * Copies `.worktreeinclude` entries (gitignore syntax, resolved by git
   * itself) from the workdir into the worktree. Only ignored, existing,
   * non-symlink files are copied; an existing target is never overwritten.
   *
   * The target side is hostile territory: the tree is a checkout of the
   * repository, so a committed symlink (a directory or a dangling file link)
   * may sit exactly where an include entry lands. The real parent of every
   * copy is verified inside the tree and any existing target entry (links
   * included) is skipped, so an include entry can never write outside the
   * tree through the host's own privileges. A genuine copy failure fails the
   * creation (the contract: every failed step cleans up and fails the task).
   */
  #copyIncludes(workdirPath: string, worktreePath: string): string[] {
    if (!existsSync(path.join(workdirPath, WORKTREE_INCLUDE_FILE))) return [];
    const listing = spawnSyncGit([
      '-C',
      workdirPath,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-from',
      WORKTREE_INCLUDE_FILE,
      '-z',
    ]);
    if (listing.code !== 0) {
      throw new Error(`读取 ${WORKTREE_INCLUDE_FILE} 失败：${gitFailure(listing)}`);
    }
    const root = canonicalPath(worktreePath);
    const copied: string[] = [];
    for (const relative of splitNul(listing.stdout)) {
      if (relative.length === 0 || path.isAbsolute(relative)) continue;
      const normalized = relative.replaceAll('\\', '/');
      if (normalized.split('/').includes('..')) continue;
      const source = path.join(workdirPath, normalized);
      const target = path.join(worktreePath, normalized);
      let sourceStat;
      try {
        sourceStat = lstatSync(source);
      } catch {
        continue;
      }
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) continue;
      // Any existing entry — a regular file, a directory, or a dangling
      // symlink — is left alone. `existsSync` would follow a dangling link
      // and let the copy write through it.
      try {
        lstatSync(target);
        continue;
      } catch {
        // ENOENT: a fresh target
      }
      const relativeDir = path.dirname(normalized);
      if (hasSymlinkComponent(worktreePath, relativeDir)) {
        // A committed symlink sits where this entry would land: never write
        // through it (the link may point outside the tree).
        this.#logger?.warn(
          { path: normalized },
          'worktree include target is behind a symlink; skipped',
        );
        continue;
      }
      try {
        mkdirSync(path.dirname(target), { recursive: true });
      } catch (error) {
        // A file where the entry needs a directory: the checkout's own
        // content wins, the include entry is skipped (never overwritten).
        this.#logger?.warn(
          { path: normalized, error: error instanceof Error ? error.message : String(error) },
          'worktree include target directory blocked; skipped',
        );
        continue;
      }
      try {
        // Belt and braces: the real parent must still live in the tree.
        const realParent = realpathSync(path.dirname(target));
        if (!isInsidePath(realParent, root)) {
          this.#logger?.warn(
            { path: normalized, realParent },
            'worktree include target escapes the tree; skipped',
          );
          continue;
        }
        copyFileSync(source, path.join(realParent, path.basename(target)));
        copied.push(normalized);
      } catch (error) {
        throw new Error(
          `复制 ${WORKTREE_INCLUDE_FILE} 条目 ${normalized} 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
    return copied;
  }

  async #cleanupFailed(workdirPath: string, target: string): Promise<void> {
    if (!existsSync(target)) {
      await this.prune(workdirPath).catch(() => {});
      return;
    }
    await this.remove(workdirPath, target).catch(() => {});
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}

/** Upper bound for the restore point: files past it are left untouched on restore. */
const RESTORE_POINT_MAX_BYTES = 64 * 1024 * 1024;

interface RestorePoint {
  restore(): void;
  dispose(): void;
}

/**
 * One touched path of the restore point. `delete` is used only when the path
 * truly did not exist before the apply (lstat ENOENT); a path that existed but
 * could not be backed up (oversized, unreadable, not a regular file) is
 * `skip` — restoring must never delete a user file it failed to snapshot.
 */
type RestoreEntry = { rel: string; action: 'restore'; slot: string } | { rel: string; action: 'delete' | 'skip' };

/**
 * Snapshot of the files an apply may touch plus the index file. `files` are
 * workdir-relative; the backup stores them by index so a hostile path cannot
 * escape the backup directory.
 */
function createRestorePoint(workdirPath: string, files: readonly string[]): RestorePoint {
  // Random 0700 directory: a pre-planted symlink inside a predictable name
  // could redirect the snapshots / the restore itself.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kepcup-worktree-restore-'));
  const entries: RestoreEntry[] = [];
  const indexFile = gitPathSync(workdirPath, 'index');
  let indexBackup: string | null = null;
  let total = 0;
  try {
    if (indexFile !== null && existsSync(indexFile)) {
      indexBackup = path.join(dir, 'index');
      copyFileSync(indexFile, indexBackup);
      total += statSync(indexFile).size;
    }
    for (const rel of files) {
      if (!isRepoRelativePath(rel)) continue;
      const source = path.join(workdirPath, rel);
      let stat;
      try {
        stat = lstatSync(source);
      } catch (error) {
        // Only a missing path may be deleted on restore; an unreadable one is
        // left exactly as the failed apply left it.
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        entries.push({ rel, action: missing ? 'delete' : 'skip' });
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        // A directory / symlink cannot be reproduced by a byte copy; leave it.
        entries.push({ rel, action: 'skip' });
        continue;
      }
      total += stat.size;
      if (total > RESTORE_POINT_MAX_BYTES) {
        // Too large to copy: restores what it has, never touches this file.
        entries.push({ rel, action: 'skip' });
        continue;
      }
      const slot = path.join(dir, `f${entries.length}`);
      try {
        copyFileSync(source, slot);
      } catch {
        entries.push({ rel, action: 'skip' });
        continue;
      }
      entries.push({ rel, action: 'restore', slot });
    }
  } catch {
    // A failed restore point must not block the apply attempt; the conflict
    // path then restores as much as it captured.
  }
  return {
    restore(): void {
      for (const entry of entries) {
        if (entry.action === 'skip') continue;
        const target = path.join(workdirPath, entry.rel);
        try {
          if (entry.action === 'restore') {
            mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(entry.slot, target);
          } else {
            rmSync(target, { force: true });
          }
        } catch {
          // best effort: the conflict report still names the files
        }
      }
      if (indexBackup !== null && indexFile !== null) {
        try {
          copyFileSync(indexBackup, indexFile);
        } catch {
          // best effort
        }
      }
    },
    dispose(): void {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best effort
      }
    },
  };
}

function gitPathSync(workdirPath: string, name: string): string | null {
  const result = spawnSyncGit(['-C', workdirPath, 'rev-parse', '--git-path', name]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  if (value.length === 0) return null;
  return path.isAbsolute(value) ? value : path.join(workdirPath, value);
}

function spawnSyncGit(args: string[]): GitResult {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  return {
    code: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error !== undefined ? String(result.error) : ''),
  };
}

function splitNul(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0);
}

/** A path git could have listed for this repository (never outside the root). */
function isRepoRelativePath(value: string): boolean {
  if (value.length === 0 || path.isAbsolute(value) || value.includes('\0')) return false;
  return !value.split(/[\\/]+/).includes('..');
}

/**
 * Whether any existing component of `relativeDir` under `root` is a symlink
 * (or a non-directory). Components that do not exist yet are fine — the copy
 * creates them. Lexical walking (no path resolution), so a dangling link is
 * seen as a link.
 */
function hasSymlinkComponent(root: string, relativeDir: string): boolean {
  if (relativeDir === '' || relativeDir === '.') return false;
  let current = root;
  for (const segment of relativeDir.split(/[\\/]+/)) {
    if (segment.length === 0) continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  }
  return false;
}

/** Parses `git diff --numstat -z` (renames use an empty path field + two names). */
function parseNumstat(value: string): Array<{
  file: string;
  insertions: number;
  deletions: number;
}> {
  const chunks = value.split('\0');
  const entries: Array<{ file: string; insertions: number; deletions: number }> = [];
  let index = 0;
  while (index < chunks.length) {
    const head = chunks[index];
    index += 1;
    if (head === undefined || head.length === 0) continue;
    const parts = head.split('\t');
    const add = parts[0] ?? '0';
    const del = parts[1] ?? '0';
    const inline = parts[2];
    let file: string;
    if (inline !== undefined && inline.length > 0) {
      file = inline;
    } else {
      const oldPath = chunks[index] ?? '';
      const newPath = chunks[index + 1] ?? '';
      index += 2;
      file = newPath.length > 0 ? newPath : oldPath;
    }
    if (file.length === 0) continue;
    entries.push({
      file,
      insertions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
      deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
    });
  }
  return entries;
}
