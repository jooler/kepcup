import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, defaultHome, expandTilde, resolvePaths } from '../../src/infra/paths.js';

describe('resolvePaths', () => {
  it('defaults to ~/.kepcup', () => {
    const paths = resolvePaths();
    expect(paths.home).toBe(path.join(homedir(), '.kepcup'));
    expect(paths.logsDir).toBe(path.join(paths.home, 'logs'));
    expect(paths.mainDbPath).toBe(path.join(paths.home, 'main.db'));
    expect(paths.runsDbPath).toBe(path.join(paths.home, 'runs.db'));
  });

  it('honors the KEPCUP_HOME override passed by the caller', () => {
    const paths = resolvePaths('/tmp/kepcup-home-x');
    // macOS canonicalizes /tmp → /private/tmp (resolvePaths realpaths).
    expect(paths.home).toBe(canonicalPath('/tmp/kepcup-home-x'));
    expect(paths.mainDbPath).toBe(path.join(canonicalPath('/tmp/kepcup-home-x'), 'main.db'));
  });

  it('expands a leading tilde', () => {
    const paths = resolvePaths('~/kepcup-home');
    expect(paths.home).toBe(path.join(homedir(), 'kepcup-home'));
  });
});

describe('expandTilde', () => {
  it('expands ~ and ~/ prefixes', () => {
    expect(expandTilde('~')).toBe(homedir());
    expect(expandTilde('~/x/y')).toBe(path.join(homedir(), 'x/y'));
    expect(expandTilde('/plain/path')).toBe('/plain/path');
  });
});

describe('defaultHome', () => {
  it('matches the documented data directory', () => {
    expect(defaultHome()).toBe(path.join(homedir(), '.kepcup'));
  });
});
