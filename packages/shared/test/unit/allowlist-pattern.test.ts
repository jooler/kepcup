import { describe, expect, it } from 'vitest';
import { allowlistPatternRefusal, allowlistProgramKey } from '../../src/policy/allowlist-pattern.js';

describe('allowlistPatternRefusal (custom allowlist entries)', () => {
  it('refuses programs that run anything, reach the network or delete, in any form', () => {
    for (const pattern of [
      'bash -c "ls"',
      'zsh script.zsh',
      '/bin/sh',
      'pwsh -Command Get-Date',
      'env FOO=1 ls',
      'sudo ls',
      'xargs cat',
      'timeout 5 ls',
      'npx eslint',
      'curl https://a.b',
      'wget -q https://a.b',
      'scp a b',
      'rm -rf build',
      'mv a b',
      'cp a b',
      'chmod +x run.sh',
      'dd if=a of=b',
      'Invoke-WebRequest https://a.b',
      'Remove-Item x',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('refuses bare interpreters / package managers / git and inline-code or run verbs', () => {
    for (const pattern of [
      'python',
      'python3.12',
      'node',
      'node -e',
      'python -c print(1)',
      'ruby -e',
      'php -r',
      'deno eval',
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'npm run',
      'pnpm run',
      'yarn run',
      'bun run',
      'npm exec tsc',
      'npm x tsc',
      'pnpm dlx create-app',
      'yarn dlx x',
      'pnpm exec',
      'git',
      'git -c core.pager=x',
      'git --exec-path=/tmp',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).not.toBeNull();
    }
  });

  it('refuses shell structure, empty patterns', () => {
    expect(allowlistPatternRefusal('')).not.toBeNull();
    expect(allowlistPatternRefusal('ls | rm')).not.toBeNull();
    expect(allowlistPatternRefusal('ls > x')).not.toBeNull();
    expect(allowlistPatternRefusal('cat $(id)')).not.toBeNull();
  });

  it('accepts specific entries the user owns', () => {
    for (const pattern of [
      'npm test',
      'pnpm test',
      'npm run build',
      'pnpm run lint',
      'python scripts/check.py',
      'node tools/report.js',
      'git status --short',
      'git push',
      'make test',
      'npm --version',
    ]) {
      expect(allowlistPatternRefusal(pattern), pattern).toBeNull();
    }
  });

  it('normalizes program names', () => {
    expect(allowlistProgramKey('/usr/bin/python3.11')).toBe('python');
    expect(allowlistProgramKey('C:\\Tools\\CURL.EXE')).toBe('curl');
    expect(allowlistProgramKey('pip3')).toBe('pip');
  });
});
