import {
  FILE_APP_SCHEME,
  MCP_APP_SCHEME,
  buildWidgetRuntimeCspHeader,
} from '@kepcup/shared';

/**
 * MCP Apps 主进程部分的纯函数（无 Electron 依赖，可单测）：URL 解析、响应头、子框架导航判定。
 * 协议注册与处理器见 `apps-ui.ts`（kepcup-app）与 `file-apps.ts`（kepcup-file，docs/design/47）。
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
 * - `kepcup-file://` 帧允许**同 token** 的自我导航（多页面 WebApp 的页内跳转），跨 token /
 *   跳别的协议 / 外部站点一律拦下；
 * - 框架未知（事件没带 frame）时，凡是导航到两个特权协议一律拒绝；
 * - 顶层窗口不能被导航到任一特权协议。
 * 首次加载（已知框架还是 about:blank / 空）放行，加载什么由渲染端 `frame-src` 决定。
 */
export function shouldBlockAppFrameNavigation(input: {
  isMainFrame: boolean;
  /** 发起导航的框架当前 URL；框架未知 = undefined。 */
  frameUrl: string | undefined;
  /** 导航目标。 */
  targetUrl?: string | undefined;
}): boolean {
  const target = input.targetUrl ?? '';
  const toApp = target.toLowerCase().startsWith(`${MCP_APP_SCHEME}://`);
  const toFile = target.toLowerCase().startsWith(`${FILE_APP_SCHEME}://`);
  if (input.isMainFrame) return toApp || toFile;
  if (input.frameUrl === undefined) return toApp || toFile;
  const frame = input.frameUrl;
  if (frame === '' || frame === 'about:blank') return false;
  if (frame.toLowerCase().startsWith(`${MCP_APP_SCHEME}://`)) return true;
  if (frame.toLowerCase().startsWith(`${FILE_APP_SCHEME}://`)) {
    return !sameFileToken(frame, target);
  }
  return toApp || toFile;
}

/** 两个 kepcup-file URL 是否同一个 token（host）：同 token 的自我导航放行。 */
function sameFileToken(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/** `kepcup-file://{token}/{相对路径…}` → 引用；形状不对（多余凭据 / 端口 / 越界段）→ null。 */
export interface FileAppRef {
  token: string;
  /** URL 解码后的相对路径（不含查询与片段；`..` 段与反斜杠直接拒绝）。 */
  rel: string;
}

export function parseFileAppUrl(raw: string): FileAppRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${FILE_APP_SCHEME}:`) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!/^f[0-9a-f]{24}$/.test(url.hostname)) return null;
  if (!url.pathname.startsWith('/') || url.pathname === '/') return null;
  const segments: string[] = [];
  for (const segment of url.pathname.slice(1).split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('\\')) return null;
    segments.push(decoded);
  }
  return { token: url.hostname, rel: segments.join('/') };
}

/** 目录预览的响应头：CSP 只保留沙箱与 frame-ancestors（完整 WebApp 档），其余固定。 */
export function fileAppResponseHeaders(mime: string): Record<string, string> {
  return {
    'content-type': mime,
    'content-security-policy': buildWidgetRuntimeCspHeader(),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(), display-capture=()',
  };
}

/**
 * 滚动条兜底脚本（主进程对 kepcup-file 子框架 executeJavaScript；单行 ASCII，内容全部
 * 来自常量，没有不可信输入）：静态注入（`<style marker>`）已存在、或页面自带滚动条
 * 样式（遍历 styleSheets，跨源表抛错按没有算）时不动，否则把默认样式插到 head 最前。
 */
export function scrollbarBackstopScript(css: string, marker: string): string {
  return (
    `(function(){if(document.querySelector('style[${marker}]'))return;` +
    'var re=/::-webkit-scrollbar|scrollbar-(width|color)\\s*:/i;' +
    'var sheets=document.styleSheets;for(var i=0;i<sheets.length;i++){var rules;' +
    'try{rules=sheets[i].cssRules}catch(e){continue}for(var j=0;j<rules.length;j++){' +
    'if(re.test(rules[j].cssText))return}}' +
    'var head=document.head||document.documentElement;if(!head)return;' +
    `var style=document.createElement('style');style.setAttribute('${marker}','');` +
    `style.textContent=${JSON.stringify(css)};head.insertBefore(style,head.firstChild)})();`
  );
}
