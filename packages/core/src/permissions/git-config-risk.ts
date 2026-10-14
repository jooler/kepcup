import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Repository configuration that makes a read-only git command run a program
 * (review P1). An allowlisted `git status` / `git diff` / `git log` runs
 * unsandboxed in confirm mode, and git obeys the repository's own config —
 * which a Bot (or a cloned repository) can write: `core.fsmonitor` runs a hook
 * on every status, `diff.external` / `diff.<driver>.textconv` / `.command` run
 * on every diff, `filter.<driver>.clean` runs while status re-hashes files,
 * `core.pager` / `pager.*` on output, `include.path` / `includeIf` pull in
 * further files, `core.worktree` re-points the work tree outside the checked
 * paths. Only repository-scoped config (`local`, `worktree`, `command`) is
 * judged: global and system config are the user's / administrator's own.
 */
const RISKY_KEY_PATTERNS: readonly RegExp[] = [
  /^core\.(fsmonitor|pager|editor|sshcommand|hookspath|askpass|gitproxy|worktree)$/,
  /^diff\.external$/,
  /^diff\..+\.(textconv|command)$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^merge\..+\.driver$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^pager\..+$/,
  /^sequence\.editor$/,
  /^gpg(\..+)?\.program$/,
];

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
    // Section and variable names are case-insensitive (git lowercases them);
    // subsection names keep their case but only the shape matters here.
    const key = (newline >= 0 ? entry.slice(0, newline) : entry).toLowerCase();
    const value = newline >= 0 ? entry.slice(newline + 1) : '';
    if (key === 'core.fsmonitor' && BOOLEAN_VALUE.test(value.trim())) continue;
    if (RISKY_KEY_PATTERNS.some((pattern) => pattern.test(key))) risky.push(key);
  }
  return [...new Set(risky)];
}

/**
 * Why an allowlisted git command may not run without a card in `cwd` (null =
 * the repository config is clean, or `cwd` is not inside a repository). Fails
 * closed: a git too old for `--show-scope` (< 2.26), a timeout or any other
 * failure to read the config returns a reason.
 */
export function gitRepoConfigRisk(
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): string | null {
  const result = spawnSync('git', ['config', '--list', '--show-scope', '-z'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return `无法读取仓库的 git 配置（${result.error.message}），白名单 git 命令不豁免`;
  }
  // Outside a repository `git config --list` still lists global / system
  // scopes and exits 0; a non-zero exit is a real failure (old git, bad config).
  if (result.status !== 0) {
    return `无法读取仓库的 git 配置（git config 退出码 ${String(result.status)}），白名单 git 命令不豁免`;
  }
  const risky = riskyGitConfigKeys(result.stdout);
  if (risky.length === 0) return null;
  return `仓库配置里有会执行程序的项（${risky.slice(0, 5).join('、')}），白名单 git 命令在 ${path.basename(cwd) || cwd} 中不豁免`;
}
