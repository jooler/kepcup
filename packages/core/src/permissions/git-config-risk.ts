import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * What an allowlisted (read-only) git command may touch before it is allowed
 * to run unsandboxed without a card in confirm mode (review P1 / P1-3 / P2).
 *
 * Two questions, both answered by asking git itself (async, bounded):
 *
 * 1. **Does the repository's own config make git run a program?** Only the keys
 *    the exempt commands (status / diff / log / show / blame / rev-parse /
 *    describe / ls-files / ls-tree / shortlog / branch listing) can execute, in
 *    repository scope (`local` / `worktree` / `command`; global and system
 *    config are the user's / administrator's own) — see {@link RISKY_KEYS}.
 * 2. **Which repository will git read?** A `.git` FILE (`gitdir: /elsewhere`),
 *    `commondir` or `objects/info/alternates` re-point git at another
 *    repository; `git show HEAD:secret.env` then reads it with no path argument
 *    the allowlist could check. The git dir, the common dir and every
 *    alternate object directory must be readable for the identity
 *    (`isReadable` = the gateway's checkPath read verdict).
 *
 * Fails closed: no git on the cleaned PATH, a timeout, git < 2.26 (no
 * `--show-scope`) or any other failure returns a reason (→ the normal card).
 *
 * Residual (documented in design 13): the check runs just before the command;
 * a concurrent writer could change the config or add a filter driver in
 * between. Bot file-tool writes to these files need a grant (gateway
 * `isGitControlPath`) and sandboxed commands cannot write `.git/config` /
 * hooks (srt mandatory denies), which leaves an approved unsandboxed command
 * running in parallel as the only writer.
 */

/** Repository-scoped keys a read-only git command can execute, with the reason. */
export const RISKY_KEYS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  // status / diff / ls-files refresh the index through the fsmonitor hook.
  { pattern: /^core\.fsmonitor$/, why: 'status / diff 会运行 fsmonitor 钩子' },
  // diff / log -p / show run the external diff program.
  { pattern: /^diff\.external$/, why: 'diff / log -p / show 会运行外部 diff 程序' },
  // diff / log -p / show / blame run textconv; diff / log -p / show run diff drivers.
  { pattern: /^diff\..+\.(textconv|command)$/, why: 'diff / show / blame 会运行 diff 驱动' },
  // status re-hashes modified files through the clean filter; process covers both.
  { pattern: /^filter\..+\.(clean|smudge|process)$/, why: 'status / diff 会运行 filter 驱动' },
  // Included files may carry any of the above (and are not re-checked at run time).
  { pattern: /^include\.path$/, why: '会引入别的配置文件' },
  { pattern: /^includeif\..+\.path$/, why: '会引入别的配置文件' },
  // Re-points the work tree outside the checked paths (status / diff read it).
  { pattern: /^core\.worktree$/, why: '把工作区指到别处' },
  // log / show verify signatures with this program when log.showSignature is on.
  { pattern: /^gpg(\..+)?\.program$/, why: 'log / show 校验签名时会运行它' },
];
// Deliberately NOT risky (review P2, false positives — none is run by the commands
// above): core.hookspath (hooks run on commit / checkout / merge …, husky sets it
// in most JS repositories), core.editor / sequence.editor (editing commands),
// core.sshcommand / core.gitproxy / core.askpass / credential.* (network), merge.*.driver
// (merges), core.pager / pager.* (git pages only on a terminal; exempt commands write
// to a pipe and also get GIT_PAGER=cat), core.attributesfile (only names drivers,
// which must be configured to run).

/** `core.fsmonitor` set to a boolean uses git's builtin daemon, not a hook. */
const BOOLEAN_VALUE = /^(true|false|yes|no|on|off|1|0|)$/i;

const REPO_SCOPES = new Set(['local', 'worktree', 'command']);

/** The risky repository-scoped keys in `git config --list --show-scope -z` output. */
export function riskyGitConfigKeys(listing: string): string[] {
  const tokens = listing.split('\0');
  const risky: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i] ?? '';
    const entry = tokens[i + 1] ?? '';
    if (!REPO_SCOPES.has(scope)) continue;
    const newline = entry.indexOf('\n');
    // Section and variable names are case-insensitive (git lowercases them).
    const key = (newline >= 0 ? entry.slice(0, newline) : entry).toLowerCase();
    const value = newline >= 0 ? entry.slice(newline + 1) : '';
    if (key === 'core.fsmonitor' && BOOLEAN_VALUE.test(value.trim())) continue;
    if (RISKY_KEYS.some(({ pattern }) => pattern.test(key))) risky.push(key);
  }
  return [...new Set(risky)];
}

