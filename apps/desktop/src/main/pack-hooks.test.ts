import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  ensureWslRootfsSource(
    wslDir: string,
    targetArch: string,
    projectDir: string,
  ): { kept: string | null; warnMissing: boolean };
  assertShareExtension(
    appBundlePath: string,
    groupId: string | null,
  ): {
    appexPath: string;
    bundleId: string;
    extensionPoint: string;
    signed: boolean;
    appGroup: string | null;
  };
  assertNoShareExtension(outDir: string): void;
  readPlist(plistPath: string): unknown;
  firstAppGroupFromEntitlements(text: string): string | null;
  shareGroupIdFromProject(projectDir: string): string | null;
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

// P13：win pass 的 WSL rootfs 备货——${arch} 子目录存在即用、空目录写 .keep
// 兜底（否则 extraResources 不拷、package 里连 Resources/wsl 都没有）、
// 缺产物按架构告警（legacy 单文件只救 x64 pass）。
describe('ensureWslRootfsSource', () => {
  function projectWithWsl(files: string[] = []): string {
    const project = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-wsl-'));
    for (const rel of files) {
      const target = path.join(project, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, '#fixture');
    }
    return project;
  }

  test('arch-specific tar exists: kept, no dir mutation beyond no-op', () => {
    const project = projectWithWsl(['resources/wsl/x64/rootfs.tar']);
    const result = hooks.ensureWslRootfsSource(path.join(project, 'resources', 'wsl'), 'x64', project);
    expect(result).toEqual({ kept: path.join('resources', 'wsl', 'x64', 'rootfs.tar'), warnMissing: false });
    // 不会在 x64 子目录里偷偷塞 .keep（产物目录必须保持 CI 语义）。
    expect(readdirSync(path.join(project, 'resources', 'wsl', 'x64'))).toEqual(['rootfs.tar']);
  });

  test('missing arch layout: .keep is written so extraResources still copies the dir', () => {
    const project = projectWithWsl();
    const result = hooks.ensureWslRootfsSource(path.join(project, 'resources', 'wsl'), 'x64', project);
    expect(result.kept).toBeNull();
    expect(result.warnMissing).toBe(true);
    expect(readdirSync(path.join(project, 'resources', 'wsl', 'x64'))).toContain('.keep');
  });

  test('legacy single file rescues an x64 pass', () => {
    const project = projectWithWsl(['resources/wsl/rootfs.tar']);
    const result = hooks.ensureWslRootfsSource(path.join(project, 'resources', 'wsl'), 'x64', project);
    expect(result).toEqual({ kept: path.join('resources', 'wsl', 'rootfs.tar'), warnMissing: false });
  });

  test('legacy single file does NOT rescue an arm64 pass', () => {
    const project = projectWithWsl(['resources/wsl/rootfs.tar']);
    const result = hooks.ensureWslRootfsSource(path.join(project, 'resources', 'wsl'), 'arm64', project);
    expect(result).toEqual({ kept: null, warnMissing: true });
  });
});

