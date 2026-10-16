import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  type BrowserWindowConstructorOptions,
} from 'electron';
import { APP_NAME, appIconPath } from './app-brand';
import {
  captureWindowState,
  loadWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  resolveWindowOptions,
  saveWindowState,
  WINDOW_STATE_FILE,
} from './window-state';

export interface MainWindowOptions {
  preloadPath: string;
  isQuitting: () => boolean;
}

const SAVE_DEBOUNCE_MS = 400;

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: options.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };

  const statePath = join(app.getPath('userData'), WINDOW_STATE_FILE);
  const saved = loadWindowState(statePath);
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const resolved = resolveWindowOptions(saved, displays, {
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
  });

  const win = new BrowserWindow({
    width: resolved.width,
    height: resolved.height,
    ...(resolved.x !== undefined && resolved.y !== undefined
      ? { x: resolved.x, y: resolved.y }
      : {}),
    // 允许窄到手机宽度（375）：扩展中心等弹框在小窗口仍可用，不再按桌面布局设下限。
    // 窄屏形态在 <640 进入（≥680 退出，滞回）；680~959 的宽屏三栏区间不再有 960 的下限兜底，
    // 由渲染端保证聊天区可用宽度：侧栏宽度按窗口夹取、放不下并排右栏时 Bot 详情改走全屏覆盖层
    //（renderer sidebar-layout.ts 的 WIDE_CHAT_MIN_WIDTH / rightPanelFits）。
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: APP_NAME,
    // win/linux：dev 窗口图标继承 electron.exe 的通用图标，任务栏/Alt-Tab 会
    // 显示错误品牌，显式指定仓库主图标；打包版由 exe 资源自带，无需设置
    //（macOS 窗口无独立图标概念，走 bundle 图标）。
    ...(process.platform !== 'darwin' && !app.isPackaged
      ? { icon: nativeImage.createFromPath(appIconPath()) }
      : {}),
    autoHideMenuBar: true,
    // macOS: hide the native title bar but keep the system traffic lights
    // inset over the content — the window keeps its native border, rounded
    // corners and shadow; the sidebar header doubles as the drag region.
    // Vibrancy: a native sidebar-material blur sits behind the web contents
    // (the frosted-glass look). The renderer keeps html/body transparent and
    // paints only the sidebar translucent so the material shows through there
    // (app.css "vibrancy" block); everything else stays opaque.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {}),
    webPreferences,
  });

  if (resolved.maximized) {
    win.maximize();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    const state = captureWindowState(win);
    if (!state) return;
    try {
      saveWindowState(statePath, state);
    } catch {
      // Disk full / permissions — next successful save will overwrite.
    }
  };

  const persistSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, SAVE_DEBOUNCE_MS);
  };

  const persistNow = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persist();
  };

  win.on('resize', persistSoon);
  win.on('move', persistSoon);
  win.on('maximize', persistSoon);
  win.on('unmaximize', persistSoon);

  win.on('ready-to-show', () => win.show());

  // Tray-resident: closing the window only hides it (02-architecture.md).
  // Persist before hide/destroy so the next show/launch restores this frame.
  win.on('close', (event) => {
    persistNow();
    if (!options.isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  // Local content only; no remote navigation or window.open.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
