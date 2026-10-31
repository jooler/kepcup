import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * 应用自有窗口是否开放 DevTools。
 *
 * 生产（已打包）构建一律关闭：终端用户不应能用菜单 / 快捷键检查或改写界面；
 * dev 与 e2e 跑的是未打包 Electron，保持可用。`app.isPackaged` 在进程生命周期
 * 内不变，读一次即可。
 *
 * 不影响 `webContents.debugger`（Bot 浏览器的 CDP 自动化）：调试器 API 与
 * DevTools 开关无关。
 */
export const DEVTOOLS_ENABLED = !app.isPackaged;

/**
 * 生产构建重建应用菜单，去掉 View 里的「Toggle Developer Tools」。
 *
 * 不能只把默认菜单里的条目设 `visible = false`：Cocoa 菜单在
 * `will-finish-launching` 时已经建好，隐藏条目仍保留 key equivalent
 *（macOS 的 Alt+Command+I），Windows/Linux 的 accelerator 表也不会随之重算。
 * 这里用与 Electron 默认菜单相同的模板重建一份、只是不包含 `toggleDevTools`，
 * 快捷键因此从一开始就不会被注册。`role: 'viewMenu'` 保留各平台本地化的
 *「View」标题与默认子菜单项，其余菜单与默认行为一致。
 */
export function installProductionAppMenu(): void {
  if (DEVTOOLS_ENABLED) return;
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
