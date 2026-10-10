import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  app,
  dialog,
  ipcMain,
  MessageChannelMain,
  Notification,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
  systemPreferences,
  type BrowserWindow,
} from 'electron';
import { CORE_SHUTDOWN_TIMEOUT_MS, type UpdateStatusPayload } from '@kepcup/shared';
import { APP_ID, APP_NAME, appIconPath } from './app-brand';
import { BrowserHost, sessionDataRoot } from './browser-host';
import { browserMethodSpecs } from './browser-methods';
import { shellMethodSpecs } from './shell-methods';
import { CoreHost, type CoreProcessState } from './core-host';
import { createMainWindow } from './window';
import { createTray } from './tray';
import { applyLoginItem } from './login-item';
import { isPermissionAllowed } from './app-permissions';
import {
  parseSensorKind,
  sensorPermissionRequest,
  sensorPermissionStatus,
  sensorSettingsUrl,
} from './sensor-permission';
import { wireUpdater } from './updater';

let window: BrowserWindow | null = null;
let quitting = false;
let coreHost: CoreHost | null = null;
let browserHost: BrowserHost | null = null;
let tray: ReturnType<typeof createTray> | null = null;
/** Tracked to honour "no notifications while the window is in the foreground". */
let windowFocused = true;
let unattendedActive = false;
/** Latest update-gate snapshot for late-loading renderer windows (P13-B UI). */
let lastUpdateStatus: UpdateStatusPayload = { phase: 'idle' };

const isQuitting = () => quitting;

function showWindow(): void {
  if (!window) {
    ensureWindow();
    return;
  }
  window.show();
  window.focus();
}

/** Opens the window and navigates the renderer to the conversation. */
function showConversation(conversationId: string): void {
  showWindow();
  window?.webContents.send('navigate-conversation', conversationId);
}

function ensureWindow(): BrowserWindow {
  if (window) return window;
  window = createMainWindow({
    preloadPath: join(__dirname, '../preload/index.cjs'),
    isQuitting,
  });
  window.on('focus', () => {
    windowFocused = true;
  });
  window.on('blur', () => {
    windowFocused = false;
  });
  window.webContents.on('did-finish-load', () => {
    sendAppPort();
  });

  coreHost?.onState((state) => {
    if (!window) return;
    window.webContents.send('core-process-state', state);
    if (state === 'up') sendAppPort();
  });

  return window;
}

/**
 * Creates a fresh app-port pair (A) each time: one end for the core service
 * (which rebinds its RPC server), the other for the renderer. Called when the
 * renderer loads and whenever the core process comes back up.
 */
function sendAppPort(): void {
  const proc = coreHost?.process();
  if (!proc || !window) return;
  const { port1, port2 } = new MessageChannelMain();
  proc.postMessage({ type: 'app-port' }, [port1]);
  window.webContents.postMessage('core-port', null, [port2]);
}

async function quitApp(): Promise<void> {
  quitting = true;
  browserHost?.closeAll();
  try {
    if (coreHost) await coreHost.shutdown(CORE_SHUTDOWN_TIMEOUT_MS);
  } finally {
    app.quit();
  }
}

