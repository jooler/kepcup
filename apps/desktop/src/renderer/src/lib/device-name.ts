/**
 * 默认设备名（配对确认卡 / 多客户端在线状态共用）。DOM 安全：渲染层单测的
 * 客户端环境没有 `navigator`，这里不能读 `window` 或强依赖浏览器全局。
 */
export function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'KepCup 客户端';
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 手机';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac 浏览器';
  if (/Windows/i.test(ua)) return 'Windows 浏览器';
  if (/Linux/i.test(ua)) return 'Linux 浏览器';
  return '浏览器';
}
