import { contextBridge, ipcRenderer } from 'electron';
import type { SensorKind } from '@kepcup/shared';

// The renderer asks for the core MessagePort through this bridge; the port
// itself is forwarded via window.postMessage because contextBridge cannot
// transfer MessagePort objects directly. The target is this very window, so
// its own origin is the exact (and only) targetOrigin that must match.
//
// Security (D73 P3 review): the message carries a per-load secret nonce that only this
// preload and the page's own main world (`window.kepcup.portNonce`) know. A sandboxed MCP App
// iframe can post to its parent too, but cannot read the nonce — without it the renderer
// ignores the message, so a page can never swap the core RPC port.
const portNonce = crypto.randomUUID();
ipcRenderer.on('core-port', (event) => {
  window.postMessage({ type: 'core-port', nonce: portNonce }, window.location.origin, event.ports);
});

// T7 融合视图：团队连接的 MessagePort（主进程 team-bridge 持另一端），与 core-port
// 同一条 window.postMessage 通道 + 同一个 nonce（防页面伪造：沙箱 iframe 读不到
// nonce）。载荷多一个 serverHash，渲染层按 `team:${serverHash}` 来源归位；每条
// team-port 消息都携带**全新的** port（首次 connect / 换账号重连 / 窗口重载补发），
// 渲染层收到即应替换该来源的旧 transport。
ipcRenderer.on('team-port', (event, meta) => {
  window.postMessage(
    {
      type: 'team-port',
      nonce: portNonce,
      serverHash: (meta as { serverHash?: unknown } | null)?.serverHash,
    },
    window.location.origin,
    event.ports,
  );
});

// 窗口衬底材质标记（main/window.ts 的 acrylic 注释）：Win11 22H2+ 主进程经
// webPreferences.additionalArguments 写进 process.argv，同步可读 —— 渲染层
// 首帧即可据此把侧栏透明化，不走异步 IPC（否则 startup 会有闪色跳变）。
const windowMaterial = process.argv.includes('--kepcup-window-material=acrylic')
  ? ('acrylic' as const)
  : ('opaque' as const);

