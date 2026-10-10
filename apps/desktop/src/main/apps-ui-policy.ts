import { MCP_APP_SCHEME } from '@kepcup/shared';

/**
 * MCP Apps 主进程部分的纯函数（无 Electron 依赖，可单测）：URL 解析、响应头、子框架导航判定。
 * 协议注册与处理器见 `apps-ui.ts`。
 */

export interface AppUiRef {
  host: string;
  resourceId: string;
}

/** `kepcup-app://{host}/{resourceId}` → 引用；任何其它形状（多余路径 / 查询 / 凭据 / 端口）→ null。 */
export function parseAppUiUrl(raw: string): AppUiRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${MCP_APP_SCHEME}:`) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const match = /^\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
  if (match === null || !/^[a-z0-9-]{1,63}$/.test(url.hostname)) return null;
  return { host: url.hostname, resourceId: match[1]! };
}

/** 页面响应头：CSP 来自 core（清洗后的 `_meta.ui.csp`），其余固定。 */
export function appUiResponseHeaders(csp: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(), display-capture=()',
  };
}

/**
 * 子框架导航拦截（失败即关闭）：
 * - 已加载了 `kepcup-app://` 页面的子框架不能再导航到任何地方（别的应用的页面、外部站点）；
 * - 框架未知（事件没带 frame）时，凡是导航到 `kepcup-app://` 一律拒绝；
 * - 顶层窗口不能被导航到 `kepcup-app://`。
 * 首次加载（已知框架还是 about:blank / 空）放行。外部 URL 另有渲染端 `frame-src kepcup-app:` 兜底。
 */
export function shouldBlockAppFrameNavigation(input: {
  isMainFrame: boolean;
  /** 发起导航的框架当前 URL；框架未知 = undefined。 */
  frameUrl: string | undefined;
  /** 导航目标。 */
  targetUrl?: string | undefined;
}): boolean {
  const scheme = `${MCP_APP_SCHEME}://`;
  const toApp = (input.targetUrl ?? '').toLowerCase().startsWith(scheme);
  if (input.isMainFrame) return toApp;
  if (input.frameUrl === undefined) return toApp;
  return input.frameUrl.startsWith(scheme);
}
