#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 移动端品牌图标生成（单一来源 apps/desktop/resources/KepCup.svg → iOS/Android）：
 *
 *   pnpm --filter @kepcup/mobile icons
 *
 * 产物直接落原生工程（全部入库）：
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/  iOS 单尺寸 1024（满幅无圆角）
 *   android res/mipmap 各密度目录                     legacy / round / 自适应前景
 *   android/app/src/main/res/values/ic_launcher_background.xml
 *
 * 渲染走仓库自带的 Electron 离屏壳（generate-icons-electron.cjs，机制同桌面
 * scripts/generate-icons.mjs）：Electron 二进制从 @kepcup/desktop 的依赖解析——
 * 移动端包自身零新增依赖。
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(scriptDir);
const repoDir = path.dirname(path.dirname(appDir));
const svgPath = path.join(repoDir, 'apps/desktop/resources/KepCup.svg');
const iosAppIconSetDir = path.join(appDir, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
const androidResDir = path.join(appDir, 'android/app/src/main/res');

if (!existsSync(svgPath)) throw new Error(`[icons] source SVG missing: ${svgPath}`);

const desktopRequire = createRequire(path.join(repoDir, 'apps/desktop/package.json'));
const electronBinary = desktopRequire('electron');

const renderer = path.join(scriptDir, 'generate-icons-electron.cjs');
console.log('[icons] rendering via offscreen Electron …');
const result = spawnSync(electronBinary, [renderer, svgPath, iosAppIconSetDir, androidResDir], {
  stdio: 'inherit',
});
if (result.status !== 0) throw new Error(`[icons] renderer failed (exit ${result.status})`);
console.log('[icons] done');
