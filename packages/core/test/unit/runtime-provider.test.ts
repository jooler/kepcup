import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UnauthorizedContext } from '@earendil-works/pi-mcp';
import { OAUTH_REFRESH_SKEW_MS } from '@kepcup/shared';
import { startFakeOAuthMcpServer, type FakeOAuthMcpServer } from '@kepcup/testkit';

import { AppAuthRequiredError } from '../../src/apps/auth/errors.js';
import { customConnectionId } from '../../src/apps/connection-store.js';
import { ConnectionAuthRegistry } from '../../src/apps/auth/registry.js';
import {
  TEST_CLIENT_ID,
  openAppAuthEnv,
  seedConnection,
  type AppAuthEnv,
} from '../support/app-auth-env.js';

/**
 * `ConnectionAuthProvider`（D73 §4.7）against the testkit fake authorization server:
 * cached read, proactive single-flight refresh within the skew, same-token short-circuit,
 * `insufficient_scope` step-up, `invalid_grant` → expired, and "never opens a browser".
 */

let app: AppAuthEnv;
let server: FakeOAuthMcpServer;
const CONN = customConnectionId('srv');

beforeEach(async () => {
  app = openAppAuthEnv();
  server = await startFakeOAuthMcpServer({ now: () => app.env.clock.now() });
});
afterEach(async () => {
  await server.stop();
  app.dispose();
});

function unauthorized(options: {
  status?: number;
  header?: string;
  token?: string | undefined;
}): UnauthorizedContext {
  return {
    response: new Response(null, {
      status: options.status ?? 401,
      headers: options.header !== undefined ? { 'www-authenticate': options.header } : {},
    }),
    serverUrl: new URL(server.mcpUrl),
    fetch: globalThis.fetch,
    ...(options.token !== undefined ? { token: options.token } : {}),
  };
}

const refreshRequests = () =>
  server.tokenRequests.filter((request) => request.params['grant_type'] === 'refresh_token');

describe('token()', () => {
  it('returns the stored access token with no network when far from expiry', async () => {
    const { issued } = seedConnection(app, server, 'srv');
    const provider = app.registry.providerFor(CONN);
    expect(await provider.token()).toBe(issued.accessToken);
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('throws not_connected without tokens', async () => {
    app.store.ensureCustom('srv', { label: 'srv', serverUrl: server.mcpUrl });
    await expect(app.registry.providerFor(CONN).token()).rejects.toMatchObject({
      name: 'AppAuthRequiredError',
      code: 'APP_AUTH_REQUIRED',
      reason: 'not_connected',
      connectionId: CONN,
    });
  });

  it('refreshes proactively inside the skew window and saves the rotated pair', async () => {
    const { issued } = seedConnection(app, server, 'srv', {
      expiresInSec: (OAUTH_REFRESH_SKEW_MS - 5_000) / 1000,
    });
    const token = await app.registry.providerFor(CONN).token();
    expect(token).not.toBe(issued.accessToken);
    expect(refreshRequests()).toHaveLength(1);
    // The refresh carried the RFC 8707 resource and the stored client.
    expect(refreshRequests()[0]!.params).toMatchObject({
      resource: server.mcpUrl,
      client_id: 'test-client',
      refresh_token: issued.refreshToken,
    });
    const stored = app.vault.getTokens(CONN)!;
    expect(stored.accessToken).toBe(token);
    expect(stored.refreshToken).not.toBe(issued.refreshToken); // rotated
    expect(server.isAccessTokenValid(token!)).toBe(true);
    // A token fresh from the refresh is outside the window: the next read is local.
    expect(await app.registry.providerFor(CONN).token()).toBe(token);
    expect(refreshRequests()).toHaveLength(1);
  });

  it('does not refresh just outside the skew window, refreshes just inside', async () => {
    const outside = seedConnection(app, server, 'srv', {
      expiresInSec: (OAUTH_REFRESH_SKEW_MS + 2_000) / 1000,
    });
    expect(await app.registry.providerFor(CONN).token()).toBe(outside.issued.accessToken);
    expect(server.tokenRequests).toHaveLength(0);
    app.env.clock.set(app.env.clock.now() + 3_000); // now 1s past the boundary
    expect(await app.registry.providerFor(CONN).token()).not.toBe(outside.issued.accessToken);
    expect(refreshRequests()).toHaveLength(1);
  });

  it('single-flight: concurrent callers share one refresh request', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    const provider = app.registry.providerFor(CONN);
    const tokens = await Promise.all(Array.from({ length: 6 }, () => provider.token()));
    expect(new Set(tokens).size).toBe(1);
    expect(refreshRequests()).toHaveLength(1);
  });

  it('invalid_grant on refresh → expired + persisted status, and the dead refresh token is not retried', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    server.failToken({ grantType: 'refresh_token', error: 'invalid_grant', times: Infinity });
    const provider = app.registry.providerFor(CONN);
    await expect(provider.token()).rejects.toMatchObject({ reason: 'expired' });
    expect(app.store.get(CONN)!.status).toBe('expired');
    expect(app.statuses).toEqual([{ connectionId: CONN, status: 'expired' }]);
    expect(refreshRequests()).toHaveLength(1);
    // The access token is still inside its lifetime but near expiry: it is served without
    // asking the authorization server again.
    expect(await provider.token()).toBe(app.vault.getTokens(CONN)!.accessToken);
    expect(refreshRequests()).toHaveLength(1);
  });

  it('a transient refresh failure keeps serving a still-valid token, but surfaces once it is really expired', async () => {
    const { issued } = seedConnection(app, server, 'srv', { expiresInSec: 30 });
    server.failToken({
      grantType: 'refresh_token',
      error: 'server_error',
      status: 500,
      times: Infinity,
    });
    const provider = app.registry.providerFor(CONN);
    expect(await provider.token()).toBe(issued.accessToken);
    expect(app.store.get(CONN)!.status).toBe('connected');
    app.env.clock.set(app.env.clock.now() + 60_000); // the access token is now expired
    const failure = await provider.token().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AppAuthRequiredError); // a fault, not a reconnect request
    expect(app.store.get(CONN)!.status).toBe('connected');
  });

  it('expired access token without a refresh token → expired', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10, refresh: false });
    app.env.clock.set(app.env.clock.now() + 60_000);
    await expect(app.registry.providerFor(CONN).token()).rejects.toMatchObject({
      reason: 'expired',
    });
    expect(app.store.get(CONN)!.status).toBe('expired');
  });

  it('a successful refresh after expiry flips the status back to connected', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    app.store.setStatus(CONN, 'expired');
    await app.registry.providerFor(CONN).token();
    expect(app.store.get(CONN)!.status).toBe('connected');
    expect(app.statuses.at(-1)).toEqual({ connectionId: CONN, status: 'connected' });
  });
});

