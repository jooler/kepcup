import type { PlatformInfo } from '$lib/shim';

/**
 * `window.kepcup` 的 web 垫片（D96 WP5，web-main.ts 在动态 import ./main.ts 之前
 * 安装——静态 import 会被提升，垫片必须先于任何 renderer 模块执行）。
 *
 * 原则：全 API 降级实现，绝不让调用点抛错——
 *  - 桌面专属能力（文件对话框 / 打开外部 / 通知 / 更新 / 自启 / 传感器权限）返回
 *    空值或 no-op resolve，对应 UI 入口在 web 端点按 capabilities 置灰（endpoint.ts）；
 *  - 事件监听（on*）注册即返回解绑函数，web 里没有主进程推送；
 *  - `isWeb: true` 是端点形态的唯一定位标记；`portNonce` / `windowMaterial` 给
 *    垫值（port 握手与亚克力判断在 web 里都不会发生）。
 */
export function installWebShim(version: string): void {
  const noop = (): Promise<void> => Promise.resolve();
  const unbind = (): (() => void) => () => {};
  const platformInfo: PlatformInfo = {
    version,
    platform: 'web',
    arch: 'wasm',
    electronVersion: '-',
    nodeVersion: '-',
    // 首启引导对 web 端点开放（D102 修订）：headless 服务端的 web 客户端就是主
    // 客户端，向导负责模型供应商引导与管家 Bot 创建（butler.ensure），否则新装
    // 服务端永远没有向导也没有管家。门控仍由 settings.onboarding.completed 决定
    // ——D96 手机遥控桌面时桌面已完成引导，web 端不会重复出现。向导里的桌面
    // 系统权限步骤（自启 / 测试通知）在本垫片降级 no-op，沙箱探测走 RPC 在
    // 服务端环境执行、如实展示。
    onboardingVisible: true,
  };
  window.kepcup = {
    // 非安全上下文（局域网 http://IP 直连 headless）没有 crypto.randomUUID——
    // 在这里裸调会让整个 web 启动炸掉。portNonce 在 web 里只是垫值（port 握手
    // 不会发生），时间+随机兜底足够（与 sidebar-sections 的 newSectionId 同型）。
    portNonce:
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    isWeb: true,
    windowMaterial: 'opaque',
    platform: {
      info: () => Promise.resolve(platformInfo),
      selectDirectory: (_options?: { message?: string }) => Promise.resolve(null),
      selectFile: () => Promise.resolve(null),
      saveFile: () => Promise.resolve(null),
      selectLocalPath: () => Promise.resolve(null),
    },
    setNativeThemeSource: noop,
    showBotBrowser: noop,
    // 组件「在新窗口打开」（widget-window.md）：桌面 Electron 能力，web 端点 no-op
    // ——viewer 按钮按 opened=false 提示失败，不出第二个「窗口」。
    openWidgetWindow: () => Promise.resolve({ opened: false }),
    onWidgetWindowPayload: () => unbind,
    closeBotBrowser: noop,
    getBotBrowserPages: () => Promise.resolve([]),
    onBotBrowserPagesChanged: () => unbind,
    onCoreProcessState: () => unbind,
    onNavigateConversation: () => unbind,
    onOpenRemotePairing: () => unbind,
    openLogsDir: noop,
    openPath: noop,
    showItemInFolder: noop,
    // 桌面 HTML 预览的外链桥接（v0.2.1 FileViewer WebApp 档）：web 端点 no-op——
    // FileViewer 的 HTML 档只在桌面宿主存在，web 里不会走到。
    openExternal: noop,
    sendTestNotification: noop,
    sensorPermissionStatus: () => Promise.resolve('unknown'),
    sensorPermissionRequest: () => Promise.resolve(false),
    sensorOpenSettings: noop,
    onAutostartResult: () => unbind,
    // D105 计算机操控（docs/design/52 §6）：helper 与被操控的桌面都在本机——
    // 远程端点一律 desktop-only 拒绝（endpointCapabilityIdSchema 'computer-use'）。
    computerStop: () => Promise.resolve({ stopped: false }),
    computerPermissionStatus: () =>
      Promise.resolve({ accessibility: 'unknown', screenRecording: 'unknown' }),
    computerPermissionOpen: noop,
    computerCapabilitiesStatus: () =>
      Promise.resolve({ available: false, error: null, checkedAt: 0 }),
    updateStatus: () => Promise.resolve(null),
    installUpdateNow: () => Promise.resolve({ ok: false, message: 'desktop-only' }),
    checkForUpdate: () => Promise.resolve({ ok: false, message: 'desktop-only' }),
    keepWaitingOnUpdate: noop,
    onUpdateStatus: () => unbind,
  };
}
