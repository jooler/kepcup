import {
  mcpHeaderTemplateOf,
  normalizeMcpHeaderValueForWire,
  type McpServer,
  type PluginManifest,
} from '@kepcup/shared';

/**
 * 发送侧 header 归一化（腾讯文档 MCP 等声明了凭据方案的插件）：`McpService` 组请求头时把解析
 * 出来的值过一遍，只对「插件清单里显式声明了 `scheme` 的 header」生效。
 *
 * 为什么放在这一层而不是 `#resolveRecordSecrets` 里按 header 名硬编码：清单是唯一事实来源，
 * 通用 MCP / 用户手填的 server 没有 `source.kind === 'instance'`，天然不经过这条规则；其他
 * header（API key 等）也没声明 scheme，值原样透传。
 */
export type McpHeaderValueNormalizer = (
  server: McpServer,
  headerName: string,
  value: string,
) => string | Promise<string>;

export interface ManifestHeaderNormalizerDeps {
  /** 插件注册表的清单查询（`PluginRegistry.manifestOf`，带内存缓存）。 */
  manifestOf(pluginId: string): Promise<PluginManifest | null>;
}

/** 按插件清单声明的 header 方案归一化发送值；任何一步查不到都原样返回。 */
export function createManifestHeaderNormalizer(
  deps: ManifestHeaderNormalizerDeps,
): McpHeaderValueNormalizer {
  return async (server, headerName, value) => {
    const source = server.source;
    if (source?.kind !== 'instance') return value;
    let manifest: PluginManifest | null;
    try {
      manifest = await deps.manifestOf(source.pluginId);
    } catch {
      // 清单读失败（插件正在更新 / 已卸载）时不阻断连接：按未声明处理。
      return value;
    }
    if (manifest === null) return value;
    // 实例供给规范：一个插件至多一份 http 模版（0 份 = 纯实例通用插件），所以按 kind 找即可。
    const contribution = manifest.contributions.mcp.find((entry) => entry.kind === 'http');
    const header = mcpHeaderTemplateOf(contribution, headerName);
    return normalizeMcpHeaderValueForWire(header?.scheme, value);
  };
}