// D94 §10.2：Share Extension 的落位校验（macOS 产物里 .appex 必须在
// Contents/PlugIns/ 下且扩展点正确；非 macOS 产物里不得出现 .appex）。
describe('share extension packaging checks', () => {
  function fakeAppex(
    overrides: { point?: string; bundleId?: string; groupId?: string | null } = {},
  ): string {
    const bundle = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-appex-'));
    const appex = path.join(bundle, 'KepCup.app', 'Contents', 'PlugIns', 'KepCupShare.appex');
    mkdirSync(path.join(appex, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      path.join(appex, 'Contents', 'Info.plist'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '<key>CFBundleIdentifier</key>',
        `<string>${overrides.bundleId ?? 'app.kepcup.desktop.ShareExtension'}</string>`,
        '<key>NSExtension</key>',
        '<dict>',
        '<key>NSExtensionPointIdentifier</key>',
        `<string>${overrides.point ?? 'com.apple.share-services'}</string>`,
        '</dict>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
    // codesign 要求包里有可执行文件。
    writeFileSync(path.join(appex, 'Contents', 'MacOS', 'KepCupShare'), '#!/bin/sh\n');
    // 打包产物里主进程读的组 id 快照（extraResources 拷进 Resources 的那份）。
    // groupId 传 null 时不写——模拟「包内缺 group.json」的坏产物。
    const packagedGroupId = overrides.groupId === undefined ? '8CL9PRK85J.app.kepcup.desktop' : overrides.groupId;
    if (packagedGroupId !== null) {
      const resources = path.join(bundle, 'KepCup.app', 'Contents', 'Resources', 'share-extension');
      mkdirSync(resources, { recursive: true });
      writeFileSync(
        path.join(resources, 'group.json'),
        JSON.stringify({ groupId: packagedGroupId, teamId: '8CL9PRK85J' }),
      );
    }
    return path.join(bundle, 'KepCup.app');
  }

  /**
   * ad-hoc 签名并带上给定 entitlements（macOS 的 codesign 可用时）。
   *
   * 可执行文件换真的 Mach-O：对 shell 脚本签名时 codesign 会静默丢掉
   * entitlements（签名成功、entitlements 为空）。
   */
  function signAppex(
    appBundle: string,
    entitlementsXml: string | null,
  ): { ok: boolean; reason?: string } {
    const appex = path.join(appBundle, 'Contents', 'PlugIns', 'KepCupShare.appex');
    cpSync('/usr/bin/true', path.join(appex, 'Contents', 'MacOS', 'KepCupShare'));
    const args = ['--force', '--sign', '-'];
    if (entitlementsXml !== null) {
      const entFile = path.join(path.dirname(appex), 'test-entitlements.plist');
      writeFileSync(entFile, entitlementsXml);
      args.push('--entitlements', entFile);
    }
    args.push(appex);
    const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
    return result.status === 0 ? { ok: true } : { ok: false, reason: result.stderr };
  }

  const hasCodesign = existsSync('/usr/bin/codesign') && existsSync('/usr/bin/true');

  /** codesign -d --entitlements 的真实输出格式（新旧 macOS 版本都可能出现）。 */
  const ENTITLEMENTS_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '<key>com.apple.security.app-sandbox</key><true/>',
    '<key>com.apple.security.application-groups</key>',
    '<array>',
    '<string>TEAM123456.app.kepcup.desktop</string>',
    '<string>group.something.else</string>',
    '</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  test('entitlements 解析：取第一个 application-group，容忍 Executable= 前缀与格式差异', () => {
    // 旧版 codesign：带 DOCTYPE 的完整 plist，前面混着 Executable= 行（stderr）。
    expect(hooks.firstAppGroupFromEntitlements(`Executable=${ENTITLEMENTS_XML}`)).toBe(
      'TEAM123456.app.kepcup.desktop',
    );
    // 新版 codesign：裸 XML（无 DOCTYPE）。
    const bare = ENTITLEMENTS_XML.replace(/<!DOCTYPE[^>]*>\n/, '');
    expect(hooks.firstAppGroupFromEntitlements(bare)).toBe('TEAM123456.app.kepcup.desktop');
    // 没有 App Group 键 / 空输入：null。
    expect(hooks.firstAppGroupFromEntitlements('<plist><dict></dict></plist>')).toBeNull();
    expect(hooks.firstAppGroupFromEntitlements('')).toBeNull();
  });

  test('shareGroupIdFromProject：读 group.json，缺失 / 损坏为 null', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-group-'));
    try {
      expect(hooks.shareGroupIdFromProject(project)).toBeNull();
      mkdirSync(path.join(project, 'resources', 'share-extension'), { recursive: true });
      writeFileSync(
        path.join(project, 'resources', 'share-extension', 'group.json'),
        JSON.stringify({ groupId: 'TEAM123456.app.kepcup.desktop', teamId: 'TEAM123456' }),
      );
      expect(hooks.shareGroupIdFromProject(project)).toBe('TEAM123456.app.kepcup.desktop');
      writeFileSync(path.join(project, 'resources', 'share-extension', 'group.json'), 'not json');
      expect(hooks.shareGroupIdFromProject(project)).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a well-formed appex passes and reports its bundle id', () => {
    const appBundle = fakeAppex();
    try {
      const summary = hooks.assertShareExtension(appBundle, '8CL9PRK85J.app.kepcup.desktop');
      expect(summary.bundleId).toBe('app.kepcup.desktop.ShareExtension');
      expect(summary.extensionPoint).toBe('com.apple.share-services');
      expect(summary.appexPath).toContain(path.join('PlugIns', 'KepCupShare.appex'));
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test.skipIf(!hasCodesign)('a signed appex with matching App Group passes the consistency check', () => {
    const appBundle = fakeAppex({ groupId: 'TEAM123456.app.kepcup.desktop' });
    try {
      const signed = signAppex(appBundle, ENTITLEMENTS_XML);
      expect(signed.ok, signed.reason).toBe(true);
      const summary = hooks.assertShareExtension(appBundle, 'TEAM123456.app.kepcup.desktop');
      expect(summary.signed).toBe(true);
      expect(summary.appGroup).toBe('TEAM123456.app.kepcup.desktop');
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test.skipIf(!hasCodesign)(
    'a signed appex whose App Group differs from group.json fails the build',
    () => {
      const appBundle = fakeAppex({ groupId: 'OTHERTEAM.app.kepcup.desktop' });
      try {
        const signed = signAppex(appBundle, ENTITLEMENTS_XML);
        expect(signed.ok, signed.reason).toBe(true);
        expect(() =>
          hooks.assertShareExtension(appBundle, 'OTHERTEAM.app.kepcup.desktop'),
        ).toThrow(/App Group 不一致/);
      } finally {
        rmSync(path.dirname(appBundle), { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!hasCodesign)(
    'a signed appex without application-groups fails when a group is expected',
    () => {
      const appBundle = fakeAppex({ groupId: 'TEAM123456.app.kepcup.desktop' });
      try {
        const signed = signAppex(
          appBundle,
          [
            '<plist version="1.0"><dict>',
            '<key>com.apple.security.app-sandbox</key><true/>',
            '</dict></plist>',
          ].join('\n'),
        );
        expect(signed.ok, signed.reason).toBe(true);
        expect(() => hooks.assertShareExtension(appBundle, 'TEAM123456.app.kepcup.desktop')).toThrow(
          /没有 application-groups/,
        );
      } finally {
        rmSync(path.dirname(appBundle), { recursive: true, force: true });
      }
    },
  );

  test('a missing packaged Resources/share-extension/group.json fails the build', () => {
    // extraResources 单文件条目的 to 不带文件名时，group.json 会被拷成名为
    // share-extension 的文件——主进程读不到就回落无前缀组 id，快照写错容器。
    const appBundle = fakeAppex({ groupId: null });
    try {
      expect(() => hooks.assertShareExtension(appBundle, '8CL9PRK85J.app.kepcup.desktop')).toThrow(
        /包内缺少 Resources\/share-extension\/group\.json/,
      );
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test('a packaged group.json whose groupId differs from the build baseline fails', () => {
    const appBundle = fakeAppex({ groupId: 'STALE.app.kepcup.desktop' });
    try {
      expect(() => hooks.assertShareExtension(appBundle, '8CL9PRK85J.app.kepcup.desktop')).toThrow(
        /与构建基准（8CL9PRK85J\.app\.kepcup\.desktop）不一致/,
      );
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test('a missing appex fails the build with a diagnosable error', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-appex-'));
    try {
      expect(() => hooks.assertShareExtension(empty, null)).toThrow(/缺少 Share Extension/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a wrong extension point fails the build', () => {
    const appBundle = fakeAppex({ point: 'com.apple.widget-extension' });
    try {
      expect(() => hooks.assertShareExtension(appBundle, null)).toThrow(/扩展点不对/);
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test('a wrong bundle id fails the build', () => {
    const appBundle = fakeAppex({ bundleId: 'com.example.other' });
    try {
      expect(() => hooks.assertShareExtension(appBundle, null)).toThrow(/bundle id 不对/);
    } finally {
      rmSync(path.dirname(appBundle), { recursive: true, force: true });
    }
  });

  test('non-macOS artifacts must not contain an appex', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'kepcup-pack-win-'));
    try {
      expect(() => hooks.assertNoShareExtension(outDir)).not.toThrow();
      const plugins = path.join(outDir, 'resources', 'app', 'PlugIns');
      mkdirSync(plugins, { recursive: true });
      mkdirSync(path.join(plugins, 'KepCupShare.appex'), { recursive: true });
      expect(() => hooks.assertNoShareExtension(outDir)).toThrow(/非 macOS 产物里出现了 Share Extension/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
