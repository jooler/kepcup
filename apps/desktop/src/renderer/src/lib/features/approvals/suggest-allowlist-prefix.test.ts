import { describe, expect, it } from 'vitest';
import { allowlistSuggestionRefusal, suggestAllowlistPrefix } from './suggest-allowlist-prefix';

describe('suggestAllowlistPrefix', () => {
  it('takes `<program> <subcommand>` for subcommand-style tools', () => {
    expect(suggestAllowlistPrefix('pnpm test')).toBe('pnpm test');
    expect(suggestAllowlistPrefix('pnpm test packages/core')).toBe('pnpm test');
    expect(suggestAllowlistPrefix('git status --short')).toBe('git status');
    expect(suggestAllowlistPrefix('cargo check --all')).toBe('cargo check');
  });

  it('defaults to the full first command otherwise (a prefix widens what runs)', () => {
    expect(suggestAllowlistPrefix('ls -la')).toBe('ls -la');
    expect(suggestAllowlistPrefix('cat ./src/a.ts')).toBe('cat ./src/a.ts');
    expect(suggestAllowlistPrefix('eslint .')).toBe('eslint .');
    expect(suggestAllowlistPrefix('python scripts/check.py --fast')).toBe('python scripts/check.py --fast');
    expect(suggestAllowlistPrefix('node b.js')).toBe('node b.js');
    // `npm run` alone is refused: keep the script name.
    expect(suggestAllowlistPrefix('npm run build')).toBe('npm run build');
  });

  it('never reduces a shell / interpreter / network / run-verb command to the bare program', () => {
    for (const command of [
      'bash -c "rm -rf /"',
      'sh ./x.sh',
      'python -c "print(1)"',
      'node -e "1"',
      'curl https://a.b',
      'wget https://a.b',
      'npx eslint .',
      'pnpm dlx create-app',
      'rm -rf build',
      'sudo ls',
      'env FOO=1 make',
    ]) {
      expect(suggestAllowlistPrefix(command), command).toBe('');
      expect(allowlistSuggestionRefusal(command), command).not.toBeNull();
    }
    expect(allowlistSuggestionRefusal('pnpm test')).toBeNull();
  });

  it('uses only the first simple segment of a compound command', () => {
    expect(suggestAllowlistPrefix('pnpm test && pnpm lint')).toBe('pnpm test');
    expect(suggestAllowlistPrefix('git status | head')).toBe('git status');
  });

  it('returns empty for blank input', () => {
    expect(suggestAllowlistPrefix('')).toBe('');
    expect(suggestAllowlistPrefix('   ')).toBe('');
  });
});
