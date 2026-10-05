import { join } from 'node:path';
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

export interface MainWindowOptions {
  preloadPath: string;
  isQuitting: () => boolean;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: options.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Kepcup',
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

  win.on('ready-to-show', () => win.show());

  // Tray-resident: closing the window only hides it (02-architecture.md).
  win.on('close', (event) => {
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
