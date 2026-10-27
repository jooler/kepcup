import {
  mcpbUserConfigValueSchema,
  type McpbUserConfigValue,
  type PluginInspectOutput,
} from '@kepcup/shared';

/**
 * Pure rendering / validation helpers for `kepcup-server plugin install` (D104 P2 step 7).
 * Kept out of `cli.ts` so the summary is unit-testable without parsing process.argv.
 */

export type PluginUserConfig = Record<string, Record<string, McpbUserConfigValue>>;

export class PluginConfigError extends Error {}

/** Parses `--config` without ever echoing the file's values. */
export function parseUserConfigText(text: string): PluginUserConfig {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new PluginConfigError('--config 文件不是合法的 JSON（内容不会显示）');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new PluginConfigError('--config 需要对象：{ "<mcpId>": { "<key>": 值 } }');
  }
  const result: PluginUserConfig = {};
  for (const [mcpId, values] of Object.entries(json)) {
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new PluginConfigError(`--config 里 ${mcpId} 的值需要是一个对象`);
    }
    result[mcpId] = {};
    for (const [key, value] of Object.entries(values)) {
      const parsed = mcpbUserConfigValueSchema.safeParse(value);
      if (!parsed.success) {
        throw new PluginConfigError(`--config 里 ${mcpId}.${key} 的类型不受支持`);
      }
      result[mcpId][key] = parsed.data;
    }
  }
  return result;
}

/**
 * Required MCPB user_config keys that neither the file nor the field default provides. On an
 * update / same-id reinstall (`info.update !== null`) a blank required **sensitive** field is
 * not missing: core keeps the stored secret (P1-2 keep-secrets) and rejects with a clear
 * INVALID_INPUT if none is stored — the same rule the desktop consent panel applies.
 */
export function missingRequiredUserConfig(
  info: Pick<PluginInspectOutput, 'mcp' | 'update'>,
  provided: PluginUserConfig,
): string[] {
  const updating = info.update !== null;
  const missing: string[] = [];
  for (const item of info.mcp) {
    if (item.kind !== 'mcpb') continue;
    const values = provided[item.id] ?? {};
    for (const field of item.userConfigFields) {
      if (!field.required) continue;
      if (updating && field.sensitive) continue;
      const value = values[field.key] ?? field.default;
      const empty =
        value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
      if (empty) missing.push(`${item.id}.${field.key}`);
    }
  }
  return missing;
}

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable inspection summary printed before the confirmation prompt. */
export function formatPluginInspection(info: PluginInspectOutput): string {
  const lines: string[] = [];
  lines.push(`插件：${info.name}（${info.id}@${info.version}）`);
  lines.push(`来源：${info.origin} · 分级：${info.tier}`);
  lines.push(`包 sha256：${info.packageSha256}（${bytes(info.sizeBytes)}）`);
  if (info.author !== null) lines.push(`作者：${info.author}`);
  if (info.homepage !== null) lines.push(`主页：${info.homepage}`);
  lines.push('');

  lines.push(`技能（${info.skills.length}）：`);
  for (const skill of info.skills) {
    const state = skill.compatible ? '' : `（不兼容：${skill.incompatibleReason ?? '未知原因'}）`;
    lines.push(`  - ${skill.name}：${skill.description}${state}`);
  }
  if (info.skills.length === 0) lines.push('  （无）');

  lines.push(`MCP 服务器（${info.mcp.length}）：`);
  for (const item of info.mcp) {
    if (item.kind === 'mcpb') {
      const runtime =
        item.runtime === null
          ? '不需要运行时'
          : `${item.runtime.kind} ${item.runtime.available ? '已就绪' : '未安装'}`;
      lines.push(
        `  - [${item.id}] ${item.displayName}：内嵌 MCPB，启动 ${item.launchCommand}，运行时 ${runtime}，sha256 ${item.mcpbSha256}`,
      );
      for (const field of item.userConfigFields) {
        lines.push(
          `      user_config：${field.key}${field.required ? '（必填）' : ''}${field.sensitive ? '（敏感）' : ''}`,
        );
      }
    } else {
      lines.push(`  - [${item.id}] ${item.displayName}：${item.url}`);
    }
  }
  if (info.mcp.length === 0) lines.push('  （无）');

  lines.push(`连接器（${info.connectors.length}）：`);
  for (const connector of info.connectors) {
    lines.push(
      `  - [${connector.slug}] ${connector.title}：${connector.authKind}，主机 ${connector.hosts.join(', ') || '（无）'}` +
        `${connector.scopes.length > 0 ? `，范围 ${connector.scopes.join(', ')}` : ''}（装好后需另行连接）`,
    );
  }
  if (info.connectors.length === 0) lines.push('  （无）');

  lines.push(`邮件模板（${info.mail.length}）：`);
  for (const template of info.mail) {
    lines.push(
      `  - ${template.label}（${template.id}）：imap ${template.imapHost} / smtp ${template.smtpHost}`,
    );
  }
  if (info.mail.length === 0) lines.push('  （无）');

  if (info.existing !== null) {
    lines.push('');
    lines.push(`已安装版本：${info.existing.version}（本地同 id 重装按更新处理）`);
  }
  if (info.update !== null) {
    lines.push(
      `更新：${info.update.from} → ${info.version}${info.update.permissionsExpanded ? `，权限扩大（${info.update.added.join(', ')}）` : ''}`,
    );
  }
  if (info.conflicts.length > 0) {
    lines.push('');
    lines.push('冲突：');
    for (const conflict of info.conflicts) {
      lines.push(`  - ${conflict.kind} ${conflict.ref} ↔ ${conflict.withWhat}`);
    }
  }
  if (info.blockers.length > 0) {
    lines.push('');
    lines.push('阻断项：');
    for (const blocker of info.blockers) lines.push(`  - ${blocker}`);
  }
  if (info.tier === 'developer') {
    lines.push('');
    lines.push('警告：本地插件未经审核；连接器工具每次调用都会逐项确认。');
  }
  return `${lines.join('\n')}\n`;
}
