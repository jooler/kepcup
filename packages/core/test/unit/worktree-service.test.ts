import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isWorktreePathOf,
  readWorktreeMeta,
  WorktreeService,
  worktreeDirFor,
  worktreePathFor,
} from '../../src/workdir/worktree.js';
import type { Run } from '@kepcup/shared';

/**
 * D140-4 worktree service against real git repositories: creation from the
 * user's working state, `.worktreeinclude`, the change summary, the three-way
 * apply (clean + conflict restore) and the orphan reaper.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * A repository in its own parent directory: the `.worktree` home lives next to
 * the workdir (shared by every repo under the same parent), so each fixture
 * needs an isolated parent for assertions and cleanup.
 */
function repo(files: Record<string, string> = { 'README.md': '# base\n' }): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'd140-worktree-root-'));
  dirs.push(root);
  const dir = path.join(root, 'workdir');
  mkdirSync(dir);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'fixture']);
  git(dir, ['config', 'user.email', 'fixture@localhost']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.eol', 'lf']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function service(): WorktreeService {
  return new WorktreeService();
}

/** git worktree list uses long forward-slash paths; Node may have 8.3 names. */
function listHasPath(listed: string, worktreePath: string): boolean {
  const normalize = (value: string) =>
    value.replaceAll('\\', '/').replace(/^\/\/\?\//, '').toLowerCase();
  const listedNorm = normalize(listed);
  const candidates = new Set([worktreePath]);
  try {
    candidates.add(realpathSync(worktreePath));
  } catch {
    // The tree may already have been removed.
  }
  try {
    candidates.add(realpathSync.native(worktreePath));
  } catch {
    // native realpath is best-effort (8.3 → long path).
  }
  return [...candidates].some((candidate) => listedNorm.includes(normalize(candidate)));
}

/** Git for Windows marks the gitfile read-only; chmod before forging it. */
function rewriteGitPointer(worktreePath: string, content: string): void {
  const pointer = path.join(worktreePath, '.git');
  try {
    chmodSync(pointer, 0o666);
  } catch {
    // already writable
  }
  writeFileSync(pointer, content);
}

describe('D140-4 WorktreeService', () => {
  it('creates <parent>/.worktree/<name>-<run tail> from the current working state (uncommitted changes included)', async () => {
    const workdir = repo();
    // Unstaged + staged changes must both land in the tree.
    writeFileSync(path.join(workdir, 'README.md'), '# changed\n');
    writeFileSync(path.join(workdir, 'staged.ts'), 'export const staged = 1;\n');
    git(workdir, ['add', 'staged.ts']);
    const runId = 'run_01KEPCUP3F9A1C2D';
    const info = await service().create({ workdirPath: workdir, runId });

    const canonical = realpathSync(workdir);
    expect(info.path).toBe(worktreePathFor(canonical, runId));
    expect(path.dirname(info.path)).toBe(worktreeDirFor(canonical));
    expect(info.path.startsWith(path.join(path.dirname(canonical), '.worktree'))).toBe(true);
    expect(readFileSync(path.join(info.path, 'README.md'), 'utf8')).toBe('# changed\n');
    expect(readFileSync(path.join(info.path, 'staged.ts'), 'utf8')).toBe(
      'export const staged = 1;\n',
    );
    // Detached HEAD pointing at the stash-create commit (the user's state).
    const head = git(info.path, ['rev-parse', 'HEAD']).trim();
    expect(head).toBe(info.baseOid);
    expect(git(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');
    // The home is private and ignores its contents (the parent may be a repo).
    const home = worktreeDirFor(workdir);
    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(path.join(home, '.gitignore'), 'utf8')).toContain('*');
    // Metadata points at the main repository's precise worktrees/ subtree.
    const meta = readWorktreeMeta(info.path);
    expect(meta).not.toBeNull();
    expect(meta!.gitWorktreeMeta).toBe(info.gitWorktreeMeta);
    expect(meta!.gitCommonDir).toBe(info.gitCommonDir);
    expect(info.gitObjectsDir).toBe(path.join(info.gitCommonDir, 'objects'));
  }, 60_000);

  it('uses HEAD when the working tree is clean and copies .worktreeinclude entries only', async () => {
    const workdir = repo({ 'README.md': '# base\n', '.gitignore': 'dist/\n.env.local\n' });
    mkdirSync(path.join(workdir, 'dist'), { recursive: true });
    writeFileSync(path.join(workdir, 'dist', 'app.js'), 'built\n');
    writeFileSync(path.join(workdir, '.env.local'), 'SECRET=1\n');
    writeFileSync(path.join(workdir, '.worktreeinclude'), 'dist/\n');
    // symlinks are skipped (a link target outside the tree must never be copied)
    if (process.platform !== 'win32') {
      writeFileSync(path.join(workdir, 'link-target.txt'), 'target\n');
      spawnSync('ln', ['-s', path.join(workdir, 'link-target.txt'), path.join(workdir, 'dist', 'link')]);
      spawnSync('sh', ['-c', `printf 'dist/link\\n' >> ${JSON.stringify(path.join(workdir, '.worktreeinclude'))}`]);
    }
    const info = await service().create({ workdirPath: workdir, runId: 'run_clean_state' });
    expect(info.baseOid).toBe(git(workdir, ['rev-parse', 'HEAD']).trim());
    expect(info.copied).toContain('dist/app.js');
    expect(readFileSync(path.join(info.path, 'dist', 'app.js'), 'utf8')).toBe('built\n');
    // Ignored but not listed: not copied.
    expect(existsSync(path.join(info.path, '.env.local'))).toBe(false);
    expect(existsSync(path.join(info.path, '.worktreeinclude'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(existsSync(path.join(info.path, 'dist', 'link'))).toBe(false);
    }
  }, 60_000);

  it('summarizes the tree diff (untracked files included) and applies it back cleanly, then removes the tree', async () => {
    const workdir = repo();
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_apply_clean' });
    writeFileSync(path.join(info.path, 'README.md'), '# base\nnew line\n');
    writeFileSync(path.join(info.path, 'new-file.ts'), 'export const created = true;\n');

    const summary = await svc.summary(info.path, info.baseOid);
    expect(summary).not.toBeNull();
    expect(summary!.fileCount).toBe(2);
    expect(summary!.files).toEqual(['new-file.ts', 'README.md']);
    expect(summary!.insertions).toBe(2);
    expect(summary!.deletions).toBe(0);

    const applied = await svc.apply({
      workdirPath: workdir,
      worktreePath: info.path,
      baseOid: info.baseOid,
    });
    expect(applied).toEqual({ ok: true, empty: false });
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toContain('new line');
    expect(readFileSync(path.join(workdir, 'new-file.ts'), 'utf8')).toContain('created = true');

    await svc.remove(workdir, info.path);
    expect(existsSync(info.path)).toBe(false);
    expect(git(workdir, ['worktree', 'list'])).not.toContain(info.path);
  }, 60_000);

  it('three-way merges an unstaged user edit (no false conflict) and never rewrites the real index', async () => {
    const workdir = repo({ 'doc.txt': 'A\nB\nC\nD\nE\nF\nG\nH\n' });
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_apply_unstaged' });
    // The task edits a later line and adds a file (untracked in the tree).
    writeFileSync(path.join(info.path, 'doc.txt'), 'A\nB\nC\nD\nTASK\nF\nG\nH\n');
    writeFileSync(path.join(info.path, 'new-from-task.txt'), 'created\n');
    // The user edits an earlier line after the task started — unstaged, the
    // normal state of a checkout. `git apply --3way` alone refuses this
    // ("does not match index"); the merge must still run.
    writeFileSync(path.join(workdir, 'doc.txt'), 'USER\nB\nC\nD\nE\nF\nG\nH\n');

    const outcome = await svc.apply({
      workdirPath: workdir,
      worktreePath: info.path,
      baseOid: info.baseOid,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.empty).toBe(false);
    // Both edits survive; the task's new file landed.
    expect(readFileSync(path.join(workdir, 'doc.txt'), 'utf8')).toBe(
      'USER\nB\nC\nD\nTASK\nF\nG\nH\n',
    );
    expect(readFileSync(path.join(workdir, 'new-from-task.txt'), 'utf8')).toBe('created\n');
    // The real index was never touched: nothing staged, the user's edit is
    // still unstaged and the merged file is not staged either.
    expect(git(workdir, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(git(workdir, ['status', '--porcelain']).split('\n').filter((line) => line !== '').sort()).toEqual([
      ' M doc.txt',
      '?? new-from-task.txt',
    ]);
  }, 60_000);

  it('a user deletion of a file the task modified is a conflict and stays deleted', async () => {
    const workdir = repo({ 'doc.txt': 'A\nB\n' });
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_apply_user_deleted' });
    writeFileSync(path.join(info.path, 'doc.txt'), 'A\nTASK\n');
    rmSync(path.join(workdir, 'doc.txt'));

    const outcome = await svc.apply({
      workdirPath: workdir,
      worktreePath: info.path,
      baseOid: info.baseOid,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.conflicts).toContain('doc.txt');
    // Restore must not resurrect a file the user had deleted.
    expect(existsSync(path.join(workdir, 'doc.txt'))).toBe(false);
    // No unmerged entries outside the user's own index (never written).
    expect(git(workdir, ['diff', '--name-only', '--diff-filter=U']).trim()).toBe('');
    // The tree still has the task's edit.
    expect(readFileSync(path.join(info.path, 'doc.txt'), 'utf8')).toBe('A\nTASK\n');
  }, 60_000);

  it('reports a conflict, restores the workdir byte-for-byte and keeps the tree', async () => {
    const workdir = repo();
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_apply_conflict' });
    writeFileSync(path.join(info.path, 'README.md'), '# base\ntask edit\n');
    // The user edits the same line after the tree started.
    writeFileSync(path.join(workdir, 'README.md'), '# base\nuser edit\n');
    const before = readFileSync(path.join(workdir, 'README.md'), 'utf8');

    const outcome = await svc.apply({
      workdirPath: workdir,
      worktreePath: info.path,
      baseOid: info.baseOid,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.conflicts).toContain('README.md');
    // The user's file is untouched: no merge markers, no task edit.
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toBe(before);
    expect(existsSync(path.join(workdir, 'README.md'))).toBe(true);
    // The index is restored too (no unmerged entries left behind).
    expect(git(workdir, ['diff', '--name-only', '--diff-filter=U']).trim()).toBe('');
    // The tree survives with its changes.
    expect(readFileSync(path.join(info.path, 'README.md'), 'utf8')).toContain('task edit');
  }, 60_000);

  it('restores deleted files and removes files the failed apply created', async () => {
    const workdir = repo({ 'README.md': '# base\n', 'keep.txt': 'keep\n' });
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_apply_restore' });
    rmSync(path.join(info.path, 'keep.txt'));
    writeFileSync(path.join(info.path, 'created.txt'), 'created\n');
    writeFileSync(path.join(info.path, 'README.md'), '# base\nconflicting task edit\n');
    writeFileSync(path.join(workdir, 'README.md'), '# base\nuser edit\n');

    const outcome = await svc.apply({
      workdirPath: workdir,
      worktreePath: info.path,
      baseOid: info.baseOid,
    });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(path.join(workdir, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(path.join(workdir, 'created.txt'))).toBe(false);
    expect(readFileSync(path.join(workdir, 'README.md'), 'utf8')).toBe('# base\nuser edit\n');
  }, 60_000);

  it('fails creation outside a git repo and cleans up an empty repo', async () => {
    const notGit = mkdtempSync(path.join(os.tmpdir(), 'd140-worktree-nogit-'));
    dirs.push(notGit);
    await expect(service().create({ workdirPath: notGit, runId: 'run_nogit' })).rejects.toThrow(
      /不是 git 仓库/,
    );
    // No half-created tree is left behind for a failure before the add step.
    expect(entriesOf(worktreeDirFor(realpathSync(notGit))).some((e) => e.includes('nogit'))).toBe(
      false,
    );

    const empty = mkdtempSync(path.join(os.tmpdir(), 'd140-worktree-empty-'));
    dirs.push(empty);
    git(empty, ['init', '-q']);
    await expect(service().create({ workdirPath: empty, runId: 'run_empty' })).rejects.toThrow(
      /还没有提交/,
    );
  }, 60_000);

  it('refuses a workdir whose parent is missing or whose tree path exceeds WORKTREE_PATH_MAX', async () => {
    const missing = path.join(
      os.tmpdir(),
      `d140-worktree-missing-${process.pid}-${Date.now()}`,
      'workdir',
    );
    await expect(service().create({ workdirPath: missing, runId: 'run_missing' })).rejects.toThrow(
      /父目录不存在/,
    );

    // Deep parent: the workdir itself is valid, its `.worktree` path is not.
    // Stay under Windows MAX_PATH (~260) so `git init` works; only the
    // computed tree path must exceed WORKTREE_PATH_MAX (200).
    const deepRoot = mkdtempSync(path.join(os.tmpdir(), 'd140-worktree-long-'));
    dirs.push(deepRoot);
    let deep = deepRoot;
    const workdirAt = (root: string) => path.join(root, 'workdir');
    const treeLen = (root: string) => worktreePathFor(workdirAt(root), 'run_long_0001').length;
    while (treeLen(deep) <= 200) {
      const next = path.join(deep, 'aaaaaaaaaa');
      // Leave headroom for `\\workdir` and git metadata under Windows MAX_PATH.
      if (workdirAt(next).length > 230) break;
      deep = next;
    }
    const workdir = workdirAt(deep);
    mkdirSync(workdir, { recursive: true });
    git(workdir, ['init', '-q', '-b', 'main']);
    git(workdir, ['config', 'user.name', 'fixture']);
    git(workdir, ['config', 'user.email', 'fixture@localhost']);
    git(workdir, ['config', 'core.autocrlf', 'false']);
    writeFileSync(path.join(workdir, 'README.md'), '# base\n');
    git(workdir, ['add', '-A']);
    git(workdir, ['commit', '-q', '-m', 'init']);
    expect(worktreePathFor(realpathSync(workdir), 'run_long_0001').length).toBeGreaterThan(200);
    await expect(service().create({ workdirPath: workdir, runId: 'run_long_0001' })).rejects.toThrow(
      /路径过长/,
    );
  }, 60_000);

  it('never overwrites a leftover directory with the same name (random suffix instead)', async () => {
    const workdir = repo();
    const svc = service();
    const first = await svc.create({ workdirPath: workdir, runId: 'run_same_name' });
    writeFileSync(path.join(first.path, 'leftover.txt'), 'leftover\n');
    const second = await svc.create({ workdirPath: workdir, runId: 'run_same_name' });
    expect(second.path).not.toBe(first.path);
    expect(second.path.startsWith(`${first.path}-`)).toBe(true);
    // The first tree is untouched.
    expect(readFileSync(path.join(first.path, 'leftover.txt'), 'utf8')).toBe('leftover\n');
    expect(existsSync(path.join(second.path, 'leftover.txt'))).toBe(false);
    // Both are registered worktrees of the repo.
    const listed = git(workdir, ['worktree', 'list']);
    expect(listHasPath(listed, first.path)).toBe(true);
    expect(listHasPath(listed, second.path)).toBe(true);
  }, 60_000);

  it('reaps aged orphan trees only when no active task owns them and they are not mounted', async () => {
    const workdir = repo();
    const svc = service();
    const orphan = await svc.create({ workdirPath: workdir, runId: 'run_orphan_0001' });
    const active = await svc.create({ workdirPath: workdir, runId: 'run_active_0002' });
    const mounted = await svc.create({ workdirPath: workdir, runId: 'run_mounted_003' });
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    for (const info of [orphan, active, mounted]) utimesSync(info.path, new Date(old), new Date(old));

    const activeRun = {
      id: 'run_active_0002',
      isolation: 'worktree',
      worktreePath: active.path,
      status: 'running',
    } as unknown as Run;
    const reaped = await svc.reap({
      workdirs: [workdir],
      activeTasks: [activeRun],
      isMounted: (candidate) => candidate === mounted.path,
      now: Date.now(),
    });
    expect(reaped).toEqual([orphan.path]);
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(mounted.path)).toBe(true);
    // The main repo's metadata was pruned with it.
    expect(listHasPath(git(workdir, ['worktree', 'list']), orphan.path)).toBe(false);
  }, 60_000);

  it('derives the apply state for unrecorded runs (surviving tree = kept, vanished = applied)', () => {
    const svc = service();
    const base = {
      id: 'run_state',
      isolation: 'worktree',
      worktreePath: '/tmp/does-not-exist-d140',
    } as unknown as Run;
    expect(svc.applyStateFor(base, true)).toBe('applied');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'd140-worktree-state-'));
    dirs.push(dir);
    const existing = { ...base, worktreePath: dir } as Run;
    expect(svc.applyStateFor(existing, true)).toBe('kept');
    expect(svc.applyStateFor(existing, false)).toBe('none');
    svc.setApplyState('run_state', 'conflict');
    expect(svc.applyStateFor(existing, true)).toBe('conflict');
    const plain = { ...base, isolation: null } as Run;
    expect(svc.applyStateFor(plain, true)).toBe('none');
  });

  it('rejects a forged .git pointer instead of letting it steer the sandbox mounts', async () => {
    // The pointer file lives inside the sandbox-writable tree: an escaped
    // `gitdir` must never turn into a readWrite mount of the target directory.
    const workdir = repo();
    const info = await service().create({ workdirPath: workdir, runId: 'run_forged_0001' });
    const target = mkdtempSync(path.join(os.tmpdir(), 'd140-forged-target-'));
    dirs.push(target);
    rewriteGitPointer(info.path, `gitdir: ${target}\n`);
    expect(readWorktreeMeta(info.path)).toBeNull();

    // Structurally plausible (<fake>/worktrees/x) but with a commondir that
    // disagrees with the structural parent: rejected.
    const fake = path.join(target, 'fake-repo');
    const fakeMeta = path.join(fake, 'worktrees', 'evil');
    mkdirSync(fakeMeta, { recursive: true });
    writeFileSync(path.join(fakeMeta, 'commondir'), '/Users\n');
    rewriteGitPointer(info.path, `gitdir: ${fakeMeta}\n`);
    expect(readWorktreeMeta(info.path)).toBeNull();

    // Correct structure but the backlink names another tree: rejected.
    rmSync(path.join(fakeMeta, 'commondir'));
    writeFileSync(path.join(fakeMeta, 'gitdir'), path.join(target, 'other', '.git'));
    expect(readWorktreeMeta(info.path)).toBeNull();

    // A real tree still parses (the create case above already asserts it, but
    // keep the negative cases anchored to a working baseline).
    rewriteGitPointer(info.path, `gitdir: ${info.gitWorktreeMeta}\n`);
    expect(readWorktreeMeta(info.path)).toEqual({
      gitCommonDir: info.gitCommonDir,
      gitWorktreeMeta: info.gitWorktreeMeta,
    });
  }, 60_000);

  it('never copies .worktreeinclude entries through a committed symlink (no host write outside the tree)', async () => {
    if (process.platform === 'win32') return;
    const workdir = repo({ 'README.md': '# base\n', '.gitignore': 'dist/\n' });
    const outside = path.join(path.dirname(workdir), 'outside');
    mkdirSync(outside);
    // The base commit carries `dist` as a symlink to a host directory.
    spawnSync('ln', ['-s', outside, path.join(workdir, 'dist')]);
    git(workdir, ['add', '-A']);
    git(workdir, ['commit', '-q', '-m', 'symlink']);
    // The user replaced it locally with a real ignored build directory.
    rmSync(path.join(workdir, 'dist'));
    mkdirSync(path.join(workdir, 'dist'));
    writeFileSync(path.join(workdir, 'dist', 'app.js'), 'built\n');
    writeFileSync(path.join(workdir, '.worktreeinclude'), 'dist/\n');

    const info = await service().create({ workdirPath: workdir, runId: 'run_symlink_esc' });
    // The copy through `tree/dist -> outside` never happened.
    expect(info.copied).not.toContain('dist/app.js');
    expect(existsSync(path.join(outside, 'app.js'))).toBe(false);
    // The tree keeps its own committed symlink untouched.
    expect(lstatSync(path.join(info.path, 'dist')).isSymbolicLink()).toBe(true);
    // The workdir's real ignored file is still where the user left it.
    expect(readFileSync(path.join(workdir, 'dist', 'app.js'), 'utf8')).toBe('built\n');
  }, 60_000);

  it('leaves a pre-existing .worktree home alone (no chmod, no .gitignore)', async () => {
    const workdir = repo();
    const home = worktreeDirFor(workdir);
    mkdirSync(home);
    writeFileSync(path.join(home, 'user.txt'), 'mine\n');
    if (process.platform !== 'win32') chmodSync(home, 0o755);
    const info = await service().create({ workdirPath: workdir, runId: 'run_preexisting' });
    expect(existsSync(info.path)).toBe(true);
    expect(readFileSync(path.join(home, 'user.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(path.join(home, '.gitignore'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(home).mode & 0o777).toBe(0o755);
    }
  }, 60_000);

  it('refuses to run host-side git on a tree whose .git pointer was rewritten', async () => {
    const workdir = repo();
    const svc = service();
    const info = await svc.create({ workdirPath: workdir, runId: 'run_tampered' });
    writeFileSync(path.join(info.path, 'changed.txt'), 'x\n');
    // A sandboxed command can rewrite the pointer; summary / apply must not
    // let host git follow it into another repository.
    rewriteGitPointer(info.path, `gitdir: ${path.join(workdir, '.git')}\n`);
    expect(await svc.summary(info.path, info.baseOid)).toBeNull();
    await expect(
      svc.apply({ workdirPath: workdir, worktreePath: info.path, baseOid: info.baseOid }),
    ).rejects.toThrow(/git 元数据不可用/);
    expect(existsSync(path.join(workdir, 'changed.txt'))).toBe(false);
  }, 60_000);

  it('never follows a symlink planted in the .worktree home when reaping', async () => {
    if (process.platform === 'win32') return;
    const workdir = repo();
    const svc = service();
    const live = await svc.create({ workdirPath: workdir, runId: 'run_live_0001' });
    expect(existsSync(live.path)).toBe(true);
    const victim = mkdtempSync(path.join(os.tmpdir(), 'd140-reap-victim-'));
    dirs.push(victim);
    writeFileSync(path.join(victim, 'keep.txt'), 'keep\n');
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    utimesSync(victim, new Date(old), new Date(old));
    // The name matches the reaper's layout; the entry is a symlink, not a tree.
    const link = path.join(worktreeDirFor(workdir), 'fake-abcd1234');
    spawnSync('ln', ['-s', victim, link]);

    const reaped = await svc.reap({
      workdirs: [workdir],
      activeTasks: [],
      isMounted: () => false,
      now: Date.now(),
    });
    expect(reaped).toEqual([]);
    expect(readFileSync(path.join(victim, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  }, 60_000);

  it('C9: opens only this root’s own trees under the shared .worktree home', () => {
    const root = path.join(os.tmpdir(), 'd140-c9', 'alice');
    expect(isWorktreePathOf(root, worktreeDirFor(root))).toBe(true);
    expect(isWorktreePathOf(root, path.join(worktreeDirFor(root), 'alice-3f9a1c2d'))).toBe(true);
    expect(
      isWorktreePathOf(root, path.join(worktreeDirFor(root), 'alice-3f9a1c2d', 'src', 'x.ts')),
    ).toBe(true);
    // A sibling root's tree under the same home stays out.
    expect(isWorktreePathOf(root, path.join(worktreeDirFor(root), 'bob-3f9a1c2d'))).toBe(false);
    expect(isWorktreePathOf(root, path.join(os.tmpdir(), 'd140-c9', 'elsewhere'))).toBe(false);
  });
});

function entriesOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
