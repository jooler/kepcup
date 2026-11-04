import path from 'node:path';

/**
 * Hard command guard for unsandboxed execution (docs/design/13-permissions.md
 * 「权限级别」). This is the one rule the `bypass` level does not bypass:
 * commands that would destroy the machine (root / home / system trees, raw
 * disks, a fork bomb) are refused without a card, and so is anything that
 * reaches the app's own data directory outside the run's workspace.
 *
 * The check is deliberately best-effort *text* analysis — a shell can hide
 * anything behind an arbitrary interpreter, and a wrapper's option value that
 * swallows the command (`sudo -u user rm …`) is not followed. It is a floor
 * under an explicit user choice, not a sandbox replacement: the sandboxed path
 * stays the default and is not weakened by this module.
 */

export interface CommandGuardOptions {
  /** The command's working directory (used to resolve relative targets). */
  cwd: string;
  homeDir: string;
  /** The app data home (`~/.kepcup`) — never reachable, in any mode. */
  dataHome: string;
  /** Paths inside the data home a command may still use (the run's workspace). */
  exemptDirs?: readonly string[];
  platform?: string;
}

export interface CommandGuardVerdict {
  blocked: boolean;
  /** User/agent-facing one-liner: what would be destroyed. */
  reason?: string;
}

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
]);
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'command',
  'builtin',
  'nohup',
  'nice',
  'time',
  'timeout',
  'exec',
  'env',
  'stdbuf',
  'caffeinate',
]);
/** Wrapper option values that are bare numbers / durations (`nice -n 5`, `timeout 10s`). */
const WRAPPER_VALUE_TOKEN = /^\d+(?:\.\d+)?[smhd]?$/i;
/** Top-level trees whose removal or permission rewrite is fatal (subtree). */
const SYSTEM_TREES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/boot',
  '/dev',
  '/System',
  '/private/etc',
  '/private/var/db',
  '/private/var/root',
  '/var/db',
  '/var/root',
];
/** Top-level directories only fatal as a whole (`rm -rf /opt`), not per entry. */
const SYSTEM_TOP_LEVEL = ['/Library', '/Applications', '/opt'];
/** Home top-level entries that are data loss if removed wholesale. */
const HOME_TOP_LEVEL = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.bash_history',
  '.zsh_history',
  'Library',
  'Documents',
  'Desktop',
  'Downloads',
  'Pictures',
  'Movies',
  'Music',
  'Public',
  'Applications',
];
const WIN_SYSTEM_TREES = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\users',
  'c:\\recovery',
  'c:\\system volume information',
];
/** Windows device paths that are raw disks. */
const WIN_RAW_DEVICE = /^\\\\\.\\(physicaldrive\d+|c:)/i;
/** POSIX raw / block device paths. */
const POSIX_RAW_DEVICE =
  /^\/dev\/(sd[a-z]|disk\d|rdisk\d|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|ada\d|da\d|mapper\/)/;

