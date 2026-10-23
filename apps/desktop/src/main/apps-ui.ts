import { app, protocol, shell, type Session, type WebContents } from 'electron';
import { FILE_APP_SCHEME, MCP_APP_SCHEME, appsUiResourceOutputSchema } from '@kepcup/shared';
import {
  appUiResponseHeaders,
  appFrameNavigationVerdict,
  createOpenExternalRateLimiter,
  parseAppUiUrl,
} from './apps-ui-policy';

/**
 * 预览外链打开的全局限流（每 webContents 一个令牌桶）：guard 的同帧跳转通路与
 * `shell:openExternal` IPC 通路共用同一份余量，防止预览页无手势刷弹系统浏览器。
 */
export const openExternalRateLimiter = createOpenExternalRateLimiter();

/**
 * MCP Apps 渲染的主进程部分（D73 P3 §7.5，设计 29 §11.6；spike 与安全结论见 todo/connected-apps.md
 * 附录 B.7）。
 *
 * - 特权协议 `kepcup-app`（`standard` + `secure`，不开 `supportFetchAPI` / `corsEnabled`）：必须在 `app.ready`
 *   之前注册（{@link registerAppsUiScheme}）。
 * - 协议处理器注册在**宿主窗口所在的 session**（默认 session）——iframe 的网络栈跟随宿主 webContents 的
 *   session，`<iframe>` 没有独立 partition（spike 证实：只在别的 partition 注册时 iframe 静默加载不到）。隔离靠
 *   opaque origin（渲染端 `sandbox="allow-scripts"`、无 `allow-same-origin`）+ 逐应用响应头 CSP + 渲染端
 *   `frame-src kepcup-app:` + 子框架导航拦截 + 默认 session 的权限白名单（`kepcup-app:` 不是应用来源，一律拒绝）。
 * - 处理器只服务 core 已登记的 `(host, resourceId)`：不透明 128 位随机 id，HTML 与 CSP 都由 core 经平台 RPC
 *   `apps.ui.resource` 给出，主进程不缓存、不解释。
 * - 没有 preload：preload 只注入主框架；子框架拿不到 `window.kepcup`（spike 实测）。
 */

/** 必须在 `app.ready` 之前调用一次（registerSchemesAsPrivileged 全应用只能调一次）。 */
export function registerAppsUiScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MCP_APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
    },
    {
      // kepcup-file（docs/design/47）：目录预览协议。supportFetchAPI 开——页面里的
      // fetch / XHR 允许打到自己源上的相对资源；corsEnabled 关——跨源读响应仍被 CORS 拦。
      scheme: FILE_APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ]);
}

export interface AppsUiHost {
  /** 向 core 取已登记的页面（平台 RPC `apps.ui.resource`）。 */
  fetchResource(input: { resourceId: string; host: string }): Promise<unknown>;
  log?: (message: string, error?: unknown) => void;
}

/** 注册协议处理器（宿主窗口的 session 上）。 */
export function installAppsUiProtocol(targetSession: Session, host: AppsUiHost): void {
  targetSession.protocol.handle(MCP_APP_SCHEME, async (request) => {
    const ref = request.method === 'GET' ? parseAppUiUrl(request.url) : null;
    if (ref === null) return new Response('not found', { status: 404 });
    try {
      const page = appsUiResourceOutputSchema.parse(await host.fetchResource(ref));
      return new Response(page.html, { status: 200, headers: appUiResponseHeaders(page.csp) });
    } catch (error) {
      host.log?.('apps-ui resource unavailable', error);
      return new Response('not found', { status: 404 });
    }
  });
}

export function guardAppFrameNavigation(contents: WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    const verdict = appFrameNavigationVerdict({
      isMainFrame: event.isMainFrame,
      frameUrl: event.frame?.url,
      targetUrl: event.url,
    });
    if (verdict === 'allow') return;
    event.preventDefault();
    // kepcup-file 预览页的页内跳转 / JS 跳外站（docs/design/47）：拦下导航并把外链
    // 转交系统浏览器（锚点点击优先走注入的桥接脚本，这里接的是程序化跳转与桥接
    // 缺位时的兜底）。限流兜住「脚本循环 location.href 无限弹浏览器」。
    if (verdict === 'open-external') {
      if (!openExternalRateLimiter.tryTake(contents)) return;
      void shell.openExternal(event.url).catch(() => undefined);
    }
  });
}

/** 给之后创建的所有 webContents 装导航拦截（主窗口创建在 `ready` 之后）。 */
export function guardAllAppFrames(): void {
  app.on('web-contents-created', (_event, contents) => guardAppFrameNavigation(contents));
}
