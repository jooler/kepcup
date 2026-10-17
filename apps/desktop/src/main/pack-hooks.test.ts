import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const hooks = require('../../scripts/pack-hooks.cjs') as {
  FORBIDDEN_MARKERS: string[];
  findForbiddenMarker(text: string): string | null;
  assertQueryDriverUnpacked(resourcesPath: string, platform: string, arch: string): string;
  smokeQueryDriver(execPath: string, driverEntry: string): unknown;
  platformDirName(context: {
    electronPlatformName?: string;
    packager?: { platform?: string | { name?: string } };
  }): string;
};

describe('afterPack forbidden markers', () => {
  test('the page-level core RPC e2e seam is forbidden in packaged bundles', () => {
    expect(hooks.FORBIDDEN_MARKERS).toContain('__kepcupRpc');
    // A renderer bundle that still contains the seam is caught; a clean one is not.
    const leaked = 'a.b(function(){window.__kepcupRpc=(e,t)=>core.call(e,t)})';
    expect(hooks.findForbiddenMarker(leaked)).toBe('__kepcupRpc');
    expect(hooks.findForbiddenMarker('console.log("clean bundle")')).toBeNull();
  });

  test('the existing seams stay forbidden', () => {
    for (const marker of [
      'KEPCUP_MOCK_LLM_URL',
      'KEPCUP_ONBOARDING',
      'KEPCUP_WSL_PROMPT',
      'KEPCUP_FILE_KEYSTORE_PATH',
    ]) {
      expect(hooks.findForbiddenMarker(`x ${marker} y`), marker).toBe(marker);
    }
  });
});

// D81 §6.1：组件查询子进程（ELECTRON_RUN_AS_NODE）加载的 SQLite 驱动必须整包解出 asar，
// 且能以与查询子进程相同的方式加载并查询加密库。
describe('afterPack query driver checks', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const driverEntry = createRequire(path.join(repoRoot, 'packages/core/package.json')).resolve(
    'better-sqlite3-multiple-ciphers',
  );
  const driverPackage = path.dirname(path.dirname(driverEntry));

  function fakeResources(): string {
    const resources = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-test-'));
    cpSync(
      driverPackage,
      path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers'),
      // 只要运行时文件（lib + prebuilds）：源码与 node-gyp 产物不拷，原生库只认 prebuilds。
      {
        recursive: true,
        dereference: true,
        filter: (src) => !/^[\\/](deps|src|build)([\\/]|$)/.test(src.slice(driverPackage.length)),
      },
    );
    return resources;
  }

  test('unpacked driver is found and a real encrypted query runs through it', () => {
    const resources = fakeResources();
    try {
      const entry = hooks.assertQueryDriverUnpacked(resources, process.platform, process.arch);
      expect(entry).toContain(path.join('app.asar.unpacked', 'node_modules', 'better-sqlite3-multiple-ciphers'));
      // 本机 Node 代替产物里的 Electron（同一 -e 脚本，ELECTRON_RUN_AS_NODE 对 Node 无影响）。
      expect(hooks.smokeQueryDriver(process.execPath, entry)).toEqual({ v: 'ok' });
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('a missing unpacked driver or native library fails the build with a diagnosable error', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-test-'));
    try {
      expect(() => hooks.assertQueryDriverUnpacked(empty, 'linux', 'x64')).toThrow(/未解出 asar/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const resources = fakeResources();
    try {
      expect(() => hooks.assertQueryDriverUnpacked(resources, 'freebsd', 'x64')).toThrow(/freebsd-x64 原生库/);
      expect(() => hooks.smokeQueryDriver(process.execPath, path.join(resources, 'nope.js'))).toThrow(
        /组件查询驱动冒烟失败/,
      );
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

describe('platformDirName', () => {
  test('maps electronPlatformName and packager.platform.name without defaulting to darwin', () => {
    expect(hooks.platformDirName({ electronPlatformName: 'win32' })).toBe('win');
    expect(hooks.platformDirName({ electronPlatformName: 'darwin' })).toBe('darwin');
    expect(hooks.platformDirName({ electronPlatformName: 'linux' })).toBe('linux');
    expect(hooks.platformDirName({ electronPlatformName: 'mas' })).toBe('darwin');
    // electron-builder Platform.WINDOWS.name is "windows", not "win"
    expect(hooks.platformDirName({ packager: { platform: { name: 'windows' } } })).toBe('win');
    expect(hooks.platformDirName({ packager: { platform: { name: 'mac' } } })).toBe('darwin');
    expect(hooks.platformDirName({ packager: { platform: 'win32' } })).toBe('win');
    expect(() => hooks.platformDirName({})).toThrow(/unknown platform/);
  });
});
