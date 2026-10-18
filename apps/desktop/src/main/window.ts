import { release } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
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

/**
 * Windows 11 22H2+（build 22621）才有 DWM 亚克力材质，低版本下 backgroundMaterial
 * 会被 Electron 静默忽略，需按 build 号判定。os.release() 返回 "10.0.22631" 形态。
 */
function windowsBackdropMaterial(): 'acrylic' | 'opaque' {
  if (process.platform !== 'win32') return 'opaque';
  const build = Number.parseInt(release().split('.')[2] ?? '', 10);
  return Number.isFinite(build) && build >= 22621 ? 'acrylic' : 'opaque';
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: options.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // Windows 亚克力（下面 win32 分支开启后）经 additionalArguments 同步传标记给
    // 渲染层 preload —— 渲染层首帧即可打标，避免异步 IPC 造成的透明化闪色。
    ...(windowsBackdropMaterial() === 'acrylic'
      ? { additionalArguments: ['--kepcup-window-material=acrylic'] }
      : {}),
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
    //
    // Windows / Linux: same shape as the mac side (title bar hidden, content
    // drags via the renderer's app-region classes), but the window stays a
    // framed window — NOT frame:false — so the OS border, rounded corners and
    // drop shadow are untouched（linux 走 GTK/Chromium 的 CSD，原生框观感一致）.
    // The three caption buttons come from the Window Controls Overlay
    // (titleBarOverlay): Chromium draws them as native caption buttons
    // (native hover/click behavior, and on Win11 hovering the maximize button
    // pops the Snap Layouts flyout because the hit-test returns HTMAXBUTTON —
    // self-drawn buttons cannot do this). The overlay background is fully
    // transparent so the buttons sit on top of whatever the window paints
    // there (headers, gradients, overlays) with no color seam; the glyph color
    // follows nativeTheme, resynced in main/index.ts when the app theme moves
    //（linux 端 titleBarOverlay 不支持 symbolColor —— 官方文档标注仅
    // Windows 可定制，字形色随系统主题，故构造时只给透明底色）.
    // Renderer-side geometry inset for content under the button strip:
    // app.css "wco-inset-end" block + window-controls-overlay.ts.
    //
    // Windows: Win11 22H2+ 衬一层原生亚克力（对应 mac 的 vibrancy 毛玻璃，能实
    // 时模糊看到下层内容；Mica/云母只取桌面壁纸，不是这里要的）。不要
    // transparent:true —— 会失去最大化，且首帧不生效/黑帧（electron#39959）；
    // backgroundColor 全透明让未绘制的合成区透出材质即可。系统「透明效果」关
    // 闭/省电/低配硬件时 DWM 自动作纯色，渲染层由 prefers-reduced-transparency
    // 降级回不透明（app.css「acrylic」块）。已知边界：拖拽最大化/还原路径上
    // 材质偶发丢失、圆角不一致（electron#46753），上游 bug，回退不致命。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay:
            process.platform === 'win32'
              ? {
                  color: '#00000000',
                  symbolColor: nativeTheme.shouldUseDarkColors ? '#FFFFFF' : '#000000',
                }
              : { color: '#00000000' },
          ...(windowsBackdropMaterial() === 'acrylic'
            ? { backgroundColor: '#00000000' as const, backgroundMaterial: 'acrylic' as const }
            : {}),
        }),
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
