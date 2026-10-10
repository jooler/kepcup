import { afterEach, describe, expect, it } from 'vitest';
import type { AppFlowLogEntry, AppToolView, Settings } from '@kepcup/shared';
import { startCatalogEnv, until, type CatalogEnv } from '../support/catalog-connect-env.js';

/**
 * D73 P2 §6.6 开发者模式：设置开关、授权流程事件日志（脱敏）、原始工具定义、手动刷新工具
 * （工具锁定照常生效）。真实 core + testkit 假授权 / MCP 服务器。
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
const SERVER_ID = 'devsrv';
const CONNECTION_ID = `custom:${SERVER_ID}`;

async function connectCustom(env: CatalogEnv): Promise<string> {
  await env.core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: SERVER_ID,
        name: 'Dev Fake',
        transport: 'http',
        url: env.fake.mcpUrl,
        enabled: true,
        autoApprove: false,
        auth: 'oauth',
      },
    ],
  });
  const { flowId } = (await env.core.rpc.call('apps.connect', {
    target: { kind: 'custom', serverId: SERVER_ID },
  })) as { flowId: string };
  await until(
    () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'),
    20_000,
    'custom flow done',
  );
  return flowId;
}

async function toolViews(env: CatalogEnv): Promise<AppToolView[]> {
  const out = (await env.core.rpc.call('apps.connections.tools', {
    connectionId: CONNECTION_ID,
  })) as { tools: AppToolView[] };
  return out.tools;
}

describe('developer mode setting', () => {
  it('defaults to off, is writable through settings.update, and keeps the core-owned apps fields', async () => {
    const env = await start();
    const before = (await env.core.rpc.call('settings.get', undefined)) as Settings;
    expect(before.apps.developerMode).toBe(false);
    const after = (await env.core.rpc.call('settings.update', {
      apps: { developerMode: true },
    })) as Settings;
    expect(after.apps.developerMode).toBe(true);
    expect(after.apps.toolLockBaselineDone).toBe(before.apps.toolLockBaselineDone);
    // An unrelated update does not reset it.
    const again = (await env.core.rpc.call('settings.update', {
      launchAtLogin: false,
    })) as Settings;
    expect(again.apps.developerMode).toBe(true);
    const off = (await env.core.rpc.call('settings.update', {
      apps: { developerMode: false },
    })) as Settings;
    expect(off.apps.developerMode).toBe(false);
  });
});

describe('authorization flow event log', () => {
  it('records redacted phases for a custom server: no token, code, state or query values', async () => {
    const env = await start({ fake: { dcrEnabled: true, tools: [ECHO] } });
    await connectCustom(env);
    const { entries } = (await env.core.rpc.call('apps.flowLog', { serverId: SERVER_ID })) as {
      entries: AppFlowLogEntry[];
    };
    const phases = entries.map((e) => e.phase);
    expect(phases).toContain('discovering');
    expect(phases).toContain('client_selected');
    expect(phases).toContain('awaiting_consent');
    expect(phases).toContain('done');
    expect(entries.find((e) => e.phase === 'client_selected')?.clientSource).toBe('dcr');
    const consent = entries.find((e) => e.phase === 'awaiting_consent')!;
    expect(consent.authorizationUrl).toBe(`${env.fake.authorizationEndpoint}`);
    expect(consent.authorizationUrl).not.toContain('?');

    const serialized = JSON.stringify(entries);
    const tokens = env.core.services.apps!.vault.getTokens(CONNECTION_ID)!;
    const authorize = env.fake.authorizeRequests[0]!;
    const code = new URL(authorize.location!).searchParams.get('code')!;
    for (const secret of [
      tokens.accessToken,
      tokens.refreshToken!,
      code,
      authorize.params.state!,
      authorize.params.code_challenge!,
    ]) {
      expect(secret.length).toBeGreaterThan(8);
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('state=');
    expect(serialized).not.toContain('code_challenge');
  });

  it('is dropped when the custom server is removed (mcp.removeServer and settings.update)', async () => {
    const env = await start({ fake: { dcrEnabled: true, tools: [ECHO] } });
    const logOf = async (): Promise<AppFlowLogEntry[]> =>
      (
        (await env.core.rpc.call('apps.flowLog', { serverId: SERVER_ID })) as {
          entries: AppFlowLogEntry[];
        }
      ).entries;
    await connectCustom(env);
    expect((await logOf()).length).toBeGreaterThan(0);
    await env.core.rpc.call('mcp.removeServer', { serverId: SERVER_ID });
    expect(await logOf()).toEqual([]);

    await connectCustom(env);
    expect((await logOf()).length).toBeGreaterThan(0);
    await env.core.rpc.call('settings.update', { mcpServers: [] });
    expect(await logOf()).toEqual([]);
  });

  it('is per server, in memory, and empty for a server that never connected', async () => {
    const env = await start();
    const { entries } = (await env.core.rpc.call('apps.flowLog', { serverId: 'nope' })) as {
      entries: AppFlowLogEntry[];
    };
    expect(entries).toEqual([]);
  });

  it('keeps failures readable without leaking: error code and message only', async () => {
    const env = await start({ fake: { dcrEnabled: false, cimdSupported: false, tools: [ECHO] } });
    await env.core.rpc.call('settings.update', {
      mcpServers: [
        {
          id: SERVER_ID,
          name: 'Dev Fake',
          transport: 'http',
          url: env.fake.mcpUrl,
          enabled: true,
          autoApprove: false,
          auth: 'oauth',
        },
      ],
    });
    const { flowId } = (await env.core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: SERVER_ID },
    })) as { flowId: string };
    await until(
      () => env.flowEvents.find((e) => e.flowId === flowId && e.phase === 'failed'),
      10_000,
      'client required',
    );
    const { entries } = (await env.core.rpc.call('apps.flowLog', { serverId: SERVER_ID })) as {
      entries: AppFlowLogEntry[];
    };
    const failed = entries.find((e) => e.phase === 'failed')!;
    expect(failed.errorCode).toBe('OAUTH_CLIENT_REQUIRED');
    expect(failed.issuer).toBe(env.fake.issuer);
    await env.core.rpc.call('apps.connect.cancel', { flowId });
  });
});

describe('raw tools and manual refresh', () => {
  it('rawTools returns the definitions with annotations; refreshTools re-lists and the tool lock still applies', async () => {
    const env = await start({ fake: { dcrEnabled: true, tools: [ECHO] } });
    await connectCustom(env);

    const raw = (await env.core.rpc.call('mcp.rawTools', { serverId: SERVER_ID })) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(raw.tools).toHaveLength(1);
    expect(raw.tools[0]).toMatchObject({ name: 'echo', annotations: { readOnlyHint: true } });
    expect(raw.tools[0]!.inputSchema).toBeTruthy();

    // Approve the first listing, then change the server's definition behind the cache's back.
    await env.core.rpc.call('apps.connections.reviewTools', {
      connectionId: CONNECTION_ID,
      accept: ['echo'],
    });
    expect((await toolViews(env)).find((t) => t.toolName === 'echo')?.exposed).toBe(true);

    await env.fake.setTools([
      { name: 'echo', description: 'Echo (changed)', annotations: { readOnlyHint: true } },
      { name: 'extra', description: 'New tool', annotations: { readOnlyHint: false } },
    ]);
    const refreshed = (await env.core.rpc.call('mcp.refreshTools', { serverId: SERVER_ID })) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(refreshed.tools.map((t) => t.name).sort()).toEqual(['echo', 'extra']);
    expect(refreshed.tools.find((t) => t.name === 'echo')?.description).toBe('Echo (changed)');

    const views = await toolViews(env);
    expect(views.find((t) => t.toolName === 'echo')).toMatchObject({
      state: 'changed',
      exposed: false,
    });
    expect(views.find((t) => t.toolName === 'extra')).toMatchObject({
      state: 'new',
      exposed: false,
    });
  });

  it('refreshTools works with developer mode off, and rejects an unknown server', async () => {
    const env = await start({ fake: { dcrEnabled: true, tools: [ECHO] } });
    await connectCustom(env);
    const settings = (await env.core.rpc.call('settings.get', undefined)) as Settings;
    expect(settings.apps.developerMode).toBe(false);
    const out = (await env.core.rpc.call('mcp.refreshTools', { serverId: SERVER_ID })) as {
      tools: unknown[];
    };
    expect(out.tools).toHaveLength(1);
    await expect(
      env.core.rpc.call('mcp.refreshTools', { serverId: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
