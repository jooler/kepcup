import type { McpbUserConfigValue, McpServer, PluginInspectOutput } from '@kepcup/shared';
import { parsePluginSkillSource } from '@kepcup/shared';
import {
  buildUserConfig,
  clearSensitive,
  initialForm,
  missingRequired,
  type McpbForm,
} from '../settings/mcpb-install';

/**
 * 插件安装表单的纯函数（D104 P0a-3）：键 = mcp 贡献 id，值 = 该 MCPB 的表单（复用
 * `settings/mcpb-install.ts` 的 `McpbForm` 与转换规则）。组件本身只管界面状态；
 * 技能 / MCP / 连接器的来源判定也在这里（渲染层不重复实现 shared 的解析）。
 */

export type PluginForm = Record<string, McpbForm>;

/** 为检视结果里的每个内嵌 MCPB 播一张初始表单（按字段默认值）。 */
export function initialPluginForm(info: PluginInspectOutput): PluginForm {
  const form: PluginForm = {};
  for (const item of info.mcp) {
    if (item.kind === 'mcpb') form[item.id] = initialForm(item.userConfigFields);
  }
  return form;
}

/** 汇总各 MCPB 的必填缺项，每项带上「{displayName}」前缀。 */
export function missingPluginConfig(info: PluginInspectOutput, form: PluginForm): string[] {
  // 更新（P1-2）：必填敏感字段留空 = 保留已存 secret（面板的 keepSecrets 提示），
  // 不算缺项——否则「留空保留」的更新流程会被禁用的确认按钮堵死。
  const updating = info.update !== null;
  const missing: string[] = [];
  for (const item of info.mcp) {
    if (item.kind !== 'mcpb') continue;
    for (const title of missingRequired(item.userConfigFields, form[item.id] ?? {}, updating)) {
      missing.push(`「${item.displayName}」${title}`);
    }
  }
  return missing;
}

/** 每个 mcpb id → 该包的 `userConfig`（没有值的 id 也保留为 `{}`）。 */
export function buildPluginUserConfig(
  info: PluginInspectOutput,
  form: PluginForm,
): Record<string, Record<string, McpbUserConfigValue>> {
  const result: Record<string, Record<string, McpbUserConfigValue>> = {};
  for (const item of info.mcp) {
    if (item.kind !== 'mcpb') continue;
    result[item.id] = buildUserConfig(item.userConfigFields, form[item.id] ?? {});
  }
  return result;
}

/** 提交后清空敏感字段（密码框不留明文），其余保持。 */
export function clearPluginSensitive(info: PluginInspectOutput, form: PluginForm): PluginForm {
  const next: PluginForm = {};
  for (const item of info.mcp) {
    if (item.kind !== 'mcpb') continue;
    next[item.id] = clearSensitive(item.userConfigFields, form[item.id] ?? {});
  }
  return next;
}

/** 确认按钮能否点：检视判定可安装、必填项齐全，且权限扩大差异已勾选确认（P1-2）。 */
export function canInstallPlugin(
  info: PluginInspectOutput,
  missing: readonly string[],
  ackDiff = false,
): boolean {
  const diffAcknowledged = info.update?.permissionsExpanded === true ? ackDiff : true;
  return info.installable && missing.length === 0 && diffAcknowledged;
}

/** 技能来源标记 `plugin://{pluginId}/{skillName}` → 插件 id；其他来源返回 null。 */
export function pluginIdOfSkillSource(sourceUrl: string): string | null {
  return parsePluginSkillSource(sourceUrl)?.pluginId ?? null;
}

/** 受插件管理的 MCP server → 插件 id；其他 server 返回 null。 */
export function managedServerPluginId(server: McpServer): string | null {
  return server.source?.kind === 'plugin' ? server.source.pluginId : null;
}
