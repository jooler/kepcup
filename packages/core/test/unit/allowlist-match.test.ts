import { describe, expect, it } from 'vitest';
import { matchAllowlistCommand } from '../../src/permissions/allowlist-match.js';
import { BUILTIN_PATTERNS } from '../../src/permissions/allowlist.js';

const POSIX = BUILTIN_PATTERNS.posix;

function ctx(overrides: Partial<Parameters<typeof matchAllowlistCommand>[1]> = {}) {
  return {
    platform: 'posix' as const,
    entries: POSIX,
    isPathAllowed: () => true,
    ...overrides,
  };
}

describe('allowlist matcher (posix)', () => {
  it('security review H2: options that execute programs or write files are never exempt', () => {
    // rg --pre runs a program per file (all spellings).
    expect(matchAllowlistCommand('rg --pre ./evil pattern', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('rg --pre=./evil pattern', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('rg --pre-glob "*.x" pattern', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('rg --pretty pattern', ctx()).exempt).toBe(true);
    // git: --output writes, --ext-diff / --textconv run configured programs.
    expect(matchAllowlistCommand('git diff --output=/tmp/x', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git log -p --output /tmp/x', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git show --out=/tmp/x', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git diff --ext-diff', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git log --textconv -p', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git status --exec-path=/tmp', ctx()).exempt).toBe(false);
    // Regression: the options that were already dangerous, in every spelling.
    expect(matchAllowlistCommand('git -c core.pager=evil log', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git diff -C/elsewhere', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('find . -execdir rm {} ;', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('sed -i.bak s/a/b/ f', ctx({ entries: [...POSIX, 'sed'] })).exempt).toBe(false);
    expect(matchAllowlistCommand('sed -ni s/a/b/p f', ctx({ entries: [...POSIX, 'sed'] })).exempt).toBe(false);
    expect(matchAllowlistCommand('sed --in-place=.bak s/a/b/ f', ctx({ entries: [...POSIX, 'sed'] })).exempt).toBe(false);
    expect(matchAllowlistCommand('sort -ofile x', ctx({ entries: [...POSIX, 'sort'] })).exempt).toBe(false);
    expect(matchAllowlistCommand('sort --compress-program=evil x', ctx({ entries: [...POSIX, 'sort'] })).exempt).toBe(false);
    expect(matchAllowlistCommand('tree -R -H .', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('file -C -m magic', ctx()).exempt).toBe(false);
    // `--opt=/path` values are path candidates too.
    expect(
      matchAllowlistCommand('grep --file=/secret/patterns x', ctx({ isPathAllowed: (p) => !p.startsWith('/secret') }))
        .exempt,
    ).toBe(false);
  });

  it('review round 2: attached short-option paths are checked; git --text is a plain option', () => {
    const strict = ctx({ isPathAllowed: (p) => !p.startsWith('/etc') });
    expect(matchAllowlistCommand('git diff -O/etc/passwd', strict).exempt).toBe(false);
    expect(matchAllowlistCommand('grep -f/etc/patterns x', strict).exempt).toBe(false);
    expect(matchAllowlistCommand('ls -la', strict).exempt).toBe(true);
    expect(matchAllowlistCommand('head -n5 a', strict).exempt).toBe(true);
    expect(matchAllowlistCommand('git diff --text a', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git diff --textconv a', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git diff --textc a', ctx()).exempt).toBe(false);
  });

  it('security review H2: the same options are refused on Windows', () => {
    const win = { platform: 'windows' as const, entries: BUILTIN_PATTERNS.windows, isPathAllowed: () => true };
    expect(matchAllowlistCommand('git diff --output=C:/x', win).exempt).toBe(false);
    expect(matchAllowlistCommand('git diff --ext-diff', win).exempt).toBe(false);
    expect(matchAllowlistCommand('git diff --stat', win).exempt).toBe(true);
  });

  it('exempts simple read-only commands', () => {
    expect(matchAllowlistCommand('cat foo.txt', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('ls -la', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('pwd', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git status', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git diff --stat', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git log --oneline -5', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git show HEAD~1', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('grep -r pattern .', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('"cat" file.txt', ctx()).exempt).toBe(true);
  });

  it('exempts inspect extras and version probes; refuses git branch deletes', () => {
    expect(matchAllowlistCommand('git branch', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git rev-parse HEAD', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git ls-files', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('echo hello', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('node -v', ctx()).exempt).toBe(true);
    // Package-manager / toolchain-proxy probes are not built-ins (review P0).
    for (const probe of ['pnpm --version', 'yarn -v', 'cargo --version', 'rustc --version', 'go version']) {
      expect(matchAllowlistCommand(probe, ctx()).exempt).toBe(false);
    }
    expect(matchAllowlistCommand('git branch -D stale', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git branch --delete stale', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('pnpm test', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('npm run build', ctx()).exempt).toBe(false);
  });

  it('does not exempt unknown commands', () => {
    expect(matchAllowlistCommand('rm -rf /', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('curl example.com', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('npm test', ctx()).exempt).toBe(false);
  });

  it('does not exempt any segment of pipelines and lists', () => {
    expect(matchAllowlistCommand('cat /etc/passwd | grep root', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('cat a | grep x | wc -l', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('cat a && rm b', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('cat a; curl evil.com', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('ls || rm x', ctx()).exempt).toBe(false);
  });

  it('does not exempt write redirects, command substitution, subshells, background', () => {
    expect(matchAllowlistCommand('cat a > /tmp/out', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('cat a >> /tmp/out', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('grep x f | tee /tmp/out', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('echo $(cat /etc/passwd)', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('echo `cat /etc/passwd`', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('(cat secret)', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('sleep 10 &', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('! grep x f', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('FOO=bar ls', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('X=$(pwd); cat $X', ctx()).exempt).toBe(false);
  });

  it('does not exempt dangerous options (find -exec/-delete, sed -i, git -c/-C/--git-dir)', () => {
    expect(matchAllowlistCommand('find . -name "*.ts" -exec rm {} ;', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('find . -delete', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('find . -fls out.txt', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('sed -i s/a/b/ f', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git -c core.pager=cat log', ctx()).exempt).toBe(false);
    // BR-P03-005: -C / --git-dir / --work-tree re-point git at other paths.
    expect(matchAllowlistCommand('git -C /somewhere status', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git --git-dir=/x log', ctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('git --work-tree=/y diff', ctx()).exempt).toBe(false);
  });

  it('checks path arguments through isPathAllowed', () => {
    // Mirrors the gateway: relative args resolve into the workspace (allowed),
    // absolute paths are judged as-is.
    const outside = ctx({
      isPathAllowed: (p) => !p.startsWith('/') || p.startsWith('/allowed'),
    });
    expect(matchAllowlistCommand('cat /allowed/x.txt', outside).exempt).toBe(true);
    expect(matchAllowlistCommand('cat /etc/hosts', outside).exempt).toBe(false);
    expect(matchAllowlistCommand('ls /allowed /elsewhere', outside).exempt).toBe(false);
    expect(matchAllowlistCommand('grep x /allowed/f', outside).exempt).toBe(true);
  });

  it('quotes do not smuggle special characters', () => {
    expect(matchAllowlistCommand('cat "file with space"', ctx()).exempt).toBe(true);
    expect(matchAllowlistCommand("cat 'a;b'", ctx()).exempt).toBe(true);
    // Shell metacharacters inside quotes are data; outside they split segments.
    expect(matchAllowlistCommand('cat a;b', ctx()).exempt).toBe(false);
  });
});

const WIN_ENTRIES = BUILTIN_PATTERNS.windows;

describe('allowlist matcher (windows, single commands only)', () => {
  function wctx(overrides: Partial<Parameters<typeof matchAllowlistCommand>[1]> = {}) {
    return {
      platform: 'windows' as const,
      entries: WIN_ENTRIES,
      isPathAllowed: () => true,
      ...overrides,
    };
  }

  it('exempts bare single commands', () => {
    expect(matchAllowlistCommand('Get-Content notes.txt', wctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('dir', wctx()).exempt).toBe(true);
    expect(matchAllowlistCommand('git status', wctx()).exempt).toBe(true);
  });

  it('never exempts pipelines, redirections, sub-expressions', () => {
    expect(matchAllowlistCommand('type a.txt | Select-String x', wctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('dir > files.txt', wctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('Get-Content $(Get-Location)', wctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('dir; Get-Content a', wctx()).exempt).toBe(false);
    expect(matchAllowlistCommand('Remove-Item a.txt', wctx()).exempt).toBe(false);
  });

  it('checks absolute path arguments', () => {
    const outside = wctx({ isPathAllowed: (p) => p.startsWith('C:\\ok') });
    expect(matchAllowlistCommand('Get-Content C:\\ok\\a.txt', outside).exempt).toBe(true);
    expect(matchAllowlistCommand('Get-Content C:\\Windows\\win.ini', outside).exempt).toBe(false);
  });
});

describe('git branch is listing-only (review P1)', () => {
  const exempt = (command: string) => matchAllowlistCommand(command, ctx()).exempt;
  const wexempt = (command: string) =>
    matchAllowlistCommand(command, { ...ctx(), platform: 'windows', entries: BUILTIN_PATTERNS.windows })
      .exempt;

  it('accepts listing forms with their value options', () => {
    for (const command of [
      'git branch',
      'git branch -a',
      'git branch -r',
      'git branch -av',
      'git branch -vv',
      'git branch --all --verbose',
      'git branch --show-current',
      'git branch --list',
      'git branch --list "feat/*"',
      'git branch -l feat',
      'git branch --contains',
      'git branch --contains HEAD~3',
      'git branch --contains=abc123',
      'git branch --merged main',
      'git branch --no-merged=main -a',
      'git branch --points-at HEAD',
      'git branch --sort=-committerdate',
      "git branch --format '%(refname)' -l feat",
      'git branch --sort -committerdate --list',
      'git branch --points-at HEAD --list x',
      'git branch --abbrev=7 -v',
    ]) {
      expect(exempt(command), command).toBe(true);
    }
    expect(wexempt('git branch -a')).toBe(true);
  });

  it('refuses every writing form, including bundled short flags', () => {
    for (const command of [
      'git branch newbranch',
      'git branch newbranch HEAD~1',
      'git branch -- newbranch',
      'git branch -d stale',
      'git branch -D stale',
      'git branch -qD stale',
      'git branch -dr origin/x',
      'git branch -Dq stale',
      'git branch -f main HEAD~1',
      'git branch --force main',
      'git branch -m old new',
      'git branch -M new',
      'git branch -c a b',
      'git branch -C a b',
      'git branch --copy a b',
      'git branch --move a b',
      'git branch --delete stale',
      'git branch -u origin/main',
      'git branch --set-upstream-to=origin/main',
      'git branch --unset-upstream',
      'git branch --track x origin/x',
      'git branch -t x origin/x',
      'git branch --edit-description',
      'git branch --create-reflog x',
      'git branch -q',
      'git branch -a newbranch',
      'git branch --contains HEAD newbranch',
      // Review P2: a required-argument option takes the next word as its value.
      'git branch --format -l evil',
      'git branch --sort -l evil',
      'git branch --points-at -l evil',
      'git branch --format',
      'git branch --abbrev 7',
      'git branch --form=x',
      'git branch --set-upstream-to origin/main',
    ]) {
      expect(exempt(command), command).toBe(false);
    }
    expect(wexempt('git branch -qD stale')).toBe(false);
    expect(wexempt('git branch newbranch')).toBe(false);
  });

  it('submodule recursion and pager options are not exempt', () => {
    expect(exempt('git diff --submodule=diff')).toBe(false);
    expect(exempt('git ls-files --recurse-submodules')).toBe(false);
    expect(exempt('git log --oneline')).toBe(true);
  });

  it('other git subcommands keep -M / -m (rename detection, merge diffs) exempt', () => {
    expect(exempt('git diff -M')).toBe(true);
    expect(exempt('git log -m --stat')).toBe(true);
  });
});

/**
 * Review P0 / P2: the built-ins are run unsandboxed without a card in confirm
 * mode. Shape rules — any new built-in must fit them, or this test changes
 * with an explicit decision (DEVIATIONS).
 */
describe('built-in patterns', () => {
  const VERSION_PROBE_PROGRAMS = new Set([
    'node', 'npm', 'python', 'python3', 'pip', 'pip3', 'tsc', 'eslint', 'prettier', 'ruby', 'php',
  ]);
  /** Programs that proxy to a project-pinned toolchain or run project code. */
  const FORBIDDEN_PROGRAMS = [
    'pnpm', 'yarn', 'corepack', 'bun', 'deno', 'npx', 'cargo', 'rustc', 'rustup', 'go', 'uv',
    'poetry', 'pipx', 'gradle', 'gradlew', 'mvn', 'make', 'bash', 'sh', 'zsh', 'env', 'xargs',
    'curl', 'wget', 'rm', 'mv', 'cp',
  ];

  it('contain no package-manager / toolchain-proxy / interpreter-running entries', () => {
    for (const platform of ['posix', 'windows'] as const) {
      for (const pattern of BUILTIN_PATTERNS[platform]) {
        const [program = '', ...rest] = pattern.split(' ');
        expect(FORBIDDEN_PROGRAMS, `${platform}: ${pattern}`).not.toContain(program.toLowerCase());
        if (VERSION_PROBE_PROGRAMS.has(program)) {
          // Interpreters / package managers only as an exact version probe.
          expect(rest.length, pattern).toBe(1);
          expect(['--version', '-v', '-V'], pattern).toContain(rest[0]);
        }
      }
    }
  });

  it('pin the exact set (a new entry is an explicit decision)', () => {
    expect([...BUILTIN_PATTERNS.posix].sort()).toMatchInlineSnapshot(`
      [
        "basename",
        "cat",
        "dirname",
        "du",
        "echo",
        "eslint --version",
        "false",
        "file",
        "find",
        "git blame",
        "git branch",
        "git describe",
        "git diff",
        "git log",
        "git ls-files",
        "git ls-tree",
        "git rev-parse",
        "git shortlog",
        "git show",
        "git status",
        "grep",
        "head",
        "ls",
        "node --version",
        "node -v",
        "npm --version",
        "npm -v",
        "php --version",
        "pip --version",
        "pip3 --version",
        "prettier --version",
        "printf",
        "pwd",
        "python --version",
        "python -V",
        "python3 --version",
        "python3 -V",
        "readlink",
        "realpath",
        "rg",
        "ruby --version",
        "stat",
        "tail",
        "tree",
        "true",
        "tsc --version",
        "uname",
        "wc",
        "which",
      ]
    `);
  });

  it('stay read-only oriented and include coding inspect extras', () => {
    expect(BUILTIN_PATTERNS.posix).toContain('git status');
    expect(BUILTIN_PATTERNS.posix).toContain('git branch');
    expect(BUILTIN_PATTERNS.posix).not.toContain('pnpm --version');
    expect(BUILTIN_PATTERNS.posix).not.toContain('npm test');
    expect(BUILTIN_PATTERNS.posix).not.toContain('rm');
    expect(BUILTIN_PATTERNS.windows).toContain('git status');
    expect(BUILTIN_PATTERNS.windows).toContain('git branch');
  });
});
