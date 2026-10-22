#!/usr/bin/env node

/**
 * 构建 macOS Share Extension（D94，docs/design/44-macos-share-extension.md §10.1）。
 *
 *   node scripts/build-share-extension.mjs arm64 x64
 *
 * 产物：`apps/desktop/resources/share-extension/{arch}/KepCupShare.appex`，
 * 打包时由 electron-builder 放进 `KepCup.app/Contents/PlugIns/`。
 *
 * 签名顺序：扩展先签，外层 app 后签（嵌套代码顺序不能反）。有 Developer ID
 * 身份时用 codesign 签扩展；没有就只出未签名产物（本地验证用，发版必须签名）。
 *
 * Xcode 不在（没装 / 非 macOS）时跳过并只警告。是否随包发行由 scripts/dist.mjs
 * 按产物存在性决定（KEPCUP_SKIP_SHARE_EXTENSION 由 dist.mjs 在自己的进程树里
 * 传给 electron-builder——子进程里设 env 传不回父进程）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const projectDir = path.join(appDir, 'macos', 'ShareExtension');
const xcodeProject = path.join(projectDir, 'KepCupShare.xcodeproj');
const outputRoot = path.join(appDir, 'resources', 'share-extension');
const entitlementsTemplate = path.join(projectDir, 'ShareExtension', 'KepCupShare.entitlements');

/** App Group 的组名（TeamID 前缀在签名时补上）。 */
const APP_GROUP_NAME = 'app.kepcup.desktop';

/**
 * appex 的 Info.plist 里注入完整组 id 的键。Swift 侧（SharedConfig.swift）读
 * 它拿 `containerURL` 要求的组 id——必须与 entitlements 展开后的值完全一致。
 */
export const SHARE_GROUP_PLIST_KEY = 'KEPCUPShareGroupId';

function log(message) {
  console.log(`[share-extension] ${message}`);
}

function warn(message) {
  console.warn(`[share-extension] ${message}`);
}

function hasXcode() {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('xcodebuild', ['-version'], { stdio: 'ignore' });
  return result.status === 0;
}

/** 目标架构：命令行给的优先，否则按宿主架构。 */
function targetArches(argv) {
  const arches = argv.filter((arg) => arg === 'arm64' || arg === 'x64');
  if (arches.length > 0) return arches;
  return [process.arch === 'x64' ? 'x64' : 'arm64'];
}

/** 钥匙串里的 Developer ID Application 身份（全名，含前缀与 TeamID）。 */
function developerIdIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  const names = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.includes('Developer ID Application')) continue;
    const match = /"([^"]+)"/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * 签名身份：KEPCUP_SHARE_SIGN_IDENTITY 优先；其次 CI 导出的 CSC_NAME（electron-builder
 * 会剥掉「Developer ID Application: 」前缀，这里换回钥匙串里的全名，codesign 认得）；
 * 再退回钥匙串里的 Developer ID 身份。多团队钥匙串下可用 KEPCUP_SHARE_TEAM_ID
 * 过滤（身份全名末尾的 `(TEAMID)` 括号）；过滤无命中时宁可不签也不选错团队。
 */
function signingIdentity() {
  const explicit = process.env.KEPCUP_SHARE_SIGN_IDENTITY;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const fromKeychain = developerIdIdentities();
  const teamFilter = (process.env.KEPCUP_SHARE_TEAM_ID ?? '').trim();
  if (teamFilter.length > 0) {
    const matched = fromKeychain.filter((name) => name.includes(`(${teamFilter})`));
    if (matched.length === 0) {
      warn(`钥匙串里没有 TeamID ${teamFilter} 的 Developer ID 身份——扩展不签名。`);
      return null;
    }
    return matched[0];
  }
  const cscName = (process.env.CSC_NAME ?? '').trim();
  if (cscName.length > 0) {
    const match = fromKeychain.find((name) => name.includes(cscName));
    return match ?? cscName;
  }
  return fromKeychain[0] ?? null;
}

/** TeamID：签名身份括号里的 Team ID，或 KEPCUP_APPLE_TEAM_ID。 */
function teamId(identity) {
  const fromEnv = process.env.KEPCUP_APPLE_TEAM_ID;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (identity) {
    const match = /\(([A-Z0-9]{10})\)\s*$/.exec(identity);
    if (match) return match[1];
  }
  return null;
}

/** 展开 entitlements 里的 $(TeamIdentifierPrefix)。 */
export function expandedEntitlements(raw, team) {
  if (team === null) {
    // 没有 TeamID：去掉 App Group 权限（本地未签名构建用不到）。
    return raw.replace(
      /\s*<key>com\.apple\.security\.application-groups<\/key>\s*<array>[\s\S]*?<\/array>/,
      '',
    );
  }
  return raw.replaceAll('$(TeamIdentifierPrefix)', `${team}.`);
}

/**
 * entitlements 展开后的完整组 id（`<TeamID>.app.kepcup.desktop`）；没有 TeamID
 * 时为 null（此时 entitlements 里根本没有 App Group 权限，注入也没意义）。
 * Swift 侧注入 Info.plist 的值必须与它逐字一致（`containerURL` 的要求）。
 */
