import { afterEach, describe, expect, it } from 'vitest';
import type { AppCatalogEntry, OAuthClientView } from '@kepcup/shared';
import { startCatalogEnv, until, type CatalogEnv } from '../support/catalog-connect-env.js';

/**
 * D73 P2 §6.4：预注册客户端（`clientRef` → oauth-clients.json 表）与用户自带（BYO）客户端。
 * 真实 core + testkit 假授权 / MCP 服务器；全部不访问真实网络。
 */

const envs: CatalogEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0).reverse()) await env.cleanup();
});
async function start(options: Parameters<typeof startCatalogEnv>[0] = {}): Promise<CatalogEnv> {
  const env = await startCatalogEnv(options);
  envs.push(env);
  return env;
}

const ECHO = { name: 'echo', description: 'Echo', annotations: { readOnlyHint: true } };

async function catalogEntry(env: CatalogEnv, slug: string): Promise<AppCatalogEntry> {
  const { entries } = (await env.core.rpc.call('apps.catalog.list', undefined)) as {
    entries: AppCatalogEntry[];
  };
  return entries.find((entry) => entry.connectorId === slug)!;
}

async function listClients(env: CatalogEnv): Promise<OAuthClientView[]> {
  const { clients } = (await env.core.rpc.call('apps.oauthClients.list', undefined)) as {
    clients: OAuthClientView[];
  };
  return clients;
}

/** Saves a custom OAuth server pointing at the fake and connects it through the RPC flow. */
async function connectCustom(env: CatalogEnv, serverId: string): Promise<string> {
  await env.core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: serverId,
        name: 'Custom Fake',
        transport: 'http',
        url: env.fake.mcpUrl,
        enabled: true,
        autoApprove: false,
        auth: 'oauth',
      },
    ],
  });
  const { flowId } = (await env.core.rpc.call('apps.connect', {
    target: { kind: 'custom', serverId },
  })) as { flowId: string };
  await until(
    () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'),
    20_000,
    'custom flow done',
  );
  return flowId;
}

describe('pre-registered clients (clientRef)', () => {
  it('connects a public PKCE client end to end; no DCR, authorize carries the table client_id', async () => {
    const env = await start({
      fake: { dcrEnabled: false, cimdSupported: false, tools: [ECHO] },
      entry: { registration: 'preregistered', clientRef: 'bigco-desktop' },
      preregisteredClients: (fake) => ({
        'bigco-desktop': { issuer: fake.issuer, clientId: 'kepcup-desktop' },
      }),
    });
    env.fake.addPreregisteredClient({
      clientId: 'kepcup-desktop',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    expect((await catalogEntry(env, 'fake')).connectable).toBe(true);

    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    expect(env.fake.registrations).toHaveLength(0);
    const authorize = env.fake.authorizeRequests[0]!;
    expect(authorize.params.client_id).toBe('kepcup-desktop');
    expect(authorize.params.code_challenge_method).toBe('S256');
    expect(authorize.clientSource).toBe('preregistered');
    expect(env.fake.tokenRequests[0]!.params.client_id).toBe('kepcup-desktop');
    // The connection remembers the client it was authorized with (refresh / revoke use it).
    const vault = env.core.services.apps!.vault;
    const row = env.core.services.apps!.store.list()[0]!;
    expect(vault.getConnectionClient(row.id)?.client_id).toBe('kepcup-desktop');
    // The table is not copied into the issuer-level vault.
    expect(await listClients(env)).toEqual([]);
  });

  it('a non-confidential client secret from the table is sent to the token endpoint', async () => {
    const env = await start({
      fake: { dcrEnabled: false, cimdSupported: false, tools: [ECHO] },
      entry: { registration: 'preregistered', clientRef: 'bigco-desktop' },
      preregisteredClients: (fake) => ({
        'bigco-desktop': {
          issuer: fake.issuer,
          clientId: 'kepcup-desktop',
          clientSecret: 'desktop-secret',
        },
      }),
    });
    env.fake.addPreregisteredClient({
      clientId: 'kepcup-desktop',
      clientSecret: 'desktop-secret',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    expect(env.fake.tokenRequests[0]!.status).toBe(200);
  });

  it('a table client whose issuer differs from the discovered one fails the flow (no DCR / CIMD fall-through)', async () => {
    // DCR and CIMD are both available at the fake: the old fall-through would register KepCup there.
    const env = await start({
      fake: { dcrEnabled: true, cimdSupported: false, tools: [ECHO] },
      entry: { registration: 'preregistered', clientRef: 'bigco-desktop' },
      preregisteredClients: () => ({
        'bigco-desktop': { issuer: 'https://other.example.com', clientId: 'kepcup-desktop' },
      }),
    });
    const { flowId } = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'fake' },
    })) as { flowId: string };
    const failed = await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'failed'),
      10_000,
      'issuer mismatch',
    );
    expect(failed.error?.code).toBe('OAUTH_ISSUER_MISMATCH');
    expect(env.fake.registrations).toHaveLength(0);
    expect(env.fake.authorizeRequests).toHaveLength(0);
    expect(env.core.services.apps!.store.list()).toHaveLength(0);
  });

  it('a BYO client still resolves a preregistered entry whose table issuer mismatches', async () => {
    const env = await start({
      fake: { dcrEnabled: false, cimdSupported: false, tools: [ECHO] },
      entry: { registration: 'preregistered', clientRef: 'bigco-desktop' },
      preregisteredClients: () => ({
        'bigco-desktop': { issuer: 'https://other.example.com', clientId: 'kepcup-desktop' },
      }),
    });
    env.fake.addPreregisteredClient({
      clientId: 'byo-client',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'byo-client',
    });
    expect((await env.connect()).last.phase).toBe('done');
    expect(env.fake.authorizeRequests[0]!.params.client_id).toBe('byo-client');
  });

  it('a preregistered entry without a resolvable clientRef is unconnectable, with a reason', async () => {
    const env = await start({
      entry: { registration: 'preregistered', clientRef: 'missing-ref' },
      preregisteredClients: () => ({}),
    });
    const entry = await catalogEntry(env, 'fake');
    expect(entry.connectable).toBe(false);
    expect(entry.unavailableReason).toContain('missing-ref');
    await expect(
      env.core.rpc.call('apps.connect', { target: { kind: 'catalog', connectorId: 'fake' } }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(env.core.services.apps!.store.list()).toHaveLength(0);
  });
});

