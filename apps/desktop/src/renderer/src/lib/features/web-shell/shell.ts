/**
 * 原生壳标记(D122,docs/design/58-mobile-shell.md §1.2):apps/mobile 的首页交接
 * 时给目标 URL 附加 `?shell=native&shellBack=<首页地址>`。WebView 内桥对一切页面
 * 可用(iOS WKUserScript 全局注入、Android 通配规则),但壳检测**不依赖**桥——
 * 走 URL 查询参数,语义稳定、可纯 Node 测试;普通浏览器路径(无参数)零行为变化。
 *
 * 模块加载期求值一次定型(与 endpoint.ts 的 ENDPOINT_KIND 同款);应用内导航
 * pushState 改写 URL 也不影响本标记(冷启动回首页重走交接,无中途丢标记场景)。
 */

/** 解析交接 URL 的查询串;独立成函数便于纯 Node 测试。 */
export function readNativeShell(search: string): { native: boolean; home: string | null } {
  const params = new URLSearchParams(search);
  if (params.get('shell') !== 'native') return { native: false, home: null };
  // shellBack 必须是壳的本地首页(https/capacitor/ionic + localhost;http:localhost
  // 是桌面浏览器 dev 服)。任意他值(伪造链接指向外站)视同缺省——断开退化为
  // history 回退,不把用户导去非本地页。
  const home = params.get('shellBack');
  return {
    native: true,
    home: home !== null && home.length > 0 && isLocalHome(home) ? home : null,
  };
}

function isLocalHome(home: string): boolean {
  try {
    const url = new URL(home);
    const schemeOk =
      url.protocol === 'capacitor:' ||
      url.protocol === 'ionic:' ||
      url.protocol === 'https:' ||
      url.protocol === 'http:';
    return schemeOk && url.hostname === 'localhost';
  } catch {
    return false;
  }
}

const shell = readNativeShell(typeof location === 'undefined' ? '' : location.search);

/** 当前页面是否跑在手机原生壳的 WebView 里。 */
export const NATIVE_SHELL = shell.native;

/** 首页地址(断开 = 导航回这里);未携带或非本地源时为 null。 */
export const NATIVE_SHELL_HOME = shell.home;
