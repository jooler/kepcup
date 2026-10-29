import type { McpServer, PluginContributionKind, PluginSummary } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * Bot 详情「插件」区块（P2 注入模型）的纯逻辑：插件启用集（`runtime.plugin_ids`）
 * 的整集写入计算、插件类别徽标推导（协议不可见：mcp 显示「工具」）、展开细选里
 * 手动工具服务的筛选。组件只负责渲染。
 */

/**
 * 勾选 / 取消一个插件后的启用集：保持其余 id 顺序、去重（`plugins.setBotPlugins`
 * 整体替换，写入端以此为准）。缺失（= 未启用任何插件）视作空集。
 */
export function togglePluginId(
  current: readonly string[] | undefined,
  pluginId: string,
  enabled: boolean,
): string[] {
  const kept = dedupePluginIds(current ?? []).filter((id) => id !== pluginId);
  return enabled ? [...kept, pluginId] : kept;
}

/** 去重（保序）：整集写入前的统一出口。 */
export function dedupePluginIds(ids: readonly string[]): string[] {
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

/** 与已安装清单求交后的启用数（卸载残留的 id 不计入摘要）。 */
export function enabledPluginCount(
  current: readonly string[] | undefined,
  installed: readonly { id: string }[],
): number {
  const ids = new Set(installed.map((plugin) => plugin.id));
  return dedupePluginIds(current ?? []).filter((id) => ids.has(id)).length;
}

/** 添加弹框的搜索口径：名称 / id / 描述 / 作者的任一字段包含全部关键词（空查询恒命中）。 */
export function matchesPluginQuery(
  plugin: Pick<PluginSummary, 'id' | 'name' | 'description' | 'author'>,
  query: string,
): boolean {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return true;
  const haystack = [plugin.name, plugin.id, plugin.description, plugin.author ?? '']
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 该 Bot 已添加、且仍在已安装清单里的插件（保持已安装清单的顺序）。 */
export function addedPlugins(
  installed: readonly PluginSummary[],
  current: readonly string[] | undefined,
): PluginSummary[] {
  const ids = new Set(dedupePluginIds(current ?? []));
  return installed.filter((plugin) => ids.has(plugin.id));
}

/** 类别徽标的文案键（`mcp` 的显示名即 i18n `plugins.kind.mcp` =「工具」）。 */
export const PLUGIN_KIND_LABEL_KEYS: Readonly<Record<PluginContributionKind, MessageKey>> = {
  skill: 'plugins.kind.skill',
  connector: 'plugins.kind.connector',
  mcp: 'plugins.kind.mcp',
  mail: 'plugins.kind.mail',
};

/**
 * 插件类别徽标（技能 / 连接 / 工具 / 邮件）：按贡献计数与实例声明推导。`mcp`
 * 一律显示「工具」类说法（显示名在 i18n `plugins.kind.mcp`，协议词不出现在
 * 界面）；纯实例插件（`providesInstances`）没有贡献计数也能被标出类别。
 */
export function pluginKindBadges(
  plugin: Pick<PluginSummary, 'counts' | 'providesInstances'>,
): PluginContributionKind[] {
  const kinds: PluginContributionKind[] = [];
  if (plugin.counts.skills > 0) kinds.push('skill');
  if (plugin.counts.connectors > 0) kinds.push('connector');
  if (plugin.counts.mcp > 0 || plugin.providesInstances.includes('mcp')) kinds.push('mcp');
  if (plugin.counts.mail > 0 || plugin.providesInstances.includes('mail')) kinds.push('mail');
  return kinds;
}

/**
 * 插件是否提供某类能力（徽标 + 展开细选都按它判定）：贡献计数或实例声明任一命中。
 */
export function pluginProvides(
  plugin: Pick<PluginSummary, 'counts' | 'providesInstances'>,
  kind: 'connector' | 'mail',
): boolean {
  return kind === 'connector'
    ? plugin.counts.connectors > 0
    : plugin.counts.mail > 0 || plugin.providesInstances.includes('mail');
}

/**
 * 展开细选里可勾选的工具服务（现 bot-mcp 控件，仅手动 server）：应用级已启用、
 * 且**不是**插件贡献的 server——插件 server 随插件启用集自动可用（P2 §3.3），
 * 历史勾选项读时忽略；手动 / mcpb 独立安装的维持 `mcp_server_ids` 勾选不变。
 */
export function manualToolServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter(
    (server) => server.enabled && (server.source?.kind ?? 'manual') !== 'plugin',
  );
}
