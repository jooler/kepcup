#!/usr/bin/env node

/**
 * computer-use 编排层冒烟（D105 WP2 验收；P-B2：CuaDriver 是唯一 provider）。
 *
 *   node scripts/computer-orchestration-smoke.mjs [app-name]
 *
 * 起 Electron 宿主（computer-orchestration-smoke-host/）fork **真实 sidecar 产物**
 * （out/main/computer-sidecar.js），验证 main 编排层全链路：capabilities 握手、
 * listApps、getAppState（树 + diff + 截图可读性）、stop 清理 CuaDriver daemon。
 * 全部不经 core（core 侧的端到端在 WP4 验收）。
 *
 * 前置：`node scripts/fetch-cua-driver.mjs`（CuaDriver.app 产物）与
 * `pnpm --filter @kepcup/desktop build`（sidecar 产物）。
 * 首次使用需要给 KepCup（宿主）授予辅助功能 + 屏幕录制（embedded 模式 TCC 归宿主，
 * daemon 永不弹窗）；macOS 26+ 还需 direct-capture 同意（首次截图跳过并如实报
 * screenshot_failed）。一次性脚本，保留供上游 provider 升级时复验。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const electronBinary = path.join(
  path.dirname(createRequire(path.join(appDir, 'package.json')).resolve('electron/package.json')),
  'dist/Electron.app/Contents/MacOS/Electron',
);

function fail(message) {
  console.error(`[smoke2] ${message}`);
  process.exit(1);
}

if (!existsSync(electronBinary)) {
  fail(`Electron 二进制不存在：${electronBinary}（workspace 依赖未装好？）`);
}
if (!existsSync(path.join(appDir, 'out', 'main', 'computer-sidecar.js'))) {
  fail('sidecar 产物不存在：先 pnpm --filter @kepcup/desktop build');
}

const host = spawn(electronBinary, [path.join(scriptDir, 'computer-orchestration-smoke-host'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
host.on('exit', (code) => process.exit(code ?? 1));