describe('BYO clients (apps.oauthClients.*)', () => {
  it('a registered client is used instead of DCR; secrets never leave; remove is refused while connected', async () => {
    const env = await start({ fake: { dcrEnabled: true, cimdSupported: false, tools: [ECHO] } });
    env.fake.addPreregisteredClient({
      clientId: 'byo-client',
      clientSecret: 'byo-secret-value',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'byo-client',
      clientSecret: 'byo-secret-value',
    });

    const listed = await listClients(env);
    expect(listed).toEqual([
      {
        issuer: env.fake.issuer,
        source: 'manual',
        clientId: 'byo-client',
        hasSecret: true,
        connectionCount: 0,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain('byo-secret-value');

    await connectCustom(env, 'byo');
    expect(env.fake.registrations).toHaveLength(0);
    expect(env.fake.authorizeRequests[0]!.params.client_id).toBe('byo-client');
    expect(env.fake.authorizeRequests[0]!.clientSource).toBe('preregistered');
    expect((await listClients(env))[0]!.connectionCount).toBe(1);

    await expect(
      env.core.rpc.call('apps.oauthClients.remove', { issuer: env.fake.issuer }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await listClients(env)).toHaveLength(1);

    await env.core.rpc.call('apps.disconnect', { connectionId: 'custom:byo' });
    expect((await listClients(env))[0]!.connectionCount).toBe(0);
    await env.core.rpc.call('apps.oauthClients.remove', { issuer: env.fake.issuer });
    expect(await listClients(env)).toEqual([]);
    await expect(
      env.core.rpc.call('apps.oauthClients.remove', { issuer: env.fake.issuer }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a BYO client beats the pre-registered table for the same issuer', async () => {
    const env = await start({
      fake: { dcrEnabled: false, cimdSupported: false, tools: [ECHO] },
      entry: { registration: 'preregistered', clientRef: 'bigco-desktop' },
      preregisteredClients: (fake) => ({
        'bigco-desktop': { issuer: fake.issuer, clientId: 'table-client' },
      }),
    });
    for (const clientId of ['table-client', 'byo-client']) {
      env.fake.addPreregisteredClient({ clientId, redirectUris: ['http://127.0.0.1/callback'] });
    }
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'byo-client',
    });
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    expect(env.fake.authorizeRequests[0]!.params.client_id).toBe('byo-client');
  });

  it('validates input and keeps the client list free of the secret after an update without one', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    await expect(
      env.core.rpc.call('apps.oauthClients.set', { issuer: 'not a url', clientId: 'x' }),
    ).rejects.toBeTruthy();
    await expect(
      env.core.rpc.call('apps.oauthClients.set', { issuer: env.fake.issuer, clientId: '  ' }),
    ).rejects.toBeTruthy();
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'a',
      clientSecret: 's',
    });
    await env.core.rpc.call('apps.oauthClients.set', { issuer: env.fake.issuer, clientId: 'b' });
    expect(await listClients(env)).toMatchObject([{ clientId: 'b', hasSecret: false }]);
  });
});

describe('BYO client hardening', () => {
  it('a BYO client saved while a DCR registration is in flight is not overwritten', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = await start({
      fake: { dcrEnabled: true, cimdSupported: false, tools: [ECHO], registerGate: () => gate },
    });
    env.fake.addPreregisteredClient({
      clientId: 'byo-client',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    await env.core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: 'race',
          name: 'Race',
          transport: 'http',
          url: env.fake.mcpUrl,
          enabled: true,
          autoApprove: false,
          auth: 'oauth',
        },
      ],
    });
    const { flowId } = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: 'race' },
    })) as { flowId: string };
    // The registration request arrived; its answer is held back.
    await until(() => env.fake.registrations.length === 1, 10_000, 'registration received');
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'byo-client',
    });
    release();
    await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'),
      20_000,
      'flow done',
    );
    // The flow completed with the client it registered, but the stored client is still the BYO one.
    const stored = env.core.services.apps!.vault.getClient(env.fake.issuer)!;
    expect(stored.source).toBe('manual');
    expect(stored.info.client_id).toBe('byo-client');
    expect((await listClients(env))[0]).toMatchObject({ source: 'manual', clientId: 'byo-client' });
  });

  it('normalises the issuer: a trailing slash is the same issuer for storage, lookup and removal', async () => {
    const env = await start({ fake: { dcrEnabled: true, cimdSupported: false, tools: [ECHO] } });
    env.fake.addPreregisteredClient({
      clientId: 'byo-client',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: `${env.fake.issuer}/`,
      clientId: 'byo-client',
    });
    expect((await listClients(env)).map((c) => c.issuer)).toEqual([env.fake.issuer]);
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'byo-client',
    });
    expect(await listClients(env)).toHaveLength(1);
    // Used by the flow although the discovered issuer has no slash.
    await connectCustom(env, 'slash');
    expect(env.fake.registrations).toHaveLength(0);
    expect(env.fake.authorizeRequests[0]!.params.client_id).toBe('byo-client');
    await env.core.rpc.call('apps.disconnect', { connectionId: 'custom:slash' });
    await env.core.rpc.call('apps.oauthClients.remove', { issuer: `${env.fake.issuer}/` });
    expect(await listClients(env)).toEqual([]);
  });

  it('set without a secret keeps the stored secret of the same client; clearSecret removes it; a new client id drops it', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const vault = env.core.services.apps!.vault;
    const secretOf = (): string | undefined => vault.getClient(env.fake.issuer)?.info.client_secret;
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'a',
      clientSecret: 'keep-me',
    });
    await env.core.rpc.call('apps.oauthClients.set', { issuer: env.fake.issuer, clientId: 'a' });
    expect(secretOf()).toBe('keep-me');
    expect((await listClients(env))[0]!.hasSecret).toBe(true);
    // A new secret replaces it.
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'a',
      clientSecret: 'rotated',
    });
    expect(secretOf()).toBe('rotated');
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'a',
      clearSecret: true,
    });
    expect(secretOf()).toBeUndefined();
    expect((await listClients(env))[0]!.hasSecret).toBe(false);
    // The secret of another client id is never carried over.
    await env.core.rpc.call('apps.oauthClients.set', {
      issuer: env.fake.issuer,
      clientId: 'a',
      clientSecret: 's1',
    });
    await env.core.rpc.call('apps.oauthClients.set', { issuer: env.fake.issuer, clientId: 'b' });
    expect(secretOf()).toBeUndefined();
  });
});
