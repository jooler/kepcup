import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  resolveStdioProxyPath,
  unpackedAsarPath,
} from '../../src/agent/external/stdio-proxy-path.js';

/**
 * stdio ↔ HTTP MCP 代理的分发与运行时路径（D72 §4.4，todo §5.3 遗留「打包」）：
 * 源码树 / core build / 打包应用三处都与引用模块同目录，打包时解出 asar。
 */

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('resolveStdioProxyPath', () => {
  it('resolves the shipped script next to the module (source tree)', () => {
    const resolved = resolveStdioProxyPath();
    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe('stdio-proxy.mjs');
    expect(existsSync(resolved!)).toBe(true);
    expect(readFileSync(resolved!, 'utf8')).toContain('KEPCUP_MCP_URL');
  });

  it('maps the packaged bundle location into app.asar.unpacked', () => {
    const bundle = 'file:///opt/KepCup/resources/app.asar/out/main/core-entry/index.js';
    const expected = '/opt/KepCup/resources/app.asar.unpacked/out/main/core-entry/stdio-proxy.mjs';
    expect(resolveStdioProxyPath(bundle, (file) => file === expected)).toBe(expected);
    expect(unpackedAsarPath('C:\\KepCup\\resources\\app.asar\\out\\x.mjs')).toBe(
      'C:\\KepCup\\resources\\app.asar.unpacked\\out\\x.mjs',
    );
    // Development layouts are left untouched.
    expect(unpackedAsarPath('/repo/packages/core/dist/agent/external/stdio-proxy.mjs')).toBe(
      '/repo/packages/core/dist/agent/external/stdio-proxy.mjs',
    );
  });

  it('returns null when the script was not shipped', () => {
    expect(resolveStdioProxyPath('file:///nowhere/index.js', () => false)).toBeNull();
  });

  it('is copied by the core build and the desktop dist script, and unpacked from the asar', () => {
    const copyAssets = readFileSync(
      path.join(repoDir, 'packages/core/scripts/copy-assets.mjs'),
      'utf8',
    );
    expect(copyAssets).toContain('agent/external/stdio-proxy.mjs');
    const pkg = JSON.parse(
      readFileSync(path.join(repoDir, 'packages/core/package.json'), 'utf8'),
    ) as {
      scripts: { build: string };
    };
    expect(pkg.scripts.build).toContain('scripts/copy-assets.mjs');
    const dist = readFileSync(path.join(repoDir, 'apps/desktop/scripts/dist.mjs'), 'utf8');
    expect(dist).toContain('packages/core/src/agent/external/stdio-proxy.mjs');
    const builder = readFileSync(path.join(repoDir, 'apps/desktop/electron-builder.yml'), 'utf8');
    expect(builder).toMatch(/asarUnpack:\s*\n\s*- out\/main\/core-entry\/stdio-proxy\.mjs/);
  });
});
