import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorIndexPublicKey } from '@kepcup/shared';
import { PLUGIN_INDEX_BASE_URL, PLUGIN_INDEX_PUBLIC_KEYS } from '@kepcup/shared';
import { MarketplaceService } from '../../src/plugins/marketplace-service.js';
import type { MarketplaceSyncEvents } from '../../src/plugins/marketplace-sync.js';
import {
  buildPluginFixture,
  buildPluginIndex,
  makeMarketKey,
  memoryMarketFetch,
  pluginIndexEntryFor,
  type PluginMarketKey,
} from '@kepcup/testkit';

/**
 * MarketplaceService 的单元测试（D104 P1-1 步骤 3.2）：官方 / 自建端点解析、公钥信任根、
 * 缓存目录隔离、切换（停旧建新 + 事件）与 endpointId。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

interface FakeSettings {
  pluginMarketplaceUrl: string;
  pluginMarketplacePublicKey: string;
  pluginAutoCheckUpdates: boolean;
}

interface Harness {
  settings: FakeSettings;
  cacheDir: string;
  officialKey: PluginMarketKey;
  customKey: PluginMarketKey;
  events: Array<{ name: string; payload: unknown }>;
  servers: Map<string, ReturnType<typeof memoryMarketFetch>>;
  requests: Map<string, number>;
  make(options?: {
    officialKeys?: ConnectorIndexPublicKey[];
    officialBaseUrl?: string;
    settings?: Partial<FakeSettings>;
  }): MarketplaceService;
  setSettings(patch: Partial<FakeSettings>): void;
}

function harness(): Harness {
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'market-svc-'));
  dirs.push(cacheDir);
  const settings: FakeSettings = {
    pluginMarketplaceUrl: '',
    pluginMarketplacePublicKey: '',
    pluginAutoCheckUpdates: true,
  };
  const officialKey = makeMarketKey('official-test');
  // The service registers custom public keys under the fixed keyId 'custom' — custom
  // indexes must be signed with a key carrying that id.
  const customKey = makeMarketKey('custom');
  const calls: Array<{ name: string; payload: unknown }> = [];
  const bus = {
    emit: (name: never, payload: never) => {
      calls.push({ name, payload });
    },
  } as unknown as MarketplaceSyncEvents;
  const servers = new Map<string, ReturnType<typeof memoryMarketFetch>>();
  const requests = new Map<string, number>();
  const fetchFactory = () => async (input: string) => {
    const base = new URL(input).origin + new URL(input).pathname.replace(/\/index\.json.*$/, '');
    requests.set(base, (requests.get(base) ?? 0) + 1);
    const server = servers.get(base);
    if (server === undefined) return new Response('not found', { status: 404 });
    return server.fetch(input);
  };
  const clock = { t: NOW, now: () => clock.t };
  const logger = { info() {}, warn() {}, error() {} } as never;
  return {
    settings,
    cacheDir,
    officialKey,
    customKey,
    events: calls,
    servers,
    requests,
    make: (options = {}) =>
      new MarketplaceService({
        settings: { get: () => ({ ...settings, ...options.settings }) },
        cacheDir,
        clock,
        logger,
        events: bus,
        official: {
          keys: options.officialKeys ?? [officialKey.publicEntry],
          baseUrl: options.officialBaseUrl ?? 'https://official.example.com/plugins/v1',
        },
        fetchFactory,
        timing: { initialDelayMs: 10, intervalMs: 3600_000 },
      }),
    setSettings(patch: Partial<FakeSettings>) {
      Object.assign(settings, patch);
    },
  };
}

/** Serves a signed index (the given key) at `base`. */
async function serve(h: Harness, base: string, key: PluginMarketKey, generatedAt = NOW): void {
  const server = memoryMarketFetch(new Map());
  const fixture = await buildPluginFixture({ dir: mkdtempSync(path.join(tmpdir(), 'svc-pkg-')) });
  dirs.push(path.dirname(fixture.path));
  const entry = pluginIndexEntryFor(fixture);
  const signed = buildPluginIndex({ key, generatedAt, entries: [{ ...entry, id: 'io.a/b' }] });
  server.publish(`${base}/index.json`, signed.indexBytes);
  server.publish(`${base}/index.json.sig`, Buffer.from(`${signed.sig}\n`));
  h.servers.set(base, server);
}

describe('official endpoint', () => {
  it('resolves the official market when the url is empty', () => {
    const h = harness();
    const service = h.make();
    expect(service.isOfficial()).toBe(true);
    expect(service.endpointId()).toBe('https://official.example.com/plugins/v1');
    const sync = service.current();
    expect(sync).not.toBeNull();
    expect(sync!.endpoint).toBe('official');
    expect(service.status()).toMatchObject({ state: 'stale', endpoint: 'official' });
  });

  it('is disabled with no_keys when the official key list is empty (production default)', () => {
    const h = harness();
    const service = h.make({ officialKeys: PLUGIN_INDEX_PUBLIC_KEYS }); // empty
    expect(service.current()).toBeNull();
    expect(service.status()).toMatchObject({
      state: 'disabled',
      disabledReason: 'no_keys',
      endpoint: 'official',
    });
  });
});

