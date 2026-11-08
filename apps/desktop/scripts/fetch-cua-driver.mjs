#!/usr/bin/env node

/**
 * 下载 / 校验 pinned 的 cua-driver（trycua/cua，P-B1，见 todo/computer-use-cua-adapter.md WP1）。
 *
 *   node scripts/fetch-cua-driver.mjs                 # 缓存命中则跳过下载，解包到 resources/
 *   node scripts/fetch-cua-driver.mjs --offline       # 只用缓存，缺缓存即失败（CI 离线复现）
 *   node scripts/fetch-cua-driver.mjs --record        # 下载后打印 lock 文件需要的哈希（升版时用）
 *
 * - 版本唯一事实来源：resources/cua-driver.lock.json（version / tag / asset / sha256）。
 * - 缓存：~/.cache/kepcup/cua-driver/<version>/<asset>；产物输出
 *   apps/desktop/resources/cua-driver/<os>-<arch>/CuaDriver.app（gitignored）。
 * - 校验失败（下载的 tarball / 解包出的可执行文件哈希不匹配 lock）直接失败，不「警告后继续」。
 * - 非 darwin 直接 exit 0（本期只验 macOS；win/linux 启用是 P-B2）。
 * - 必须以完整 CuaDriver.app bundle 形态落盘：裸二进制会被 AMFI SIGKILL（签名校验需要
 *   bundle 内的 Info.plist），findings「架构级新发现 1」。
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(scriptDir, '..');
const lockPath = join(appDir, 'resources', 'cua-driver.lock.json');
const outputRoot = join(appDir, 'resources', 'cua-driver');
const cacheRoot = join(homedir(), '.cache', 'kepcup', 'cua-driver');

const argv = new Set(process.argv.slice(2));
const offline = argv.has('--offline');
const record = argv.has('--record');

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fail(message) {
  console.error(`fetch-cua-driver: ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  // P-B1 只验 macOS；win/linux 打包随 P-B2 打开。
  process.exit(0);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const asset = lock.assets[`darwin-${arch}`];
if (!asset) fail(`lock file has no darwin-${arch} asset`);

const cacheDir = join(cacheRoot, lock.version);
const cacheTarball = join(cacheDir, asset.asset);
const outputDir = join(outputRoot, `darwin-${arch}`);
const outputApp = join(outputDir, 'CuaDriver.app');
const outputExecutable = join(outputApp, 'Contents', 'MacOS', 'cua-driver');

const alreadyExtracted =
  existsSync(outputExecutable) &&
  existsSync(join(outputApp, 'Contents', 'Info.plist')) &&
  (asset.files['CuaDriver.app/Contents/MacOS/cua-driver'] ?? '') !== 'PENDING' &&
  sha256File(outputExecutable) === asset.files['CuaDriver.app/Contents/MacOS/cua-driver'];

if (alreadyExtracted && !record) {
  console.log(`fetch-cua-driver: darwin-${arch} ${lock.version} already up to date at ${outputDir}`);
  process.exit(0);
}

if (!existsSync(cacheTarball) || sha256File(cacheTarball) !== asset.assetSha256) {
  if (offline) {
    fail(`--offline: no valid cached tarball for ${asset.asset} (expected sha256 ${asset.assetSha256})`);
  }
  if ((asset.assetSha256 ?? '') === 'PENDING') {
    fail(
      'lock file hashes are PENDING; run with --record after filling version/tag, ' +
        'or fill assetSha256 from the release checksums.txt'
    );
  }
  const url = `https://github.com/${lock.repository}/releases/download/${lock.tag}/${asset.asset}`;
  console.log(`fetch-cua-driver: downloading ${url}`);
  mkdirSync(cacheDir, { recursive: true });
  const partial = `${cacheTarball}.partial`;
  try {
    execFileSync(
      'curl',
      ['-fL', '--retry', '3', '--retry-delay', '2', '-o', partial, url],
      { stdio: 'inherit' }
    );
  } catch {
    rmSync(partial, { force: true });
    fail(`download failed: ${url}`);
  }
  const actual = sha256File(partial);
  if (actual !== asset.assetSha256) {
    rmSync(partial, { force: true });
    fail(`downloaded tarball sha256 mismatch: got ${actual}, want ${asset.assetSha256}`);
  }
  rmSync(cacheTarball, { force: true });
  renameSync(partial, cacheTarball);
}

// 解包到临时目录再原子换入，避免半成品被当成已安装产物。
// staging 必须在 outputDir 之外（换入前会 rm 掉 outputDir 整棵树）。
const staging = join(cacheDir, `.staging-${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
try {
  execFileSync('tar', ['-xzf', cacheTarball, '-C', staging]);
} catch (error) {
  fail(`tar extraction failed: ${error instanceof Error ? error.message : String(error)}`);
}
// tarball 顶层可能带版本前缀目录（cua-driver-rs-<v>-darwin-<arch>/CuaDriver.app）。
const stagedApp = findCuaDriverBundle(staging);
if (!stagedApp) {
  fail('release tarball did not contain CuaDriver.app (bundle form is required; see findings)');
}
const stagedExecutable = join(stagedApp, 'Contents', 'MacOS', 'cua-driver');
const executableSha = sha256File(stagedExecutable);
const pinnedExecutableSha = asset.files['CuaDriver.app/Contents/MacOS/cua-driver'];
if (record) {
  console.log(JSON.stringify({ version: lock.version, assetSha256: sha256File(cacheTarball), executableSha256: executableSha }, null, 2));
}
if (pinnedExecutableSha !== 'PENDING' && executableSha !== pinnedExecutableSha) {
  fail(`extracted executable sha256 mismatch: got ${executableSha}, want ${pinnedExecutableSha}`);
}
chmodSync(stagedExecutable, 0o755);
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
execFileSync('mv', [stagedApp, outputApp]);
rmSync(staging, { recursive: true, force: true });
console.log(`fetch-cua-driver: installed ${lock.version} darwin-${arch} -> ${outputApp}`);

/** 在解包目录里找 CuaDriver.app（顶层或版本前缀子目录）。 */
function findCuaDriverBundle(fromDir) {
  const direct = join(fromDir, 'CuaDriver.app');
  if (existsSync(join(direct, 'Contents', 'MacOS', 'cua-driver'))) {
    return direct;
  }
  for (const entry of readdirSync(fromDir)) {
    const candidate = join(fromDir, entry, 'CuaDriver.app');
    if (existsSync(join(candidate, 'Contents', 'MacOS', 'cua-driver'))) {
      return candidate;
    }
  }
  return null;
}
