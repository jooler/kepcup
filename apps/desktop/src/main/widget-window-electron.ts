import { BrowserWindow } from 'electron';
import { DEVTOOLS_ENABLED } from './devtools';
import type {
  WidgetWindowCreateInput,
  WidgetWindowLike,
} from './widget-window';

/**
 * 组件窗口的 Electron 装配（widget-window.md §4.2；纯逻辑在 widget-window.ts，
 * 拆文件是因为主进程单测约定：被测模块不得 import electron 运行时）。
 *
 * webPreferences 与主窗口同款（同 preload / sandbox / contextIsolation / 无
 * nodeIntegration）——组件窗口是「另一个主窗口」，不是降权的查看器。iframe 沙箱
 * （kepcup-app 协议 + opaque origin + 权限白名单）跟随 default session，全部照常。
 */
export function createWidgetWindow(input: WidgetWindowCreateInput): WidgetWindowLike {
  const win = new BrowserWindow({
    width: input.width,
    height: input.height,
    minWidth: input.minWidth,
    minHeight: input.minHeight,
    useContentSize: true,
    show: false,
    autoHideMenuBar: true,
    title: input.title,
    webPreferences: {
      preload: input.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: DEVTOOLS_ENABLED,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 主框架不许跳离渲染入口（payload 靠 did-finish-load 重放，跳走即失效）；
  // kepcup-app 子框架的导航拦截由 guardAllAppFrames 全局兜底。
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => input.onDidLoad(win));
  win.once('ready-to-show', () => win.show());
  if (input.target.kind === 'url') void win.loadURL(input.target.url);
  else void win.loadFile(input.target.path, { query: input.target.query });
  return win;
}