const api = {
  /** 窗口衬底材质（sync 常量）：'acrylic' = Win11 22H2+ 已开原生亚克力。 */
  windowMaterial,
  /** Secret accompanying the core port message (see above); never sent anywhere else. */
  portNonce,
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
    /** System directory picker (workdir selector; optional prompt, D104 plugins); null when cancelled. */
    selectDirectory: (options?: { message?: string }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:selectDirectory', options),
    /** System file picker (D73 P2 MCPB install); null when cancelled. */
    selectFile: (extensions: string[]): Promise<string | null> =>
      ipcRenderer.invoke('dialog:selectFile', extensions),
    /** System save-as picker (D48 Bot 模板导出); null when cancelled. */
    saveFile: (options: {
      title?: string;
      defaultFileName?: string;
      extensions?: string[];
    }): Promise<string | null> => ipcRenderer.invoke('dialog:saveFile', options),
    /** 对话里 @ 本地文件/文件夹：只返回路径与类型，绝不上传文件字节。 */
    selectLocalPath: (): Promise<{ path: string; kind: 'file' | 'folder' } | null> =>
      ipcRenderer.invoke('dialog:selectLocalPath'),
    /**
     * T7 融合视图：凭据 / 多账号 / 桥接启停（主进程 team-servers.ts 实现；token
     * 永不出主进程——任何返回值都不含 token / 密码）。错误约定：reject 的
     * Error.message 是 `JSON.stringify({code, message, details?})`（code 取 shared
     * ERROR_CODES；解析失败按通用错误处理）。
     */
    teamServers: {
      list: (): Promise<
        Array<{
          serverHash: string;
          url: string;
          /** 用户在本机起的显示名（'' = 未设，UI 回退显示 url）。 */
          name: string;
          accounts: Array<{
            memberId: string;
            username: string;
            displayName: string;
            remembered: boolean;
          }>;
          activeMemberId: string | null;
          status: 'idle' | 'connecting' | 'connected' | 'unauthenticated' | 'error';
        }>
      > => ipcRenderer.invoke('platform:teamServers:list'),
      add: (input: { url: string }): Promise<{ serverHash: string }> =>
        ipcRenderer.invoke('platform:teamServers:add', input),
      remove: (input: { serverHash: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:remove', input),
      login: (input: {
        serverHash: string;
        username: string;
        password: string;
        remember: boolean;
      }): Promise<{ member: { id: string; displayName: string } }> =>
        ipcRenderer.invoke('platform:teamServers:login', input),
      logout: (input: { serverHash: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:logout', input),
      switchAccount: (input: { serverHash: string; memberId: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:switchAccount', input),
      /** 本机重命名（name trim 落盘，空 = 清除回退显示 url）；只存本机。 */
      rename: (input: { serverHash: string; name: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:rename', input),
      connect: (input: { serverHash: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:connect', input),
      disconnect: (input: { serverHash: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamServers:disconnect', input),
      /** 健康检查（whoami 探测）：添加流程第一步，确认服务可用再出现登录表单。 */
      probe: (input: { url: string }): Promise<{
        reachable: boolean;
        kind: 'team' | 'personal' | 'unknown';
        authenticated?: boolean;
        member?: { id: string; displayName: string };
        detail?: string;
      }> => ipcRenderer.invoke('platform:teamServers:probe', input),
      /** 状态 / 名单变化（主进程推送 ipc 事件 team-servers:changed）；返回解绑函数。 */
      onChanged: (callback: () => void): (() => void) => {
        const listener = (): void => callback();
        ipcRenderer.on('team-servers:changed', listener);
        return () => {
          ipcRenderer.removeListener('team-servers:changed', listener);
        };
      },
    },
    /**
     * T8 客户端本地缓存（platform.teamCache.*，主进程 team-cache/ 实现）：分区整库
     * 加密的只读镜像。会话 / 消息视图字段与 team.bootstrap / messages.list 一致
     * （shared conversationCacheSchema / messageCacheSchema）。错误约定同 teamServers
     * （reject 的 Error.message 是 JSON 载荷）。web 垫片不提供（web 走 IndexedDB）。
     */
    teamCache: {
      open: (input: { serverHash: string; memberId: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamCache:open', input),
      close: (input: { serverHash: string; memberId: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamCache:close', input),
      putConversations: (input: {
        serverHash: string;
        memberId: string;
        conversations: unknown[];
        replace?: boolean;
      }): Promise<{ ok: true }> => ipcRenderer.invoke('platform:teamCache:putConversations', input),
      putMessages: (input: {
        serverHash: string;
        memberId: string;
        conversationId: string;
        messages: unknown[];
        replace?: boolean;
      }): Promise<{ ok: true }> => ipcRenderer.invoke('platform:teamCache:putMessages', input),
      getConversations: (input: {
        serverHash: string;
        memberId: string;
      }): Promise<{ conversations: unknown[] }> =>
        ipcRenderer.invoke('platform:teamCache:getConversations', input),
      getMessages: (input: {
        serverHash: string;
        memberId: string;
        conversationId: string;
        limit?: number;
        beforeSeq?: number;
      }): Promise<{ messages: unknown[] }> =>
        ipcRenderer.invoke('platform:teamCache:getMessages', input),
      putAttachment: (input: {
        serverHash: string;
        memberId: string;
        key: string;
        bytes: string;
      }): Promise<{ ok: true }> => ipcRenderer.invoke('platform:teamCache:putAttachment', input),
      getAttachment: (input: {
        serverHash: string;
        memberId: string;
        key: string;
      }): Promise<{ bytes: string } | { missing: true }> =>
        ipcRenderer.invoke('platform:teamCache:getAttachment', input),
      clearPartition: (input: { serverHash: string; memberId: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamCache:clearPartition', input),
      clearServer: (input: { serverHash: string }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamCache:clearServer', input),
      usage: (input: {
        serverHash: string;
        memberId: string;
      }): Promise<{ cacheBytes: number | null; attachmentLimitBytes: number }> =>
        ipcRenderer.invoke('platform:teamCache:usage', input),
      setAttachmentLimit: (input: { limitBytes: number }): Promise<{ ok: true }> =>
        ipcRenderer.invoke('platform:teamCache:setAttachmentLimit', input),
    },
  },
  /**
   * Syncs nativeTheme.themeSource so the macOS vibrancy material follows the
   * in-app theme (mode-watcher owns the UI theme; the native blur does not).
   */
  setNativeThemeSource: (mode: 'light' | 'dark' | 'system'): Promise<void> =>
    ipcRenderer.invoke('window:setThemeSource', mode),
  /** P13 任务 6 诊断: reveals `{dataHome}/logs` in the OS file manager. */
  openLogsDir: (): Promise<void> => ipcRenderer.invoke('shell:openLogsDir'),
  /** Bot 文件卡片：用系统默认程序打开 / 在文件管理器中显示。 */
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('shell:openPath', target),
  showItemInFolder: (target: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', target),
  /** FileViewer HTML 预览（docs/design/47）：预览页外链转交系统浏览器；scheme 白名单在主进程兜底。 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
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
  /**
   * 组件「在新窗口打开」（widget-window.md）：把 { messageId, card } 交给主进程起独立
   * 窗口。主进程按 widgetCardSchema 重验后再开窗；打开方负责随后关闭覆盖层（移交语义）。
   */
  openWidgetWindow: (input: { messageId: string; card: unknown }): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('window:openWidget', input),
  /**
   * 组件窗口的启动载荷（主进程在 did-finish-load 后推送一次；窗口模式渲染层据此挂
   * WidgetRuntime）。只在该窗口模式页面上监听。
   */
  onWidgetWindowPayload: (
    callback: (payload: { messageId: string; card: unknown }) => void,
  ): (() => void) => {
    const listener = (_event: unknown, payload: { messageId: string; card: unknown }) =>
      callback(payload);
    ipcRenderer.on('widget-window:payload', listener);
    return () => {
      ipcRenderer.removeListener('widget-window:payload', listener);
    };
  },
  /** 强制释放该 (Bot, 对话) 的浏览器页面（接管中也直接关；会话数据保留）。 */
  closeBotBrowser: (botId: string, conversationId: string): Promise<void> =>
    ipcRenderer.invoke('browser:close', botId, conversationId),
  /**
   * D105 / P-B2 计算机操控（docs/design/52 §3）：用户 kill switch 直达 main（不经 core，
   * core 卡死也要能停）+ 宿主 TCC 权限三态与系统设置深链（设置页引导区块）。
   */
  computerStop: (reason?: string): Promise<{ stopped: boolean }> =>
    ipcRenderer.invoke('computer:stop', reason),
  computerPermissionStatus: (): Promise<{
    accessibility: 'granted' | 'not-granted' | 'unknown';
    screenRecording: 'granted' | 'not-granted' | 'unknown';
    directCapture: 'granted' | 'not-granted' | 'unknown';
  }> => ipcRenderer.invoke('computer:permissions-status'),
  computerPermissionProbeCapture: (): Promise<{
    status: {
      accessibility: 'granted' | 'not-granted' | 'unknown';
      screenRecording: 'granted' | 'not-granted' | 'unknown';
      directCapture: 'granted' | 'not-granted' | 'unknown';
    };
    reason: string | null;
  }> => ipcRenderer.invoke('computer:permissions-probe-capture'),
  computerPermissionOpen: (permission: 'accessibility' | 'screen-recording'): Promise<void> =>
    ipcRenderer.invoke('computer:permissions-open', permission),
  /** 设置页可用性行：重新握手并落盘（computer-use-capabilities.json），失败原因随结果返回。 */
  computerCapabilitiesStatus: (): Promise<{
    available: boolean;
    error: string | null;
    checkedAt: number;
  }> => ipcRenderer.invoke('computer:capabilities-status'),
  /** Open bot browser pages (bot × conversation); pushed on every open / close. */
  getBotBrowserPages: (): Promise<Array<{ botId: string; conversationId: string }>> =>
    ipcRenderer.invoke('browser:pages'),
  onBotBrowserPagesChanged: (
    callback: (pages: Array<{ botId: string; conversationId: string }>) => void,
  ): (() => void) => {
    const listener = (_event: unknown, pages: Array<{ botId: string; conversationId: string }>) =>
      callback(pages);
    ipcRenderer.on('browser:pages', listener);
    return () => {
      ipcRenderer.removeListener('browser:pages', listener);
    };
  },
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
  /** D96: 托盘「连接手机…」→ 打开窗口并弹出配对二维码小窗。 */
  onOpenRemotePairing: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on('open-remote-pairing', listener);
    return () => {
      ipcRenderer.removeListener('open-remote-pairing', listener);
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
   * 「取消更新」：停下本次下载并跳过该版本（gate 相位守卫：仅 downloading
   * 有效；跳过版本持久化，更新的版本恢复正常流程）。
   */
  cancelUpdateDownload: (): Promise<void> => ipcRenderer.invoke('update:cancelDownload'),
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