/**
 * Absolute path of `name` on `pathValue` — never the current directory (review
 * P1-4: on Windows a bare name would be looked up in the cwd first, so a Bot-
 * dropped `git.exe` in the workspace would run). Only absolute PATH entries are
 * searched; on win32 the PATHEXT extensions are tried. `exists` is injectable
 * for tests.
 */
export function resolveExecutable(
  name: string,
  pathValue: string,
  platform: string,
  options: { pathExt?: string; exists?: (candidate: string) => boolean } = {},
): string | null {
  const win = platform === 'win32';
  const pathApi = win ? path.win32 : path.posix;
  const exists =
    options.exists ??
    ((candidate: string) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  const exts = win
    ? (options.pathExt ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((ext) => ext.length > 0)
        .map((ext) => ext.toLowerCase())
    : [''];
  for (const dir of pathValue.split(win ? ';' : ':')) {
    if (dir.length === 0 || !pathApi.isAbsolute(dir)) continue;
    if (win && !/^([a-zA-Z]:[\\/]|\\\\)/.test(dir)) continue; // `\foo` is drive-relative
    for (const ext of exts) {
      const candidate = pathApi.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface BoundedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn error or timeout. */
  error?: string;
}

/** Runs `file args` without a shell, async, killed after `timeoutMs`. */
export function runBounded(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: null, stdout, stderr, error: `超时（${options.timeoutMs} ms）` });
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** Alternate object directories of `objectsDir` (recursively, bounded). */
export function alternateObjectDirs(objectsDir: string, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 5 || seen.has(objectsDir)) return [];
  seen.add(objectsDir);
  const file = path.join(objectsDir, 'info', 'alternates');
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return ['<unreadable alternates>'];
  }
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const dir = path.resolve(objectsDir, line);
    out.push(dir, ...alternateObjectDirs(dir, depth + 1, seen));
  }
  return out;
}

export interface GitExemptionContext {
  cwd: string;
  /** Child environment: the cleaned exempt env (absolute PATH entries only). */
  env: NodeJS.ProcessEnv;
  platform: string;
  /** The gateway's read verdict for a path (resolved, symlinks followed). */
  isReadable: (absolutePath: string) => boolean;
  timeoutMs?: number;
}

/**
 * Why an allowlisted git command may not run without a card in `cwd` (null =
 * fine). Resolves git from the cleaned PATH; asks git for the repository it
 * will use and its config; fails closed.
 */
export async function gitExemptionRisk(ctx: GitExemptionContext): Promise<string | null> {
  const timeoutMs = ctx.timeoutMs ?? 5_000;
  const git = resolveExecutable('git', ctx.env['PATH'] ?? '', ctx.platform, {
    ...(ctx.env['PATHEXT'] !== undefined ? { pathExt: ctx.env['PATHEXT'] } : {}),
  });
  if (git === null) return '在清理后的 PATH 上找不到 git，白名单 git 命令不豁免';
  const opts = { cwd: ctx.cwd, env: ctx.env, timeoutMs };

  const dirs = await runBounded(git, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], opts);
  if (dirs.error !== undefined) return `无法确认 git 仓库位置（${dirs.error}），白名单 git 命令不豁免`;
  if (dirs.status !== 0) {
    // Not inside a repository: git reads no repository (commands like
    // `git diff --no-index a b` only read their path arguments, checked already).
    if (/not a git repository/i.test(dirs.stderr)) return null;
    return `无法确认 git 仓库位置（rev-parse 退出码 ${String(dirs.status)}），白名单 git 命令不豁免`;
  }
  const [gitDirLine, commonLine] = dirs.stdout.split(/\r?\n/);
  if (gitDirLine === undefined || commonLine === undefined || gitDirLine.length === 0) {
    return '无法确认 git 仓库位置，白名单 git 命令不豁免';
  }
  const gitDir = path.resolve(ctx.cwd, gitDirLine);
  const commonDir = path.resolve(ctx.cwd, commonLine);
  for (const dir of [gitDir, commonDir, ...alternateObjectDirs(path.join(commonDir, 'objects'))]) {
    if (dir === '<unreadable alternates>' || !ctx.isReadable(dir)) {
      return `git 会读取可访问范围之外的仓库（${dir}），白名单 git 命令不豁免`;
    }
  }

  const config = await runBounded(git, ['config', '--list', '--show-scope', '-z'], opts);
  if (config.error !== undefined) return `无法读取仓库的 git 配置（${config.error}），白名单 git 命令不豁免`;
  if (config.status !== 0) {
    return `无法读取仓库的 git 配置（git config 退出码 ${String(config.status)}），白名单 git 命令不豁免`;
  }
  const risky = riskyGitConfigKeys(config.stdout);
  if (risky.length === 0) return null;
  return `仓库配置里有会执行程序的项（${risky.slice(0, 5).join('、')}），白名单 git 命令不豁免`;
}
