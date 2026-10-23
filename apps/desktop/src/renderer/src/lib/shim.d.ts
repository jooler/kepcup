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
      /** Secret nonce of the core-port window message (preload ↔ this page only). */
      portNonce: string;
      /**
       * D96 web 构建（手机 PWA）：web-main.ts 的垫片先于任何 renderer 模块打标；
       * Electron 有真实 preload，恒无此字段。端点形态判定（endpoint.ts）与
       * CoreConnection 的传输选择都读它。
       */
      isWeb?: boolean;
      /** 窗口衬底材质（sync，来自 preload 的 argv 标记）：'acrylic' 仅 Win11 22H2+。 */
      windowMaterial: 'acrylic' | 'opaque';
      platform: {
        info(): Promise<PlatformInfo>;
        /** System directory picker (workdir selector, P04); null when cancelled. */
        selectDirectory(): Promise<string | null>;
        /** System file picker (D73 P2 MCPB install); null when cancelled. */
        selectFile(extensions: string[]): Promise<string | null>;
        /** 对话里 @ 本地文件/文件夹：只返回路径与类型，不上传文件字节。 */
        selectLocalPath(): Promise<{ path: string; kind: 'file' | 'folder' } | null>;
      };
      /** Syncs nativeTheme.themeSource (macOS vibrancy material follows the app theme). */
      setNativeThemeSource(mode: 'light' | 'dark' | 'system'): Promise<void>;
      /** P11 查看窗口: shows the bot's page for this conversation (任务 5). */
      showBotBrowser(
        botId: string,
        conversationId: string,
        title: string,
        labels?: { agent: string; user: string; handback: string },
      ): Promise<void>;
      /** 强制释放该 (Bot, 对话) 的浏览器页面（接管中也直接关；会话数据保留）。 */
      closeBotBrowser(botId: string, conversationId: string): Promise<void>;
      getBotBrowserPages(): Promise<Array<{ botId: string; conversationId: string }>>;
      onBotBrowserPagesChanged(
        callback: (pages: Array<{ botId: string; conversationId: string }>) => void,
      ): () => void;
      onCoreProcessState(callback: (state: string) => void): () => void;
      onNavigateConversation(callback: (conversationId: string) => void): () => void;
      /** D96: 托盘「连接手机…」→ 打开配对二维码小窗（设置页 remote 分区）。 */
      onOpenRemotePairing(callback: () => void): () => void;
      /** P13 任务 6 诊断: reveals the logs directory in the OS file manager. */
      openLogsDir(): Promise<void>;
      /** Bot 文件卡片：用系统默认程序打开 / 在文件管理器中显示。 */
      openPath(target: string): Promise<void>;
      showItemInFolder(target: string): Promise<void>;
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

  /**
   * D96 web 构建注入的应用版本（vite.config.web.ts 从 package.json 读入），
   * web 垫片的 platform.info 返回它。
   */
  const __KEPCUP_WEB_VERSION__: string;
}

export type { CoreStatusPayload };
