import { join } from 'node:path';
import { app, nativeImage } from 'electron';

/**
 * 应用品牌常量与资源解析（P13 元数据统一）。
 *
 * - APP_NAME 是全部用户可见名称的唯一来源（窗口标题、托盘 tooltip、Linux
 *   autostart、Windows AUMID）；打包侧由 electron-builder productName
 *   （electron-builder.yml）保持一致，dev 侧由 app.setName + scripts/
 *   patch-dev-electron.cjs（改 dev 壳 Info.plist）对齐。
 * - 图标产物由 scripts/generate-icons.mjs 从 resources/KepCup.svg 生成：
 *   icon.png / icon.icns / icons/（Linux 尺寸集）与 tray/（托盘四件套）。
 */

/** User-facing name (window title, tray tooltip, notifications, autostart). */
export const APP_NAME = 'KepCup';

/** Bundle id / Windows AppUserModelId（与 electron-builder appId 一致）。 */
export const APP_ID = 'app.kepcup.desktop';

/**
 * 托盘资源目录：dev 读仓库 resources/tray；打包后由 extraResources 落在
 * <pkg>/Contents/Resources/tray（mac）或 <pkg>/resources/tray（win/linux）。
 */
export function trayIconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray', name)
    : join(__dirname, '../../resources/tray', name);
}

/**
 * 仓库主图标（1024）。仅 dev 用（Dock / win-linux 窗口图标）；打包版的
 * Dock/任务栏图标由 .app bundle（icns）与 exe 资源自带。macOS 用 Big Sur
 * 留白变体（icon-mac.png，与系统其它 Dock 图标视觉同大），win/linux 用满幅。
 */
export function appIconPath(): string {
  return join(
    __dirname,
    '../../resources',
    process.platform === 'darwin' ? 'icon-mac.png' : 'icon.png',
  );
}

/**
 * 托盘图：macOS 用黑/alpha template（菜单栏自动适配亮暗，@2x 由
 * nativeImage 按 DPI 自动选）；win/linux 任务栏不识别 template，用彩色品牌图。
 */
export function loadTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const icon = nativeImage.createFromPath(trayIconPath(isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) icon.setTemplateImage(true);
  return icon;
}
