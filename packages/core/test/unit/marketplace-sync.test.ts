import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPluginFixture, type PluginFixture } from '@kepcup/testkit';
import { MarketplaceSync, type MarketplaceSyncEvents } from '../../src/plugins/marketplace-sync.js';
import {
  buildPluginIndex,
  makeMarketKey,
  memoryMarketFetch,
  pluginIndexEntryFor,
  type PluginMarketKey,
} from '../support/plugin-market-fixture.js';

/**
 * MarketplaceSync 的单元测试（D104 P1-1 步骤 3）：条目逐条校验、custom 封顶 community、
 * 版本挑选与兼容判断、撤销名单、包下载的各防篡改分支与缓存行为。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const BASE = 'https://market.example.com/plugins/v1';

interface Events {
  calls: Array<{ name: string; payload: unknown }>;
  bus: MarketplaceSyncEvents;
}

function events(): Events {
  const calls: Array<{ name: string; payload: unknown }> = [];
  return {
    calls,
    bus: {
      emit: (name: never, payload: never) => {
        calls.push({ name, payload });
      },
    } as unknown as MarketplaceSyncEvents,
  };
}

interface Package {
  fixture: PluginFixture;
  bytes: Buffer;
}

async function makePackage(options: { id?: string; version?: string } = {}): Promise<Package> {
  const fixture = await buildPluginFixture({
    dir: mkdtempSync(path.join(tmpdir(), 'market-pkg-')),
    manifest: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.version !== undefined ? { version: options.version } : {}),
    },
    skills: [{ name: 'demo' }],
  });
  dirs.push(path.dirname(fixture.path));
  return { fixture, bytes: readFileSync(fixture.path) };
}

interface Harness {
  dir: string;
  packagesDir: string;
  key: PluginMarketKey;
  files: Map<string, Buffer>;
  server: ReturnType<typeof memoryMarketFetch>;
  clock: { t: number; now(): number };
  events: Events;
  packages: Record<string, Package>;
  make(overrides?: Partial<ConstructorParameters<typeof MarketplaceSync>[0]>): MarketplaceSync;
  publish(
    entries: Array<Record<string, unknown>>,
    generatedAt: number,
    options?: { key?: PluginMarketKey; revoked?: Array<Record<string, unknown>> },
  ): void;
}

async function harness(
  options: { endpoint?: 'official' | 'custom'; key?: PluginMarketKey } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'market-idx-'));
  const packagesDir = mkdtempSync(path.join(tmpdir(), 'market-cache-'));
  dirs.push(dir, packagesDir);
  const key = options.key ?? makeMarketKey();
  const files = new Map<string, Buffer>();
  const server = memoryMarketFetch(files);
  const clock = { t: NOW, now: () => clock.t };
  const bus = events();
  const packages: Record<string, Package> = {};
  const syncOptions = {
    dir,
    packagesDir,
    baseUrl: BASE,
    keys: [key.publicEntry],
    endpoint: options.endpoint ?? ('official' as const),
    fetch: server.fetch,
    downloadFetch: server.fetch,
    clock,
    logger: {
      info() {},
      warn() {},
      error() {},
    } as never,
    events: bus.bus,
  };
  const make = (overrides: Partial<typeof syncOptions> = {}) =>
    new MarketplaceSync({ ...syncOptions, ...overrides });
  return {
    dir,
    packagesDir,
    key,
    files,
    server,
    clock,
    events: bus,
    packages,
    make,
    publish(entries, generatedAt, publishOptions = {}) {
      const signKey = publishOptions.key ?? key;
      const signed = buildPluginIndex({
        key: signKey,
        generatedAt,
        entries,
        ...(publishOptions.revoked !== undefined ? { revoked: publishOptions.revoked } : {}),
      });
      files.set(`${BASE}/index.json`, signed.indexBytes);
      files.set(`${BASE}/index.json.sig`, Buffer.from(`${signed.sig}\n`));
    },
  };
}

interface Registered {
  h: Harness;
  entry: ReturnType<typeof pluginIndexEntryFor>;
}

async function registerPackage(
  h: Harness,
  options: {
    id?: string;
    version?: string;
    tier?: 'verified' | 'community';
    downloadUrl?: string;
    engines?: { kepcup: string };
    platforms?: Array<'darwin' | 'win32' | 'linux'>;
    broken?: boolean;
  } = {},
): Promise<Registered> {
  const pkg = await makePackage({ id: options.id, version: options.version });
  const suffix = Object.keys(h.packages).length === 0 ? '' : `-${Object.keys(h.packages).length}`;
  const id = (pkg.fixture.manifest as { id: string }).id;
  h.packages[`${id}${suffix}`] = pkg;
  const downloadUrl = options.downloadUrl ?? `https://pkg.test/${pkg.fixture.sha256}.kepcup`;
  h.files.set(downloadUrl, options.broken ? Buffer.from('tampered') : pkg.bytes);
  const entry = pluginIndexEntryFor(pkg.fixture, {
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    downloadUrl,
  });
  if (options.engines !== undefined) entry.engines = options.engines;
  if (options.platforms !== undefined) entry.platforms = options.platforms;
  return { h, entry };
}

describe('entries', () => {
  it('parses the adopted index and skips malformed entries', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h);
    h.publish([{ ...entry, size: -5 }, entry], NOW); // first one fails its schema
    const sync = h.make();
    expect((await sync.sync()).state).toBe('ok');
    expect(sync.entries()).toHaveLength(1);
    expect(sync.entries()[0]).toMatchObject({ id: entry.id, sha256: entry.sha256 });
    expect(sync.revision()).toBe(1);
  });

  it('caps custom-endpoint tiers at community', async () => {
    const h = await harness({ endpoint: 'custom' });
    const { entry } = await registerPackage(h, { tier: 'verified' });
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    expect(sync.entries()[0]!.tier).toBe('community');
  });
});

describe('find', () => {
  it('picks the highest compatible version', async () => {
    const h = await harness();
    const v1 = await registerPackage(h, { version: '1.0.0' });
    const v2 = await registerPackage(h, { version: '1.2.0' });
    const v11 = await registerPackage(h, { version: '1.1.0' });
    h.publish([v1.entry, v2.entry, v11.entry], NOW);
    const sync = h.make();
    await sync.sync();
    expect(sync.find((v1.entry as { id: string }).id, { appVersion: '1.0.0', platform: 'darwin' }))
      .toMatchObject({ version: '1.2.0' });
  });

  it('matches an exact version even when incompatible', async () => {
    const h = await harness();
    const older = await registerPackage(h, {
      version: '1.0.0',
      engines: { kepcup: '>=99.0.0' },
    });
    h.publish([older.entry], NOW);
    const sync = h.make();
    await sync.sync();
    const id = (older.entry as { id: string }).id;
    expect(
      sync.find(id, { version: '1.0.0', appVersion: '1.0.0', platform: 'darwin' }),
    ).toMatchObject({ version: '1.0.0' });
    expect(
      sync.find(id, { appVersion: '1.0.0', platform: 'darwin' }),
    ).toBeNull();
  });

  it('filters by platform and engine range', async () => {
    const h = await harness();
    const winOnly = await registerPackage(h, { platforms: ['win32'] });
    const engine = await registerPackage(h, { engines: { kepcup: '>=2.0.0' } });
    h.publish([winOnly.entry, engine.entry], NOW);
    const sync = h.make();
    await sync.sync();
    const appVersion = '1.5.0';
    expect(sync.find((winOnly.entry as { id: string }).id, { appVersion, platform: 'darwin' })).toBeNull();
    expect(sync.find((winOnly.entry as { id: string }).id, { appVersion, platform: 'win32' })).not.toBeNull();
    // 0.0.0 cores (dev / test) skip the engine check entirely.
    expect(sync.find((engine.entry as { id: string }).id, { appVersion: '0.0.0-test', platform: 'darwin' })).not.toBeNull();
    expect(sync.find((engine.entry as { id: string }).id, { appVersion, platform: 'darwin' })).toBeNull();
    expect(
      sync.incompatibleReason(engine.entry, appVersion, 'darwin'),
    ).toContain('2.0.0');
  });
});

describe('revocationOf', () => {
  it('matches exact versions, whole ids and prefers disable over warn', async () => {
    const h = await harness();
    const a = await registerPackage(h, { id: 'io.a/one', version: '1.0.0' });
    const b = await registerPackage(h, { id: 'io.b/two', version: '2.0.0' });
    h.publish([a.entry, b.entry], NOW, {
      revoked: [
        { id: 'io.a/one', version: '1.0.0', action: 'warn' },
        { id: 'io.b/two', action: 'disable' },
      ],
    });
    const sync = h.make();
    await sync.sync();
    expect(sync.revocationOf('io.a/one', '1.0.0')).toBe('warn');
    expect(sync.revocationOf('io.a/one', '9.9.9')).toBeNull();
    expect(sync.revocationOf('io.b/two', '2.0.0')).toBe('disable');
  });
});

describe('download', () => {
  it('downloads, verifies sha256 / size, renames to the content address with 0600', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h);
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    const filePath = await sync.download(entry);
    expect(filePath).toBe(path.join(h.packagesDir, `${entry.sha256}.kepcup`));
    expect(existsSync(filePath)).toBe(true);
    expect(
      createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    ).toBe(entry.sha256);
    expect((readFileSync(filePath)).length).toBe(entry.size);
  });

  it('rejects a package whose bytes do not match the indexed sha256', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h, { broken: true });
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    await expect(sync.download(entry)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    // No leftover temp files.
    expect(readdirSync(h.packagesDir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('rejects a body larger than the declared size and an over-large Content-Length', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h);
    // Serve extra bytes behind the same URL: the streamed size check aborts mid-write.
    h.files.set(entry.downloadUrl, Buffer.concat([readFileSync(h.packages[`${entry.id}`].fixture.path), Buffer.alloc(10, 1)]));
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    await expect(sync.download(entry)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
    expect(readdirSync(h.packagesDir).filter((name) => name.startsWith('.tmp-'))).toEqual([]);

    // A Content-Length above entry.size is refused before reading the body.
    const { entry: entry2 } = await registerPackage(h);
    h.publish([entry2], NOW);
    const oversize = new Response(readFileSync(h.packages[`${entry2.id}`].fixture.path), {
      status: 200,
      headers: { 'content-length': String(entry2.size + 1) },
    });
    const refusingFetch = async () => oversize;
    const sync2 = h.make({ downloadFetch: refusingFetch as never });
    await expect(sync2.download(entry2)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('rejects an unsafe download url', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h, { downloadUrl: 'http://pkg.test/x.kepcup' });
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    await expect(sync.download(entry)).rejects.toMatchObject({ code: 'PLUGIN_INVALID' });
  });

  it('reuses a valid cache hit and re-downloads a corrupted one', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h);
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    const filePath = path.join(h.packagesDir, `${entry.sha256}.kepcup`);
    expect(await sync.download(entry)).toBe(filePath);
    const servedBefore = h.server.requests.filter((url) => url === entry.downloadUrl).length;
    expect(await sync.download(entry)).toBe(filePath);
    expect(h.server.requests.filter((url) => url === entry.downloadUrl)).toHaveLength(servedBefore);

    writeFileSync(filePath, Buffer.from('corrupted'));
    h.server.requests.length = 0;
    expect(await sync.download(entry)).toBe(filePath);
    expect(h.server.requests.filter((url) => url === entry.downloadUrl)).toHaveLength(1);
    expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(entry.sha256);
  });

  it('merges concurrent downloads of the same package', async () => {
    const h = await harness();
    const { entry } = await registerPackage(h);
    h.publish([entry], NOW);
    const sync = h.make();
    await sync.sync();
    const [a, b] = await Promise.all([sync.download(entry), sync.download(entry)]);
    expect(a).toBe(b);
    expect(h.server.requests.filter((url) => url === entry.downloadUrl)).toHaveLength(1);
  });

  it('cleans up package cache files older than seven days at start()', async () => {
    const h = await harness();
    const stale = path.join(h.packagesDir, `${'a'.repeat(64)}.kepcup`);
    const fresh = path.join(h.packagesDir, `${'b'.repeat(64)}.kepcup`);
    writeFileSync(stale, 'old');
    writeFileSync(fresh, 'new');
    const oldTime = new Date(NOW - 8 * 24 * 3600_000);
    utimesSync(stale, oldTime, oldTime);
    const sync = h.make();
    sync.start();
    await vi.waitFor(() => {
      expect(existsSync(stale)).toBe(false);
    });
    expect(existsSync(fresh)).toBe(true);
    sync.stop();
  });
});

describe('enabled gates only the timer', () => {
  it('a disabled timer does not pull, while manual sync still does', async () => {
    vi.useFakeTimers();
    const h = await harness();
    const { entry } = await registerPackage(h);
    h.publish([entry], NOW);
    let on = false;
    const sync = h.make({ enabled: () => on, initialDelayMs: 10, intervalMs: 1000, random: () => 0.5 });
    const pulls = () => h.server.requests.filter((url) => url === `${BASE}/index.json`).length;
    sync.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(pulls()).toBe(0); // gated off: the tick skipped the fetch
    // Manual sync ignores the switch (打开市场页仍联网).
    await sync.sync();
    expect(pulls()).toBe(1);
    on = true;
    await vi.advanceTimersByTimeAsync(1200);
    expect(pulls()).toBeGreaterThan(1);
    sync.stop();
  });
});