describe('onUnauthorized()', () => {
  it('returns without refreshing when the request used an older token (another request already refreshed)', async () => {
    seedConnection(app, server, 'srv');
    const provider = app.registry.providerFor(CONN);
    await provider.onUnauthorized(unauthorized({ token: 'an-older-token' }));
    expect(server.tokenRequests).toHaveLength(0);
  });

  it('401 with the current token → one refresh, then the transport retries', async () => {
    const { issued } = seedConnection(app, server, 'srv');
    const provider = app.registry.providerFor(CONN);
    await provider.onUnauthorized(
      unauthorized({ token: issued.accessToken, header: 'Bearer error="invalid_token"' }),
    );
    expect(refreshRequests()).toHaveLength(1);
    expect(app.vault.getTokens(CONN)!.accessToken).not.toBe(issued.accessToken);
  });

  it('401 with a rejected refresh token (invalid_grant) → expired, never a browser', async () => {
    const { issued } = seedConnection(app, server, 'srv');
    server.revokeToken(issued.refreshToken!);
    const provider = app.registry.providerFor(CONN);
    const error = await provider
      .onUnauthorized(unauthorized({ token: issued.accessToken }))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppAuthRequiredError);
    expect(error).toMatchObject({ reason: 'expired', connectionId: CONN });
    expect(app.store.get(CONN)!.status).toBe('expired');
    // No authorization request of any kind reached the server.
    expect(server.authorizeRequests).toHaveLength(0);
  });

  it('401 without a refresh token → expired', async () => {
    const { issued } = seedConnection(app, server, 'srv', { refresh: false });
    await expect(
      app.registry.providerFor(CONN).onUnauthorized(unauthorized({ token: issued.accessToken })),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('403 insufficient_scope → needs_scope with the step-up scope set (granted ∪ challenged), no refresh', async () => {
    const { issued } = seedConnection(app, server, 'srv', { scope: ['read'] });
    const provider = app.registry.providerFor(CONN);
    const error = await provider
      .onUnauthorized(
        unauthorized({
          status: 403,
          token: issued.accessToken,
          header: 'Bearer error="insufficient_scope", scope="write admin"',
        }),
      )
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppAuthRequiredError);
    expect((error as AppAuthRequiredError).reason).toBe('scope');
    expect((error as AppAuthRequiredError).scopes).toEqual(['read', 'write', 'admin']);
    expect(app.store.get(CONN)!.status).toBe('needs_scope');
    expect(app.statuses).toEqual([{ connectionId: CONN, status: 'needs_scope' }]);
    expect(server.tokenRequests).toHaveLength(0);
    expect(server.authorizeRequests).toHaveLength(0);
  });

  it('401 without any tokens → not_connected', async () => {
    app.store.ensureCustom('srv', { label: 'srv', serverUrl: server.mcpUrl });
    await expect(
      app.registry.providerFor(CONN).onUnauthorized(unauthorized({})),
    ).rejects.toMatchObject({ reason: 'not_connected' });
  });
});

describe('registry', () => {
  it('keeps one provider per connection and ignores status writes for unknown rows', () => {
    const first = app.registry.providerFor(CONN);
    expect(app.registry.providerFor(CONN)).toBe(first);
    expect(app.registry.providerFor(customConnectionId('other'))).not.toBe(first);
    app.registry.setStatus('custom:ghost', 'expired');
    expect(app.statuses).toEqual([]);
  });

  it('invalidate() clears the dead-refresh memory and resets failures / drops the cached client on the bound McpService', async () => {
    const calls: string[] = [];
    app.registry.bindMcp({
      resetFailures: (serverId) => calls.push(`reset:${serverId}`),
      closeServer: async (serverId) => {
        calls.push(`close:${serverId}`);
      },
    });
    const { issued } = seedConnection(app, server, 'srv', { expiresInSec: 10 });
    server.failToken({ grantType: 'refresh_token', error: 'invalid_grant', times: 1 });
    const provider = app.registry.providerFor(CONN);
    await expect(provider.token()).rejects.toMatchObject({ reason: 'expired' });
    // The interactive flow stores a new pair and invalidates: refresh works again.
    const fresh = server.issueToken({ clientId: 'test-client' });
    app.vault.saveTokens(CONN, {
      access_token: fresh.accessToken,
      token_type: 'Bearer',
      refresh_token: fresh.refreshToken!,
      expires_in: 3600,
    });
    await app.registry.invalidate(CONN);
    expect(calls).toEqual(['reset:srv', 'close:srv']);
    expect(await provider.token()).toBe(fresh.accessToken);
    expect(issued.accessToken).not.toBe(fresh.accessToken);
  });
});

describe('per-connection client (D73 review: DCR client overwritten by another connection)', () => {
  it('two connections on one issuer: the second re-registers (issuer client replaced), the first still refreshes with its own client', async () => {
    // Connection A authorised with `test-client`; B later re-registered on another port and the
    // issuer-level client became `other-client`.
    seedConnection(app, server, 'a', { expiresInSec: 10 });
    app.vault.saveConnectionClient(customConnectionId('a'), { client_id: TEST_CLIENT_ID });
    server.addPreregisteredClient({
      clientId: 'other-client',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const issuedB = server.issueToken({ clientId: 'other-client' });
    app.store.ensureCustom('b', { label: 'b', serverUrl: server.mcpUrl });
    app.vault.saveDiscovery(
      customConnectionId('b'),
      app.vault.getDiscovery(customConnectionId('a'))!,
    );
    app.vault.saveTokens(customConnectionId('b'), {
      access_token: issuedB.accessToken,
      token_type: 'Bearer',
      refresh_token: issuedB.refreshToken!,
      expires_in: 10,
    });
    app.vault.saveConnectionClient(customConnectionId('b'), { client_id: 'other-client' });
    app.vault.saveClient(server.issuer, { client_id: 'other-client' }, { source: 'dcr' });

    const tokenA = await app.registry.providerFor(customConnectionId('a')).token();
    const tokenB = await app.registry.providerFor(customConnectionId('b')).token();
    expect(tokenA).not.toBe(app.vault.getTokens(customConnectionId('b'))!.accessToken);
    expect(refreshRequests().map((request) => request.params['client_id'])).toEqual([
      TEST_CLIENT_ID,
      'other-client',
    ]);
    expect(app.store.get(customConnectionId('a'))!.status).toBe('connected');
    expect(tokenB).toBe(app.vault.getTokens(customConnectionId('b'))!.accessToken);
  });

  it('falls back to the issuer client when the connection has no record (data from before the record existed)', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    await app.registry.providerFor(CONN).token();
    expect(refreshRequests()[0]!.params['client_id']).toBe(TEST_CLIENT_ID);
  });

  it('prefers the recorded client over the issuer client for CIMD-obtained connections too', () => {
    seedConnection(app, server, 'srv');
    const discovery = app.vault.getDiscovery(CONN)!;
    discovery.authorizationServerMetadata = {
      ...discovery.authorizationServerMetadata!,
      client_id_metadata_document_supported: true,
    };
    app.vault.saveConnectionClient(CONN, { client_id: 'https://kepcup.test/client.json' });
    expect(app.registry.clientFor(CONN, server.issuer, discovery)).toEqual({
      client_id: 'https://kepcup.test/client.json',
    });
    // No record → the stored issuer client, then CIMD only without any stored client.
    app.vault.clearConnection(CONN);
    expect(app.registry.clientFor(CONN, server.issuer, discovery)).toEqual({
      client_id: TEST_CLIENT_ID,
    });
  });
});

describe('refresh in flight when the connection is disconnected (D73 review)', () => {
  function gatedRegistry(): {
    registry: ConnectionAuthRegistry;
    started: Promise<void>;
    release(): void;
  } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registry = new ConnectionAuthRegistry({
      vault: app.vault,
      store: app.store,
      clock: app.env.clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
      onStatus: (payload) => app.statuses.push(payload),
      fetchFor: () => async (input, init) => {
        markStarted();
        await gate;
        return globalThis.fetch(input, init);
      },
    });
    return { registry, started, release };
  }

  it('the late refresh result is discarded: no tokens are written back after the disconnect', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    const { registry, started, release } = gatedRegistry();
    const pending = registry
      .providerFor(CONN)
      .token()
      .catch((error: unknown) => error);
    await started;
    // What apps.disconnect does: invalidate the in-flight refresh, then clear the Vault.
    registry.discardInflight(CONN);
    app.vault.clearConnection(CONN);
    release();
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(AppAuthRequiredError);
    expect(outcome).toMatchObject({ reason: 'not_connected' });
    expect(app.vault.getTokens(CONN)).toBeNull();
    expect(app.store.get(CONN)!.status).toBe('not_connected');
    expect(app.store.get(CONN)!.tokenExpiresAt).toBeNull();
  });

  it('a permanent grant error that lands after the disconnect does not flip the status to expired', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    server.failToken({ grantType: 'refresh_token', error: 'invalid_grant', times: 1 });
    const { registry, started, release } = gatedRegistry();
    const pending = registry
      .providerFor(CONN)
      .token()
      .catch((error: unknown) => error);
    await started;
    await registry.invalidate(CONN);
    app.vault.clearConnection(CONN);
    release();
    expect(await pending).toMatchObject({ reason: 'not_connected' });
    expect(app.store.get(CONN)!.status).toBe('not_connected');
  });

  it('a reconnect that completed during the refresh wins: the new tokens are used, the stale result dropped', async () => {
    seedConnection(app, server, 'srv', { expiresInSec: 10 });
    const { registry, started, release } = gatedRegistry();
    const pending = registry.providerFor(CONN).token();
    await started;
    const fresh = server.issueToken({ clientId: TEST_CLIENT_ID });
    app.vault.saveTokens(CONN, {
      access_token: fresh.accessToken,
      token_type: 'Bearer',
      refresh_token: fresh.refreshToken!,
      expires_in: 3600,
    });
    await registry.invalidate(CONN);
    release();
    expect(await pending).toBe(fresh.accessToken);
    expect(app.vault.getTokens(CONN)!.accessToken).toBe(fresh.accessToken);
  });
});

