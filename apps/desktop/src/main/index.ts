import { isAbsolute, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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
import { WidgetPreviewHost } from './widget-preview';
import { widgetPreviewMethodSpecs } from './widget-preview-methods';
import { guardAllAppFrames, installAppsUiProtocol, registerAppsUiScheme } from './apps-ui';
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
import { createFileUpdateSourceStore } from './update-sources';
import { ShareIntakeCoordinator } from './share-intake/coordinator';
import { shareGroupDir } from './share-intake/app-group';

let window: BrowserWindow | null = null;
let quitting = false;
let coreHost: CoreHost | null = null;
let browserHost: BrowserHost | null = null;
/** D87 P3b: hidden S2 preview window for widget drafts (never the app's main window). */
let widgetPreviewHost: WidgetPreviewHost | null = null;
let tray: ReturnType<typeof createTray> | null = null;
/** Tracked to honour "no notifications while the window is in the foreground". */
let windowFocused = true;
let unattendedActive = false;
/** Latest update-gate snapshot for late-loading renderer windows (P13-B UI). */
let lastUpdateStatus: UpdateStatusPayload = { phase: 'idle' };
/** D94: 分享协调器（App Group inbox → core inbox → share.consume）。 */
let shareCoordinator: ShareIntakeCoordinator | null = null;
/** 冷启动时先到的 `kepcup://` URL：core 就绪后再消费。 */
const pendingShareUrls: string[] = [];

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

/**
 * D94 §7.2：`kepcup://share-intake?id=…`（Share Extension 唤起主应用）。
 * 冷启动时 URL 先到、core 还没就绪——先排队，core ready 后再消费。
 */
function handleShareUrl(raw: string): void {
  if (shareCoordinator === null) {
    pendingShareUrls.push(raw);
    return;
  }
  void shareCoordinator.handleUrl(raw).then((outcome) => {
    if (outcome === null) return;
    // P0：把 KepCup 带到前台；静默导入是 P1 的体验优化。
    showWindow();
  });
}

/** core 就绪后：消费排队的 URL、扫描 App Group inbox、重写目标快照。 */
async function drainShareIntakes(): Promise<void> {
  if (shareCoordinator === null) return;
  const queued = pendingShareUrls.splice(0, pendingShareUrls.length);
  for (const raw of queued) {
    await shareCoordinator.handleUrl(raw);
  }
  await shareCoordinator.scan();
  await shareCoordinator.refreshTargets();
}

/**
 * D94 §16.3 的兜底：沙盒扩展不一定能打开 `kepcup://`（唤起主应用是待验证项）。
 * 主应用在运行时定期扫一眼 App Group inbox——扩展写完但没能唤起主应用时，
 * 文件照样进得来（用户下次打开 KepCup 也会扫）。
 */
const SHARE_SCAN_INTERVAL_MS = 30_000;
let shareScanTimer: NodeJS.Timeout | null = null;

function startShareScanTimer(): void {
  if (shareScanTimer !== null) return;
  shareScanTimer = setInterval(() => {
    void shareCoordinator?.scan();
  }, SHARE_SCAN_INTERVAL_MS);
  shareScanTimer.unref?.();
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
    // 右栏「查看浏览器」只在该 Bot 有打开的页面时显示。
    onPagesChanged: (pages) => {
      if (window && !window.isDestroyed()) window.webContents.send('browser:pages', pages);
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

  // Windows WCO（window.ts 的 titleBarOverlay）：caption 字形颜色跟应用主题。
  // 主题模式由渲染层经上面的 window:setThemeSource 写进 nativeTheme，这里订阅
  // updated（themeSource 切换 / 跟随系统翻转）重设字形色即可。Overlay 底色是
  // 全透明（透明度由 Blink 颜色解析器保留），只有字形需要跟色。linux 端
  // symbolColor 不可定制（官方文档标注仅 Windows），不做同步，无 win32 时提前
  // 返回。
  nativeTheme.on('updated', () => {
    if (process.platform !== 'win32') return;
    if (window === null || window.isDestroyed()) return;
    try {
      window.setTitleBarOverlay({
        symbolColor: nativeTheme.shouldUseDarkColors ? '#FFFFFF' : '#000000',
      });
    } catch {
      // Overlay 未落下（理论上仅在构造期）/ 窗口正在销毁——等下一个事件再同步。
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

  /** Bot 文件卡片：用系统默认程序打开 / 在文件管理器中显示。 */
  ipcMain.handle('shell:openPath', async (_event, target: unknown) => {
    if (typeof target !== 'string' || !isAbsolute(target)) {
      throw new Error('invalid path');
    }
    const error = await shell.openPath(target);
    if (error.length > 0) throw new Error(error);
  });
  ipcMain.handle('shell:showItemInFolder', (_event, target: unknown) => {
    if (typeof target !== 'string' || !isAbsolute(target)) {
      throw new Error('invalid path');
    }
    shell.showItemInFolder(target);
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
      message: '选择要作为工作目录的目录',
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

  // 对话里 @ 本地文件/文件夹（只传路径，不上传字节）：macOS 面板可同时选
  // 文件或目录；Windows/Linux 的原生面板不支持二合一，先让用户选类型。
  ipcMain.handle('dialog:selectLocalPath', async () => {
    if (window === null) return null;
    let mode: 'both' | 'file' | 'folder' = 'both';
    if (process.platform !== 'darwin') {
      const choice = await dialog.showMessageBox(window, {
        type: 'question',
        message: '选择文件或文件夹',
        buttons: ['选择文件', '选择文件夹', '取消'],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice.response === 2) return null;
      mode = choice.response === 1 ? 'folder' : 'file';
    }
    const result = await dialog.showOpenDialog(window, {
      properties:
        mode === 'both'
          ? ['openFile', 'openDirectory']
          : [mode === 'folder' ? 'openDirectory' : 'openFile'],
      message: '选择文件或文件夹',
    });
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return null;
    try {
      const info = await stat(picked);
      return { path: picked, kind: info.isDirectory() ? 'folder' : 'file' } as const;
    } catch {
      return null;
    }
  });

  // P11 任务 5 (查看窗口): moves the bot's page for this conversation into a
  // visible window. Capability only — whether showing is appropriate is the
  // renderer's / core's decision, not the main process's.
  // W8: the toolbar copy (labels) is localized in the renderer, like the title.
  ipcMain.handle('browser:pages', () => browserHost?.openPages() ?? []);
  ipcMain.handle(
    'browser:show',
    (_event, botId: string, conversationId: string, title?: string, labels?: unknown) => {
      browserHost?.show({ botId, conversationId, title, labels });
    },
  );
  // 强制释放（UI 按钮）：接管中也直接关（force），会话数据保留（非 permanent）。
  ipcMain.handle('browser:close', (_event, botId: string, conversationId: string) => {
    void browserHost?.close({ botId, conversationId, force: true }).catch(() => {});
  });

  // D73 P3 §7.5 MCP Apps: `kepcup-app://` pages are served from core-registered resources only
  // (the scheme itself is registered before ready, below); the handler lives on the window's session.
  // D81 Bot Widgets ride the same scheme: hosts prefixed `widget-` are bot-authored pages.
  installAppsUiProtocol(session.defaultSession, {
    fetchResource: async (input) => {
      if (coreHost === null) throw new Error('core not running');
      if (input.host.startsWith('widget-')) {
        return coreHost.callPlatform('widgets.ui.resource', input);
      }
      return coreHost.callPlatform('apps.ui.resource', input);
    },
    log: (message, error) => {
      const detail = error instanceof Error ? ` — ${error.message}` : '';
      console.warn(`[apps-ui] ${message}${detail}`);
    },
  });

  widgetPreviewHost = new WidgetPreviewHost();
  // D94: 分享协调器。App Group 不可用（非 macOS / 未配置）时 groupDir = null，
  // 协调器只做无害的跳过。
  shareCoordinator = new ShareIntakeCoordinator({
    groupDir: shareGroupDir(process.env, process.resourcesPath),
    coreHome: process.env.KEPCUP_HOME ?? join(homedir(), '.kepcup'),
    logger: {
      // 主进程只允许 console.warn / console.error（BR-P13-008：无文案进程）。
      info: (message, detail) => console.warn(`[share] ${message}`, detail ?? ''),
      warn: (message, detail) => console.error(`[share] ${message}`, detail ?? ''),
    },
    callPlatform: <T>(method: string, input?: unknown) =>
      coreHost!.callPlatform(method, input) as Promise<T>,
  });
  coreHost = new CoreHost(app.getVersion(), {
    // P11: the core's browser tools call the main process over port B.
    // D73: …and so does OAuth consent (shell.openExternal, URL allow-list in shell-methods).
    serverMethods: {
      ...browserMethodSpecs(browserHost),
      ...shellMethodSpecs((url) => shell.openExternal(url)),
      // D87 P3b: S2 widget preview (hidden window, created lazily on the first run).
      ...widgetPreviewMethodSpecs(widgetPreviewHost),
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
    // D94: core ready 后消费排队的分享 URL、扫描 App Group inbox、重写快照。
    if (payload.status === 'ready') {
      void drainShareIntakes();
      startShareScanTimer();
    }
  });
  // D94 §5.2: Bot / 项目 / 归档变了 → 重写 App Group 里的目标快照。
  coreHost.onShareTargetsChanged(() => {
    shareCoordinator?.scheduleTargetsRefresh();
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
    // 选源赢家的持久化（GitHub/R2/OSS 探测的结果）：跨启动记住可达的源，
    // 之后每次检查直达，不再探测。
    store: createFileUpdateSourceStore(() => app.getPath('userData')),
    // dev 下真查 feed 的显式开关（electron-updater 未打包默认跳过检查）；
    // 不开则 dev 里检查恒为 skip，不影响 e2e（NODE_ENV=test 本就不排定时检查）。
    forceDevUpdateConfig: !app.isPackaged && process.env.KEPCUP_DEV_UPDATE_CHECK === '1',
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

// D73 P3 §7.5: the privileged `kepcup-app` scheme must be registered before `app.ready`; the
// navigation guard is installed for every webContents created from now on.
registerAppsUiScheme();
guardAllAppFrames();

// D94: URL Scheme 唤起（Share Extension 写完 inbox 后调用）。必须早于
// app.ready 注册——冷启动时 URL 会在 ready 之前送达。
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleShareUrl(url);
});
// dev 下 scheme 由 Electron 壳注册（打包版由 Info.plist 的 CFBundleURLTypes
// 负责，docs/design/44-macos-share-extension.md §7.2）。
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('kepcup', process.execPath, [resolve(process.argv[1] as string)]);
} else {
  app.setAsDefaultProtocolClient('kepcup');
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
    widgetPreviewHost?.dispose();
  });
  void app.whenReady().then(bootstrap);
}
