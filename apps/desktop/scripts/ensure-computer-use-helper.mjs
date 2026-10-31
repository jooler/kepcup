#!/usr/bin/env node

/**
 * 确保 macOS computer-use helper .app 已构建（D105，pnpm dev 前置步骤）。
 *
 *   node scripts/ensure-computer-use-helper.mjs [--rebuild]
 *
 * 产物 `resources/computer-use/darwin-<arch>/KepCup Computer Use.app` 是 gitignored
 * 的构建产物（build-computer-use-macos.mjs 生成）：新 clone 首次 `pnpm dev` 会自动
 * 补建一次；已有产物直接复用，不重复构建。`--rebuild` 先删旧产物再重建，用于改了
 * vendored 源码（native/computer-use-macos/）或构建脚本后强制刷新。
 *
 * dev 产物只需要稳定签名、不需要公证：Gatekeeper/公证只拦带 quarantine 属性的
 * 下载产物，本机 SwiftPM 构建没有 quarantine；TCC 授权按（bundle id + Developer ID
 * 签名）记账，同身份重签不丢授权。公证只发生在发版打包（docs/dev/06-release.md），
 * helper 作为嵌套代码随外层 .app 一起被 notarytool 校验。
 *
 * 非 darwin 平台、或设置了 KEPCUP_SKIP_COMPUTER_USE=1（与 pack-hooks.cjs 的打包
 * 硬校验同名豁免）直接跳过——没有 Swift 工具链的机器也能正常 dev，只是计算机
 * 操控能力不可用。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);

// 与 build-computer-use-macos.mjs 的常量保持一致（那边硬编码，不设 env 覆盖）。
const executableName = 'orca-computer-use-macos';
const displayName = 'KepCup Computer Use';

const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const appPath = path.join(
  appDir,
  'resources',
  'computer-use',
  `darwin-${arch}`,
  `${displayName}.app`,
);

function log(message) {
  console.log(`[computer-use] ${message}`);
}

if (process.platform !== 'darwin') {
  // computer-use 是 macOS P0 能力，其他平台没有 native provider，无需产物。
  process.exit(0);
}

if (process.env.KEPCUP_SKIP_COMPUTER_USE === '1') {
  log('KEPCUP_SKIP_COMPUTER_USE=1，跳过 helper 产物检查');
  process.exit(0);
}

const rebuild = process.argv.includes('--rebuild');
if (rebuild) {
  log(`--rebuild：删除旧产物 ${path.relative(appDir, appPath)}`);
  rmSync(appPath, { recursive: true, force: true });
} else if (existsSync(path.join(appPath, 'Contents', 'MacOS', executableName))) {
  log(`helper 已存在，复用：${path.relative(appDir, appPath)}`);
  process.exit(0);
} else {
  log('helper .app 未构建，首次构建约 30 秒（之后 dev 直接复用）…');
}

const build = spawnSync(process.execPath, [path.join(scriptDir, 'build-computer-use-macos.mjs')], {
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error(
    `[computer-use] helper 构建失败（exit ${build.status}），计算机操控将不可用。` +
      '需要 Xcode/Swift 工具链；设置 KEPCUP_SKIP_COMPUTER_USE=1 可跳过本检查继续 dev。',
  );
  process.exit(build.status ?? 1);
}
