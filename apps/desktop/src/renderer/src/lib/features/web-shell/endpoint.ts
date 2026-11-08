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

export { defaultDeviceName } from '../../device-name';
