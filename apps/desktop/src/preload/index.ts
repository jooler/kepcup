import { contextBridge, ipcRenderer } from 'electron';
import type { SensorKind } from '@kepcup/shared';

// The renderer asks for the core MessagePort through this bridge; the port
// itself is forwarded via window.postMessage because contextBridge cannot
// transfer MessagePort objects directly. The target is this very window, so
// its own origin is the exact (and only) targetOrigin that must match.
ipcRenderer.on('core-port', (event) => {
  window.postMessage('core-port', window.location.origin, event.ports);
});

const api = {
  platform: {
    info: (): Promise<{
      version: string;
      platform: string;
      arch: string;
      electronVersion: string;
      nodeVersion: string;
      /** P13 任务 4: false only via the e2e seam; packaged builds are always true. */
      onboardingVisible: boolean;
    }> => ipcRenderer.invoke('platform:info'),
    /** System directory picker (project selector); null when cancelled. */
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory'),
  },
  /**
   * Syncs nativeTheme.themeSource so the macOS vibrancy material follows the
   * in-app theme (mode-watcher owns the UI theme; the native blur does not).
   */
  setNativeThemeSource: (mode: 'light' | 'dark' | 'system'): Promise<void> =>
    ipcRenderer.invoke('window:setThemeSource', mode),
  /** P13 任务 6 诊断: reveals `{dataHome}/logs` in the OS file manager. */
  openLogsDir: (): Promise<void> => ipcRenderer.invoke('shell:openLogsDir'),
  /** P13 任务 4 引导步骤 3: posts a test notification (macOS permission prompt). */
  sendTestNotification: (title: string, body: string): Promise<void> =>
    ipcRenderer.invoke('notify:test', title, body),
  /**
   * 传感器系统权限（docs/design/31-sensors.md，D76；由 26 号的 mic* 泛化）：
   * 状态查询、主动拉起系统授权弹框（仅 macOS not-determined 时有系统反馈）、
   * 深链打开系统设置对应面板（已拒绝后的唯一去路）。
   */
  sensorPermissionStatus: (
    kind: SensorKind,
  ): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'> =>
    ipcRenderer.invoke('sensor:permission:status', kind),
  sensorPermissionRequest: (kind: SensorKind): Promise<boolean> =>
    ipcRenderer.invoke('sensor:permission:request', kind),
  sensorOpenSettings: (kind: SensorKind): Promise<void> =>
    ipcRenderer.invoke('sensor:permission:openSettings', kind),
  /**
   * P13 任务 3: verdict of applying the launch-at-login setting to the OS
   * ({ outcome: 'applied' | 'failed', enabled, reason? }); pushed after each
   * settings change (packaged builds only — dev/e2e never touch login items).
   */
  onAutostartResult: (
    callback: (result: { outcome: string; enabled: boolean; reason?: string }) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      result: { outcome: string; enabled: boolean; reason?: string },
    ) => callback(result);
    ipcRenderer.on('autostart:result', listener);
    return () => {
      ipcRenderer.removeListener('autostart:result', listener);
    };
  },
  /** P11 查看窗口: shows the bot's browser page for this conversation (任务 5). */
  showBotBrowser: (
    botId: string,
    conversationId: string,
    title: string,
    labels?: { agent: string; user: string; handback: string },
  ): Promise<void> => ipcRenderer.invoke('browser:show', botId, conversationId, title, labels),
  onCoreProcessState: (callback: (state: string) => void): (() => void) => {
    const listener = (_event: unknown, state: string) => callback(state);
    ipcRenderer.on('core-process-state', listener);
    return () => {
      ipcRenderer.removeListener('core-process-state', listener);
    };
  },
  /** Notification click → open the window on this conversation (P03). */
  onNavigateConversation: (callback: (conversationId: string) => void): (() => void) => {
    const listener = (_event: unknown, conversationId: string) => callback(conversationId);
    ipcRenderer.on('navigate-conversation', listener);
    return () => {
      ipcRenderer.removeListener('navigate-conversation', listener);
    };
  },
  // --- P13 任务 2: update gate surface (P13-B consumes the UI) ---------------
  /** Latest update-gate snapshot (safe to call before the first push). */
  updateStatus: (): Promise<unknown> => ipcRenderer.invoke('update:status'),
  /**
   * User-confirmed install: interrupts in-flight executions (gate cancels via
   * core), waits for them to settle, then quits and installs.
   */
  installUpdateNow: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('update:installNow'),
  /** Manual update check. */
  checkForUpdate: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('update:checkNow'),
  /**
   * 「继续等待」(BR-P13-002): re-arms the gate's drain poll after the user
   * deferred the interrupt decision.
   */
  keepWaitingOnUpdate: (): Promise<void> => ipcRenderer.invoke('update:keepWaiting'),
  /**
   * dev/e2e-only seam (DCE'd from packaged builds, same mechanism as the
   * mock-LLM seeding): drives the REAL gate through evaluate() so e2e can
   * exercise the production transition without a real update feed.
   */
  ...(__KEPCUP_TEST_HOOKS__
    ? {
        testGateEvaluate: (version: string): Promise<void> =>
          ipcRenderer.invoke('update:testEvaluate', version),
      }
    : {}),
  /** Pushed on every gate transition (payload matches updateStatusPayloadSchema). */
  onUpdateStatus: (callback: (status: unknown) => void): (() => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => {
      ipcRenderer.removeListener('update:status', listener);
    };
  },
};

contextBridge.exposeInMainWorld('kepcup', api);

export type PreloadApi = typeof api;
