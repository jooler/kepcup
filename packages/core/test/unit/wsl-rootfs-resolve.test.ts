import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * BR-P12-005 后的 rootfs 解析单测（纯路径逻辑，故意不放在 win-only 的
 * wsl-setup 集成套件里）：双架构布局选择 + 旧单文件布局兼容 + 覆盖优先级。
 */
import { resolveRootfsTarPath } from '../../src/sandbox/wsl/setup.js';

const CLEANUP: string[] = [];
afterEach(() => {
  for (const dir of CLEANUP.splice(0, CLEANUP.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 模拟 repo checkout 布局：fixture 里的「repo 根」是 <tmp>/home/src/kepcup，
 * searchRoot 是 setup 模块所在目录（repoRoot/packages/core/dist/sandbox/wsl，
 * 与生产同层数）；repoRootFrom(root) 下落产物文件。
 */
function repoFixture(repoRelativeFiles: string[]): { searchRoot: string; repoRoot: string } {
  const outer = mkdtempSync(path.join(tmpdir(), 'kepcup-rootfs-resolve-'));
  CLEANUP.push(outer);
  const repoRoot = path.join(outer, 'home', 'src', 'kepcup');
  mkdirSync(repoRoot, { recursive: true });
  for (const rel of repoRelativeFiles) {
    const target = path.join(repoRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '#fixture');
  }
  // 生产布局：wslSetupModuleDir() = …/packages/core/<编译产物所需层数>/sandbox/wsl。
  const searchRoot = path.join(repoRoot, 'packages', 'core', 'dist', 'sandbox', 'wsl');
  mkdirSync(searchRoot, { recursive: true });
  return { searchRoot, repoRoot };
}

describe('resolveRootfsTarPath', () => {
  it('KEPCUP_WSL_ROOTFS override wins over any layout', () => {
    const overrideTar = path.join(tmpdir(), `kepcup-rootfs-override-${process.pid}-${Date.now()}.tar`);
    writeFileSync(overrideTar, '#override');
    // 只登记文件本身：dirname 是 tmpdir()，误登记会把系统临时目录整个删掉（CI 上
    // 曾把 runner 的 $TMPDIR 清空，引发全量 ENOENT / EACCES）。
    CLEANUP.push(overrideTar);
    const { searchRoot } = repoFixture(['apps/desktop/resources/wsl/arm64/rootfs.tar']);
    expect(
      resolveRootfsTarPath({ env: { KEPCUP_WSL_ROOTFS: overrideTar }, searchRoot, arch: 'arm64' }),
    ).toBe(overrideTar);
  });

  it('override pointing at a missing file does not fall back', () => {
    const { searchRoot } = repoFixture(['apps/desktop/resources/wsl/x64/rootfs.tar']);
    expect(
      resolveRootfsTarPath({
        env: { KEPCUP_WSL_ROOTFS: path.join(tmpdir(), 'no-such-rootfs.tar') },
        searchRoot,
        arch: 'x64',
      }),
    ).toBeNull();
  });

  it('picks resources/wsl/<arch>/rootfs.tar for the requested arch', () => {
    const { searchRoot, repoRoot } = repoFixture([
      'apps/desktop/resources/wsl/x64/rootfs.tar',
      'apps/desktop/resources/wsl/arm64/rootfs.tar',
    ]);
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'arm64' })).toBe(
      path.join(repoRoot, 'apps', 'desktop', 'resources', 'wsl', 'arm64', 'rootfs.tar'),
    );
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'x64' })).toBe(
      path.join(repoRoot, 'apps', 'desktop', 'resources', 'wsl', 'x64', 'rootfs.tar'),
    );
  });

  it('arch-specific tar beats the legacy single file', () => {
    const { searchRoot, repoRoot } = repoFixture([
      'apps/desktop/resources/wsl/x64/rootfs.tar',
      'apps/desktop/resources/wsl/arm64/rootfs.tar',
      'apps/desktop/resources/wsl/rootfs.tar',
    ]);
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'arm64' })).toBe(
      path.join(repoRoot, 'apps', 'desktop', 'resources', 'wsl', 'arm64', 'rootfs.tar'),
    );
  });

  it('falls back to the legacy single file when no arch layout exists', () => {
    const { searchRoot, repoRoot } = repoFixture(['apps/desktop/resources/wsl/rootfs.tar']);
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'x64' })).toBe(
      path.join(repoRoot, 'apps', 'desktop', 'resources', 'wsl', 'rootfs.tar'),
    );
  });

  it('returns null when neither layout is present', () => {
    const { searchRoot } = repoFixture(['apps/desktop/resources/wsl/.gitkeep']);
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'x64' })).toBeNull();
    expect(resolveRootfsTarPath({ env: {}, searchRoot, arch: 'arm64' })).toBeNull();
  });
});
