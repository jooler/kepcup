#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 品牌图标生成（单一来源 resources/KepCup.svg → 全平台图标产物）：
 *
 *   pnpm --filter @kepcup/desktop icons
 *
 * 产物（全部入库，electron-builder 直接引用，见 electron-builder.yml）：
 *   resources/icon.png                       1024 满幅圆角母图（win ico 转换源、
 *                                            dev 的 win/linux 窗口图标）
 *   resources/icon-mac.png                   1024 macOS 变体（Big Sur 网格：图形
 *                                            占 824/1024、四周留白）→ dev 的 Dock 图标
 *   resources/icon.icns                      macOS（icp4…ic10 + @2x 组，PNG 载荷，
 *                                            取自留白变体；darwin 上用 iconutil 反解校验）
 *   resources/icons/{n}x{n}.png              Linux hicolor 尺寸集（deb/AppImage）
 *   resources/tray/trayTemplate{,@2x}.png    macOS 菜单栏黑/alpha template（气泡剪影）
 *   resources/tray/tray{,@2x}.png            win/linux 托盘彩色品牌图
 *
 * 渲染走仓库自带的 Electron 离屏壳（generate-icons-electron.cjs）：零新增依赖，
 * 矢量按目标尺寸逐个栅格化，小尺寸笔画边缘锐利。
 */

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const resourcesDir = path.join(appDir, 'resources');
const svgPath = path.join(resourcesDir, 'KepCup.svg');

if (!existsSync(svgPath)) throw new Error(`[icons] source SVG missing: ${svgPath}`);
for (const rel of ['icons', 'tray']) {
  rmSync(path.join(resourcesDir, rel), { recursive: true, force: true });
}

// electron 包在 Node 上下文里导出 Electron 二进制路径。
const electronBinary = require('electron');
const renderer = path.join(scriptDir, 'generate-icons-electron.cjs');
console.log('[icons] rendering via offscreen Electron …');
const result = spawnSync(electronBinary, [renderer, resourcesDir, svgPath], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`[icons] renderer failed (exit ${result.status})`);

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const EXPECTED = [
  ['icon.png', 1024, 1024],
  ['icon-mac.png', 1024, 1024],
  ...[16, 24, 32, 48, 64, 96, 128, 256, 512].map((n) => [`icons/${n}x${n}.png`, n, n]),
  ['tray/trayTemplate.png', 26, 20],
  ['tray/trayTemplate@2x.png', 52, 40],
  ['tray/tray.png', 44, 44],
  ['tray/tray@2x.png', 88, 88],
];

let failed = false;
for (const [rel, width, height] of EXPECTED) {
  const file = path.join(resourcesDir, rel);
  const ok = existsSync(file) && statSync(file).size > 0;
  if (!ok) {
    console.error(`[icons] MISSING ${rel}`);
    failed = true;
    continue;
  }
  const size = pngSize(file);
  if (size.width !== width || size.height !== height) {
    console.error(
      `[icons] BAD SIZE ${rel}: ${size.width}x${size.height} (want ${width}x${height})`,
    );
    failed = true;
    continue;
  }
  console.log(`[icons] ok ${rel} (${width}x${height})`);
}

// icns：头部结构校验 +（darwin）iconutil 反解 = NSImage 可读性的强验证。
const icnsPath = path.join(resourcesDir, 'icon.icns');
const icns = readFileSync(icnsPath);
if (icns.subarray(0, 4).toString('ascii') !== 'icns' || icns.readUInt32BE(4) !== icns.length) {
  console.error('[icons] BAD icon.icns (header/length mismatch)');
  failed = true;
} else if (process.platform === 'darwin') {
  const probe = path.join(tmpdir(), `kepcup-icons-probe-${process.pid}.iconset`);
  rmSync(probe, { recursive: true, force: true });
  execFileSync('/usr/bin/iconutil', ['-c', 'iconset', '-o', probe, icnsPath]);
  rmSync(probe, { recursive: true, force: true });
  console.log('[icons] ok icon.icns (iconutil roundtrip passed)');
}
if (failed) throw new Error('[icons] validation failed');

// 旧版托盘图（根目录 16px 方形占位）已被 tray/ 目录取代。
for (const legacy of ['trayTemplate.png', 'trayTemplate@2x.png']) {
  const file = path.join(resourcesDir, legacy);
  if (existsSync(file)) {
    rmSync(file);
    console.log(`[icons] removed legacy ${legacy} (superseded by tray/)`);
  }
}
console.log('[icons] done');
