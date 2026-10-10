import { afterEach, describe, expect, it } from 'vitest';
import { publishCimdDocument, startFileServer, type FakeMcpTool } from '@kepcup/testkit';
import {
  fakeCatalogEntry,
  startCatalogEnv,
  until,
  whoamiTool,
  type CatalogEnv,
} from '../support/catalog-connect-env.js';

/**
 * D73 P1 §5.4：目录连接——真实 core（加密 main.db、真实工具锁定与 Bot 授权）+ testkit 假授权 / MCP 服务器
 * + 假目录 + 假浏览器。覆盖客户端注册（CIMD / DCR）、多账号、账号识别（id_token / whoami / 自动编号）、
 * 首连工具复核（确认 / 拒绝 / 超时）、门禁、授权 Bot 与断开级联。全部不访问真实网络。
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

const ECHO: FakeMcpTool = {
  name: 'echo',
  description: 'Echo',
  annotations: { readOnlyHint: true },
};
const DELETE_ALL: FakeMcpTool = {
  name: 'delete_all',
  description: 'Delete everything',
  annotations: { readOnlyHint: false, destructiveHint: true },
};

function rows(env: CatalogEnv) {
  return env.core.services.apps!.store.list();
}

describe('catalog connect: client registration paths', () => {
  it('DCR: connects, reviews tools, confirms; the row records connector / version / url', async () => {
    const env = await start({
      fake: { tools: [ECHO, DELETE_ALL] },
      entry: { version: '2.3.4' },
    });
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    // The catalog entry's authorization server shares the site with the MCP endpoint: no consent step.
    expect(outcome.events.map((e) => e.phase)).toEqual([
      'discovering',
      'awaiting_browser',
      'exchanging',
      'reviewing_tools',
      'done',
    ]);
    expect(env.fake.registrations).toHaveLength(1);
    expect(env.shellCalls).toHaveLength(1);

    const [row] = rows(env);
    expect(rows(env)).toHaveLength(1);
    expect(row).toMatchObject({
      connectorId: 'fake',
      connectorVer: '2.3.4',
      serverUrl: env.fake.mcpUrl,
      status: 'connected',
      issuer: env.fake.issuer,
    });
    expect(row!.id.startsWith('conn_')).toBe(true);
    expect(outcome.last.connectionId).toBe(row!.id);
  });

  it('CIMD: a metadata-document client needs no registration', async () => {
    const files = await startFileServer({});
    const cimd = publishCimdDocument(files);
    const env = await start({
      fake: { cimdSupported: true, dcrEnabled: false, tools: [ECHO] },
      cimdUrl: cimd.clientId,
    });
    envs.push({ cleanup: () => files.stop() } as CatalogEnv);
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
    expect(env.fake.registrations).toHaveLength(0);
    expect(env.fake.cimdFetches.some((f) => f.ok)).toBe(true);
    expect(rows(env)[0]).toMatchObject({ status: 'connected' });
  });

  it('asks for consent when the authorization server is on another site', async () => {
    const env = await start({
      fake: { tools: [ECHO] },
      loopbackAllowlist: ['127.0.0.1', 'localhost'],
    });
    const authorize = `http://localhost:${env.fake.port}/authorize`;
    env.fake.configure({ authorizationEndpoint: () => authorize });
    const outcome = await env.connect();
    expect(outcome.events.map((e) => e.phase)).toContain('awaiting_consent');
    expect(outcome.last.phase).toBe('done');
  });
});

describe('catalog connect: gate and unsupported registration', () => {
  it('rejects a connector the release gate keeps closed', async () => {
    const env = await start({ approvedGates: ['something-else'] });
    expect(
      ((await env.core.rpc.call('apps.catalog.list', undefined)) as { entries: unknown[] }).entries,
    ).toEqual([]);
    await expect(
      env.core.rpc.call('apps.connect', { target: { kind: 'catalog', connectorId: 'fake' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(rows(env)).toHaveLength(0);
    expect(env.shellCalls).toHaveLength(0);
  });

  it('accepts the connector once its gate is approved', async () => {
    const env = await start({ approvedGates: ['fake'], fake: { tools: [ECHO] } });
    const outcome = await env.connect();
    expect(outcome.last.phase).toBe('done');
  });

  it('fails clearly for a pre-registered-client entry (P2) and for an unknown slug', async () => {
    const env = await start({
      extraEntries: (fake) => [
        fakeCatalogEntry({ slug: 'bigco', url: fake.mcpUrl, registration: 'preregistered' }),
      ],
    });
    await expect(
      env.core.rpc.call('apps.connect', { target: { kind: 'catalog', connectorId: 'bigco' } }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(
      env.core.rpc.call('apps.connect', { target: { kind: 'catalog', connectorId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(rows(env)).toHaveLength(0);
  });
});

describe('catalog connect: accounts', () => {
  it('multi-account: two accounts → two rows; the same account again reuses its row and updates tokens', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const { apps } = env.core.services;

    env.fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'one@example.com' } });
    const first = await env.connect();
    env.fake.configure({ idTokenClaims: { sub: 'acct-2', email: 'two@example.com' } });
    const second = await env.connect();
    expect(first.last.connectionId).not.toBe(second.last.connectionId);
    expect(rows(env).map((r) => [r.label, r.accountSub])).toEqual([
      ['one@example.com', 'acct-1'],
      ['two@example.com', 'acct-2'],
    ]);

    const before = apps!.vault.getTokens(first.last.connectionId!)!;
    env.fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'one@example.com' } });
    const third = await env.connect();
    expect(third.last.phase).toBe('done');
    // Same account: the old row is reused (new tokens), no third row, and the unchanged tool list
    // needs no new review.
    expect(third.last.connectionId).toBe(first.last.connectionId);
    expect(third.review).toBeUndefined();
    expect(rows(env)).toHaveLength(2);
    const after = apps!.vault.getTokens(first.last.connectionId!)!;
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(env.fake.isAccessTokenValid(after.accessToken)).toBe(true);
    expect(rows(env).find((r) => r.id === first.last.connectionId)).toMatchObject({
      status: 'connected',
    });
    // The scratch row of the third connect is gone and its secrets with it.
    const names = env.core.services.domain!.secrets.names();
    for (const name of names.filter((n) => n.startsWith('conn:'))) {
      expect(
        [first.last.connectionId, second.last.connectionId].some((id) =>
          name.startsWith(`conn:${id}:`),
        ),
      ).toBe(true);
    }
  });

  it('identifies the account from the id_token (label = email, account_sub = sub); no-label tokens fall back to numbering', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    env.fake.configure({ idTokenClaims: { sub: 'only-sub' } });
    const a = await env.connect();
    expect(rows(env).find((r) => r.id === a.last.connectionId)).toMatchObject({
      label: 'Fake fake #1',
      accountSub: 'only-sub',
    });
    env.fake.configure({ idTokenClaims: { sub: 'second', preferred_username: 'bob' } });
    const b = await env.connect();
    expect(rows(env).find((r) => r.id === b.last.connectionId)).toMatchObject({
      label: 'bob',
      accountSub: 'second',
    });
  });

  it('ignores an id_token of another issuer / audience', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    env.fake.configure({
      idTokenClaims: { sub: 'x', email: 'x@example.com', iss: 'https://evil.example' },
    });
    const outcome = await env.connect();
    expect(rows(env).find((r) => r.id === outcome.last.connectionId)).toMatchObject({
      accountSub: null,
      label: 'Fake fake #1',
    });
  });

  it('uses userinfo when the token response has no id_token', async () => {
    const env = await start({
      fake: { tools: [ECHO], userinfoClaims: { sub: 'ui-1', email: 'ui@example.com' } },
    });
    const outcome = await env.connect();
    expect(rows(env).find((r) => r.id === outcome.last.connectionId)).toMatchObject({
      label: 'ui@example.com',
      accountSub: 'ui-1',
    });
  });

  it('whoami: label and sub come from the catalog read-only tool', async () => {
    const account = { current: { id: 'w-1', email: 'who@example.com' } };
    const env = await start({
      fake: { tools: [ECHO, whoamiTool(account)] },
      entry: { whoami: { tool: 'whoami', labelPath: 'user.email', subjectPath: 'user.id' } },
    });
    const first = await env.connect();
    expect(rows(env).find((r) => r.id === first.last.connectionId)).toMatchObject({
      label: 'who@example.com',
      accountSub: 'w-1',
    });
    // The same account connecting again is recognised through whoami too.
    const second = await env.connect();
    expect(second.last.connectionId).toBe(first.last.connectionId);
    expect(rows(env)).toHaveLength(1);
    account.current = { id: 'w-2', email: 'other@example.com' };
    const third = await env.connect();
    expect(third.last.connectionId).not.toBe(first.last.connectionId);
    expect(rows(env)).toHaveLength(2);
  });

  it('whoami is only called when the tool is read-only', async () => {
    let called = 0;
    const evil: FakeMcpTool = {
      name: 'whoami',
      description: 'Looks harmless',
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: () => {
        called += 1;
        return JSON.stringify({ user: { id: 'z', email: 'z@example.com' } });
      },
    };
    const env = await start({
      fake: { tools: [evil] },
      entry: { whoami: { tool: 'whoami', labelPath: 'user.email', subjectPath: 'user.id' } },
    });
    const outcome = await env.connect();
    expect(called).toBe(0);
    expect(rows(env).find((r) => r.id === outcome.last.connectionId)).toMatchObject({
      label: 'Fake fake #1',
      accountSub: null,
    });
  });

  it('numbers anonymous accounts "{title} #{n}" with the smallest free number', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const one = await env.connect();
    const two = await env.connect();
    expect(rows(env).map((r) => r.label)).toEqual(['Fake fake #1', 'Fake fake #2']);
    await env.core.rpc.call('apps.disconnect', { connectionId: one.last.connectionId });
    await env.connect();
    expect(
      rows(env)
        .map((r) => r.label)
        .sort(),
    ).toEqual(['Fake fake #1', 'Fake fake #2']);
    expect(rows(env).some((r) => r.id === two.last.connectionId)).toBe(true);
  });

  it('reconnecting an existing connection keeps its row; a different account is refused and revoked', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    env.fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'one@example.com' } });
    const first = await env.connect();
    const id = first.last.connectionId!;

    const again = await env.connect({ connectionId: id });
    expect(again.last).toMatchObject({ phase: 'done', connectionId: id });
    expect(rows(env)).toHaveLength(1);

    env.fake.configure({ idTokenClaims: { sub: 'someone-else' } });
    env.fake.resetRecords();
    const wrong = await env.connect({ connectionId: id });
    expect(wrong.last.phase).toBe('failed');
    expect(wrong.last.error?.code).toBe('OAUTH_FLOW_FAILED');
    expect(rows(env)).toHaveLength(1);
    // The unrelated authorization the user just granted is revoked; the original connection is untouched.
    expect(env.fake.revokeRequests.length).toBeGreaterThan(0);
    expect(rows(env)[0]).toMatchObject({ id, status: 'connected', accountSub: 'acct-1' });
  });

  it('reconnecting requests the union of the row scopes and the requested / default scopes', async () => {
    const env = await start({
      fake: { tools: [ECHO] },
      entry: { scopes: { default: ['read'], write: ['write'] } },
    });
    env.fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'one@example.com' } });
    const scopeOfLastAuthorize = (): string[] =>
      (env.fake.authorizeRequests.at(-1)!.params['scope'] ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .sort();
    const connectWith = async (input: Record<string, unknown>): Promise<string> => {
      const { flowId } = (await env.core.rpc.call('apps.connect', {
        target: { kind: 'catalog', connectorId: 'fake' },
        ...input,
      })) as { flowId: string };
      const review = await until(() =>
        env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'reviewing_tools'),
      );
      await env.core.rpc.call('apps.connect.confirmTools', { flowId });
      const done = await until(() =>
        env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'),
      );
      expect(review.connectionId).toBeDefined();
      return done.connectionId!;
    };

    // First connect with a step-up scope set: the row records what the server granted.
    const id = await connectWith({ scopes: ['a', 'b'] });
    expect(scopeOfLastAuthorize()).toEqual(['a', 'b']);
    expect(rows(env)[0]).toMatchObject({ id, scopes: ['a', 'b'] });

    // Reconnect from Settings (no scopes): defaults ∪ existing — nothing previously granted is dropped.
    const again = await env.connect({ connectionId: id });
    expect(again.last).toMatchObject({ phase: 'done', connectionId: id });
    expect(scopeOfLastAuthorize()).toEqual(['a', 'b', 'read']);
    expect(rows(env)[0]!.scopes.sort()).toEqual(['a', 'b', 'read']);

    // Reconnect with an explicit step-up: requested ∪ existing.
    const { flowId } = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'fake' },
      connectionId: id,
      scopes: ['c'],
    })) as { flowId: string };
    await until(() => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'));
    expect(scopeOfLastAuthorize()).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(rows(env)).toHaveLength(1);
    expect(rows(env)[0]!.scopes).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });
});

describe('catalog connect: first-connect tool review', () => {
  it('lists the tools with risk, hides them until confirmed, then approves them all', async () => {
    const env = await start({
      fake: { tools: [ECHO, DELETE_ALL] },
      entry: { toolPolicy: { echo: { risk: 'write' } } },
    });
    const parked = await env.connect({ review: 'park' });
    expect(parked.review).toBeDefined();
    const review = parked.review!;
    const connectionId = review.connectionId!;
    const tools = [...(review.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    expect(tools).toEqual([
      { name: 'delete_all', description: 'Delete everything', risk: 'destructive' },
      // catalog toolPolicy can only raise the risk (read → write)
      { name: 'echo', description: 'Echo', risk: 'write' },
    ]);
    // Reviewing: nothing is exposed, the connection is not yet "connected".
    const { toolLock } = env.core.services;
    expect(env.core.services.apps!.store.get(connectionId)!.status).toBe('connecting');
    expect(toolLock!.isExposed(connectionId, 'echo')).toBe(false);
    expect(toolLock!.list(connectionId).every((row) => row.state === 'new')).toBe(true);
    const view = (await env.core.rpc.call('apps.connections.tools', { connectionId })) as {
      tools: Array<{ toolName: string; exposed: boolean; state: string }>;
    };
    expect(view.tools.every((t) => !t.exposed && t.state === 'new')).toBe(true);

    await env.core.rpc.call('apps.connect.confirmTools', { flowId: review.flowId });
    await until(() => env.flowEvents.find((e) => e.flowId === review.flowId && e.phase === 'done'));
    expect(toolLock!.isExposed(connectionId, 'echo')).toBe(true);
    expect(toolLock!.isExposed(connectionId, 'delete_all')).toBe(true);
    expect(env.core.services.apps!.store.get(connectionId)!.status).toBe('connected');
    // confirmTools outside of a review is an error.
    await expect(
      env.core.rpc.call('apps.connect.confirmTools', { flowId: review.flowId }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejecting (cancel while reviewing) revokes at the authorization server and clears everything', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const outcome = await env.connect({ review: 'cancel' });
    expect(outcome.last.phase).toBe('cancelled');
    expect(rows(env)).toHaveLength(0);
    expect(env.fake.revokeRequests.map((r) => r.params['token_type_hint'])).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(env.core.services.domain!.secrets.names().filter((n) => n.startsWith('conn:'))).toEqual(
      [],
    );
    expect(
      env.core.services.mainDb!.prepare('select count(*) as n from app_connection_tools').get(),
    ).toEqual({ n: 0 });
    // The UI is told the (temporary) connection is gone.
    expect(env.statusEvents.some((e) => e.status === 'not_connected')).toBe(true);
    // A DCR client left without a connection is cleaned too.
    expect(
      env.core.services.domain!.secrets.names().filter((n) => n.startsWith('oauth:client:')),
    ).toEqual([]);
  });

  it('a review that is never answered times out like any other phase and is rejected', async () => {
    const env = await start({ fake: { tools: [ECHO] }, flowTimeoutMs: 2_500 });
    const outcome = await env.connect({ review: 'park' });
    expect(outcome.review).toBeDefined();
    const failed = await until(
      () => env.flowEvents.find((e) => e.flowId === outcome.flowId && e.phase === 'failed'),
      10_000,
      'review timeout',
    );
    expect(failed.error?.code).toBe('OAUTH_FLOW_TIMEOUT');
    expect(rows(env)).toHaveLength(0);
    expect(env.fake.revokeRequests.length).toBeGreaterThan(0);
  });

  it('concurrent connect requests for the same app share one flow (also while reviewing)', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const parked = await env.connect({ review: 'park' });
    const again = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'fake' },
    })) as { flowId: string };
    expect(again.flowId).toBe(parked.flowId);
    await until(
      () =>
        env.flowEvents.filter((e) => e.flowId === parked.flowId && e.phase === 'reviewing_tools')
          .length >= 2,
    );
    await env.core.rpc.call('apps.connect.confirmTools', { flowId: parked.flowId });
    await until(() => env.flowEvents.find((e) => e.flowId === parked.flowId && e.phase === 'done'));
    expect(rows(env)).toHaveLength(1);
  });
});

describe('catalog connect: granting a Bot and disconnecting', () => {
  it('grantBotId: core writes the connection into the Bot app_connection_ids on completion', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const bot = await env.makeBot('小应');
    const outcome = await env.connect({ grantBotId: bot.id });
    const got = (await env.core.rpc.call('bots.get', { id: bot.id })) as {
      bot: { profile: { runtime: { app_connection_ids: string[] } } };
    };
    expect(got.bot.profile.runtime.app_connection_ids).toEqual([outcome.last.connectionId]);
  });

  it('two Bots connecting the same app share one flow and both get the connection; a grantBotId after the flow ended starts a new flow', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    // A stable account: the late flow below must merge into the same connection row.
    env.fake.configure({ idTokenClaims: { sub: 'acct-1', email: 'one@example.com' } });
    const a = await env.makeBot('甲');
    const b = await env.makeBot('乙');
    const c = await env.makeBot('丙');
    const idsOf = async (botId: string): Promise<string[]> =>
      (
        (await env.core.rpc.call('bots.get', { id: botId })) as {
          bot: { profile: { runtime: { app_connection_ids: string[] } } };
        }
      ).bot.profile.runtime.app_connection_ids;

    // Group chat: Bot 甲's card starts the flow; Bot 乙's card joins it (same target → same flowId).
    const parked = await env.connect({ grantBotId: a.id, review: 'park' });
    const joined = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'fake' },
      grantBotId: b.id,
    })) as { flowId: string };
    expect(joined.flowId).toBe(parked.flowId);
    expect(env.fake.authorizeRequests).toHaveLength(1);
    await env.core.rpc.call('apps.connect.confirmTools', { flowId: parked.flowId });
    const done = await until(() =>
      env.flowEvents.find((e) => e.flowId === parked.flowId && e.phase === 'done'),
    );
    const connectionId = done.connectionId!;
    expect(rows(env)).toHaveLength(1);
    // Core granted the connection to both Bots (nobody wrote the Profile from outside).
    expect(await idsOf(a.id)).toEqual([connectionId]);
    expect(await idsOf(b.id)).toEqual([connectionId]);
    expect(await idsOf(c.id)).toEqual([]);

    // After the flow ended, a third Bot's grantBotId is not applied retroactively: a new flow runs
    // (same account → merged into the same row), and only then is 丙 granted.
    const late = await env.connect({ grantBotId: c.id });
    expect(late.flowId).not.toBe(parked.flowId);
    expect(late.last.phase).toBe('done');
    expect(late.last.connectionId).toBe(connectionId);
    expect(env.fake.authorizeRequests).toHaveLength(2);
    expect(rows(env)).toHaveLength(1);
    expect(await idsOf(c.id)).toEqual([connectionId]);
    expect(await idsOf(a.id)).toEqual([connectionId]);
  });

  it('a failed grant (unknown Bot) does not fail the connection', async () => {
    const env = await start({ fake: { tools: [ECHO] } });
    const outcome = await env.connect({ grantBotId: 'bot_does_not_exist' });
    expect(outcome.last.phase).toBe('done');
    expect(rows(env)).toHaveLength(1);
  });

  it('disconnect cascades: tool rows, grants, Bot authorization, MCP connection and tokens', async () => {
    const env = await start({ fake: { tools: [ECHO, DELETE_ALL] } });
    const { core } = env;
    const bot = await env.makeBot('小应');
    const outcome = await env.connect({ grantBotId: bot.id });
    const connectionId = outcome.last.connectionId!;
    const services = core.services;
    // Open an MCP connection and record a persistent tool grant.
    const server = services.mcp!.serverFor(connectionId)!;
    await services.mcp!.listTools(server);
    services.appToolGrants!.create({ botId: bot.id, connectionId, toolName: 'delete_all' });
    expect(services.toolLock!.list(connectionId)).toHaveLength(2);
    expect(services.appToolGrants!.list({ connectionId })).toHaveLength(1);

    env.mcpStatus.length = 0;
    env.fake.resetRecords();
    await core.rpc.call('apps.disconnect', { connectionId });

    expect(services.apps!.store.get(connectionId)).toBeNull();
    expect(services.toolLock!.list(connectionId)).toEqual([]);
    expect(services.appToolGrants!.list({ connectionId, includeRevoked: true })).toEqual([]);
    const got = (await core.rpc.call('bots.get', { id: bot.id })) as {
      bot: { profile: { runtime: { app_connection_ids: string[] } } };
    };
    expect(got.bot.profile.runtime.app_connection_ids).toEqual([]);
    expect(services.mcp!.serverFor(connectionId)).toBeUndefined();
    expect(env.mcpStatus).toContainEqual(
      expect.objectContaining({ serverId: connectionId, status: 'closed' }),
    );
    expect(env.fake.revokeRequests).toHaveLength(2);
    expect(services.domain!.secrets.names().filter((n) => n.startsWith('conn:'))).toEqual([]);
  });
});
