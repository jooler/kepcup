import { describe, expect, it } from 'vitest';
import { matchAllowlistCommand } from '../../src/permissions/allowlist-match.js';
import { BUILTIN_PATTERNS } from '../../src/permissions/allowlist.js';

const POSIX = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'tree', 'which', 'grep', 'rg', 'find', 'git status', 'git diff', 'git log', 'git show'];

function ctx(overrides: Partial<Parameters<typeof matchAllowlistCommand>[1]> = {}) {
  return {
    platform: 'posix' as const,
    entries: POSIX,
    isPathAllowed: () => true,
    ...overrides,
  };
}

describe('allowlist matcher (posix)', () => {
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

const WIN_ENTRIES = ['dir', 'type', 'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Location', 'git status', 'git diff', 'git log', 'git show'];

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

describe('built-in patterns', () => {
  it('match the design list on both platforms', () => {
    expect(BUILTIN_PATTERNS.posix).toEqual(POSIX);
    expect(BUILTIN_PATTERNS.windows).toEqual(WIN_ENTRIES);
  });
});
