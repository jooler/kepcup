import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvePaths } from '../../src/infra/paths.js';
import { createSandboxBackend } from '../../src/sandbox/index.js';
import { buildSandboxPolicy } from '../../src/sandbox/policy.js';
import { WorktreeService, worktreePathFor } from '../../src/workdir/worktree.js';
import type { SandboxBackend, SandboxExecResult } from '../../src/sandbox/types.js';

/**
 * D140-4 against the real srt sandbox (macOS / Linux): a task's worktree is the
 * command cwd, the linked worktree's git operations (status / diff / commit)
 * work with only the precise `.git` subtrees writable, `.git/config` stays
 * closed, and the workdir protect rules hold inside the tree.
 */

const supported = process.platform === 'darwin' || process.platform === 'linux';
const d = supported ? describe : describe.skip;
const TIMEOUT = 180_000;

let home: string;
let backend: SandboxBackend;
let available: boolean;
const fixtures: string[] = [];

function fixture(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function repo(files: Record<string, string>): string {
  const root = fixture('kepcup-wt-sandbox-');
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
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'kepcup-wt-sandbox-home-'));
  fixtures.push(home);
  const paths = resolvePaths(home);
  for (const dir of [
    paths.cacheDir,
    paths.cacheNpmDir,
    paths.cachePipDir,
    paths.cacheXdgDir,
    paths.cacheCargoDir,
    paths.cacheUvDir,
    paths.cachePycacheDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  backend = createSandboxBackend({ paths, logger, env: process.env });
  available = (await backend.probe()).available;
}, TIMEOUT);

