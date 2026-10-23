import {
  endpointHasCapability,
  type EndpointCapabilityId,
  type EndpointKind,
} from '@kepcup/shared';

/**
 * 端点形态（D96，design 46 §3.2 / host-capabilities.ts 尾部）：web 构建（手机
 * PWA）= remote，桌面 = desktop。web-main.ts 的垫片先于任何 renderer 模块给
 * `window.kepcup.isWeb` 打标，这里在模块加载时求值一次即定型。
 *
 * 各处 desktop-only 入口据此裁剪：显示「仅桌面」不可用态（置灰），不隐藏入口——
 * 不让远程用户产生「功能消失了」的错觉。用 `endpointSupports('open-external')`
 * 这样的调用逐点判断；能力项全集见 shared 的 `DESKTOP_ONLY_CAPABILITIES`。
 */
export const ENDPOINT_KIND: EndpointKind = window.kepcup.isWeb === true ? 'remote' : 'desktop';

/** 本端点是否具备某个 UI 能力（desktop 恒全量；remote 缺 DESKTOP_ONLY 全集）。 */
export function endpointSupports(id: EndpointCapabilityId): boolean {
  return endpointHasCapability(ENDPOINT_KIND, id);
}

/**
 * 从 navigator.userAgent 提取配对确认卡上的默认设备名摘要（用户可改），
 * 如「iPhone」「Android 手机」；提不出就给一个中性名。
 */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 手机';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac 浏览器';
  if (/Windows/i.test(ua)) return 'Windows 浏览器';
  if (/Linux/i.test(ua)) return 'Linux 浏览器';
  return '浏览器';
}
