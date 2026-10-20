'use strict';

/**
 * 开发壳品牌补丁（仅 macOS，幂等，pnpm dev 自动执行）：
 *
 * dev 模式跑的是 node_modules 里 Electron 官方发行壳，CFBundleName 固定为
 * "Electron"——菜单栏应用名与 Dock hover 名称都会显示 Electron；打包版则由
 * electron-builder 的 productName 生成正确的 Info.plist。这里把 dev 壳改成
 * 同名（KepCup），开发期与打包后的系统级名称一致。
 *
 * 系统通知（Notification Center）里的应用图标取自 .app bundle 的 icns，而
 * app.dock.setIcon 只影响 Dock——不换壳内图标，dev 通知会一直显示 Electron
 * 的默认图标。因此这里把仓库的 icon.icns 拷进壳里并指向它。
 *
 * 修改 Info.plist / bundle 资源会使壳的现有签名失效（Apple Silicon 强制校验），
 * 必须重新 adhoc 签名。已是最新时直接跳过，避免每次 dev 都重签。
 * Windows/Linux 的 dev 任务栏名来自 electron(.exe) 文件名，不做替换（如需可把
 * dist 下的可执行文件拷贝改名后再启动）。
 */

const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

// electron 包在 Node 上下文里导出二进制路径：…/Electron.app/Contents/MacOS/Electron
const appBundle = path.resolve(path.dirname(require('electron')), '..', '..');
const bundleResources = path.join(appBundle, 'Contents', 'Resources');
const plist = path.join(appBundle, 'Contents', 'Info.plist');

const APP_NAME = 'KepCup';
const ICON_NAME = `${APP_NAME}.icns`;
const iconSource = path.resolve(__dirname, '..', 'resources', 'icon.icns');
const iconTarget = path.join(bundleResources, ICON_NAME);

function plistPrint(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function plistWrite(key, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
  }
}

const nameUpToDate =
  plistPrint('CFBundleName') === APP_NAME && plistPrint('CFBundleDisplayName') === APP_NAME;
const iconNameUpToDate = plistPrint('CFBundleIconFile') === ICON_NAME;
const iconFileUpToDate =
  existsSync(iconTarget) &&
  existsSync(iconSource) &&
  readFileSync(iconTarget).equals(readFileSync(iconSource));

if (nameUpToDate && iconNameUpToDate && iconFileUpToDate) {
  process.exit(0);
}

if (existsSync(iconSource) && !iconFileUpToDate) {
  copyFileSync(iconSource, iconTarget);
}
if (existsSync(iconTarget)) {
  plistWrite('CFBundleIconFile', ICON_NAME);
}
plistWrite('CFBundleName', APP_NAME);
plistWrite('CFBundleDisplayName', APP_NAME);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
console.log(
  `[dev-brand] dev 壳已更名为 ${APP_NAME}（名称/图标 + adhoc 重签，通知与 Dock 使用品牌图标）`,
);
