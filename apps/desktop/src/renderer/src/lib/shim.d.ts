import type { CoreStatusPayload, SensorKind } from '@kepcup/shared';

export interface PlatformInfo {
  version: string;
  platform: string;
  arch: string;
  electronVersion: string;
  nodeVersion: string;
  /** P13 任务 4: false only via the e2e seam (KEPCUP_ONBOARDING=off). */
  onboardingVisible: boolean;
}

export interface AutostartResult {
  outcome: string;
  enabled: boolean;
  reason?: string;
}

declare global {
  interface Window {
    kepcup: {
      platform: {
        info(): Promise<PlatformInfo>;
        /** System directory picker (project selector, P04); null when cancelled. */
        selectDirectory(): Promise<string | null>;
      };
      /** Syncs nativeTheme.themeSource (macOS vibrancy material follows the app theme). */
      setNativeThemeSource(mode: 'light' | 'dark' | 'system'): Promise<void>;
      /** P11 查看窗口: shows the bot's page for this conversation (任务 5). */
      showBotBrowser(botId: string, conversationId: string, title: string): Promise<void>;
      onCoreProcessState(callback: (state: string) => void): () => void;
      onNavigateConversation(callback: (conversationId: string) => void): () => void;
      /** P13 任务 6 诊断: reveals the logs directory in the OS file manager. */
      openLogsDir(): Promise<void>;
      /** P13 任务 4 引导: posts a test notification (macOS permission prompt). */
      sendTestNotification(title: string, body: string): Promise<void>;
      /** 传感器（31 号设计）的系统权限三件套（macOS TCC；其他平台恒 granted）。 */
      sensorPermissionStatus(
        kind: SensorKind,
      ): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
      sensorPermissionRequest(kind: SensorKind): Promise<boolean>;
      sensorOpenSettings(kind: SensorKind): Promise<void>;
      /** P13 任务 3: verdict of applying the launch-at-login setting to the OS. */
      onAutostartResult(callback: (result: AutostartResult) => void): () => void;
      /** P13 任务 2 update gate surface. */
      updateStatus(): Promise<unknown>;
      installUpdateNow(): Promise<{ ok: boolean; message?: string }>;
      checkForUpdate(): Promise<{ ok: boolean; message?: string }>;
      /** BR-P13-002: re-arms the gate's drain poll (「继续等待」). */
      keepWaitingOnUpdate(): Promise<void>;
      /** dev/e2e-only (DCE'd in packaged builds): drives the real gate's evaluate(). */
      testGateEvaluate?(version: string): Promise<void>;
      onUpdateStatus(callback: (status: unknown) => void): () => void;
    };
  }

  /**
   * Bundler-injected build-time constant (see src/main/build-constants.d.ts):
   * `true` for dev/e2e builds, `false` in the packaged artifact where guarded
   * code (dev status bar, test seams) is dead-code-eliminated.
   */
  const __KEPCUP_TEST_HOOKS__: boolean;
}

export type { CoreStatusPayload };
