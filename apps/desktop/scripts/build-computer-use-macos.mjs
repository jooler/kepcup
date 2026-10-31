#!/usr/bin/env node

/**
 * 构建 computer-use 的 macOS 原生 helper（D105，docs/design/52-computer-use.md §7）。
 *
 *   node scripts/build-computer-use-macos.mjs [arm64|x64]
 *
 * 改造自 stablyai/orca 的 config/scripts/build-computer-macos.mjs（commit 55507b87）：
 * - 单目标架构出包、不做 universal lipo——对齐 rg「平台私有二进制只打本机架构一份」
 *   （electron-builder.yml mac.extraResources 的 ${arch} 宏），产物
 *   `resources/computer-use/darwin-${arch}/KepCup Computer Use.app`。
 * - vendored 的 SwiftPM 包（native/computer-use-macos/）一行不改：包名与可执行名
 *   保持上游的 `orca-computer-use-macos`，重命名只发生在 .app 层（bundle id /
 *   显示名 / 图标，见 Info.plist 模板与 entitlements 注释）。
 * - entitlements 是空 dict：helper 无特殊 entitlement，TCC 按(bundle id + 签名)记账。
 *
 * 签名身份解析沿 orca 顺序：KEPCUP_COMPUTER_MACOS_SIGN_IDENTITY / CSC_NAME 显式
 * 指定 > Apple Development（dev）> Developer ID Application / Apple Distribution
 * （release）> ad-hoc（'-'，本地冒烟用，警告提示）。release（KEPCUP_MAC_RELEASE=1）
 * 加 hardened runtime + timestamp + entitlements；ad-hoc 时跳过这些选项（没有身份
 * 撑不起公证链）。发版包的 helper 缺失 / 未有效签名由 pack-hooks.cjs 硬校验
 * fail-fast（WP5），本脚本只警告不阻塞 dev。
 *
 * 非 darwin 平台 exit 0（CI 的 win/linux runner 直接跳过，沿 orca 语义）。
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const packagePath = path.join(appDir, 'native', 'computer-use-macos');
const outputRoot = path.join(appDir, 'resources', 'computer-use');
// 空 dict：helper 无特殊 entitlement，辅助功能 / 屏幕录制的 TCC 授权由系统按
// （bundle id + 签名）记账。注意 AMFI 的 entitlements 解析器不支持 XML 注释——
// 该 plist 必须保持纯净结构（根因记录见 DEVIATIONS DEV-081），说明只能写在这里。
const entitlementsPath = path.join(appDir, 'resources', 'entitlements.computer-use.mac.plist');
const iconPath = path.join(appDir, 'resources', 'icon.icns');

// vendored Package.swift 的 executable 产物名（保持上游，勿改）。
const executableName = 'orca-computer-use-macos';
const bundleId = process.env.KEPCUP_COMPUTER_MACOS_BUNDLE_ID ?? 'app.kepcup.desktop.computer-use';
const displayName = 'KepCup Computer Use';
const releaseBuild = process.env.KEPCUP_MAC_RELEASE === '1';

/** electron-builder 的 arch 名 → SwiftPM triple（macOS 14+，沿 orca 门控）。 */
function tripleForArch(arch) {
  return arch === 'x64' ? 'x86_64-apple-macosx' : 'arm64-apple-macosx';
}

/** 目标架构：命令行给的优先（允许出非本机架构的包），否则按宿主架构。 */
function targetArch(argv) {
  const given = argv.filter((arg) => arg === 'arm64' || arg === 'x64');
  if (given.length > 0) return given[0];
  return process.arch === 'x64' ? 'x64' : 'arm64';
}

function log(message) {
  console.log(`[computer-use] ${message}`);
}

function warn(message) {
  console.warn(`[computer-use] WARNING: ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** 钥匙串里的 codesigning 身份全名列表。 */
function codesigningIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) return [];
  return [...result.stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function resolveSigningIdentity() {
  const explicit = process.env.KEPCUP_COMPUTER_MACOS_SIGN_IDENTITY ?? process.env.CSC_NAME;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const identities = codesigningIdentities();
  const developmentMatch = identities.find((name) => name.includes('Apple Development:'));
  if (!releaseBuild && developmentMatch) return developmentMatch;
  const releaseMatch =
    identities.find((name) => name.includes('Developer ID Application:')) ??
    identities.find((name) => name.includes('Apple Distribution:'));
  return releaseMatch ?? developmentMatch ?? '-';
}

function buildBinary(arch) {
  const triple = tripleForArch(arch);
  // SwiftPM 6.4+ 的 swiftbuild 默认不再产出 .build/<triple>/release 布局，显式走
  // native build system（沿 orca 构建脚本对 swift-swiftbuild #21145 的处理）。
  run('swift', [
    'build',
    '-c',
    'release',
    '--package-path',
    packagePath,
    '--triple',
    triple,
    '--build-system',
    'native',
  ]);
  return path.join(packagePath, '.build', triple, 'release', executableName);
}

function appVersion() {
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '1.0.0';
}

function createHelperApp(arch, binaryPath) {
  const appPath = path.join(outputRoot, `darwin-${arch}`, `${displayName}.app`);
  const appExecutablePath = path.join(appPath, 'Contents', 'MacOS', executableName);
  const appIconPath = path.join(appPath, 'Contents', 'Resources', 'AppIcon.icns');
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(path.dirname(appExecutablePath), { recursive: true });
  mkdirSync(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  copyFileSync(binaryPath, appExecutablePath);
  copyFileSync(iconPath, appIconPath);
  chmodSync(appExecutablePath, 0o755);
  writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(), 'utf8');

  const identity = resolveSigningIdentity();
  if (identity === '-') {
    warn(
      '未找到 codesigning 身份——helper 以 ad-hoc 签名，TCC 授权会在每次重建后丢失；' +
        '发版构建必须提供身份（pack-hooks 会 fail-fast）。',
    );
  } else {
    log(`codesign: ${identity}`);
  }
  run('codesign', codesignArgs(identity, appPath));
  log(`${appPath}`);
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity];
  if (releaseBuild && identity !== '-') {
    args.push('--options', 'runtime', '--timestamp', '--entitlements', entitlementsPath);
  }
  args.push(targetPath);
  return args;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlist(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapePlist(appVersion())}</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>计算机操控需要辅助功能权限，用于在你要求 Bot 操作应用时读取并操控应用界面。</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>计算机操控需要屏幕录制权限，用于在你要求 Bot 查看屏幕时截取应用窗口画面。</string>
</dict>
</plist>
`;
}

function escapePlist(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

if (process.platform !== 'darwin') {
  log('非 darwin 平台，跳过 computer-use helper 构建。');
  process.exit(0);
}

const arch = targetArch(process.argv.slice(2));
const binaryPath = buildBinary(arch);
chmodSync(binaryPath, 0o755);
createHelperApp(arch, binaryPath);
