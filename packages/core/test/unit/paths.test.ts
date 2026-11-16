import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import {
  canonicalPath,
  defaultHome,
  ensurePluginDataDir,
  expandTilde,
  pluginArtifactDirFor,
  pluginDataDirFor,
  resolvePaths,
} from '../../src/infra/paths.js';

describe('resolvePaths', () => {
  it('defaults to ~/.kepcup', () => {
    const paths = resolvePaths();
    expect(paths.home).toBe(path.join(homedir(), '.kepcup'));
    expect(paths.logsDir).toBe(path.join(paths.home, 'logs'));
    expect(paths.mainDbPath).toBe(path.join(paths.home, 'main.db'));
    expect(paths.runsDbPath).toBe(path.join(paths.home, 'runs.db'));
  });

  it('places plugins under {home}/plugins (D104)', () => {
    const paths = resolvePaths();
    expect(paths.pluginsDir).toBe(path.join(paths.home, 'plugins'));
  });

  it('places execution-type plugin data under {home}/plugin-data (D125 补丁)', () => {
    const paths = resolvePaths();
    expect(paths.pluginDataDir).toBe(path.join(paths.home, 'plugin-data'));
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

describe('plugin data directories (D125 补丁)', () => {
  const pluginRoot = mkdtempSync(path.join(tmpdir(), 'plugin-data-paths-'));
  afterAll(() => rmSync(pluginRoot, { recursive: true, force: true }));

  it('uses the lower-cased {ns}/{name} and no version segment', () => {
    const dir = pluginDataDirFor(pluginRoot, 'IO.GitHub.Alice/Doc-Tools');
    expect(dir).toBe(path.join(pluginRoot, 'io.github.alice', 'doc-tools'));
    // Version-independent: the same plugin id always resolves to the same dir.
    expect(pluginDataDirFor(pluginRoot, 'io.github.alice/doc-tools')).toBe(dir);
    expect(pluginArtifactDirFor(pluginRoot, 'io.github.alice/doc-tools')).toBe(
      path.join(dir, 'artifacts'),
    );
  });

  it('rejects ids that are not exactly two safe segments (PLUGIN_INVALID)', () => {
    for (const bad of [
      '../escape',
      'nodash',
      'a/b/c',
      '/abs/path',
      'a/../b',
      'io.test/..',
      'io.test/../escape',
      'io.test\\x',
      'io.test/na me',
      '',
    ]) {
      expect(() => pluginDataDirFor(pluginRoot, bad)).toThrow(AppError);
      try {
        pluginDataDirFor(pluginRoot, bad);
      } catch (error) {
        expect((error as AppError).code).toBe('PLUGIN_INVALID');
      }
    }
  });

  it('ensurePluginDataDir creates the private directory (0700) and returns it', () => {
    const dir = ensurePluginDataDir(pluginRoot, 'io.test/ensured');
    expect(dir).toBe(path.join(pluginRoot, 'io.test', 'ensured'));
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });
});
