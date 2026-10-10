import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AppCatalogEntry,
  AppConnectFlowPayload,
  AppsDirectoryStatus,
  Approval,
} from '@kepcup/shared';
import {
  createTestStack,
  listRuns,
  makeBot,
  openDirect,
  sendBatch,
  simulateBrowser,
  startFakeOAuthMcpServer,
  step,
  viaTask,
  waitFor,
  type FakeMcpTool,
  type TestStack,
} from '@kepcup/testkit';
import { ConnectorCatalog } from '../../src/apps/catalog.js';
import { fakeCatalogEntry, until } from '../support/catalog-connect-env.js';
import { makeKey, signIndex } from '../support/directory-fixture.js';

/**
 * D73 P3 §7.1 / §7.2, real core, fakes only:
 *
 * 1. Signed directory: a fake `dl.kepcup.com` (loopback http, test-hook base URL) serves a signed
 *    index; `apps.directory.sync` verifies it, the remote community / verified entries appear in
 *    `apps.catalog.list`; tampering / rollback / outage keep the last verified entries and degrade
 *    the status; an empty key list or the setting switch disables it.
 * 2. Community tier: the connect flow's `reviewing_tools` event carries `tier: community`; a write
 *    tool's card offers only once / conversation; a forged `bot` decision degrades to once and
 *    creates no grant; a conversation grant still works.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePorts(count: number): Promise<number[]> {
  const holders: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holders.push(server);
    ports.push((server.address() as AddressInfo).port);
  }
  await Promise.all(holders.map((s) => new Promise<void>((r) => server_close(s, r))));
  return ports;
}
function server_close(server: Server, done: () => void): void {
  server.close(() => done());
}

describe('signed directory through the real core', () => {
  async function serveDirectory(): Promise<{
    baseUrl: string;
    serve(signed: { indexBytes: Buffer; sig: string } | null): void;
    hits: string[];
  }> {
    let current: { indexBytes: Buffer; sig: string } | null = null;
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (current === null) {
        res.statusCode = 503;
        res.end('down');
        return;
      }
      if (req.url?.endsWith('/index.json.sig')) {
        res.end(`${current.sig}\n`);
      } else if (req.url?.endsWith('/index.json')) {
        res.setHeader('content-type', 'application/json');
        res.end(current.indexBytes);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((r) => server_close(server, r)));
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${port}/connectors/v1`,
      serve: (signed) => {
        current = signed;
      },
      hits,
    };
  }

  const T1 = Date.now() - 3 * 24 * 3600_000;
  const T2 = T1 + 3600_000;
  const entries = (): unknown[] => [
    fakeCatalogEntry({
      slug: 'acme',
      title: 'Acme',
      tier: 'verified',
      url: 'https://acme.example.com/mcp',
    }),
    fakeCatalogEntry({
      slug: 'hobby',
      title: 'Hobby',
      tier: 'community',
      url: 'https://hobby.example.com/mcp',
    }),
  ];
  const catalogList = async (stack: TestStack): Promise<AppCatalogEntry[]> =>
    (
      (await stack.core.rpc.call('apps.catalog.list', undefined)) as {
        entries: AppCatalogEntry[];
      }
    ).entries;
  const status = async (stack: TestStack): Promise<AppsDirectoryStatus> =>
    (await stack.core.rpc.call('apps.directory.status', undefined)) as AppsDirectoryStatus;

  it('verified remote entries reach apps.catalog.list; tamper / rollback / outage degrade but keep them; the setting disables sync', async () => {
    const key = makeKey('it-1');
    const dir = await serveDirectory();
    const stack = await createTestStack({
      directorySync: { keys: [key.publicEntry], baseUrl: dir.baseUrl, initialDelayMs: 3_600_000 },
    });
    cleanups.push(() => stack.cleanup());

    expect(await catalogList(stack)).toEqual([]); // snapshot is empty in test-hook builds
    expect(await status(stack)).toMatchObject({ state: 'stale', lastSync: null });

    dir.serve(signIndex({ entries: entries(), key, generatedAt: T2 }));
    const ok = (await stack.core.rpc.call('apps.directory.sync', undefined)) as AppsDirectoryStatus;
    expect(ok).toMatchObject({
      state: 'ok',
      keyId: 'it-1',
      version: T2,
      remoteEntries: 2,
      error: null,
    });
    const list = await catalogList(stack);
    expect(list.map((e) => [e.connectorId, e.tier, e.connectable])).toEqual([
      ['acme', 'verified', true],
      ['hobby', 'community', true],
    ]);
    expect(list[0]!.iconDataUri).toBeNull();

    // Rolled back (older but validly signed): rejected, previous entries stay.
    dir.serve(signIndex({ entries: [entries()[0]], key, generatedAt: T1 }));
    const rolled = (await stack.core.rpc.call(
      'apps.directory.sync',
      undefined,
    )) as AppsDirectoryStatus;
    expect(rolled).toMatchObject({ state: 'degraded', version: T2 });
    expect(rolled.error).toContain('rollback');
    expect(await catalogList(stack)).toHaveLength(2);

    // Tampered bytes: rejected.
    const signed = signIndex({ entries: entries(), key, generatedAt: T2 + 1000 });
    dir.serve({
      indexBytes: Buffer.from(signed.indexBytes.toString('utf8').replace('Hobby', 'Evil!')),
      sig: signed.sig,
    });
    expect(
      ((await stack.core.rpc.call('apps.directory.sync', undefined)) as AppsDirectoryStatus).error,
    ).toContain('bad_signature');
    expect((await catalogList(stack)).map((e) => e.title)).toEqual(['Acme', 'Hobby']);

    // Outage, then recovery with a newer index that drops an entry.
    dir.serve(null);
    expect(
      ((await stack.core.rpc.call('apps.directory.sync', undefined)) as AppsDirectoryStatus).state,
    ).toBe('degraded');
    dir.serve(signIndex({ entries: [entries()[0]], key, generatedAt: T2 + 2000 }));
    expect(await stack.core.rpc.call('apps.directory.sync', undefined)).toMatchObject({
      state: 'ok',
      remoteEntries: 1,
    });
    expect((await catalogList(stack)).map((e) => e.connectorId)).toEqual(['acme']);

    // The setting switch: no network at all, and the cached remote entries vanish at once.
    const before = dir.hits.length;
    await stack.core.rpc.call('settings.update', { apps: { directorySync: false } });
    expect(await catalogList(stack)).toEqual([]);
    expect(await status(stack)).toMatchObject({ state: 'disabled', disabledReason: 'setting_off' });
    await stack.core.rpc.call('apps.directory.sync', undefined);
    expect(dir.hits.length).toBe(before);
    // Back on: the verified cache returns without needing the network first.
    await stack.core.rpc.call('settings.update', { apps: { directorySync: true } });
    expect((await catalogList(stack)).map((e) => e.connectorId)).toEqual(['acme']);
  }, 60_000);

  it('a directory-sourced entry with a loopback endpoint never reaches the catalog (no loopback exception)', async () => {
    const key = makeKey('it-3');
    const dir = await serveDirectory();
    const stack = await createTestStack({
      directorySync: { keys: [key.publicEntry], baseUrl: dir.baseUrl, initialDelayMs: 3_600_000 },
    });
    cleanups.push(() => stack.cleanup());
    dir.serve(
      signIndex({
        entries: [
          fakeCatalogEntry({
            slug: 'sneaky',
            tier: 'community',
            url: 'http://127.0.0.1:9999/mcp',
          }),
          entries()[0],
        ],
        key,
        generatedAt: T2,
      }),
    );
    await stack.core.rpc.call('apps.directory.sync', undefined);
    expect((await catalogList(stack)).map((e) => e.connectorId)).toEqual(['acme']);
    await expect(
      stack.core.rpc.call('apps.connect', { target: { kind: 'catalog', connectorId: 'sneaky' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);

  it('an empty key list (the production default) disables sync: snapshot only, no network', async () => {
    const dir = await serveDirectory();
    const key = makeKey('it-2');
    dir.serve(signIndex({ entries: entries(), key, generatedAt: T2 }));
    const stack = await createTestStack({
      directorySync: { keys: [], baseUrl: dir.baseUrl, initialDelayMs: 10 },
    });
    cleanups.push(() => stack.cleanup());
    expect(await status(stack)).toMatchObject({ state: 'disabled', disabledReason: 'no_keys' });
    await stack.core.rpc.call('apps.directory.sync', undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dir.hits).toEqual([]);
    expect(await catalogList(stack)).toEqual([]);
  });
});

describe('community tier: first connect and write-tool durations', () => {
  const TOOLS: FakeMcpTool[] = [
    {
      name: 'create_note',
      description: 'Create a note',
      // Closed world: not a taint egress channel, so the standing grant alone decides.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
  const ACCOUNT = { sub: 'acct-1', email: 'jyy@example.com' };
  const TERMINAL = new Set(['done', 'failed', 'cancelled']);

  it('review event carries the tier; the write card has no bot duration; a forged bot degrades; a conversation grant works', async () => {
    const fake = await startFakeOAuthMcpServer({ dcrEnabled: true, tools: TOOLS });
    cleanups.push(() => fake.stop());
    const catalog = new ConnectorCatalog({
      env: {},
      source: {
        entries: [
          fakeCatalogEntry({
            slug: 'notes',
            title: 'Notes',
            tier: 'community',
            url: fake.mcpUrl,
            releaseGate: 'notes-gate',
          }),
        ],
        iconsDir: null,
      },
      approvedGates: ['notes-gate'],
    });
    const stack = await createTestStack({
      connectorCatalog: catalog,
      shellRpc: {
        async openExternal({ url }) {
          void simulateBrowser(url).catch(() => undefined);
          return { ok: true };
        },
      },
      oauthLoopbackAllowlist: ['127.0.0.1'],
      oauthCallbackPorts: await freePorts(3),
      oauthFlowTimeoutMs: 20_000,
      toolLockTrustFirstList: false,
    });
    cleanups.push(() => stack.cleanup());
    const { core, llm } = stack;
    fake.configure({ idTokenClaims: { ...ACCOUNT } });
    const flowEvents: AppConnectFlowPayload[] = [];
    core.onEvent('apps.connect_flow', (payload) => {
      flowEvents.push(payload);
      if (payload.phase === 'awaiting_consent') {
        void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
      }
    });

    const bot = await makeBot(core, '小应');
    const { flowId } = (await core.rpc.call('apps.connect', {
      target: { kind: 'catalog', connectorId: 'notes' },
      grantBotId: bot.id,
    })) as { flowId: string };
    const mine = () => flowEvents.filter((e) => e.flowId === flowId);
    const review = await until(
      () => mine().find((e) => e.phase === 'reviewing_tools' || TERMINAL.has(e.phase)),
      20_000,
      'reviewing_tools',
    );
    expect(review).toMatchObject({ phase: 'reviewing_tools', tier: 'community' });
    // Core enforces the community acknowledgement itself, not only the renderer checkbox.
    await expect(core.rpc.call('apps.connect.confirmTools', { flowId })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      core.rpc.call('apps.connect.confirmTools', { flowId, acknowledgeCommunity: false }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mine().some((e) => TERMINAL.has(e.phase))).toBe(false); // still waiting for review
    await core.rpc.call('apps.connect.confirmTools', { flowId, acknowledgeCommunity: true });
    const done = await until(() => mine().find((e) => TERMINAL.has(e.phase)), 20_000, 'done');
    expect(done.phase).toBe('done');
    const connectionId = done.connectionId!;

    const conv = await openDirect(core, bot.id);
    llm.script('mock-main', [
      ...viaTask({
        writes: true,
        taskSteps: [
          step().replyToolCall('app_notes_create_note', { title: 'one' }),
          step().replyToolCall('app_notes_create_note', { title: 'two' }),
          step().replyToolCall('app_notes_create_note', { title: 'three' }),
          step().replyText('完成'),
        ],
        relay: '好了',
      }),
    ]);
    await sendBatch(core, conv.id, ['记三条']);

    const cards = async (): Promise<Approval[]> =>
      (
        (await core.rpc.call('approvals.list', { conversationId: conv.id })) as {
          approvals: Approval[];
        }
      ).approvals.filter((a) => a.kind === 'mcp_tool');
    const cardFor = async (title: string): Promise<Approval | null> =>
      (await cards()).find((a) => String(a.payload['argsSummary']).includes(`"${title}"`)) ?? null;
    const pending = (title: string): Promise<Approval> =>
      waitFor(
        async () => {
          const card = await cardFor(title);
          return card?.status === 'pending' ? card : null;
        },
        { label: `card ${title}`, timeoutMs: 30_000 },
      );

    const first = await pending('one');
    expect(first.payload).toMatchObject({
      toolName: 'create_note',
      risk: 'write',
      durations: ['once', 'conversation'],
    });
    // A forged 「总是允许」 (the card never offered it) degrades to once; no grant is written.
    await core.rpc.call('approvals.decide', { id: first.id, approve: true, duration: 'bot' });
    expect((await cardFor('one'))!.decision).toEqual({ duration: 'once' });
    expect(core.services.appToolGrants!.list({ connectionId })).toEqual([]);

    // The second call asks again; 「本对话内」 is allowed and the third call needs no card.
    const second = await pending('two');
    expect(second.payload['durations']).toEqual(['once', 'conversation']);
    await core.rpc.call('approvals.decide', {
      id: second.id,
      approve: true,
      duration: 'conversation',
    });
    await waitFor(
      async () =>
        (await listRuns(core, conv.id)).find(
          (r) => r.loopType === 'task' && r.status === 'completed',
        ) ?? null,
      { label: 'task completed', timeoutMs: 60_000 },
    );
    expect(await cards()).toHaveLength(2);
    expect(core.services.appToolGrants!.list({ connectionId })).toMatchObject([
      { botId: bot.id, toolName: 'create_note', conversationId: conv.id },
    ]);
    expect(fake.toolCalls.filter((c) => c.name === 'create_note')).toHaveLength(3);
  }, 120_000);
});
