import { describe, expect, it } from 'vitest';
import { suggestAllowlistPrefix } from './suggest-allowlist-prefix';

describe('suggestAllowlistPrefix', () => {
  it('takes a subcommand pair when the second token is not a flag or path', () => {
    expect(suggestAllowlistPrefix('pnpm test')).toBe('pnpm test');
    expect(suggestAllowlistPrefix('pnpm test packages/core')).toBe('pnpm test');
    expect(suggestAllowlistPrefix('git status --short')).toBe('git status');
    expect(suggestAllowlistPrefix('npm run build')).toBe('npm run');
  });

  it('falls back to the program when the second token is a flag or path', () => {
    expect(suggestAllowlistPrefix('ls -la')).toBe('ls');
    expect(suggestAllowlistPrefix('cat ./src/a.ts')).toBe('cat');
    expect(suggestAllowlistPrefix('eslint .')).toBe('eslint');
    expect(suggestAllowlistPrefix("head '~/notes.txt'")).toBe('head');
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
