#!/usr/bin/env node
/**
 * 成品守卫（CI）：win/linux 打包产物的 CuaDriver 校验（三端启用修订）。
 *
 * pack-hooks 在打包阶段已校验一次；这里对 electron-builder 留下的 **最终解包目录**
 * 再确认一次——即使有人误加 KEPCUP_SKIP_COMPUTER_USE=1（pack-hooks 只警告不失败），
 * 发版也会挂在这里。darwin 的校验（codesign / TeamIdentifier）留在 release.yml
 * 的 mac 专属步骤里。
 *
 *   node scripts/release/verify-cua-driver-package.mjs --platform win  --arch x64
 *   node scripts/release/verify-cua-driver-package.mjs --platform linux --arch x64
 *
 * win：release/win-unpacked（x64）与 release/win-arm64-unpacked（arm64），按本次
 *      dist 参数应出现的目录必须存在；每个目录按自身 arch 的 lock key 校验。
 * linux：release/linux-unpacked（x64）/ release/linux-arm64-unpacked（arm64），同构，
 *      另加 wayland-helper/ 目录随包检查。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--platform' || argv[index] === '--arch') {
      out[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
    if (argv[index] === '--expect-both') {
      out.expectBoth = true;
    }
  }
  return out;
}

const { platform, arch, expectBoth } = parseArgs(process.argv.slice(2));
if (platform !== 'win' && platform !== 'linux') {
  fail(`unsupported --platform ${platform ?? '(missing)'} (this script covers win/linux; mac 在 release.yml 内联校验)`);
}
if (arch !== 'x64' && arch !== 'arm64') {
  fail(`unsupported --arch ${arch ?? '(missing)'}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..', '..');
const releaseDir = path.join(desktopDir, 'release');
const repoLock = JSON.parse(
  readFileSync(path.join(desktopDir, 'resources', 'cua-driver.lock.json'), 'utf8'),
);

/** 每个 unpacked 目录对应一个 arch；非默认 arch 目录带 -<arch>-unpacked 后缀。 */
function unpackedDirs() {
  if (!existsSync(releaseDir)) {
    fail(`release 目录不存在：${releaseDir}（先跑 dist）`);
  }
  const dirs = [];
  for (const entry of readdirSync(releaseDir)) {
    // 只认两种已知命名（electron-builder：默认 arch 无后缀，arm64 带 -arm64），
    // 未知命名跳过并提示，避免误分类。
    const dirArch =
      entry === `${platform}-unpacked` ? 'x64' : entry === `${platform}-arm64-unpacked` ? 'arm64' : null;
    if (dirArch === null) continue;
    dirs.push({ name: entry, dirArch, path: path.join(releaseDir, entry) });
  }
  const expected = arch === 'x64' ? `${platform}-unpacked` : `${platform}-arm64-unpacked`;
  if (!dirs.some((dir) => dir.name === expected)) {
    fail(`缺少 ${platform} ${arch} 的解包产物目录 ${expected}（dist 实际产物：${dirs.map((d) => d.name).join(', ') || '（无）'}）`);
  }
  if (expectBoth) {
    const other = arch === 'x64' ? `${platform}-arm64-unpacked` : `${platform}-unpacked`;
    if (!dirs.some((dir) => dir.name === other)) {
      fail(`--expect-both：缺少另一架构的解包产物目录 ${other}（合并构建两个 arch 都必须有驱动）`);
    }
  }
  return dirs;
}

let checked = 0;
for (const dir of unpackedDirs()) {
  const resourcesDir = path.join(dir.path, 'resources');
  const driverDir = path.join(resourcesDir, 'cua-driver');
  const lockPath = path.join(resourcesDir, 'cua-driver.lock.json');
  const key = `${platform}-${dir.dirArch}`;
  const executableRel = platform === 'win' ? 'cua-driver.exe' : 'cua-driver';

  if (!existsSync(lockPath)) fail(`[${dir.name}] cua-driver.lock.json 未随包（${lockPath}）`);
  if (!existsSync(driverDir)) fail(`[${dir.name}] CuaDriver 未随包（${driverDir}）`);
  const executablePath = path.join(driverDir, executableRel);
  if (!existsSync(executablePath)) fail(`[${dir.name}] cua-driver 可执行体缺失（${executablePath}）`);
  if (platform === 'linux' && !existsSync(path.join(driverDir, 'wayland-helper'))) {
    fail(`[${dir.name}] cua-driver 缺 wayland-helper/（Wayland 会话降级）`);
  }

  const packagedLock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (packagedLock.version !== repoLock.version) {
    fail(`[${dir.name}] 随包 lock 版本不一致：${packagedLock.version} ≠ ${repoLock.version}`);
  }
  const pinnedFiles = repoLock.assets?.[key]?.files ?? {};
  if (Object.keys(pinnedFiles).length === 0) {
    fail(`仓内 lock 没有 ${key} 资产条目`);
  }
  for (const [rel, pinned] of Object.entries(pinnedFiles)) {
    const filePath = path.join(driverDir, ...rel.split('/'));
    if (!existsSync(filePath)) fail(`[${dir.name}] 产物缺少 lock pin 的文件 ${rel}（${filePath}）`);
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (actual !== pinned) {
      fail(`[${dir.name}] ${rel} sha256 与 lock 不一致（${actual} ≠ ${pinned}）`);
    }
  }
  console.log(`[${dir.name}] CuaDriver OK：${key} ${repoLock.version}（${Object.keys(pinnedFiles).length} 个 pin 文件哈希一致）`);
  checked += 1;
}
if (checked === 0) fail('没有任何解包产物被校验');
console.log(`verify-cua-driver-package：${platform}-${arch} 全部通过（${checked} 个产物目录）。`);
