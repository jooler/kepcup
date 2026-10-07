import parse from 'bash-parser';

import type { AllowlistEntry, AllowlistPlatform } from '@kepcup/shared';

/**
 * Read-only command allowlist matcher (docs/design/13-permissions.md "只读命令
 * 白名单"). The command must parse; every pipeline/&&/; segment must match an
 * enabled entry; redirects, command substitution, variable expansion, subshells,
 * background execution, negation and assignment prefixes all fail closed.
 * 白名单宁可漏判（需要确认）也不能误判（放行了写入命令）.
 */

export interface AllowlistCheckContext {
  platform: AllowlistPlatform;
  /** Enabled entries for the platform ("cat", "git status", ...). */
  entries: string[];
  /** Read check for candidate path args; false = fail closed. */
  isPathAllowed: (absoluteOrRelative: string) => boolean;
}

export interface AllowlistVerdict {
  exempt: boolean;
  /** Why the command still needs confirmation (or was rejected). */
  reason?: string;
}

/**
 * Options that give otherwise-read-only commands write/exec semantics.
 * Matching (`isDangerousOption`): long options also match `--opt=value` and
 * unambiguous GNU-style abbreviations (`--out` for `--output`); short ones
 * also match an attached value (`-i.bak`, `-ofile`) and, for commands that
 * cluster short flags, any cluster containing the letter (`sed -ni`).
 */
const DANGEROUS_OPTIONS: Record<string, string[]> = {
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'],
  // `-C` switches git's working directory, `--git-dir`/`--work-tree` re-point
  // git at another repository — all change which paths the arguments refer to,
  // so our per-argument path check would judge the wrong locations (宁可漏判).
  // `--output` writes a file; `--ext-diff` / `--textconv` run programs from
  // the repository configuration; `--exec-path` re-points git's helpers.
  git: [
    '-c',
    '-C',
    '--git-dir',
    '--work-tree',
    '--output',
    '--ext-diff',
    '--textconv',
    '--exec-path',
  ],
  sed: ['-i', '--in-place'],
  sort: ['-o', '--output', '--compress-program'],
  // `-R` re-runs tree with `-o 00Tree.html` in every directory.
  tree: ['-o', '-R'],
  // `--pre` runs a command for every searched file.
  rg: ['--pre', '--pre-glob'],
  // `-C` compiles a magic file (writes `*.mgc`).
  file: ['-C', '--compile'],
};

/**
 * Real, harmless long options that would otherwise read as abbreviations of a
 * dangerous one (git `--text` = `-a`, not `--textconv`; review round 2).
 */
const SAFE_LONG_OPTIONS: Record<string, string[]> = {
  git: ['--text'],
};

/** Commands whose short flags cluster (`-ni`): any cluster with the letter counts. */
const CLUSTERING_COMMANDS = new Set(['sed', 'sort', 'tree', 'file']);

/** True when `arg` is (a spelling of) the dangerous option `option`. */
export function isDangerousOption(command: string, arg: string, option: string): boolean {
  if (arg === option) return true;
  if (option.startsWith('--')) {
    if (!arg.startsWith('--')) return false;
    const name = arg.split('=', 1)[0] ?? arg;
    if (name === option) return true;
    if ((SAFE_LONG_OPTIONS[command] ?? []).includes(name)) return false;
    // A GNU / git-style unambiguous abbreviation (`--out` for `--output`).
    return name.length >= 4 && option.startsWith(name);
  }
  if (option.length === 2) {
    // Short option: attached value (`-ofile`, `-i.bak`) or a flag cluster.
    if (arg.startsWith(option)) return true;
    return (
      CLUSTERING_COMMANDS.has(command) &&
      /^-[A-Za-z]+$/.test(arg) &&
      arg.slice(1).includes(option.slice(1))
    );
  }
  // Single-dash long options (`find -exec`): exact or a longer variant.
  return arg.startsWith(option);
}

/** Redirect operators that only read (stdin source / fd duplication). */
const READ_ONLY_REDIRECT_OPS = new Set(['less', 'lessand']);

type WordNode = { type: string; text?: string; expansion?: Array<{ type: string }> };

/** True when the word contains any expansion ($cmd, $var, `cmd`, arithmetic). */
function hasExpansion(word: WordNode | undefined): boolean {
  if (!word) return false;
  return Array.isArray(word.expansion) && word.expansion.length > 0;
}

interface Segment {
  name: string;
  args: string[];
  redirects: Array<{ op: string; file: string }>;
}

