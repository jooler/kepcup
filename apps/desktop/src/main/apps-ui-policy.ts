import { FILE_APP_SCHEME, MCP_APP_SCHEME, buildWidgetRuntimeCspHeader } from '@kepcup/shared';

/**
 * MCP Apps 主进程部分的纯函数（无 Electron 依赖，可单测）：URL 解析、响应头、子框架导航
 * 判定、预览外链白名单与限流、帧内注入脚本（滚动条兜底 / 外链桥接）。协议注册与处理器见
 * `apps-ui.ts`（kepcup-app）与 `file-apps.ts`（kepcup-file，docs/design/47）。
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

export type AppFrameNavigationVerdict = 'allow' | 'block' | 'open-external';

/**
 * 子框架导航判定（失败即关闭）：
 * - 已加载了 `kepcup-app://` 页面的子框架不能再导航到任何地方（别的应用的页面、外部站点）；
 * - `kepcup-file://` 帧允许**同 token** 的自我导航（多页面 WebApp 的页内跳转）；跨 token /
 *   跳两个特权协议一律拦下；外部站点 / mailto 等白名单 scheme 返回 `open-external`——调用方
 *   拦下导航并转交系统浏览器（docs/design/47），其余未知 scheme 静默拦；
 * - 框架未知（事件没带 frame）时，凡是导航到两个特权协议一律拒绝；
 * - 顶层窗口不能被导航到任一特权协议。
 * 首次加载（已知框架还是 about:blank / 空）放行，加载什么由渲染端 `frame-src` 决定。
 */
export function appFrameNavigationVerdict(input: {
  isMainFrame: boolean;
  /** 发起导航的框架当前 URL；框架未知 = undefined。 */
  frameUrl: string | undefined;
  /** 导航目标。 */
  targetUrl?: string | undefined;
}): AppFrameNavigationVerdict {
  const target = input.targetUrl ?? '';
  const toApp = target.toLowerCase().startsWith(`${MCP_APP_SCHEME}://`);
  const toFile = target.toLowerCase().startsWith(`${FILE_APP_SCHEME}://`);
  const toPrivileged = toApp || toFile;
  if (input.isMainFrame) return toPrivileged ? 'block' : 'allow';
  if (input.frameUrl === undefined) return toPrivileged ? 'block' : 'allow';
  const frame = input.frameUrl;
  if (frame === '' || frame === 'about:blank') return 'allow';
  if (frame.toLowerCase().startsWith(`${MCP_APP_SCHEME}://`)) return 'block';
  if (frame.toLowerCase().startsWith(`${FILE_APP_SCHEME}://`)) {
    if (sameFileToken(frame, target)) return 'allow';
    if (toPrivileged) return 'block';
    return isOpenablePreviewLinkUrl(target) ? 'open-external' : 'block';
  }
  return toPrivileged ? 'block' : 'allow';
}

/** 预览页外链白名单（docs/design/47）：http / https（任意主机）+ mailto + tel。 */
export const PREVIEW_EXTERNAL_LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'] as const;

const PREVIEW_EXTERNAL_LINK_SCHEME_SET = new Set<string>(PREVIEW_EXTERNAL_LINK_SCHEMES);

/**
 * 预览页允许转交系统浏览器打开的 URL（外链判定与 `shell:openExternal` 兜底共用；
 * 拒凭据，http(s) 须有主机，白名单外 scheme 一律 false——OAuth 的
 * `isOpenableExternalUrl`（https 外加回环 http）是 core 发起授权的边界，这里是
 * 用户点击语义，http 站点照开，两个白名单各自独立）。
 */
export function isOpenablePreviewLinkUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!PREVIEW_EXTERNAL_LINK_SCHEME_SET.has(url.protocol)) return false;
  if (url.username !== '' || url.password !== '') return false;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === '') return false;
  return true;
}

export interface OpenExternalRateLimiter {
  /** 取走一个令牌；该 sender 余量不足时 false（调用方静默放弃本次打开）。 */
  tryTake(sender: object): boolean;
}

/**
 * 外链打开限流（每 sender 一个令牌桶）：预览页不需要用户手势也能走到 `shell.openExternal`
 * （JS `location.href`、伪造桥接消息两条路都通），令牌桶兜住「onload 循环无限弹系统
 * 浏览器」——容量 4、每 10s 回 1，正常连点几条外链不受影响，脚本狂刷每分钟至多几个。
 * WeakMap 挂在 webContents 上，销毁即回收；`now` 可注入以便单测。
 */
export function createOpenExternalRateLimiter(
  now: () => number = Date.now,
): OpenExternalRateLimiter {
  const buckets = new WeakMap<object, { tokens: number; at: number }>();
  return {
    tryTake(sender) {
      const at = now();
      const bucket = buckets.get(sender) ?? { tokens: 4, at };
      buckets.set(sender, bucket);
      bucket.tokens = Math.min(4, bucket.tokens + (at - bucket.at) / 10_000);
      bucket.at = at;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
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
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('\\'))
      return null;
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

/**
 * 预览页外链桥接脚本（主进程对 kepcup-file 子框架 executeJavaScript；单行 ASCII，内容
 * 全部来自常量，没有不可信输入）：拦截白名单 scheme 的链接点击——sandbox 无
 * allow-popups，`target=_blank` 的点击在 Blink 层就被静默吞掉，主进程导航守卫收不到
 * 事件——preventDefault 后 postMessage 给宿主渲染层（FILE_APP_OPEN_EXTERNAL_MESSAGE），
 * 由渲染层经 `shell:openExternal` 转交系统浏览器（主进程再验一次白名单 + 限流）。
 * 不拦：同 token 页内跳转（同协议同 host）、页内锚点、带凭据 URL（主进程白名单照拒，
 * 让它落回导航守卫静默拦，两条通路行为一致）、嵌套帧（parent≠top 时 postMessage 落不到
 * 渲染层，不装拦截让点击成为同帧导航由守卫接手）；guard 标记防导航后重复注入叠 listener。
 */
export function externalLinkBridgeScript(schemes: readonly string[], messageType: string): string {
  return (
    '(function(){if(window.parent!==window.top)return;' +
    'if(window.__kepcupExtLink)return;window.__kepcupExtLink=1;' +
    `var ok=${JSON.stringify(schemes)},TYPE=${JSON.stringify(messageType)};` +
    "document.addEventListener('click',function(ev){" +
    'if(ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey||ev.defaultPrevented)return;' +
    'var n=ev.target;while(n&&n.localName!=="a")n=n.parentElement;' +
    'if(!n||!n.hasAttribute("href"))return;' +
    'var href=n.getAttribute("href");' +
    'if(href===""||href.charAt(0)==="#")return;' +
    'var u;try{u=new URL(href,location.href)}catch(e){return}' +
    'if(u.protocol===location.protocol&&u.host===location.host)return;' +
    'if(ok.indexOf(u.protocol)===-1)return;' +
    'if(u.username!==""||u.password!=="")return;' +
    'ev.preventDefault();' +
    'try{window.parent.postMessage({type:TYPE,url:u.toString()},"*")}catch(e){}' +
    '},false)})();'
  );
}
