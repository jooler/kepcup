import { app, webFrameMain, type Session } from 'electron';
import {
  FILE_APP_OPEN_EXTERNAL_MESSAGE,
  FILE_APP_SCHEME,
  filePreviewResourceOutputSchema,
  IFRAME_SCROLLBAR_CSS,
  IFRAME_SCROLLBAR_STYLE_MARKER,
  injectIframeScrollbarStyle,
  type FilePreviewResourceInput,
} from '@kepcup/shared';
import {
  externalLinkBridgeScript,
  fileAppResponseHeaders,
  parseFileAppUrl,
  PREVIEW_EXTERNAL_LINK_SCHEMES,
  scrollbarBackstopScript,
} from './apps-ui-policy';

/**
 * kepcup-file 目录预览协议的主进程部分（docs/design/47）：FileViewer 浏览 HTML 时页面在
 * `kepcup-file://{token}/…` 源里加载，handler 按 token 经平台 RPC `files.previewResource`
 * 向 core 取该 HTML 所在目录内的文件字节。协议特权注册与导航守卫分别在 `apps-ui.ts`
 * （registerAppsUiScheme 一次注册两个协议）与 `apps-ui-policy.ts`（appFrameNavigationVerdict，
 * 预览页外链转交系统浏览器）。
 *
 * 响应头见 `fileAppResponseHeaders`：CSP 只保留沙箱与 frame-ancestors（完整 WebApp 档，
 * 网络与资源不设限——这就是「像浏览器开了一个网站」的语义），Permissions-Policy 拒一切
 * 浏览器权限（default session 的权限白名单也只认应用自身 origin，双保险）。
 */

export interface FileAppHost {
  /** 平台 RPC `files.previewResource`（token + 相对路径 → mime + base64）。 */
  fetchResource(input: FilePreviewResourceInput): Promise<unknown>;
  log?: (message: string, error?: unknown) => void;
}

/**
 * text/html 注入默认滚动条样式（应用同款；页面自定义了滚动条样式则原样返回，见
 * shared iframe-defaults）。插入内容是纯 ASCII：走 latin1 字节级往返——任何 ASCII
 * 兼容编码（UTF-8 / GBK / 单字节）逐字节不变形；含 \x00（UTF-16 等非 ASCII 兼容
 * 编码）的文档不动。
 */
function withScrollbarStyle(bytes: Buffer): Buffer {
  const text = bytes.toString('latin1');
  if (text.includes('\x00')) return bytes;
  const injected = injectIframeScrollbarStyle(text);
  return injected === text ? bytes : Buffer.from(injected, 'latin1');
}

/** 注册协议处理器（宿主窗口所在的 session 上）。 */
export function installFileAppProtocol(targetSession: Session, host: FileAppHost): void {
  targetSession.protocol.handle(FILE_APP_SCHEME, async (request) => {
    const ref = request.method === 'GET' ? parseFileAppUrl(request.url) : null;
    if (ref === null) return new Response('not found', { status: 404 });
    try {
      const out = filePreviewResourceOutputSchema.parse(await host.fetchResource(ref));
      const raw = Buffer.from(out.dataBase64, 'base64');
      const body = out.mime.startsWith('text/html') ? withScrollbarStyle(raw) : raw;
      return new Response(body, {
        status: 200,
        headers: fileAppResponseHeaders(out.mime),
      });
    } catch (error) {
      host.log?.('file-app resource unavailable', error);
      return new Response('not found', { status: 404 });
    }
  });
}

/** 滚动条兜底脚本（构造见 apps-ui-policy.scrollbarBackstopScript）。 */
const SCROLLBAR_BACKSTOP_JS = scrollbarBackstopScript(
  IFRAME_SCROLLBAR_CSS,
  IFRAME_SCROLLBAR_STYLE_MARKER,
);

/** 预览页外链桥接脚本（构造见 apps-ui-policy.externalLinkBridgeScript）。 */
const EXTERNAL_LINK_BRIDGE_JS = externalLinkBridgeScript(
  PREVIEW_EXTERNAL_LINK_SCHEMES,
  FILE_APP_OPEN_EXTERNAL_MESSAGE,
);

/**
 * kepcup-file 子框架的加载后脚本（框架加载完成后各跑一次，与 guardAllAppFrames 同一挂法
 * ——app 级、窗口创建前注册一次）：滚动条兜底 + 外链桥接（`target=_blank` 的点击被
 * sandbox 挡在 Blink 层，导航守卫收不到，只能帧内拦截后 postMessage 给渲染层，
 * docs/design/47）。两段都是幂等脚本，分两次 executeJavaScript——互不连累
 * （一段抛异常不影响另一段注入）。
 */
export function watchFileAppFrameScripts(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-frame-finish-load', (_e, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      try {
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId) ?? null;
        if (frame === null || !frame.url.startsWith(`${FILE_APP_SCHEME}://`)) return;
        void frame.executeJavaScript(SCROLLBAR_BACKSTOP_JS, false).catch(() => undefined);
        void frame.executeJavaScript(EXTERNAL_LINK_BRIDGE_JS, false).catch(() => undefined);
      } catch {
        // 框架已经销毁 / 不可达：静态注入（若有）已覆盖，忽略。
      }
    });
  });
}