/**
 * AST walk for POSIX shells. Returns the command segments, or null when the
 * command uses any construct the allowlist must not shortcut.
 */
function segmentsOf(node: unknown, out: Segment[]): Segment[] | null {
  if (node === null || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  switch (n['type']) {
    case 'Script':
    case 'CompoundList':
    case 'Pipeline':
      for (const child of (n['commands'] ?? []) as unknown[]) {
        if (segmentsOf(child, out) === null) return null;
      }
      return out;
    case 'LogicalExpression': {
      if (segmentsOf(n['left'], out) === null) return null;
      return segmentsOf(n['right'], out);
    }
    case 'Subshell':
    case 'Function':
      return null; // subshells and functions never match
    case 'Command': {
      if (n['async'] === true) return null; // background execution
      if (n['bang'] === true) return null; // negation — fail closed
      const prefix = (n['prefix'] ?? []) as WordNode[];
      for (const word of prefix) {
        // Variable-assignment prefixes (FOO=bar cmd) are rejected outright.
        if (word.type === 'AssignmentWord' || word.type === 'Assignment') return null;
        if (hasExpansion(word)) return null;
      }
      const name = n['name'] as WordNode | undefined;
      if (!name || typeof name.text !== 'string' || name.text.length === 0) return null;
      if (hasExpansion(name)) return null;
      const segment: Segment = { name: name.text, args: [], redirects: [] };
      for (const word of (n['suffix'] ?? []) as unknown[]) {
        const w = word as WordNode & { op?: { text?: string }; file?: WordNode; numberIo?: unknown };
        if (w.type === 'Redirect') {
          const op = w.op?.text ?? '';
          const file = w.file;
          if (!READ_ONLY_REDIRECT_OPS.has(op)) return null;
          if (!file || typeof file.text !== 'string' || hasExpansion(file)) return null;
          segment.redirects.push({ op, file: file.text });
          continue;
        }
        if (typeof w.text !== 'string') return null;
        if (hasExpansion(w)) return null;
        segment.args.push(w.text);
      }
      out.push(segment);
      return out;
    }
    case 'NotNode':
    case 'Negation':
      return null;
    default:
      return null;
  }
}

function entryMatches(words: string[], entryWords: string[]): boolean {
  if (words.length < entryWords.length) return false;
  return entryWords.every((w, i) => words[i] === w);
}

function checkPosixSegment(
  segment: Segment,
  entries: string[][],
  ctx: AllowlistCheckContext,
): string | null {
  const words = [segment.name, ...segment.args];
  const entry = entries.find((candidate) => entryMatches(words, candidate));
  if (entry === undefined) return `命令不在白名单中：${segment.name}`;

  const command = entry[0] ?? segment.name;
  const dangerous = DANGEROUS_OPTIONS[command] ?? [];
  const rest = words.slice(entry.length);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (dangerous.some((option) => isDangerousOption(command, arg, option))) {
      return `参数 ${arg} 具有写入或执行语义，不豁免`;
    }
    if (arg.startsWith('-')) {
      // `--file=/some/path`: the value is a path candidate too.
      const value = optionValuePath(arg);
      if (value !== null && !ctx.isPathAllowed(value)) return `参数路径超出可访问范围：${value}`;
      continue;
    }
    // Non-option argument: treat as a path candidate (sub-commands like
    // "status" are consumed by the entry prefix; relative junk resolves
    // inside the workspace and passes harmlessly).
    if (!ctx.isPathAllowed(arg)) return `参数路径超出可访问范围：${arg}`;
  }
  for (const redirect of segment.redirects) {
    if (!ctx.isPathAllowed(redirect.file)) return `重定向路径超出可访问范围：${redirect.file}`;
  }
  return null;
}