function bootstrap(): void {
  // dev 的 Dock 图标：打包版由 .app bundle（icns）/ exe 资源自带；dev 壳
  // （Electron.app）需要手动指定仓库主图标（名称由 patch-dev-electron.cjs 改）。
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath()));
  }

  // Bot browser partitions live inside the data home (P11), not userData —
  // must be set before any session is created.
  app.setPath('sessionData', sessionDataRoot(process.env));
  browserHost = new BrowserHost(process.env, {
    // W8 自动接管 · 交还: the core tells the page's running tasks to snapshot
    // before going on. Best effort — a core restart window just drops it.
    onControlReturned: (input) => {
      coreHost?.callPlatform('browser.controlReturned', input).catch(() => {});
    },
  });
  // P13 任务 2: assigned once the updater is wired below (tray builds first).
  let checkUpdates: () => void = () => {};
  tray = createTray({
    onOpenWindow: showWindow,
    onQuit: quitApp,
    onCheckUpdates: () => checkUpdates(),
    onToggleUnattended: () => {
      // Tray toggle: on with risk acknowledged (menu action = explicit user
      // intent), off without hours. The core publishes the new state either way.
      if (coreHost && !unattendedActive) {
        void coreHost
          .callPlatform('unattended.enable', { hours: null, acknowledgeRisk: true })
          .catch(() => {});
      } else {
        coreHost?.callPlatform('unattended.disable').catch(() => {});
      }
    },
  });

  ipcMain.handle('platform:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    // P13 任务 4: whether the renderer may show the first-run wizard. Only
    // the e2e seam can turn it off (an env switch read here, see the e2e
    // specs) and the guarded branch is dead code in packaged builds —
    // production is always `true` (the wizard itself is gated by the
    // persisted onboarding setting).
    onboardingVisible: __KEPCUP_TEST_HOOKS__ ? process.env.KEPCUP_ONBOARDING !== 'off' : true,
  }));

  // macOS 毛玻璃（window.ts 的 vibrancy）：原生材质跟着 nativeTheme 走，
  // 而应用内主题由 mode-watcher 管理。渲染层在用户切换亮/暗（含恢复跟随
  // 系统）时同步到这里，侧栏毛玻璃才不会和应用 UI 主题相反。
  ipcMain.handle('window:setThemeSource', (_event, mode: unknown) => {
    if (mode === 'light' || mode === 'dark' || mode === 'system') {
      nativeTheme.themeSource = mode;
    }
  });

  // P13 任务 6 诊断页「日志目录：在文件管理器中打开」. The renderer never
  // joins data-directory paths; the main process resolves the same logs dir
  // the core logger writes to (KEPCUP_HOME override honored, as with the
  // browser session root above).
  ipcMain.handle('shell:openLogsDir', () => {
    const home = process.env.KEPCUP_HOME ?? join(homedir(), '.kepcup');
    const logsDir = join(home, 'logs');
    mkdirSync(logsDir, { recursive: true });
    shell.showItemInFolder(logsDir);
  });

  // P13 任务 4 引导步骤 3「系统通知」: posting the first notification is what
  // makes macOS show its permission prompt; the test notification lets the
  // user grant it during onboarding instead of at an arbitrary later moment.
  // BR-P13-008: the localized copy comes from the renderer (i18n single
  // source, zh-CN.ts) — the main process stays copy-free, like browser:show's
  // title parameter.
  ipcMain.handle('notify:test', (_event, title: unknown, body: unknown) => {
    if (!Notification.isSupported()) return;
    if (typeof title !== 'string' || typeof body !== 'string' || body.length === 0) return;
    new Notification({ title, body }).show();
  });

  // 传感器系统权限（docs/design/31-sensors.md，D76；由 26 号的 mic:* 泛化）：
  // macOS TCC 的状态查询、主动拉起系统授权弹框（askForMediaAccess 仅
  // not-determined 时弹）、已拒绝后的去路——深链系统设置对应面板（被拒后系统
  // 不会再弹框，只能引导用户到设置里打开）。非 macOS 无 TCC，视为已授权。
  // kind 在此校验，未知 kind 拒绝。
  ipcMain.handle('sensor:permission:status', (_event, kind: unknown) =>
    sensorPermissionStatus(parseSensorKind(kind), systemPreferences),
  );
  ipcMain.handle('sensor:permission:request', (_event, kind: unknown) =>
    sensorPermissionRequest(parseSensorKind(kind), systemPreferences),
  );
  ipcMain.handle('sensor:permission:openSettings', (_event, kind: unknown) => {
    const url = sensorSettingsUrl(parseSensorKind(kind));
    if (url !== null) void shell.openExternal(url);
  });

  // 主窗口 default session 的权限白名单（D76-7，docs/design/31-sensors.md）：Electron
  // 未设置处理器时默认放行一切权限请求；这里只放行应用自身界面的 media /
  // 复制 / 全屏，其余拒绝并记 warn 便于发现遗漏的合法依赖。
  const appUrl = (): string =>
    !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : 'file:///';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowed = isPermissionAllowed({
      permission,
      requestingUrl: details.requestingUrl,
      mediaTypes: 'mediaTypes' in details ? (details.mediaTypes ?? []) : undefined,
      appUrl: appUrl(),
    });
    if (!allowed)
      console.warn(`[permissions] denied request: ${permission} (${details.requestingUrl})`);
    callback(allowed);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    isPermissionAllowed({
      permission,
      requestingUrl: details.requestingUrl ?? requestingOrigin,
      // enumerateDevices 等检查的 mediaType 为 'unknown'：不带轨道类型，按来源 + 权限判定。
      mediaTypes:
        'mediaType' in details && (details.mediaType === 'audio' || details.mediaType === 'video')
          ? [details.mediaType]
          : undefined,
      appUrl: appUrl(),
    }),
  );

  // System directory picker (docs/dev/02-architecture.md: the result goes to
  // the core through port A as a plain path; the main process only dialogs).
  ipcMain.handle('dialog:selectDirectory', async () => {
    if (window === null) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      message: '选择要作为 project 的目录',
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  // D73 P2 (MCPB): system file picker restricted to the given extensions; path only, the core
  // reads and verifies the file itself (inspect → sha256 → confirm → install).
  ipcMain.handle('dialog:selectFile', async (_event, extensions: unknown) => {
    if (window === null) return null;
    const allowed = Array.isArray(extensions)
      ? extensions.filter(
          (ext): ext is string => typeof ext === 'string' && /^[a-z0-9]+$/i.test(ext),
        )
      : [];
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      ...(allowed.length > 0
        ? { filters: [{ name: allowed.join(', '), extensions: allowed }] }
        : {}),
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  });

  // P11 任务 5 (查看窗口): moves the bot's page for this conversation into a
  // visible window. Capability only — whether showing is appropriate is the
  // renderer's / core's decision, not the main process's.
  // W8: the toolbar copy (labels) is localized in the renderer, like the title.
  ipcMain.handle(
    'browser:show',
    (_event, botId: string, conversationId: string, title?: string, labels?: unknown) => {
      browserHost?.show({ botId, conversationId, title, labels });
    },
  );

  coreHost = new CoreHost(app.getVersion(), {
    // P11: the core's browser tools call the main process over port B.
    // D73: …and so does OAuth consent (shell.openExternal, URL allow-list in shell-methods).
    serverMethods: {
      ...browserMethodSpecs(browserHost),
      ...shellMethodSpecs((url) => shell.openExternal(url)),
    },
  });
  coreHost.onState((state: CoreProcessState) => {
    if (state === 'failed') {
      // The window shows the error page; logs live under the data directory.
      ensureWindow();
    }
  });
  coreHost.onStatus((payload) => {
    // The window appears once the core reports any terminal state so the
    // locked / error pages are reachable too.
    if (payload.status !== 'starting') ensureWindow();
  });
  coreHost.onNotify(({ conversationId, title, body }) => {
    // Focus rule (docs/design/13-permissions.md "系统通知"): never while the
    // window is in the foreground.
    if (windowFocused && window !== null && window.isVisible()) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (conversationId !== null) showConversation(conversationId);
      else showWindow();
    });
    notification.show();
  });
  coreHost.onUnattended(({ active }) => {
    unattendedActive = active;
    tray?.setUnattended(active);
  });
  // P13 任务 3: launch-at-login (settings default ON). Applied best-effort —
  // an unsigned macOS build may refuse to register (logged; verification on a
  // signed build is on the cross-platform list). Dev/e2e runs (app.isPackaged
  // false) never touch the OS login items — the default-ON setting must not
  // register the developer's Electron binary.
  coreHost.onAutostart(({ enabled }) => {
    if (!app.isPackaged) return;
    const result = applyLoginItem(app, enabled, process.platform, {
      execPath: app.getPath('exe'),
      env: process.env,
    });
    // P13-B 设置页开关: surface the apply verdict (an unsigned macOS build
    // refuses to register — the user should see why the switch "didn't work").
    window?.webContents.send('autostart:result', result);
    if (result.outcome === 'failed') {
      console.warn(`[autostart] 开机自启设置未生效（enabled=${enabled}）: ${result.reason}`);
    }
  });
  // P13 任务 2: electron-updater + in-flight-run gate. All update state
  // reaches the renderer as 'update:status' pushes (P13-B consumes the UI).
  const updater = wireUpdater({
    host: {
      broadcast: (channel, payload) => {
        lastUpdateStatus = payload;
        // P13 任务 2: a download sitting at the gate also surfaces in the
        // tray tooltip; earlier phases stay window-only (no toast spam).
        if (payload.phase === 'ready-to-install' && payload.version !== undefined) {
          tray?.setUpdateReady(payload.version);
        }
        window?.webContents.send(channel, payload);
      },
      log: (message, error) => {
        const detail = error instanceof Error ? ` — ${error.message}` : '';
        console.warn(`[updater] ${message}${detail}`);
      },
    },
    listActiveRuns: async () => {
      const result = (await coreHost?.callPlatform('update.activeRuns')) as {
        runs: unknown[];
      } | null;
      return result?.runs ?? [];
    },
    cancelActiveRuns: async (reason) => {
      await coreHost?.callPlatform('update.cancelActive', { reason });
    },
  });
  // 托盘「检查更新…」: opens the window (the banner / settings row live
  // there) and runs a manual check; failures stay silent (P13-A semantics).
  checkUpdates = () => {
    showWindow();
    void updater.checkNow();
  };

  // P13 任务 2 renderer surface (P13-B consumes the UI; the contract ships now).
  ipcMain.handle('update:status', () => lastUpdateStatus);
  ipcMain.handle('update:installNow', async () => {
    // User-confirmed path: the gate cancels in-flight runs, waits for them to
    // settle, then quits and installs. Never invoked without explicit user
    // intent from the update UI.
    try {
      await updater.gate.installNow();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle('update:checkNow', async () => {
    try {
      await updater.checkNow();
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  // BR-P13-002 「继续等待」: re-arms the gate's drain poll instead of parking
  // in awaiting-user forever (each confirmation grants a fresh wait budget).
  ipcMain.handle('update:keepWaiting', async () => {
    await updater.gate.keepWaiting();
  });
  // dev/e2e-only seam (DCE'd from packaged builds, same mechanism as the
  // mock-LLM seeding): drives the REAL gate through evaluate() so the e2e can
  // exercise the production transition path without a real update feed.
  if (__KEPCUP_TEST_HOOKS__) {
    ipcMain.handle('update:testEvaluate', (_event, version: string) =>
      updater.gate.evaluate(String(version)),
    );
  }
  // P10: powerMonitor events travel over port B; the core re-fires schedules
  // missed while asleep (docs/dev/phases/P10-proactive.md 接口与数据). Calls
  // during a core restart window are rejected and dropped on purpose.
  powerMonitor.on('resume', () => {
    coreHost?.callPlatform('power.resume').catch(() => {});
  });
  powerMonitor.on('suspend', () => {
    coreHost?.callPlatform('power.suspend').catch(() => {});
  });
  coreHost.start();
}

// 用户可见名统一 KepCup（app-brand.ts）：dev/打包的菜单、通知、userData 目录
// 都跟随该名，与 electron-builder productName、dev 壳 Info.plist 补丁一致。
// setName 会重定默认 userData 路径——与 KEPCUP_HOME 覆盖一样，必须放在单实例
// 锁之前。
app.setName(APP_NAME);
// Windows toast 通知按 AUMID 归组到开始菜单磁贴；不设置时显示 "Electron"。
app.setAppUserModelId(APP_ID);

// dev/e2e（KEPCUP_HOME）：把 userData 一并隔离到数据目录下——渲染层
// localStorage、GPU 缓存与 requestSingleInstanceLock 都以 userData 为作用域，
// 多套 dev/e2e 实例互不抢占单实例锁，也不与生产实例冲突；生产（未设该环境
// 变量）保持默认 userData。必须在请求单实例锁之前设置。
if (process.env.KEPCUP_HOME) {
  app.setPath('userData', join(process.env.KEPCUP_HOME, 'userData'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  // Tray-resident: an empty listener keeps Electron from quitting when the
  // last window closes (non-macOS default).
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    coreHost?.markQuitting();
    // Pages (and their viewer windows) go first on every quit path, not just
    // the tray's: a viewer closing mid-quit must not re-adopt its page into a
    // freshly created hidden host window (that window would keep the app alive).
    browserHost?.closeAll();
  });
  void app.whenReady().then(bootstrap);
}