describe('providerFor with the URL in use (defense in depth)', () => {
  it('refuses when the connection row records another URL or no row exists; accepts the same endpoint', () => {
    seedConnection(app, server, 'srv');
    expect(() => app.registry.providerFor(CONN, server.mcpUrl)).not.toThrow();
    expect(() => app.registry.providerFor(CONN, 'https://attacker.example/mcp')).toThrow(
      AppAuthRequiredError,
    );
    expect(() => app.registry.providerFor(CONN, null)).toThrow(AppAuthRequiredError);
    expect(() => app.registry.providerFor(customConnectionId('ghost'), server.mcpUrl)).toThrow(
      AppAuthRequiredError,
    );
    // No URL given (non-mcp callers): unchanged behaviour.
    expect(() => app.registry.providerFor(CONN)).not.toThrow();
  });
});

describe('never interactive', () => {
  it('the runtime provider does not import the interactive OAuth flow or the shell', () => {
    const source = readFileSync(
      new URL('../../src/apps/auth/runtime-provider.ts', import.meta.url),
      'utf8',
    );
    const imports = source
      .split('\n')
      .filter((line) => /^import |^\} from /.test(line))
      .join('\n');
    for (const forbidden of [
      'authorizeMcp',
      'adaptOAuthProvider',
      'McpOAuthProvider',
      'startAuthorization',
      'shell',
      'flow.js',
    ]) {
      expect(imports).not.toContain(forbidden);
    }
  });
});