/** Windows: only bare single commands (no pipes, redirections, substitution). */
function checkWindows(command: string, entries: string[][], ctx: AllowlistCheckContext): string | null {
  const risky = /[|&;<>()`$\n]|\btry\b\s*\{/i;
  if (risky.test(command)) return '命令包含管道、重定向或替换结构，不豁免';
  const words = command.trim().split(/\s+/).map((w) => w.replace(/^"(.*)"$/, '$1'));
  if (words.length === 0) return '空命令';
  const entry = entries.find((candidate) =>
    entryMatches(words.map((w) => w.toLowerCase()), candidate.map((w) => w.toLowerCase())),
  );
  if (entry === undefined) return `命令不在白名单中：${words[0] ?? ''}`;
  const program = (entry[0] ?? '').toLowerCase();
  const dangerous = DANGEROUS_OPTIONS[program] ?? [];
  for (const arg of words.slice(entry.length)) {
    if (dangerous.some((option) => isDangerousOption(program, arg, option))) {
      return `参数 ${arg} 具有写入或执行语义，不豁免`;
    }
    if (arg.startsWith('-')) continue;
    if (/^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith('\\\\') || arg.startsWith('/')) {
      if (!ctx.isPathAllowed(arg)) return `参数路径超出可访问范围：${arg}`;
    }
  }
  return null;
}

/**
 * The path-looking value of an option (null when none): `--opt=value`, or a
 * short option's attached value (`-O/etc/passwd`, review round 2).
 */
export function optionValuePath(arg: string): string | null {
  const eq = arg.indexOf('=');
  let value: string | null = null;
  if (eq >= 0) value = arg.slice(eq + 1);
  else if (!arg.startsWith('--') && arg.length > 2) value = arg.slice(2);
  if (value === null || value.length === 0) return null;
  return value.includes('/') || value.includes('\\') || value.startsWith('~') || value.startsWith('.')
    ? value
    : null;
}

/** One simple command of a parsed command line, every word a plain literal. */
export interface LiteralSegment {
  /** Command name + arguments + redirect targets (quotes removed). */
  words: string[];
}

/**
 * Parses a POSIX command line into simple commands whose words are all plain
 * literals (security review round 2, the unattended floor): null when the
 * line does not parse or uses anything a text analysis cannot follow —
 * parameter / command / arithmetic / process expansion, globs (`* ? [ ]`,
 * even quoted), brace expansion, `~user`, variable-assignment prefixes,
 * subshells, functions, compound commands, negation or background jobs.
 * Pipelines, `&&` / `||` / `;` lists and redirects are fine (their targets
 * become words).
 */
export function literalCommandSegments(command: string): LiteralSegment[] | null {
  const out: LiteralSegment[] = [];
  const literal = (word: WordNode | undefined): string | null => {
    if (word === undefined || typeof word.text !== 'string') return null;
    if (hasExpansion(word)) return null;
    const text = word.text;
    if (/[*?[\]{}]/.test(text)) return null;
    if (/^~[^/]/.test(text)) return null;
    return text;
  };
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    const n = node as Record<string, unknown>;
    switch (n['type']) {
      case 'Script':
      case 'CompoundList':
      case 'Pipeline':
        return ((n['commands'] ?? []) as unknown[]).every(walk);
      case 'LogicalExpression':
        return walk(n['left']) && walk(n['right']);
      case 'Command': {
        if (n['async'] === true || n['bang'] === true) return false;
        if (((n['prefix'] ?? []) as unknown[]).length > 0) return false;
        const name = literal(n['name'] as WordNode | undefined);
        if (name === null || name.length === 0) return false;
        const words = [name];
        for (const item of (n['suffix'] ?? []) as unknown[]) {
          const w = item as WordNode & { file?: WordNode };
          const text = literal(w.type === 'Redirect' ? w.file : w);
          if (text === null) return false;
          words.push(text);
        }
        out.push({ words });
        return true;
      }
      default:
        return false;
    }
  };
  try {
    return walk(parse(command)) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Verdict for one command line. Never throws; a parse error or any doubt
 * means "needs confirmation".
 */
export function matchAllowlistCommand(
  command: string,
  ctx: AllowlistCheckContext,
): AllowlistVerdict {
  const entries = ctx.entries
    .map((pattern) => pattern.trim().split(/\s+/).filter((w) => w.length > 0))
    .filter((words) => words.length > 0);
  try {
    if (ctx.platform === 'windows') {
      const reason = checkWindows(command, entries, ctx);
      return reason === null ? { exempt: true } : { exempt: false, reason };
    }
    const segments: Segment[] = [];
    if (segmentsOf(parse(command), segments) === null) {
      return { exempt: false, reason: '命令包含白名单不允许的结构（管道段、替换、赋值前缀、重定向等）' };
    }
    for (const segment of segments) {
      const reason = checkPosixSegment(segment, entries, ctx);
      if (reason !== null) return { exempt: false, reason };
    }
    return { exempt: true };
  } catch {
    return { exempt: false, reason: '命令无法解析，不豁免' };
  }
}

/** Convenience: entry words from rows. */
export function entryPatterns(rows: AllowlistEntry[]): string[] {
  return rows.filter((r) => r.enabled).map((r) => r.pattern);
}
