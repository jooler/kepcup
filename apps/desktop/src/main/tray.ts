import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export interface TrayController {
  destroy(): void;
  /** Reflects unattended mode (P03): suffix in the tooltip + checkmark. */
  setUnattended(active: boolean): void;
  /** P13 任务 2: shows an update-ready hint in the tooltip. */
  setUpdateReady(version: string): void;
}

/**
 * Tray / menu-bar presence. Labels are duplicated from the renderer i18n
 * module on purpose: the main process has no dependency on renderer code.
 */
export function createTray(options: {
  onOpenWindow: () => void;
  onQuit: () => void;
  onToggleUnattended: () => void;
  onCheckUpdates: () => void;
}): TrayController {
  const isPackaged = app.isPackaged;
  const resourcesDir = isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources');
  const icon = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate.png'));
  icon.setTemplateImage(true);

  const tray = new Tray(icon);
  let unattended = false;
  let updateReadyVersion: string | null = null;

  const rebuild = () => {
    const suffix = [
      unattended ? '（无人值守模式开启）' : '',
      updateReadyVersion !== null ? `（新版本 ${updateReadyVersion} 待安装）` : '',
    ].join('');
    tray.setToolTip(`Kepcup${suffix}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开窗口', click: () => options.onOpenWindow() },
        { label: '检查更新…', click: () => options.onCheckUpdates() },
        { type: 'separator' },
        {
          label: unattended ? '关闭无人值守模式' : '开启无人值守模式',
          type: 'checkbox',
          checked: unattended,
          click: () => options.onToggleUnattended(),
        },
        { type: 'separator' },
        { label: '退出', click: () => options.onQuit() },
      ]),
    );
  };
  rebuild();
  tray.on('click', () => options.onOpenWindow());

  return {
    destroy() {
      tray.destroy();
    },
    setUnattended(active: boolean) {
      unattended = active;
      rebuild();
    },
    setUpdateReady(version: string) {
      updateReadyVersion = version;
      rebuild();
    },
  };
}
