import { afterEach, describe, expect, it } from 'vitest';
import type { AppConnectFlowPayload } from '@kepcup/shared';
import { startFakeOAuthMcpServer } from '@kepcup/testkit';
import { ConnectFlowManager, type CatalogFlowHost } from '../../src/apps/auth/flow.js';
import { AppConnectionStore } from '../../src/apps/connection-store.js';
import { PreregisteredClients } from '../../src/apps/oauth-clients.js';
import { TokenVault } from '../../src/apps/token-vault.js';
import { openRealMainDb } from '../support/real-secrets.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('PreregisteredClients', () => {
  const table = {
    'z-ref': { issuer: 'https://as.example.com', clientId: 'z-client' },
    'a-ref': { issuer: 'https://as.example.com/', clientId: 'a-client' },
    other: { issuer: 'https://other.example.com', clientId: 'o-client' },
  };

  it('findByIssuer is deterministic (smallest clientRef) and ignores a trailing slash', () => {
    const forward = new PreregisteredClients(table);
    const reversed = new PreregisteredClients(Object.fromEntries(Object.entries(table).reverse()));
    for (const clients of [forward, reversed]) {
      expect(clients.findByIssuer('https://as.example.com')?.clientId).toBe('a-client');
      expect(clients.findByIssuer('https://as.example.com/')?.clientId).toBe('a-client');
      expect(clients.findByIssuer('https://nope.example.com')).toBeNull();
    }
  });

  it('lookup tells a missing clientRef from an issuer mismatch', () => {
    const clients = new PreregisteredClients(table);
    expect(clients.lookup('https://as.example.com', 'z-ref')).toEqual({
      kind: 'ok',
      info: { client_id: 'z-client' },
    });
    expect(clients.lookup('https://as.example.com', 'other')).toEqual({ kind: 'issuer_mismatch' });
    expect(clients.lookup('https://as.example.com', 'gone')).toEqual({ kind: 'missing' });
    expect(clients.lookup('https://as.example.com', null).kind).toBe('ok');
  });
});

describe('flow: catalog entry whose clientRef is missing from the table', () => {
  it('parks at OAUTH_CLIENT_REQUIRED instead of registering KepCup with DCR / CIMD', async () => {
    const env = openRealMainDb();
    cleanups.push(() => env.dispose());
    const fake = await startFakeOAuthMcpServer({ dcrEnabled: true, cimdSupported: false });
    cleanups.push(() => fake.stop());
    const store = new AppConnectionStore({ db: env.db, clock: env.clock });
    const vault = new TokenVault({ secrets: env.secrets, store, clock: env.clock });
    const events: AppConnectFlowPayload[] = [];
    const host: CatalogFlowHost = {
      begin: () => {
        const row = store.create({
          connectorId: 'bigco',
          label: 'BigCo',
          serverUrl: fake.mcpUrl,
          status: 'connecting',
        });
        return {
          connectorId: 'bigco',
          title: 'BigCo',
          serverUrl: fake.mcpUrl,
          defaultScopes: [],
          clientRef: 'gone',
          connectionId: row.id,
          reconnectTo: null,
          existingScopes: [],
        };
      },
      abandon: (id) => {
        store.delete(id);
      },
      settle: () => Promise.reject(new Error('unexpected')),
      confirm: () => Promise.resolve(),
      reject: () => Promise.resolve(),
    };
    const flows = new ConnectFlowManager({
      store,
      vault,
      settings: { get: () => ({ mcpServers: [] }) as never },
      shell: { openExternal: () => Promise.resolve({ ok: true }) },
      events: {
        emit: ((name: string, payload: unknown) => {
          if (name === 'apps.connect_flow') events.push(payload as AppConnectFlowPayload);
        }) as never,
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      clock: env.clock,
      loopbackAllowlist: ['127.0.0.1'],
      flowTimeoutMs: 10_000,
      preregistered: new PreregisteredClients({}),
    });
    cleanups.push(() => flows.shutdown());
    flows.attachCatalogHost(host);

    const { flowId } = flows.start({ target: { kind: 'catalog', connectorId: 'bigco' } });
    const deadline = Date.now() + 8000;
    while (!events.some((e) => e.phase === 'failed') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const failed = events.find((e) => e.flowId === flowId && e.phase === 'failed')!;
    expect(failed.error?.code).toBe('OAUTH_CLIENT_REQUIRED');
    expect(fake.registrations).toHaveLength(0);
    expect(fake.cimdFetches).toHaveLength(0);
    flows.cancel(flowId);
  });
});
