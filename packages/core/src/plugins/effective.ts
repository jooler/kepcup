import type { BotProfile } from '@kepcup/shared';

/**
 * P2 注入模型的有效启用集（todo/plugin-platform/P2-injection.md §3.1）：
 * `effective(bot, conversation) = profile.runtime.plugin_ids ∪ (项目会话 ? project_plugins : ∅)`。
 *
 * 唯一实现，五处装配点（skills / mcp / connections / mail / 外部智能体能力包）
 * 经各自的 `extraPluginIds` 参数消费它。只做可见性过滤——审批 / 风险 / 锁定 /
 * 污点语义一概不在此处（degrade 原则，§3.8）。
 *
 * 调用方约定：`projectPlugins` 只在会话为 `type:'project'` 时读 `project_plugins`
 * （一次读取，不进缓存），非项目会话传空；`plugin_ids` 缺失 = 未启用任何插件。
 */
export function effectivePluginIds(
  botProfile: Pick<BotProfile, 'runtime'>,
  projectPlugins: readonly string[] = [],
): Set<string> {
  return new Set([...(botProfile.runtime.plugin_ids ?? []), ...projectPlugins]);
}
