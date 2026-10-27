import type {
  PluginConsentConnector,
  PluginConsentMail,
  PluginConsentMcp,
  PluginConsentSkill,
} from '@kepcup/shared';

/**
 * Permission-token derivation for plugin updates (D104 P1-2 step 3): the consent
 * items a manifest produces are normalized into one token per demanded capability
 * (skill name, connector slug, host, OAuth scope, MCP server, runtime, config
 * field, mail template). A new version "expands permissions" iff its token set
 * has tokens the installed version's set lacks — only removals never expand.
 * Pure functions; the consent panel diff (P1-3) reuses `describePermission`.
 */

export interface ConsentItems {
  skills: PluginConsentSkill[];
  connectors: PluginConsentConnector[];
  mcp: PluginConsentMcp[];
  mail: PluginConsentMail[];
}

/** Canonical permission tokens of one consent view (one kind per prefix, prefix + colon). */
export function permissionTokens(items: ConsentItems): Set<string> {
  const tokens = new Set<string>();
  for (const skill of items.skills) tokens.add(`skill:${skill.name}`);
  for (const connector of items.connectors) {
    tokens.add(`connector:${connector.slug}`);
    for (const host of connector.hosts) tokens.add(`host:${host.toLowerCase()}`);
    for (const scope of connector.scopes) tokens.add(`scope:${connector.slug}:${scope}`);
  }
  for (const item of items.mcp) {
    if (item.kind === 'mcpb') {
      tokens.add(`mcpb:${item.id}`);
      if (item.runtime !== null) tokens.add(`runtime:${item.runtime.kind}`);
      for (const field of item.userConfigFields) tokens.add(`config:${item.id}:${field.key}`);
    } else {
      tokens.add(`mcp-http:${item.id}`);
      tokens.add(`host:${item.host.toLowerCase()}`);
    }
  }
  for (const template of items.mail) tokens.add(`mail:${template.id}`);
  return tokens;
}

export interface PermissionDiff {
  /** The new set demands at least one token the old set did not. */
  expanded: boolean;
  /** Tokens only the new set has, sorted (stable for snapshots / tests). */
  added: string[];
}

/** `expanded` = tokens present in the new set but missing from the old one (只删不增 = 不扩大). */
export function diffPermissions(
  oldTokens: ReadonlySet<string>,
  newTokens: ReadonlySet<string>,
): PermissionDiff {
  const added = [...newTokens].filter((token) => !oldTokens.has(token)).sort();
  return { expanded: added.length > 0, added };
}

function runtimeLabel(kind: string): string {
  return kind === 'node' ? 'Node.js' : kind === 'python' ? 'Python' : kind === 'uv' ? 'uv' : kind;
}

/** One token → one Chinese line for the consent panel's "new permissions" list. */
export function describePermission(token: string): string {
  const colon = token.indexOf(':');
  if (colon <= 0) return token;
  const prefix = token.slice(0, colon);
  const rest = token.slice(colon + 1);
  switch (prefix) {
    case 'skill':
      return `新增技能 ${rest}（对所有 Bot 可见）`;
    case 'connector':
      return `新增连接应用 ${rest}`;
    case 'host':
      return `新增网络主机 ${rest}`;
    case 'scope': {
      const sep = rest.indexOf(':');
      return sep > 0
        ? `应用 ${rest.slice(0, sep)} 新增授权范围 ${rest.slice(sep + 1)}`
        : `新增授权范围 ${rest}`;
    }
    case 'mcpb':
      return `新增本地 MCP 服务器 ${rest}`;
    case 'mcp-http':
      return `新增远端 MCP 服务器 ${rest}`;
    case 'runtime':
      return `需要 ${runtimeLabel(rest)} 运行时`;
    case 'config': {
      const sep = rest.indexOf(':');
      return sep > 0
        ? `MCP 服务器 ${rest.slice(0, sep)} 新增配置项 ${rest.slice(sep + 1)}`
        : `新增配置项 ${rest}`;
    }
    case 'mail':
      return `新增邮件模板 ${rest}`;
    default:
      return token;
  }
}
