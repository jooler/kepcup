import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinPluginsEnv } from '../src/builtin-plugins.js';

/**
 * builtinPluginsEnv（D104 P0b）：打包布局下 dist 的同级 plugins/ 目录注入
 * KEPCUP_BUILTIN_PLUGINS；env 已设置时原样返回；两者皆无时透传。
 */

const root = mkdtempSync(path.join(tmpdir(), 'server-builtin-plugins-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('builtinPluginsEnv', () => {
  it('returns env untouched when KEPCUP_BUILTIN_PLUGINS is already set', () => {
    const env = { KEPCUP_BUILTIN_PLUGINS: '/opt/kepcup/plugins', OTHER: 'x' };
    expect(builtinPluginsEnv(path.join(root, 'dist'), env)).toBe(env);
  });

  it('injects a sibling plugins/ directory of distDir when present', () => {
    const pkgDir = path.join(root, `pkg-${Math.random().toString(36).slice(2, 8)}`);
    const distDir = path.join(pkgDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(pkgDir, 'plugins'), { recursive: true });
    expect(builtinPluginsEnv(distDir, {})).toEqual({
      KEPCUP_BUILTIN_PLUGINS: path.join(pkgDir, 'plugins'),
    });
  });

  it('passes env through when no sibling plugins/ exists', () => {
    const distDir = path.join(root, `no-plugins-${Math.random().toString(36).slice(2, 8)}`, 'dist');
    mkdirSync(distDir, { recursive: true });
    const env = { OTHER: 'y' };
    expect(builtinPluginsEnv(distDir, env)).toBe(env);
  });
});
