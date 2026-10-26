import type { McpServer } from '@kepcup/shared';
import type { ConnectorCatalog } from './catalog.js';
import type { AppConnectionStore } from './connection-store.js';

/**
 * Whether an MCP server's HTTP traffic must go through the SSRF-guarded fetch
 * (`createGuardedMcpFetch`, D73 P0): every endpoint that did not come from the
 * reviewed bundled snapshot. That is catalog connections from the local-connector
 * source, and — since D104 — plugin-registered servers (their http endpoints and
 * their connector entries are unreviewed package content). A plugin's embedded MCPB
 * is stdio and never reaches this predicate; answering `true` for its source kind
 * is harmless.
 *
 * Pure predicate so it is unit-testable; `start.ts` maps it onto `guardedMcpFetch`.
 */
export function useGuardedMcpFetch(
  server: McpServer,
  deps: { store: Pick<AppConnectionStore, 'get'>; catalog: ConnectorCatalog },
): boolean {
  if (server.source?.kind === 'plugin') return true;
  const row = deps.store.get(server.id);
  return (
    row !== null &&
    (deps.catalog.isLocal(row.connectorId) || deps.catalog.isPlugin(row.connectorId))
  );
}
