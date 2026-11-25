#!/usr/bin/env node

/**
 * 下载 / 校验 pinned 的 cua-driver（trycua/cua，P-B1/P-B2，见 todo/computer-use-cua-adapter.md；
 * 2026-11 三端启用修订：同一 lock 同时 pin darwin / win / linux 资产）。
 *
 *   node scripts/fetch-cua-driver.mjs                      # 本机平台，缓存命中则跳过下载
 *   node scripts/fetch-cua-driver.mjs --os win --arch x64  # 交叉打包：取指定平台/架构
 *   node scripts/fetch-cua-driver.mjs --offline            # 只用缓存，缺缓存即失败（CI 离线复现）
 *   node scripts/fetch-cua-driver.mjs --record             # 下载后打印 lock 需要的哈希（升版时用）
 *
 * - 版本唯一事实来源：resources/cua-driver.lock.json（version / tag / assets["<os>-<arch>"]）。
 * - 缓存：~/.cache/kepcup/cua-driver/<version>/<asset>；产物输出
 *   apps/desktop/resources/cua-driver/<os>-<arch>/（gitignored）。darwin 是完整
 *   CuaDriver.app（裸二进制会被 AMFI SIGKILL，findings「架构级新发现 1」）；
 *   win/linux 是运行时目录（主二进制 + 同级 helper / SDK 库，必须同目录部署）。
 * - 校验失败（下载的压缩包 / 解包出的文件哈希不匹配 lock）直接失败，不「警告后继续」。
 * - win 资产是 zip（用 PowerShell Expand-Archive / unzip 解包），darwin/linux 是 tar.gz。
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(scriptDir, '..');
const lockPath = join(appDir, 'resources', 'cua-driver.lock.json');
const outputRoot = join(appDir, 'resources', 'cua-driver');
const cacheRoot = join(homedir(), '.cache', 'kepcup', 'cua-driver');

const SUPPORTED_OS = ['darwin', 'win', 'linux'];

const rawArgs = process.argv.slice(2);
const argv = new Set(rawArgs);
const offline = argv.has('--offline');
const record = argv.has('--record');

function argValue(name) {
  for (let index = 0; index < rawArgs.length; index += 1) {
    if (rawArgs[index] === name) {
      const value = rawArgs[index + 1];
      if (value === undefined || value.startsWith('-')) {
        fail(`${name} requires a value`);
      }
      return value;
    }
    if (rawArgs[index].startsWith(`${name}=`)) {
      const value = rawArgs[index].slice(name.length + 1);
      if (value.length === 0 || value.startsWith('-')) {
        fail(`${name} requires a value`);
      }
      return value;
    }
  }
  return null;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function fail(message) {
  console.error(`fetch-cua-driver: ${message}`);
  process.exit(1);
}

function hostOs() {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'linux') return 'linux';
  return null;
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const requestedOs = argValue('--os');
const os = requestedOs ?? hostOs();
if (!os || !SUPPORTED_OS.includes(os)) {
  fail(`unsupported --os ${requestedOs ?? '(host)'} (expected ${SUPPORTED_OS.join(' / ')})`);
}
const requestedArch = argValue('--arch');
if (requestedArch !== null && requestedArch !== 'arm64' && requestedArch !== 'x64') {
  fail(`unsupported --arch ${requestedArch} (expected arm64 or x64)`);
}
const arch = requestedArch ?? (process.arch === 'x64' ? 'x64' : 'arm64');
const assetKey = `${os}-${arch}`;
const asset = lock.assets[assetKey];
if (!asset) fail(`lock file has no ${assetKey} asset`);

const isDarwin = os === 'darwin';
const isZip = asset.asset.endsWith('.zip');
const mainExecutableRel = isDarwin
  ? 'CuaDriver.app/Contents/MacOS/cua-driver'
  : os === 'win'
    ? 'cua-driver.exe'
    : 'cua-driver';

const cacheDir = join(cacheRoot, lock.version);
const cacheArchive = join(cacheDir, asset.asset);
const outputDir = join(outputRoot, assetKey);
const pinnedFiles = asset.files ?? {};
const pinnedExecutableSha = pinnedFiles[mainExecutableRel];

const allPinnedFilesValid =
  validSha256(pinnedExecutableSha) &&
  Object.entries(pinnedFiles).every(([rel, sha]) => {
    const path = join(outputDir, ...rel.split('/'));
    return validSha256(sha) && existsSync(path) && sha256File(path) === sha;
  });
const alreadyExtracted =
  allPinnedFilesValid &&
  (!isDarwin || existsSync(join(outputDir, 'CuaDriver.app', 'Contents', 'Info.plist')));

if (alreadyExtracted && !record) {
  console.log(`fetch-cua-driver: ${assetKey} ${lock.version} already up to date at ${outputDir}`);
  process.exit(0);
}

if (!existsSync(cacheArchive) || sha256File(cacheArchive) !== asset.assetSha256) {
  if (offline) {
    fail(`--offline: no valid cached archive for ${asset.asset} (expected sha256 ${asset.assetSha256})`);
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
  const partial = `${cacheArchive}.partial`;
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
    fail(`downloaded archive sha256 mismatch: got ${actual}, want ${asset.assetSha256}`);
  }
  rmSync(cacheArchive, { force: true });
  renameSync(partial, cacheArchive);
}

// 解包到临时目录再原子换入，避免半成品被当成已安装产物。
// staging 必须在 outputDir 之外（换入前会 rm 掉 outputDir 整棵树）。
const staging = join(cacheDir, `.staging-${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
if (isZip) {
  // zip 成员路径没有 tar 那样的「拒绝绝对路径 / ..」预检闸（Expand-Archive /
  // unzip 无统一列目录接口）：安全性由压缩包的 assetSha256 pin 兜底（上游资产
  // 哈希匹配后内容即固定），解包后还有 realpath 包含性第二道闸。
  expandArchive(cacheArchive, staging);
} else {
  // win32 宿主的 GNU tar（Git Bash / MSYS）会把 `C:\…` 当远程主机；bsdtar 也认
  // 这个旗标（libarchive 3.3+），统一加上避免 PATH 上 tar 实现差异。
  const tarArgs = process.platform === 'win32' ? ['--force-local'] : [];
  // 第一道闸：拒绝绝对路径 / '..' 成员，防止 tarball 逃逸 staging。
  const archiveEntries = execFileSync('tar', [...tarArgs, '-tzf', cacheArchive], { encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry.length > 0);
  for (const entry of archiveEntries) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      fail(`release archive contains an unsafe path: ${entry}`);
    }
  }
  try {
    // 用 cwd 而不是 -C：win32 宿主可能解析到 MSYS GNU tar，它会把 `-C C:\…`
    // 里的盘符冒号当远程主机分隔符转义（"Cannot connect to C: resolve failed"），
    // 相对路径 + 进程 cwd 对三种 tar 实现（GNU/bsdtar/MSYS）都安全。
    execFileSync('tar', [...tarArgs, '-xzf', cacheArchive, '--no-same-owner'], { cwd: staging });
  } catch (error) {
    fail(`tar extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// 压缩包顶层可能带版本前缀目录（cua-driver-rs-<v>-<os>-<arch>/…）。
const stagedRuntime = isDarwin ? findCuaDriverBundle(staging) : findRuntimeRoot(staging, mainExecutableRel);
if (!stagedRuntime) {
  fail(
    isDarwin
      ? 'release archive did not contain CuaDriver.app (bundle form is required; see findings)'
      : `release archive did not contain ${mainExecutableRel}`
  );
}
// 第二道闸：解包结果必须仍在 staging 内，且可执行文件是普通文件（非符号链接）。
const realStaging = realpathSync(staging);
const realStagedRuntime = realpathSync(stagedRuntime);
if (!realStagedRuntime.startsWith(`${realStaging}${sep}`)) {
  fail('release archive escaped the staging directory');
}
// findCuaDriverBundle 返回 CuaDriver.app 本身；lock 与 mainExecutableRel
// 则以运行时根为基准（前缀 CuaDriver.app/）。win/linux 的 stagedRuntime 就是运行时根。
function pathFromRuntimeRoot(rel) {
  if (isDarwin) {
    const prefix = 'CuaDriver.app/';
    if (!rel.startsWith(prefix)) {
      fail(`darwin 路径必须位于 CuaDriver.app/ 下：${rel}`);
    }
    return join(stagedRuntime, ...rel.slice(prefix.length).split('/'));
  }
  return join(stagedRuntime, ...rel.split('/'));
}
const stagedExecutable = pathFromRuntimeRoot(mainExecutableRel);
if (!lstatSync(stagedExecutable).isFile()) {
  fail('cua-driver executable is not a regular file');
}
const executableSha = sha256File(stagedExecutable);
if (record) {
  console.log(
    JSON.stringify(
      {
        version: lock.version,
        assetSha256: sha256File(cacheArchive),
        files: recordFileHashes(stagedRuntime, mainExecutableRel, executableSha),
      },
      null,
      2
    )
  );
} else if (!validSha256(pinnedExecutableSha)) {
  fail(
    `lock file has no pinned executable sha256 for ${assetKey}; ` +
      'run with --record and commit the value'
  );
} else {
  for (const [rel, sha] of Object.entries(pinnedFiles)) {
    const path = pathFromRuntimeRoot(rel);
    if (!validSha256(sha)) {
      fail(`lock file has no valid pinned sha256 for ${rel}; run with --record and commit the value`);
    }
    if (!existsSync(path)) {
      fail(`release archive is missing pinned file ${rel}`);
    }
    const actual = sha256File(path);
    if (actual !== sha) {
      fail(`extracted file sha256 mismatch for ${rel}: got ${actual}, want ${sha}`);
    }
  }
}
if (!isZip) {
  chmodSync(stagedExecutable, 0o755);
}
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
if (isDarwin) {
  movePath(stagedRuntime, join(outputDir, 'CuaDriver.app'));
} else {
  for (const entry of readdirSync(stagedRuntime)) {
    movePath(join(stagedRuntime, entry), join(outputDir, entry));
  }
}
rmSync(staging, { recursive: true, force: true });
console.log(`fetch-cua-driver: installed ${lock.version} ${assetKey} -> ${outputDir}`);

/** zip 解包：win32 用 PowerShell（CI 无 unzip 保证），其余用 unzip。 */
function expandArchive(archivePath, destDir) {
  if (process.platform === 'win32') {
    // PowerShell 单引号字符串里 `'` 用 `''` 转义（宿主用户目录可能含撇号，
    // 如 O'Brien——裸拼会让解包必然失败）。
    const escapePsSingleQuoted = (value) => value.replace(/'/g, "''");
    const command =
      `Expand-Archive -LiteralPath '${escapePsSingleQuoted(archivePath)}' ` +
      `-DestinationPath '${escapePsSingleQuoted(destDir)}' -Force`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: 'inherit',
      });
    } catch (error) {
      fail(`Expand-Archive failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  try {
    execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'inherit' });
  } catch (error) {
    fail(`unzip failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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

/** 在解包目录里找 win/linux 运行时根（顶层或版本前缀子目录，主二进制在根上）。 */
function findRuntimeRoot(fromDir, executableRel) {
  const executableParts = executableRel.split('/');
  if (existsSync(join(fromDir, ...executableParts))) {
    return fromDir;
  }
  for (const entry of readdirSync(fromDir)) {
    const candidate = join(fromDir, entry);
    if (!statSync(candidate).isDirectory()) {
      continue;
    }
    if (existsSync(join(candidate, ...executableParts))) {
      return candidate;
    }
  }
  return null;
}

/**
 * --record：收集 lock.files 需要的哈希。主二进制必有；win/linux 附带运行时根上
 * 的全部顶层普通文件（helper / SDK 库），darwin 附带 bundle 内主二进制。
 */
function recordFileHashes(runtimeRoot, executableRel, executableSha) {
  const files = { [executableRel]: executableSha };
  if (isDarwin) {
    return files;
  }
  for (const entry of readdirSync(runtimeRoot)) {
    const path = join(runtimeRoot, entry);
    if (lstatSync(path).isFile()) {
      files[entry] = sha256File(path);
    }
  }
  return files;
}

/** rename 优先（同盘原子），跨盘回退 cp+rm（Windows 上 cache 与 worktree 可不同盘）。 */
function movePath(fromPath, toPath) {
  try {
    renameSync(fromPath, toPath);
  } catch {
    cpSync(fromPath, toPath, { recursive: true });
    rmSync(fromPath, { recursive: true, force: true });
  }
}
