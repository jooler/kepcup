import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Share Extension 构建脚本的纯函数与 plist 注入（D94 §9.6 / §10.1）。
 *
 * P1 修复：Swift 侧 `containerURL` 用的组 id 必须与 entitlements 展开值
 * （`<TeamID>.app.kepcup.desktop`）逐字一致——构建脚本在签名前把它注入
 * appex 的 Info.plist（键 `KEPCUPShareGroupId`），Swift 读它、读不到回退常量。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const build = await import('../../scripts/build-share-extension.mjs');
const plan = await import('../../scripts/dist-share-extension.mjs');

/** 造一个最小可用的 plist（plutil 校验格式）。 */
function writePlist(file: string): void {
  writeFileSync(
    file,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '<key>CFBundleName</key>',
      '<string>KepCupShare</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
}

function readPlistJson(file: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
  );
}

const hasPlistBuddy = existsSync('/usr/libexec/PlistBuddy');

describe('build-share-extension entitlementGroupId', () => {
  test('有 TeamID 时给 entitlements 展开值（TeamID 前缀）', () => {
    expect(build.entitlementGroupId('8CL9PRK85J')).toBe('8CL9PRK85J.app.kepcup.desktop');
  });

  test('无 TeamID 时不注入（entitlements 里也没有 App Group 权限）', () => {
    expect(build.entitlementGroupId(null)).toBeNull();
  });

  test('expandedEntitlements：无 team 剥掉 App Group，有 team 展开前缀', () => {
    const raw = [
      '<plist version="1.0"><dict>',
      '<key>com.apple.security.app-sandbox</key><true/>',
      '<key>com.apple.security.application-groups</key>',
      '<array><string>$(TeamIdentifierPrefix)app.kepcup.desktop</string></array>',
      '</dict></plist>',
    ].join('');
    expect(build.expandedEntitlements(raw, null)).not.toContain('application-groups');
    expect(build.expandedEntitlements(raw, 'TEAM123456')).toContain(
      '<string>TEAM123456.app.kepcup.desktop</string>',
    );
  });
});

describe('build-share-extension injectGroupIdIntoPlist', () => {
  test.skipIf(!hasPlistBuddy)('写入 Info.plist 键且幂等（Set→Add 两条路）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-share-inject-'));
    try {
      const plist = path.join(dir, 'Info.plist');
      writePlist(plist);
      build.injectGroupIdIntoPlist(plist, 'TEAM123456.app.kepcup.desktop');
      expect(readPlistJson(plist)[build.SHARE_GROUP_PLIST_KEY]).toBe(
        'TEAM123456.app.kepcup.desktop',
      );
      // 已有键时 Set 成功——注入两次不会坏。
      build.injectGroupIdIntoPlist(plist, 'OTHERTEAM.app.kepcup.desktop');
      expect(readPlistJson(plist)[build.SHARE_GROUP_PLIST_KEY]).toBe(
        'OTHERTEAM.app.kepcup.desktop',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasPlistBuddy)('plist 不存在 / 写不进去时报可诊断的错误', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-share-inject-'));
    try {
      expect(() =>
        build.injectGroupIdIntoPlist(path.join(dir, 'nope.plist'), 'g.app.kepcup.desktop'),
      ).toThrow(/不存在/);
      // 文件在但不是 plist：PlistBuddy Set/Add 都失败。
      const junk = path.join(dir, 'junk.plist');
      writeFileSync(junk, 'not a plist');
      expect(() => build.injectGroupIdIntoPlist(junk, 'g.app.kepcup.desktop')).toThrow(
        /无法把 App Group id 写进/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dist-share-extension macTargetArches', () => {
  const yml = readFileSync(
    path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'),
    'utf8',
  );

  test('从 electron-builder.yml 读出 mac target 的双架构', () => {
    expect(plan.macTargetArchesFromYml(yml)).toEqual(['arm64', 'x64']);
  });

  test('yml 解析的边界：无 mac 块为空、arch 列表去重', () => {
    expect(plan.macTargetArchesFromYml('win:\n  target: nsis\n')).toEqual([]);
    expect(
      plan.macTargetArchesFromYml('mac:\n  target:\n    - target: dmg\n      arch: [arm64, arm64]\n'),
    ).toEqual(['arm64']);
  });

  test('非 mac 目标不构建 appex', () => {
    expect(plan.macTargetArches(['--win', '--x64'], ['arm64', 'x64'])).toEqual([]);
  });

  test('裸 --mac 对齐 yml 声明（P1：第二个 pass 缺 appex 必挂）', () => {
    expect(plan.macTargetArches(['--mac'], ['arm64', 'x64'])).toEqual(['arm64', 'x64']);
  });

  test('yml 读不出来时退默认双架构', () => {
    expect(plan.macTargetArches(['--mac'], [])).toEqual(['arm64', 'x64']);
  });

  test('显式架构参数优先且去重', () => {
    expect(plan.macTargetArches(['--mac', '--arm64'], ['arm64', 'x64'])).toEqual(['arm64']);
    expect(plan.macTargetArches(['--mac', '--x64', '--arm64', '--x64'], [])).toEqual(['x64', 'arm64']);
  });
});

describe('dist-share-extension shareExtensionSkipPlan', () => {
  test('全部架构都有产物：不跳过', () => {
    expect(
      plan.shareExtensionSkipPlan({ arches: ['arm64', 'x64'], appexExists: () => true }),
    ).toEqual({ skip: false, missing: [] });
  });

  test('任一架构缺产物：整体跳过并报告缺失清单', () => {
    const result = plan.shareExtensionSkipPlan({
      arches: ['arm64', 'x64'],
      appexExists: (arch) => arch === 'arm64',
    });
    expect(result).toEqual({ skip: true, missing: ['x64'] });
  });
});

// 导入即执行构建是老问题（脚本顶层跑 main）——main 现在有 import 守卫，这条
// 测试守住回归：测试进程 import 它绝不能触发 xcodebuild。
describe('build-share-extension import guard', () => {
  test('被 import 时不执行构建（不会碰 xcodebuild / resources 目录）', () => {
    expect(build.entitlementGroupId('X')).toBe('X.app.kepcup.desktop');
  });
});

// KEPCUP_SKIP_SHARE_EXTENSION 的跨进程传递（P1）：build-share-extension 在子进程
// 里设 env 传不回 dist.mjs——现在由 dist.mjs 决定并通过 spawn env 传给
// electron-builder。用一次真实子进程验证「子进程 env 不泄漏回父进程」的机制
// 本身（防止有人改回子进程内设 env 的老写法）。
describe('KEPCUP_SKIP_SHARE_EXTENSION propagation', () => {
  test('子进程里设的 env 不会出现在父进程', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-share-env-'));
    try {
      const file = path.join(dir, 'child.mjs');
      writeFileSync(file, "process.env.KEPCUP_SKIP_SHARE_EXTENSION = '1';\n");
      const result = spawnSync(process.execPath, [file], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(process.env.KEPCUP_SKIP_SHARE_EXTENSION).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('spawn env 选项能把变量传给子进程（dist.mjs 的传递方式）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-share-env-'));
    try {
      const file = path.join(dir, 'child.mjs');
      writeFileSync(file, "process.stdout.write(process.env.KEPCUP_SKIP_SHARE_EXTENSION ?? 'unset');\n");
      chmodSync(file, 0o644);
      const result = spawnSync(process.execPath, [file], {
        encoding: 'utf8',
        env: { ...process.env, KEPCUP_SKIP_SHARE_EXTENSION: '1' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
