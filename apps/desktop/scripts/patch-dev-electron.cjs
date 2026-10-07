'use strict';

/**
 * 开发壳品牌补丁（仅 macOS，幂等，pnpm dev 自动执行）：
 *
 * dev 模式跑的是 node_modules 里 Electron 官方发行壳，CFBundleName 固定为
 * "Electron"——菜单栏应用名与 Dock hover 名称都会显示 Electron；打包版则由
 * electron-builder 的 productName 生成正确的 Info.plist。这里把 dev 壳改成
 * 同名（KepCup），开发期与打包后的系统级名称一致。
 *
 * 修改 Info.plist 会使壳的现有签名失效（Apple Silicon 强制校验），必须重新
 * adhoc 签名。Windows/Linux 的 dev 任务栏名来自 electron(.exe) 文件名，不做
 * 替换（如需可把 dist 下的可执行文件拷贝改名后再启动）。
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'darwin') process.exit(0);

// electron 包在 Node 上下文里导出二进制路径：…/Electron.app/Contents/MacOS/Electron
const appBundle = path.resolve(path.dirname(require('electron')), '..', '..');
const plist = path.join(appBundle, 'Contents', 'Info.plist');

const APP_NAME = 'KepCup';

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

if (plistPrint('CFBundleName') === APP_NAME && plistPrint('CFBundleDisplayName') === APP_NAME) {
  process.exit(0);
}

plistWrite('CFBundleName', APP_NAME);
plistWrite('CFBundleDisplayName', APP_NAME);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
console.log(`[dev-brand] dev 壳已更名为 ${APP_NAME}（CFBundleName/DisplayName + adhoc 重签）`);