export function catastrophicCommandVerdict(
  command: string,
  options: CommandGuardOptions,
): CommandGuardVerdict {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = platform === 'darwin' || platform === 'win32';
  const norm = (value: string) => (fold ? value.toLowerCase() : value);
  const ctx: ResolveContext = {
    p,
    norm,
    cwd: p.resolve(options.cwd),
    home: norm(p.resolve(options.homeDir)),
    dataHome: norm(p.resolve(options.dataHome)),
    exempt: (options.exemptDirs ?? []).map((dir) => norm(p.resolve(dir))),
  };

  if (FORK_BOMB.test(command)) return blocked('fork bomb');
  if (commandReachesDataHome(command, options)) return blocked('访问应用数据目录');

  for (const words of shellSegments(command, platform === 'win32')) {
    const found = commandName(words);
    if (found === null) continue;
    const lower = found.name.toLowerCase();
    const args = words.slice(found.index);
    if (SHELLS.has(lower)) {
      const inner = shellPayload(args);
      if (inner !== null) {
        const nested = catastrophicCommandVerdict(inner, { ...options, platform });
        if (nested.blocked) return nested;
      }
      continue;
    }
    if (lower === 'eval') {
      const nested = catastrophicCommandVerdict(args.slice(1).join(' '), { ...options, platform });
      if (nested.blocked) return nested;
      continue;
    }
    if (lower === 'xargs') {
      const rest = args.slice(1);
      const rmAt = rest.findIndex((word) => baseName(word) === 'rm');
      if (rmAt >= 0) {
        const rmArgs = rest.slice(rmAt + 1);
        const recursive = rmArgs.some(
          (flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === '--recursive',
        );
        const hasTarget = rmArgs.some((word) => !word.startsWith('-'));
        if (recursive && !hasTarget) return blocked('xargs rm -r with an unknown target');
      }
      continue;
    }
    if (lower === 'rm') {
      const verdict = checkRm(args, ctx);
      if (verdict !== null) return verdict;
      continue;
    }
    if (lower === 'del' || lower === 'erase' || lower === 'rd' || lower === 'rmdir') {
      const recursive = args.some((arg) => /^\/s$/i.test(arg) || /^-recurse/i.test(arg));
      if (recursive) {
        for (const target of args.filter((word) => !word.startsWith('/') && !word.startsWith('-'))) {
          const protectedPath = criticalTarget(target, ctx);
          if (protectedPath !== null) return blocked(`递归删除受保护路径：${protectedPath}`);
        }
      }
      continue;
    }
    if (
      lower === 'remove-item' ||
      lower === 'ri' ||
      lower === 'rm-item' ||
      lower === 'remove-itemproperty'
    ) {
      if (args.some((arg) => /^-recurse/i.test(arg))) {
        for (const target of args.filter((word) => !word.startsWith('-'))) {
          const protectedPath = criticalTarget(target, ctx);
          if (protectedPath !== null) return blocked(`递归删除受保护路径：${protectedPath}`);
        }
      }
      continue;
    }
    if (lower === 'format' || lower === 'diskpart') {
      return blocked(`格式化 / 分区磁盘：${lower}`);
    }
    if (lower === 'shred') {
      for (const target of args.filter((word) => !word.startsWith('-'))) {
        const protectedPath = criticalTarget(target, ctx);
        if (protectedPath !== null) return blocked(`擦除受保护路径：${protectedPath}`);
      }
      continue;
    }
    if (lower === 'dd') {
      for (const arg of args) {
        const match = /^of=(.+)$/i.exec(arg);
        if (match === null) continue;
        const target = match[1] ?? '';
        if (isRawDevice(target, platform) || criticalTarget(target, ctx) !== null) {
          return blocked(`写入裸设备或受保护路径：${target}`);
        }
      }
      continue;
    }
    if (lower.startsWith('mkfs') || lower === 'wipefs' || lower === 'newfs') {
      for (const arg of args) {
        if (arg.startsWith('/dev/') || WIN_RAW_DEVICE.test(arg)) {
          return blocked(`格式化 / 擦除磁盘：${arg}`);
        }
      }
      continue;
    }
    if (lower === 'diskutil') {
      const sub = args[1] ?? '';
      if (/^(eraseDisk|eraseVolume|partitionDisk|zeroDisk|secureErase)$/i.test(sub)) {
        return blocked(`抹除磁盘：diskutil ${sub}`);
      }
      continue;
    }
    if (lower === 'fdisk' || lower === 'gdisk' || lower === 'parted' || lower === 'sfdisk') {
      if (args.some((arg) => arg.startsWith('/dev/') || WIN_RAW_DEVICE.test(arg))) {
        return blocked(`修改磁盘分区：${lower}`);
      }
      continue;
    }
    if (lower === 'shutdown' || lower === 'reboot' || lower === 'halt' || lower === 'poweroff') {
      return blocked(`关闭 / 重启系统：${lower}`);
    }
    if (lower === 'init' && ['0', '6'].includes(args[1] ?? '')) {
      return blocked(`关闭 / 重启系统：init ${args[1]}`);
    }
    if (lower === 'kill' && (args.includes('-9') || args.includes('-KILL')) && args.includes('-1')) {
      return blocked('向所有进程发送 SIGKILL');
    }
    if (lower === 'killall' && (args.includes('-9') || args.includes('-KILL'))) {
      return blocked('killall -9 会杀死所有同名进程');
    }
    if (lower === 'chmod' || lower === 'chown' || lower === 'chgrp') {
      const targets = args.filter((word) => !word.startsWith('-') && !/^\d{3,4}$/.test(word));
      for (const target of targets) {
        const protectedPath = criticalTarget(target, ctx);
        if (protectedPath !== null) {
          return blocked(`${lower} 作用于受保护路径：${protectedPath}`);
        }
      }
      continue;
    }
    if (lower === 'mv') {
      const sources = args.filter((word) => !word.startsWith('-'));
      for (const source of sources.slice(0, -1)) {
        const protectedPath = criticalTarget(source, ctx);
        if (protectedPath !== null) return blocked(`移动受保护路径：${protectedPath}`);
      }
      continue;
    }
    if (lower === 'find') {
      const deleting = args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir');
      if (deleting) {
        const root = args
          .slice(1)
          .find((word) => !word.startsWith('-') && !word.startsWith('('));
        if (root !== undefined) {
          const protectedPath = criticalTarget(root, ctx);
          if (protectedPath !== null) return blocked(`find 删除受保护路径：${protectedPath}`);
        }
      }
      continue;
    }
    if (lower === 'truncate') {
      for (const target of args.filter((word) => !word.startsWith('-'))) {
        if (isRawDevice(target, platform)) return blocked(`截断裸设备：${target}`);
        const protectedPath = criticalTarget(target, ctx);
        if (protectedPath !== null) return blocked(`截断受保护路径：${protectedPath}`);
      }
    }
  }

  // Redirect / truncate forms the word scanner cannot attribute (`: > /dev/sda`,
  // `echo x > /etc/passwd`). Area is narrow on purpose: only raw devices and
  // protected trees, never ordinary files.
  for (const match of command.matchAll(/>\s*(\S+)/g)) {
    const target = (match[1] ?? '').replace(/^['"]|['"]$/g, '');
    if (isRawDevice(target, platform)) return blocked(`写入裸设备：${target}`);
    const protectedPath = criticalTarget(target, ctx);
    if (protectedPath !== null) return blocked(`写入受保护路径：${protectedPath}`);
  }

  return { blocked: false };
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;?\s*:/;

/**
 * True when any path token of the command resolves inside the app data home
 * (outside `exemptDirs`). Unlike the unattended floor this does **not** treat
 * a bare `~` / `$HOME` as a hit: `cd ~ && npm test` must stay usable.
 */
export function commandReachesDataHome(command: string, options: CommandGuardOptions): boolean {
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = platform === 'darwin' || platform === 'win32';
  const norm = (value: string) => (fold ? value.toLowerCase() : value);
  const ctx: ResolveContext = {
    p,
    norm,
    cwd: p.resolve(options.cwd),
    home: norm(p.resolve(options.homeDir)),
    dataHome: norm(p.resolve(options.dataHome)),
    exempt: (options.exemptDirs ?? []).map((dir) => norm(p.resolve(dir))),
  };
  for (const words of shellSegments(command, platform === 'win32')) {
    for (const word of words) {
      if (word.length === 0) continue;
      if (word.startsWith('-') && !word.includes('=')) continue;
      const raw =
        word.startsWith('-') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
      const resolved = resolveTarget(raw, ctx);
      if (resolved === null) continue;
      const value = ctx.norm(resolved.value);
      if (ctx.exempt.some((dir) => isUnder(value, dir, ctx.p))) continue;
      if (value === ctx.dataHome || isUnder(value, ctx.dataHome, ctx.p)) return true;
    }
  }
  return false;
}

interface ResolveContext {
  p: typeof path.posix;
  norm: (value: string) => string;
  cwd: string;
  home: string;
  dataHome: string;
  exempt: string[];
}

function checkRm(args: string[], ctx: ResolveContext): CommandGuardVerdict | null {
  let recursive = false;
  let noPreserveRoot = false;
  const targets: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args.slice(1)) {
    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith('-') && arg !== '-') {
      if (arg === '--recursive') recursive = true;
      else if (arg === '--no-preserve-root') noPreserveRoot = true;
      else if (/^-[a-zA-Z]+$/.test(arg) && /[rR]/.test(arg)) recursive = true;
      continue;
    }
    targets.push(arg);
  }
  if (!recursive && !noPreserveRoot) return null;
  for (const target of targets) {
    const protectedPath = criticalTarget(target, ctx);
    if (protectedPath !== null) return blocked(`递归删除受保护路径：${protectedPath}`);
  }
  return null;
}

/** Returns the protected path the target is, or null. */
function criticalTarget(target: string, ctx: ResolveContext): string | null {
  const resolved = resolveTarget(target, ctx);
  if (resolved === null) return null;
  const value = ctx.norm(resolved.value);

  // The run's own workspace lives inside the data home and stays usable.
  if (ctx.exempt.some((dir) => isUnder(value, dir, ctx.p))) return null;

  // The app's own data directory (anything outside the exempt workspace).
  if (value === ctx.dataHome || isUnder(value, ctx.dataHome, ctx.p)) return target;
  // The user home itself, or an ancestor of it (`/Users`, `/home`, `/`).
  if (value === ctx.home) return target;
  if (isUnder(ctx.home, value, ctx.p)) return target;

  if (ctx.p === path.win32) {
    if (value === ctx.p.parse(value).root) return target;
    for (const tree of WIN_SYSTEM_TREES) {
      const normalized = ctx.norm(tree);
      if (value === normalized || isUnder(value, normalized, ctx.p)) return target;
    }
    for (const entry of HOME_TOP_LEVEL) {
      const homeEntry = ctx.norm(`${ctx.home}\\${entry}`);
      if (value === homeEntry || (resolved.wildcard && value === homeEntry)) return target;
    }
    return null;
  }

  if (value === '/') return target;
  for (const tree of SYSTEM_TREES) {
    const normalized = ctx.norm(tree);
    if (value === normalized || isUnder(value, normalized, ctx.p)) return target;
  }
  for (const tree of SYSTEM_TOP_LEVEL) {
    const normalized = ctx.norm(tree);
    if (value === normalized || (resolved.wildcard && value === normalized)) return target;
  }
  for (const entry of HOME_TOP_LEVEL) {
    const homeEntry = ctx.norm(`${ctx.home}/${entry}`);
    if (value === homeEntry || (resolved.wildcard && value === homeEntry)) return target;
  }
  return null;
}

function resolveTarget(
  raw: string,
  ctx: ResolveContext,
): { value: string; wildcard: boolean } | null {
  if (raw.length === 0 || raw === '-') return null;
  let text = raw.replace(/^['"]|['"]$/g, '');
  if (text.startsWith('$HOME') || text.startsWith('${HOME}')) {
    text = `${ctx.home}${text.replace(/^\$\{?HOME\}?/, '')}`;
  } else if (/^%(userprofile|home)%/i.test(text)) {
    text = `${ctx.home}${text.replace(/^%(userprofile|home)%/i, '')}`;
  } else if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = `${ctx.home}${text.slice(1)}`;
  } else if (/^~[^/\\]/.test(text)) {
    return null; // another user's home: not ours to judge
  }
  let wildcard = false;
  if (/(?:^|[/\\])\*\*?$/.test(text)) {
    wildcard = true;
    text = text.replace(/[/\\]\*\*?$/, '');
    if (text.length === 0) text = ctx.p.sep;
  }
  // `/Users/tester/` and `~` must compare equal to the normalized home.
  while (text.length > 1 && (text.endsWith('/') || text.endsWith('\\'))) {
    text = text.slice(0, -1);
  }
  // `C:` after stripping `C:\` is a drive, not a relative name.
  if (ctx.p === path.win32 && /^[A-Za-z]:$/.test(text)) text = `${text}\\`;
  const value = ctx.p.normalize(ctx.p.isAbsolute(text) ? text : ctx.p.resolve(ctx.cwd, text));
  return { value, wildcard };
}

function isRawDevice(target: string, platform: string): boolean {
  if (platform === 'win32') return WIN_RAW_DEVICE.test(target);
  return POSIX_RAW_DEVICE.test(target);
}

function isUnder(candidate: string, root: string, p: typeof path.posix): boolean {
  if (candidate === root) return true;
  const rel = p.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !p.isAbsolute(rel);
}

function blocked(what: string): CommandGuardVerdict {
  return {
    blocked: true,
    reason: `已阻止灾难性命令（${what}）。完全控制档也不会执行会破坏系统、用户目录或应用数据目录的命令。`,
  };
}

/** Command name and index of one segment, skipping shell wrappers and their options. */
function commandName(words: string[]): { name: string; index: number } | null {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? '';
    if (word.length === 0) {
      index += 1;
      continue;
    }
    const name = baseName(word);
    if (!WRAPPERS.has(name.toLowerCase())) return { name, index };
    index += 1;
    while (
      index < words.length &&
      (words[index]!.startsWith('-') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) ||
        WRAPPER_VALUE_TOKEN.test(words[index]!))
    ) {
      index += 1;
    }
  }
  return null;
}

function baseName(word: string): string {
  const cleaned = word.replace(/^['"]|['"]$/g, '');
  const base = path.basename(cleaned.replaceAll('\\', '/'));
  return base.replace(/\.exe$/i, '');
}

/** `bash -c "rm -rf /"` → the payload string. */
function shellPayload(args: string[]): string | null {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (
      arg === '-c' ||
      arg === '/c' ||
      arg === '-Command' ||
      arg === '-command' ||
      // Combined short flags (`bash -lc "..."`, `sh -ec "..."`).
      (/^-[a-zA-Z]+$/.test(arg) && arg.includes('c'))
    ) {
      const rest = args.slice(i + 1).join(' ');
      return rest.length > 0 ? rest : null;
    }
  }
  return null;
}

/** Characters a backslash actually escapes; anything else keeps the backslash
 * (`C:\Windows` must stay one path token). */
const ESCAPABLE = /[\s'"\\;|&$()<>*?[\]{}~!^`]/;
function shellSegments(command: string, windows = false): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let current = '';
  let hasWord = false;
  let quote: '"' | "'" | null = null;
  const pushWord = () => {
    if (!hasWord) return;
    words.push(current);
    current = '';
    hasWord = false;
  };
  const endSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (
        !windows &&
        ch === '\\' &&
        quote === '"' &&
        i + 1 < command.length &&
        ESCAPABLE.test(command[i + 1]!)
      ) {
        current += command[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      hasWord = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (!windows && ch === '\\' && i + 1 < command.length && ESCAPABLE.test(command[i + 1]!)) {
      current += command[i + 1];
      i += 1;
      hasWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pushWord();
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      continue;
    }
    current += ch;
    hasWord = true;
  }
  endSegment();
  return segments;
}
