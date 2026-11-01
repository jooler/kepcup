#!/usr/bin/env node

/**
 * computer-use 独立冒烟（D105 WP1，M1 前半；todo/computer-use.md WP1「独立冒烟」）。
 *
 *   node scripts/computer-use-smoke.mjs [app-name]
 *   node scripts/computer-use-smoke.mjs --permissions   # 打开 helper 的权限引导窗口
 *
 * 不经 KepCup main / core：起一个 Electron 主进程宿主（computer-use-smoke-host/，
 * dev 壳身份 com.github.Electron，模拟 KepCup dev 拓扑），由它拉起 vendored helper
 * （`--agent` unix-socket 模式）并 fork 冒烟客户端（computer-use-smoke-client/），
 * 依次 handshake / listApps / getAppState（含截图），验证 socket 通路与 TCC 行为。
 * 宿主/客户端的目录结构与文件名都是 helper peer 校验的要求，勿重命名。
 *
 * 首次运行 getAppState 会 permission_denied：系统要求给「KepCup Computer Use」
 * （不是主应用）授予辅助功能 + 屏幕录制。用 --permissions 走引导或在系统设置里
 * 手动授权后重跑。
 *
 * 一次性脚本：WP2 移植完 main 编排层后，冒烟改走 `computer.invoke`，本脚本退役
 * （保留供上游 helper 版本升级时的最小验证）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const helperExecutable = path.join(
  appDir,
  'resources/computer-use/darwin-arm64/KepCup Computer Use.app/Contents/MacOS/orca-computer-use-macos',
);
const electronBinary = path.join(
  path.dirname(createRequire(path.join(appDir, 'package.json')).resolve('electron/package.json')),
  'dist/Electron.app/Contents/MacOS/Electron',
);

function fail(message) {
  console.error(`[smoke] ${message}`);
  process.exit(1);
}

if (!existsSync(helperExecutable)) {
  fail(`helper 未构建：${helperExecutable} 不存在——先跑 node scripts/build-computer-use-macos.mjs`);
}
if (!existsSync(electronBinary)) {
  fail(`Electron 二进制不存在：${electronBinary}（workspace 依赖未装好？）`);
}

const args = process.argv.slice(2);
if (args[0] === '--permissions') {
  // helper 的前台权限引导窗口（沿 orca setup flow）：打开系统设置的 TCC 面板。
  const result = spawnSync(helperExecutable, ['--permissions'], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

const host = spawn(electronBinary, [path.join(scriptDir, 'computer-use-smoke-host'), ...args], {
  stdio: 'inherit',
});
host.on('exit', (code) => process.exit(code ?? 1));
