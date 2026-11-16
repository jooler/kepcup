import type { PluginRuntimeDisclosure } from '@kepcup/shared';

/**
 * 同意卡「执行型插件能力披露」的展示口径（D125 P4，61 §7）：只做事实投影——
 * 联网域名清单（含通配标记）、凭据字段名（不含值）、存储配额。数据来自
 * `plugins.inspect` 的 `runtime`（core 从清单 + 实例字段声明推导，渲染端不采信清单自述）。
 *
 * 数据型插件（`runtime` 为 null / 缺省）返回 null：同意卡不渲染该区块，与今日零变化。
 */
export interface RuntimeDisclosureView {
  /** 清单 `runtime.network.allow` 原文（精确 host 或 `*.domain`）。 */
  networkDomains: string[];
  /** 是否存在通配条目（渲染「* 匹配子域」说明）。 */
  networkWildcard: boolean;
  /** 实例敏感字段名（不含值）。 */
  credentialFields: string[];
  /** `host.storage` 配额（字节）。 */
  storageQuotaBytes: number;
}

export function runtimeDisclosureView(
  runtime: PluginRuntimeDisclosure | null | undefined,
): RuntimeDisclosureView | null {
  if (runtime === null || runtime === undefined) return null;
  return {
    networkDomains: [...runtime.networkDomains],
    networkWildcard: runtime.networkDomains.some((domain) => domain.startsWith('*.')),
    credentialFields: [...runtime.credentialFields],
    storageQuotaBytes: runtime.storageQuotaBytes,
  };
}