describe('custom endpoint', () => {
  it('is disabled with no_custom_key when no public key is registered', () => {
    const h = harness();
    const service = h.make();
    h.setSettings({ pluginMarketplaceUrl: 'https://self.example.com/plugins/v1' });
    expect(service.current()).toBeNull();
    expect(service.isOfficial()).toBe(false);
    expect(service.status()).toMatchObject({
      state: 'disabled',
      disabledReason: 'no_custom_key',
      endpoint: 'custom',
    });
    expect(service.endpointId()).toBe('https://self.example.com/plugins/v1');
  });

  it('verifies with the registered custom key and rejects an official-signed index', async () => {
    const h = harness();
    await serve(h, 'https://self.example.com/plugins/v1', h.customKey);
    const service = h.make();
    h.setSettings({
      pluginMarketplaceUrl: 'https://self.example.com/plugins/v1',
      pluginMarketplacePublicKey: h.customKey.publicEntry.publicKey,
    });
    const sync = service.current();
    expect(sync).not.toBeNull();
    expect(sync!.endpoint).toBe('custom');
    expect((await sync!.sync()).state).toBe('ok');
    expect(sync!.entries()).toHaveLength(1);
    // Custom tiers cap at community even though the index says verified.
    expect(sync!.entries()[0]!.tier).toBe('community');
  });

  it('rejects an index signed with the official key on a custom endpoint', async () => {
    const h = harness();
    await serve(h, 'https://self.example.com/plugins/v1', h.officialKey);
    const service = h.make();
    h.setSettings({
      pluginMarketplaceUrl: 'https://self.example.com/plugins/v1',
      pluginMarketplacePublicKey: h.customKey.publicEntry.publicKey,
    });
    const sync = service.current()!;
    // The official keyId is not registered on the custom endpoint → rejected outright.
    expect((await sync.sync()).state).toBe('degraded');
    expect((await sync.sync()).error).toContain('unknown_key');
    expect(sync.entries()).toEqual([]);
  });
});

describe('endpoint switch', () => {
  it('stops the old instance, uses an independent cache dir and announces the switch', async () => {
    vi.useFakeTimers();
    const h = harness();
    await serve(h, 'https://official.example.com/plugins/v1', h.officialKey);
    await serve(h, 'https://self.example.com/plugins/v1', h.customKey);
    const service = h.make();
    service.start();
    const official = service.current()!;
    await vi.advanceTimersByTimeAsync(50);
    const officialRequests = h.requests.get('https://official.example.com/plugins/v1') ?? 0;
    expect(officialRequests).toBeGreaterThan(0);

    h.setSettings({
      pluginMarketplaceUrl: 'https://self.example.com/plugins/v1',
      pluginMarketplacePublicKey: h.customKey.publicEntry.publicKey,
    });
    const custom = service.current()!;
    expect(custom).not.toBe(official);
    expect(custom.endpoint).toBe('custom');
    await custom.sync();
    expect(custom.entries()).toHaveLength(1);
    // The old instance no longer pulls: advance well past its interval.
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(h.requests.get('https://official.example.com/plugins/v1')).toBe(officialRequests);
    expect(h.events).toContainEqual({
      name: 'plugins.marketplace.updated',
      payload: { generatedAt: null },
    });
    service.stop();
  });

  it('switching back to official stops the custom instance', async () => {
    const h = harness();
    await serve(h, 'https://self.example.com/plugins/v1', h.customKey);
    const service = h.make();
    h.setSettings({
      pluginMarketplaceUrl: 'https://self.example.com/plugins/v1',
      pluginMarketplacePublicKey: h.customKey.publicEntry.publicKey,
    });
    const custom = service.current()!;
    expect(custom.endpoint).toBe('custom');
    h.setSettings({ pluginMarketplaceUrl: '', pluginMarketplacePublicKey: '' });
    const official = service.current()!;
    expect(official).not.toBe(custom);
    expect(official.endpoint).toBe('official');
  });
});

describe('endpointId normalization', () => {
  it('trims trailing slashes of a custom url', () => {
    const h = harness();
    const service = h.make();
    h.setSettings({ pluginMarketplaceUrl: 'https://self.example.com/plugins/v1///' });
    expect(service.endpointId()).toBe('https://self.example.com/plugins/v1');
  });

  it('falls back to the shared official base url constant by default', () => {
    const h = harness();
    const service = h.make({
      officialBaseUrl: PLUGIN_INDEX_BASE_URL,
      officialKeys: PLUGIN_INDEX_PUBLIC_KEYS,
    });
    expect(service.endpointId()).toBe(PLUGIN_INDEX_BASE_URL);
    expect(service.status().disabledReason).toBe('no_keys');
  });
});