afterAll(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

d('D140-4 worktree in the real sandbox', () => {
  it('runs in the tree, commits with only the precise .git subtrees writable, and keeps .git/config and .env closed', async () => {
    // The host must provide srt (CI skips unsupported platforms above).
    expect(available).toBe(true);
    const workdir = repo({
      'README.md': '# base\n',
      '.env': 'SECRET=do-not-read\n',
      'src/app.ts': 'export const value = 1;\n',
    });
    const worktrees = new WorktreeService();
    const info = await worktrees.create({
      workdirPath: workdir,
      runId: 'run_sandbox_wt',
    });
    // A sibling task's tree: its contents are another task's private area.
    const siblingPath = worktreePathFor(realpathSync(workdir), 'run_sibling_01');
    const sibling = await worktrees.create({ workdirPath: workdir, runId: 'run_sibling_01' });
    expect(sibling.path).toBe(siblingPath);
    writeFileSync(path.join(sibling.path, 'sibling-only.txt'), 'other task\n');
    const policy = buildSandboxPolicy({
      platform: process.platform,
      paths: resolvePaths(home),
      workspacePath: path.join(home, 'bots', 'bot_1', 'workspaces', 'conv_1'),
      network: { mode: 'none', allowDomains: [] },
      workdir: {
        path: workdir,
        // The task's lease is keyed on the tree, not the workdir.
        hasLease: false,
        denyReadGlobs: [`${workdir}/.env`],
      },
      taskWorktree: {
        path: info.path,
        gitWorktreeMeta: info.gitWorktreeMeta,
        gitObjectsDir: info.gitObjectsDir,
        // The workdir protect rules anchored at the tree root.
        denyReadGlobs: [`${info.path}/.env`, `${info.path}/.env.*`, `${info.path}/**/.env`],
      },
    });

    const run = (command: string, cwd = info.path): Promise<SandboxExecResult> =>
      backend.exec({ command, cwd, policy, timeoutMs: 60_000 });
    const violations = (result: SandboxExecResult): string =>
      result.violations.map((violation) => violation.line).join('\n');

    // The command runs in the tree.
    const pwd = await run('pwd');
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toContain(path.basename(info.path));

    // A write lands in the tree only.
    const touch = await run('printf "sandbox\\n" > sandbox-made.txt');
    expect(touch.exitCode, violations(touch)).toBe(0);
    expect(readFileSync(path.join(info.path, 'sandbox-made.txt'), 'utf8')).toBe('sandbox\n');
    expect(existsSync(path.join(workdir, 'sandbox-made.txt'))).toBe(false);

    // git status / diff read the linked worktree metadata.
    const status = await run('git status --porcelain');
    expect(status.exitCode, violations(status)).toBe(0);
    expect(status.stdout).toContain('sandbox-made.txt');
    const diff = await run('git diff --stat src/app.ts');
    expect(diff.exitCode, violations(diff)).toBe(0);

    // git add / commit write objects + .git/worktrees/<name>/{index,HEAD,logs}.
    const commit = await run(
      'git add -A && git -c user.name=task -c user.email=task@localhost commit -q -m "task commit" && git log -1 --format=%s',
    );
    expect(commit.exitCode, `${violations(commit)}\n${commit.stderr}`).toBe(0);
    expect(commit.stdout.trim()).toBe('task commit');
    // The main checkout's own HEAD is untouched (detached HEAD in the tree).
    expect(git(workdir, ['log', '-1', '--format=%s']).trim()).toBe('init');

    // .git/config (outside the writable set) cannot be appended to.
    const configPath = path.join(workdir, '.git', 'config');
    const before = readFileSync(configPath, 'utf8');
    const configAppend = await run(`printf "x\\n" >> ${JSON.stringify(configPath)}`);
    expect(configAppend.exitCode).not.toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(before);

    // The workdir protect rule is anchored at the tree: .env stays unreadable.
    const envRead = await run('cat .env');
    expect(envRead.exitCode).not.toBe(0);
    expect(envRead.stdout).not.toContain('do-not-read');

    // The main workdir stays a read-only reference.
    const writeWorkdir = await run(
      `printf "escape\\n" > ${JSON.stringify(path.join(workdir, 'escape.txt'))}`,
    );
    expect(writeWorkdir.exitCode).not.toBe(0);
    expect(existsSync(path.join(workdir, 'escape.txt'))).toBe(false);
    // …and stays readable as a reference.
    const readWorkdir = await run(`cat ${JSON.stringify(path.join(workdir, 'README.md'))}`);
    expect(readWorkdir.exitCode, violations(readWorkdir)).toBe(0);
    expect(readWorkdir.stdout).toContain('# base');

    // A read-only subagent of the task still reads the tree, but cannot write.
    const readOnlyPolicy = buildSandboxPolicy({
      platform: process.platform,
      paths: resolvePaths(home),
      workspacePath: path.join(home, 'bots', 'bot_1', 'workspaces', 'conv_1'),
      network: { mode: 'none', allowDomains: [] },
      workdir: { path: workdir, hasLease: false, denyReadGlobs: [`${workdir}/.env`] },
      taskWorktree: {
        path: info.path,
        gitWorktreeMeta: info.gitWorktreeMeta,
        gitObjectsDir: info.gitObjectsDir,
        denyReadGlobs: [`${info.path}/.env`],
      },
      readOnlyRun: true,
    });
    const roRun = (command: string): Promise<SandboxExecResult> =>
      backend.exec({ command, cwd: info.path, policy: readOnlyPolicy, timeoutMs: 60_000 });
    const roRead = await roRun('cat README.md');
    expect(roRead.exitCode, violations(roRead)).toBe(0);
    expect(roRead.stdout).toContain('# base');
    const roWrite = await roRun('printf "ro\\n" > readonly-escape.txt');
    expect(roWrite.exitCode).not.toBe(0);
    expect(existsSync(path.join(info.path, 'readonly-escape.txt'))).toBe(false);

    // A sibling task's tree under the same `.worktree` home is not readable.
    const siblingRead = await run(`cat ../${path.basename(sibling.path)}/sibling-only.txt`);
    expect(siblingRead.exitCode).not.toBe(0);
    expect(siblingRead.stdout).not.toContain('other task');
    const siblingAbs = await run(
      `cat ${JSON.stringify(path.join(sibling.path, 'sibling-only.txt'))}`,
    );
    expect(siblingAbs.exitCode).not.toBe(0);
  }, TIMEOUT);
});