export function entitlementGroupId(team) {
  return team === null ? null : `${team}.${APP_GROUP_NAME}`;
}

/**
 * 把完整组 id 写进 plist 的 `SHARE_GROUP_PLIST_KEY` 键。PlistBuddy 的 `Set` 只改
 * 已有键、`Add` 只建新键——两个都试一次即幂等。注意：必须在 codesign 之前调用，
 * 签名后再改 Info.plist 会破坏签名。PlistBuddy 对不存在的文件会静默新建一个
 * 只含该键的 plist——这里显式拒绝（appex 缺 Info.plist 是结构错误，不是可修复项）。
 */
export function injectGroupIdIntoPlist(plistPath, groupId) {
  if (!fs.existsSync(plistPath)) {
    throw new Error(`App Group id 注入失败：${plistPath} 不存在（appex 结构不完整）`);
  }
  const commands = [
    `Set :${SHARE_GROUP_PLIST_KEY} ${groupId}`,
    `Add :${SHARE_GROUP_PLIST_KEY} string ${groupId}`,
  ];
  for (const command of commands) {
    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], {
      encoding: 'utf8',
    });
    if (result.status === 0) return;
  }
  throw new Error(`无法把 App Group id 写进 ${plistPath}（PlistBuddy Set/Add 都失败）`);
}

function buildArch(arch) {
  // xcodebuild 的架构名是 x86_64（不是 electron-builder 的 x64）——传 x64 会让
  // 构建设置里的 ARCHS 变成无效值，编译步骤被静默跳过、产物里没有可执行文件。
  const xcodeArch = arch === 'x64' ? 'x86_64' : arch;
  const derivedData = fs.mkdtempSync(path.join(os.tmpdir(), `kepcup-share-${arch}-`));
  try {
    log(`xcodebuild ${xcodeArch}`);
    execFileSync(
      'xcodebuild',
      [
        '-project',
        xcodeProject,
        '-scheme',
        'KepCupShare',
        '-configuration',
        'Release',
        '-arch',
        xcodeArch,
        '-derivedDataPath',
        derivedData,
        'build',
        'CODE_SIGNING_ALLOWED=NO',
      ],
      { stdio: 'inherit' },
    );
    const built = path.join(derivedData, 'Build', 'Products', 'Release', 'KepCupShare.appex');
    if (!fs.existsSync(built)) {
      throw new Error(`xcodebuild 未产出 ${built}`);
    }
    const target = path.join(outputRoot, arch, 'KepCupShare.appex');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(built, target, { recursive: true });
    return target;
  } finally {
    fs.rmSync(derivedData, { recursive: true, force: true });
  }
}

/** 签扩展：先签 appex，外层 app 之后由 electron-builder 签。 */
function signAppex(appexPath, identity, team) {
  const entitlementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepcup-share-ent-'));
  const entitlementsPath = path.join(entitlementDir, 'entitlements.plist');
  fs.writeFileSync(
    entitlementsPath,
    expandedEntitlements(fs.readFileSync(entitlementsTemplate, 'utf8'), team),
  );
  try {
    log(`codesign ${identity}`);
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        identity,
        '--entitlements',
        entitlementsPath,
        '--options',
        'runtime',
        '--timestamp',
        appexPath,
      ],
      { stdio: 'inherit' },
    );
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', appexPath], { stdio: 'inherit' });
  } finally {
    fs.rmSync(entitlementDir, { recursive: true, force: true });
  }
}

function main() {
  if (!hasXcode()) {
    warn('未找到 xcodebuild——跳过 Share Extension 构建（产物不带系统分享入口）。');
    return;
  }
  const arches = targetArches(process.argv.slice(2));
  const identity = signingIdentity();
  const team = teamId(identity);
  const groupId =
    process.env.KEPCUP_SHARE_GROUP_ID ?? (team ? `${team}.${APP_GROUP_NAME}` : APP_GROUP_NAME);
  // Swift 侧 `containerURL` 用的组 id 必须与 entitlements 展开值逐字一致：只在
  // 有 TeamID 时注入（无 TeamID 的构建 entitlements 里没有 App Group 权限）。
  const injectGroupId = entitlementGroupId(team);

  for (const arch of arches) {
    const appex = buildArch(arch);
    if (injectGroupId !== null) {
      injectGroupIdIntoPlist(path.join(appex, 'Contents', 'Info.plist'), injectGroupId);
    }
    if (identity !== null) {
      signAppex(appex, identity, team);
    } else {
      warn('钥匙串里没有 Developer ID Application 身份——扩展未签名（仅本地验证可用）。');
    }
    log(`产出 ${path.relative(appDir, appex)}`);
  }

  // 主进程靠这个文件知道 App Group 容器目录（容器名带 TeamID 前缀）。
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(
    path.join(outputRoot, 'group.json'),
    `${JSON.stringify({ groupId, groupName: APP_GROUP_NAME, teamId: team }, null, 2)}\n`,
  );
  log(`App Group：${groupId}`);
}

// 直接执行（node scripts/build-share-extension.mjs …）才跑构建；被测试 import 时不跑。
const invokedAsScript =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) main();
