import {
  CONNECTOR_META_KEY,
  connectorCatalogEntrySchema,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';

/**
 * 连接应用目录条目的测试样板（D73 P1）：合法的 `server.json` 子集 + `_meta` 扩展，
 * 连接行的 `connector_id` 即清单 `name`（`com.{slug}/mcp`）。
 */
export function connectorEntry(
  slug: string,
  options: {
    title?: string;
    description?: string;
    tier?: 'builtin' | 'verified' | 'community' | 'developer';
    toolPolicy?: Record<string, { risk: 'read' | 'write' | 'destructive' }>;
  } = {},
): ConnectorCatalogEntry {
  return connectorCatalogEntrySchema.parse({
    name: `com.${slug}/mcp`,
    title: options.title ?? slug.toUpperCase(),
    description: options.description ?? `${slug} 的测试连接器`,
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: `https://mcp.${slug}.test/mcp` }],
    _meta: {
      [CONNECTOR_META_KEY]: {
        slug,
        icon: `${slug}.svg`,
        category: 'other',
        tier: options.tier ?? 'builtin',
        auth: {
          kind: 'oauth',
          registration: 'auto',
          clientRef: null,
          scopes: { default: [], write: [] },
        },
        toolPolicy: options.toolPolicy ?? {},
        privacyPolicy: `https://${slug}.test/privacy`,
        releaseGate: `gate-${slug}`,
      },
    },
  });
}

/** `connectorId` of the connection row for an entry. */
export const connectorIdOf = (entry: ConnectorCatalogEntry): string => entry.name;
