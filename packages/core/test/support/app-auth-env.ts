import type { OAuthServerInfo } from '@earendil-works/pi-mcp/oauth';
import type { AppConnection, AppConnectionStatusPayload } from '@kepcup/shared';
import type { FakeOAuthMcpServer, IssuedToken } from '@kepcup/testkit';

import { ConnectionAuthRegistry } from '../../src/apps/auth/registry.js';
import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import { TokenVault } from '../../src/apps/token-vault.js';
import { openRealMainDb, type RealMainDb } from './real-secrets.js';

export const TEST_CLIENT_ID = 'test-client';

const LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

export interface AppAuthEnv {
  env: RealMainDb;
  store: AppConnectionStore;
  vault: TokenVault;
  registry: ConnectionAuthRegistry;
  statuses: AppConnectionStatusPayload[];
  dispose(): void;
}

/** Real encrypted main.db + store + vault + registry (no core, no network). */
export function openAppAuthEnv(): AppAuthEnv {
  const env = openRealMainDb();
  env.clock.set(1_000_000);
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const vault = new TokenVault({ secrets: env.secrets, store, clock: env.clock });
  const statuses: AppConnectionStatusPayload[] = [];
  const registry = new ConnectionAuthRegistry({
    vault,
    store,
    clock: env.clock,
    logger: LOGGER,
    onStatus: (payload) => statuses.push(payload),
  });
  return { env, store, vault, registry, statuses, dispose: () => env.dispose() };
}

/** Discovery document equivalent to what the interactive flow saves for the fake server. */
export function discoveryOf(server: FakeOAuthMcpServer): OAuthServerInfo {
  return {
    authorizationServerUrl: server.issuer,
    authorizationServerMetadata: {
      issuer: server.issuer,
      authorization_endpoint: server.authorizationEndpoint,
      token_endpoint: server.tokenEndpoint,
      revocation_endpoint: server.revocationEndpoint,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    },
    resourceMetadata: { resource: server.mcpUrl, authorization_servers: [server.issuer] },
  };
}

/**
 * Stands in for a finished interactive flow (tests never run it): connection row, discovery,
 * a manually registered client, and a token pair issued by the fake server and saved through
 * the Vault. `expiresInSec` is what the vault records (the server's own expiry is separate).
 */
export function seedConnection(
  app: AppAuthEnv,
  server: FakeOAuthMcpServer,
  serverId: string,
  options: { scope?: string[]; expiresInSec?: number; label?: string; refresh?: boolean } = {},
): { connection: AppConnection; issued: IssuedToken } {
  const connectionId = customConnectionId(serverId);
  app.store.ensureCustom(serverId, { label: options.label ?? serverId, serverUrl: server.mcpUrl });
  app.vault.saveDiscovery(connectionId, discoveryOf(server));
  app.vault.saveClient(server.issuer, { client_id: TEST_CLIENT_ID }, { source: 'manual' });
  const issued = server.issueToken({
    clientId: TEST_CLIENT_ID,
    scope: options.scope ?? [],
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
  });
  app.vault.saveTokens(connectionId, {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    ...(issued.refreshToken !== null ? { refresh_token: issued.refreshToken } : {}),
    expires_in: options.expiresInSec ?? 3600,
    ...(issued.scope.length > 0 ? { scope: issued.scope.join(' ') } : {}),
  });
  const connection = app.store.setStatus(connectionId, 'connected');
  return { connection, issued };
}
