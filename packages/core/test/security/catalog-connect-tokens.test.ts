import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_EVENT_NAMES } from '@kepcup/shared';
import { startCatalogEnv, whoamiTool, type CatalogEnv } from '../support/catalog-connect-env.js';

/**
 * D73 P1 security gate (catalog connections): after a catalog connection that identifies the
 * account through an id_token (and a whoami fallback), uses the app, reviews its tools and is
 * disconnected, neither the id_token (used transiently for `sub` + display name) nor any access /
 * refresh token exists in the databases, audit log, logs, RPC returns, events or file bytes.
 */

const envs: CatalogEnv[] = [];
afterEach(async () => {
  for (const env of envs.splice(0).reverse()) await env.cleanup();
});

function allFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...allFiles(full));
    else if (info.size < 64 * 1024 * 1024) found.push(full);
  }
  return found;
}

describe('catalog connections: id_token and tokens never persisted or leaked', () => {
  it('connect (id_token) → use → second account (whoami) → disconnect — nothing sensitive anywhere', async () => {
    const account = { current: { id: 'w-9', email: 'whoami@example.com' } };
    const env = await startCatalogEnv({
      fake: {
        tools: [
          { name: 'echo', description: 'Echo', annotations: { readOnlyHint: true } },
          whoamiTool(account),
        ],
      },
      entry: { whoami: { tool: 'whoami', labelPath: 'user.email', subjectPath: 'user.id' } },
    });
    envs.push(env);
    const { core, fake } = env;
    const services = core.services;

    const rpcReturns: string[] = [];
    const call = async (method: string, input?: unknown): Promise<unknown> => {
      const result = await core.rpc.call(method as never, input as never);
      rpcReturns.push(JSON.stringify(result));
      return result;
    };
    const events: string[] = [];
    for (const name of RPC_EVENT_NAMES) {
      services.events.on(
        name as never,
        ((payload: unknown) => {
          events.push(`${name} ${JSON.stringify(payload)}`);
        }) as never,
      );
    }

    const known = new Set<string>();
    const sample = (connectionId: string): void => {
      const tokens = services.apps!.vault.getTokens(connectionId);
      if (tokens !== null) {
        known.add(tokens.accessToken);
        if (tokens.refreshToken !== undefined) known.add(tokens.refreshToken);
      }
    };

    // Account 1: id_token carries the identity.
    fake.configure({ idTokenClaims: { sub: 'idtoken-sub', email: 'idtoken@example.com' } });
    const one = await env.connect();
    sample(one.last.connectionId!);
    // Account 2: no id_token — the catalog whoami tool identifies it.
    fake.configure({ idTokenClaims: undefined });
    const two = await env.connect();
    sample(two.last.connectionId!);
    // Same account 1 again: tokens move onto the existing row.
    fake.configure({ idTokenClaims: { sub: 'idtoken-sub', email: 'idtoken@example.com' } });
    const three = await env.connect();
    expect(three.last.connectionId).toBe(one.last.connectionId);
    sample(one.last.connectionId!);

    // Use the app through the runtime provider; look at every view the UI has.
    const mcp = services.mcp!;
    await mcp.callTool(mcp.serverFor(one.last.connectionId!)!, 'echo', { text: 'hi' });
    for (const token of fake.toolCalls.map((c) => c.token)) if (token !== null) known.add(token);
    await call('apps.catalog.list');
    await call('apps.connections.list', { includeCustom: true });
    await call('apps.connections.tools', { connectionId: one.last.connectionId });
    await call('apps.connections.grants', { connectionId: one.last.connectionId });
    await call('settings.get');
    await call('mcp.toolRisks', { serverId: one.last.connectionId });

    const idTokens = [...fake.issuedIdTokens];
    expect(idTokens.length).toBeGreaterThanOrEqual(2);
    expect(known.size).toBeGreaterThanOrEqual(4);

    await call('apps.disconnect', { connectionId: one.last.connectionId });
    await call('apps.disconnect', { connectionId: two.last.connectionId });

    // --- the scan -----------------------------------------------------------
    const dumpTables = (db: NonNullable<typeof services.mainDb>): string =>
      (
        db
          .prepare(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
          )
          .all() as Array<{ name: string }>
      )
        .map(
          ({ name }) => `${name}: ${JSON.stringify(db.prepare(`select * from "${name}"`).all())}`,
        )
        .join('\n');
    const secretNames = services.domain!.secrets.names();
    const secretValues = secretNames.map((n) => services.domain!.secrets.getValue(n) ?? '');
    const logsDir = services.paths.logsDir;
    const haystacks: Record<string, string> = {
      'main.db rows': dumpTables(services.mainDb!),
      'runs.db rows': dumpTables(services.runsDb!),
      'secret names': secretNames.join('\n'),
      'secret values': secretValues.join('\n'),
      'log files': readdirSync(logsDir)
        .map((file) => readFileSync(path.join(logsDir, file), 'utf8'))
        .join('\n'),
      'rpc returns': rpcReturns.join('\n'),
      events: events.join('\n'),
    };
    const raw = allFiles(services.paths.home).map((file) => readFileSync(file));

    const leaks: string[] = [];
    // id_token: neither the whole token nor its (fake) signature may be anywhere.
    for (const idToken of idTokens) {
      for (const needle of [idToken, 'fake-signature']) {
        for (const [where, text] of Object.entries(haystacks)) {
          if (text.includes(needle)) leaks.push(`${where}: id_token ${needle.slice(0, 12)}…`);
        }
        for (const [index, bytes] of raw.entries()) {
          if (bytes.includes(Buffer.from(needle))) leaks.push(`file #${index}: id_token`);
        }
      }
    }
    // Access / refresh tokens: never outside the Vault's secrets (secret values are the vault).
    for (const secret of known) {
      for (const [where, text] of Object.entries(haystacks)) {
        if (where === 'secret values') continue;
        if (text.includes(secret)) leaks.push(`${where}: ${secret.slice(0, 8)}…`);
      }
      for (const [index, bytes] of raw.entries()) {
        if (bytes.includes(Buffer.from(secret)))
          leaks.push(`file #${index}: ${secret.slice(0, 8)}…`);
      }
    }
    expect(leaks).toEqual([]);

    // Controls: the lifecycle really happened and the scan sees what it should.
    expect(haystacks['events']).toContain('reviewing_tools');
    expect(haystacks['events']).toContain('apps.connection_status');
    expect(haystacks['main.db rows']).toContain('app_connect');
    expect(haystacks['main.db rows']).toContain('app_disconnect');
    expect(haystacks['rpc returns']).toContain('idtoken@example.com'); // the label is non-secret
    expect(haystacks['rpc returns']).toContain('whoami@example.com');
    expect(haystacks['secret names']).not.toMatch(/id_token/i);
    expect(services.apps!.vault.getTokens(one.last.connectionId!)).toBeNull();
    expect(fake.revokeRequests.length).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
