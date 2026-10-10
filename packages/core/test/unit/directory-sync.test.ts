import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_INDEX_STALE_AFTER_MS } from '@kepcup/shared';
import { DirectorySync, verifySignedIndex } from '../../src/apps/directory-sync.js';
import { fakeCatalogEntry } from '../support/catalog-connect-env.js';
import {
  FakeDirectory,
  makeKey,
  signIndex,
  signScript,
  type TestKey,
} from '../support/directory-fixture.js';

/**
 * 签名目录索引客户端（D73 P3 §7.1）：验签、密钥选择、防回滚、ETag、缓存、回落、状态。
 * 用真实签名脚本的函数造索引，内存里的假目录服务；不联网。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const T1 = Date.parse('2026-10-09T00:00:00.000Z');
const T2 = Date.parse('2026-10-10T00:00:00.000Z');

const entry = (
  slug: string,
  version = '1.0.0',
  tier: 'verified' | 'community' | 'builtin' = 'verified',
) => fakeCatalogEntry({ slug, version, tier, url: `https://${slug}.example.com/mcp` });

interface Harness {
  dir: string;
  server: FakeDirectory;
  key: TestKey;
  clock: { t: number; now(): number };
  warnings: Array<Record<string, unknown>>;
  make(overrides?: Partial<ConstructorParameters<typeof DirectorySync>[0]>): DirectorySync;
}

function harness(options: { key?: TestKey; dir?: string } = {}): Harness {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), 'dirsync-'));
  if (options.dir === undefined) dirs.push(dir);
  const key = options.key ?? makeKey();
  const server = new FakeDirectory();
  const clock = { t: NOW, now: () => clock.t };
  const warnings: Array<Record<string, unknown>> = [];
  return {
    dir,
    server,
    key,
    clock,
    warnings,
    make: (overrides = {}) =>
      new DirectorySync({
        dir,
        keys: [key.publicEntry],
        fetch: server.fetch,
        clock,
        logger: {
          info() {},
          warn: (record: Record<string, unknown>) => warnings.push(record),
        } as never,
        baseUrl: 'https://dl.example.com/connectors/v1',
        ...overrides,
      }),
  };
}

function publish(h: Harness, entries: unknown[], generatedAt: number, key = h.key): void {
  h.server.publish(signIndex({ entries, key, generatedAt }));
}

describe('sync: the happy path', () => {
  it('verifies, caches atomically and exposes the entries', async () => {
    const h = harness();
    publish(h, [entry('alpha'), entry('beta')], T1);
    const sync = h.make();
    expect(sync.status()).toMatchObject({ state: 'stale', lastSync: null, version: null });

    const status = await sync.sync();
    expect(status).toMatchObject({
      state: 'ok',
      version: T1,
      keyId: 'test-1',
      remoteEntries: 2,
      error: null,
      lastSync: NOW,
    });
    expect(sync.entries()).toHaveLength(2);
    expect(sync.revision()).toBe(1);
    for (const file of ['index.json', 'index.json.sig', 'state.json']) {
      expect(existsSync(path.join(h.dir, file)), file).toBe(true);
    }
    const state = JSON.parse(readFileSync(path.join(h.dir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ version: 1, generatedAt: T1, keyId: 'test-1' });
  });

  it('a fresh instance re-verifies and loads the cache without any network', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    await h.make().sync();
    h.server.offline = true;
    const reloaded = h.make();
    expect(reloaded.entries()).toHaveLength(1);
    expect(reloaded.status()).toMatchObject({ state: 'ok', version: T1, remoteEntries: 1 });
    expect(h.server.requests.filter((r) => r.path === 'index.json')).toHaveLength(1);
  });

  it('a tampered cache on disk is ignored (re-verified at load), not trusted', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    await h.make().sync();
    const file = path.join(h.dir, 'index.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('alpha', 'omega'));
    const reloaded = h.make();
    expect(reloaded.entries()).toEqual([]);
    expect(h.warnings.some((w) => String(w['error']).includes('bad_signature'))).toBe(true);
  });
});

describe('ETag', () => {
  it('sends If-None-Match and treats 304 as a successful, unchanged check', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 3600_000;
    const status = await sync.sync();
    const requests = h.server.requests.filter((r) => r.path === 'index.json');
    expect(requests[0]!.ifNoneMatch).toBeNull();
    expect(requests[1]!.ifNoneMatch).toMatch(/^"v1"$/);
    expect(status).toMatchObject({ state: 'ok', error: null, lastSync: NOW + 3600_000 });
    expect(sync.revision()).toBe(1); // nothing changed, no re-merge
    // the signature file is not downloaded again on 304
    expect(h.server.requests.filter((r) => r.path === 'index.json.sig')).toHaveLength(1);
  });
});

describe('verification failures fall back (snapshot / last verified cache) and degrade', () => {
  it('tampered index bytes are rejected', async () => {
    const h = harness();
    const signed = signIndex({ entries: [entry('alpha')], key: h.key, generatedAt: T1 });
    h.server.publish(signed);
    h.server.tamper(
      'index.json',
      Buffer.from(signed.indexBytes.toString('utf8').replace('alpha', 'omega')),
    );
    const sync = h.make();
    const status = await sync.sync();
    expect(status.state).toBe('degraded');
    expect(status.error).toContain('bad_signature');
    expect(sync.entries()).toEqual([]);
    expect(h.warnings.length).toBeGreaterThan(0);
    expect(existsSync(path.join(h.dir, 'index.json'))).toBe(false);
  });

  it('a tampered signature is rejected, a garbage signature is rejected', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    h.server.tamper('index.json.sig', Buffer.from(`${'A'.repeat(86)}==`));
    expect((await h.make().sync()).error).toContain('bad_signature');
    h.server.tamper('index.json.sig', Buffer.from('not base64 !!'));
    expect((await h.make().sync()).error).toContain('invalid_signature_format');
  });

  it('an index signed by a different key under the right keyId is rejected', async () => {
    const h = harness();
    const attacker = makeKey('test-1');
    publish(h, [entry('alpha')], T1, attacker);
    const status = await h.make().sync();
    expect(status.state).toBe('degraded');
    expect(status.error).toContain('bad_signature');
  });

  it('an unknown keyId is rejected', async () => {
    const h = harness();
    const other = makeKey('someone-else');
    publish(h, [entry('alpha')], T1, other);
    expect((await h.make().sync()).error).toContain('unknown_key');
  });

  it('a revoked key is rejected even with a valid signature', async () => {
    const key = makeKey('test-1', { revoked: true });
    const h = harness({ key });
    publish(h, [entry('alpha')], T1);
    const status = await h.make().sync();
    expect(status.state).toBe('degraded');
    expect(status.error).toContain('revoked_key');
  });

  it('a key outside its validity window is rejected', async () => {
    const key = makeKey('test-1', { validFrom: T2 });
    const h = harness({ key });
    publish(h, [entry('alpha')], T1);
    expect((await h.make().sync()).error).toContain('key_not_valid_at');
  });

  it('a schema-invalid envelope (correctly signed) is rejected', async () => {
    const h = harness();
    const signed = signIndex({ entries: [entry('alpha')], key: h.key, generatedAt: T1 });
    const bad = Buffer.from(JSON.stringify({ ...signed.index, version: 2 }));
    // Signed properly, so only the schema check can fail.
    h.server.publish({ indexBytes: bad, sig: signScript.signBytes(bad, h.key.privateKey) });
    const status = await h.make().sync();
    expect(status.state).toBe('degraded');
    expect(status.error).toContain('schema_invalid');
  });

  it('an oversized response is rejected', async () => {
    const h = harness();
    const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
    h.server.publish({ indexBytes: big, sig: 'A'.repeat(88) });
    expect((await h.make().sync()).error).toContain('too_large');
  });

  it('a verification failure keeps the last verified cache in use', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make();
    await sync.sync();
    h.server.tamper('index.json', Buffer.from('{"version":1}'));
    const status = await sync.sync();
    expect(status.state).toBe('degraded');
    expect(sync.entries()).toHaveLength(1);
    expect(status.version).toBe(T1);
  });
});

describe('anti-rollback', () => {
  it('rejects an older generatedAt, accepts a newer one', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T2);
    const sync = h.make();
    await sync.sync();
    publish(h, [entry('alpha'), entry('stale')], T1); // older but validly signed
    const rolled = await sync.sync();
    expect(rolled.state).toBe('degraded');
    expect(rolled.error).toContain('rollback');
    expect(sync.entries()).toHaveLength(1);
    expect(rolled.version).toBe(T2);
    publish(h, [entry('alpha'), entry('beta')], T2 + 1000);
    const forward = await sync.sync();
    expect(forward).toMatchObject({ state: 'ok', version: T2 + 1000, remoteEntries: 2 });
  });

  it('rejects an equal generatedAt with different content, treats identical bytes as unchanged', async () => {
    const h = harness();
    const original = signIndex({ entries: [entry('alpha')], key: h.key, generatedAt: T1 });
    h.server.publish(original);
    const sync = h.make();
    await sync.sync();
    // Same bytes served again without an ETag match (fresh etag): unchanged, not an error.
    h.server.publish(original);
    expect(await sync.sync()).toMatchObject({ state: 'ok', error: null });
    // Same generatedAt, different content: replay.
    publish(h, [entry('alpha'), entry('evil')], T1);
    const replay = await sync.sync();
    expect(replay.state).toBe('degraded');
    expect(replay.error).toContain('rollback');
    expect(sync.entries()).toHaveLength(1);
  });

  it('the ratchet survives restarts and a wiped cache (state.json alone refuses older indexes)', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T2);
    await h.make().sync();
    rmSync(path.join(h.dir, 'index.json'));
    const restarted = h.make();
    expect(restarted.entries()).toEqual([]);
    publish(h, [entry('old')], T1);
    expect((await restarted.sync()).error).toContain('rollback');
  });

  it('rejects an index dated far in the future (would freeze the ratchet)', async () => {
    const h = harness();
    publish(h, [entry('alpha')], NOW + 5 * 24 * 3600_000);
    expect((await h.make().sync()).error).toContain('future_dated');
  });
});

describe('offline / failures', () => {
  it('offline: snapshot only (no entries), degraded, a warning is logged', async () => {
    const h = harness();
    h.server.offline = true;
    const sync = h.make();
    const status = await sync.sync();
    expect(status).toMatchObject({ state: 'degraded', version: null, remoteEntries: 0 });
    expect(status.error).toContain('fetch failed');
    expect(sync.entries()).toEqual([]);
    expect(h.warnings).not.toHaveLength(0);
  });

  it('HTTP errors degrade; the next success clears the error', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    h.server.status = 503;
    const sync = h.make();
    expect((await sync.sync()).error).toContain('HTTP 503');
    h.server.status = null;
    expect(await sync.sync()).toMatchObject({ state: 'ok', error: null });
  });

  it('offline with a verified cache keeps serving it', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make();
    await sync.sync();
    h.server.offline = true;
    const status = await sync.sync();
    expect(status.state).toBe('degraded');
    expect(sync.entries()).toHaveLength(1);
  });

  it('a long time without a successful check is stale', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + CONNECTOR_INDEX_STALE_AFTER_MS + 1000;
    expect(sync.status().state).toBe('stale');
  });
});

describe('disabled', () => {
  it('an empty key list disables sync entirely: no network, status disabled', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make({ keys: [] });
    expect(sync.status()).toMatchObject({ state: 'disabled', disabledReason: 'no_keys' });
    expect(await sync.sync()).toMatchObject({ state: 'disabled' });
    sync.start();
    sync.stop();
    expect(h.server.requests).toEqual([]);
    expect(sync.entries()).toEqual([]);
  });

  it('the settings switch disables it without touching the network', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    let on = false;
    const sync = h.make({ enabled: () => on });
    expect(await sync.sync()).toMatchObject({ state: 'disabled', disabledReason: 'setting_off' });
    expect(h.server.requests).toEqual([]);
    on = true;
    expect(await sync.sync()).toMatchObject({ state: 'ok' });
  });
});

describe('timer', () => {
  it('start() pulls after the initial delay and repeats at the interval', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    const sync = h.make({ initialDelayMs: 5, intervalMs: 20, random: () => 0.5 });
    sync.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    sync.stop();
    const pulls = h.server.requests.filter((r) => r.path === 'index.json').length;
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(sync.status().state).toBe('ok');
  });
});

describe('verifySignedIndex (pure)', () => {
  it('round-trips a script-signed index and rejects every single-byte change', () => {
    const key = makeKey();
    const signed = signIndex({ entries: [entry('alpha')], key, generatedAt: T1 });
    const ok = verifySignedIndex(signed.indexBytes, signed.sig, [key.publicEntry]);
    expect(ok).toMatchObject({ ok: true, keyId: 'test-1' });
    const flipped = Buffer.from(signed.indexBytes);
    flipped[flipped.length - 3] = flipped[flipped.length - 3]! ^ 1;
    expect(verifySignedIndex(flipped, signed.sig, [key.publicEntry]).ok).toBe(false);
  });
});

describe('runtime toggle of the setting', () => {
  it('turning the switch off stops cached remote entries immediately; on brings them back', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    let on = true;
    const sync = h.make({ enabled: () => on });
    await sync.sync();
    expect(sync.entries()).toHaveLength(1);
    const before = sync.revision();
    on = false;
    expect(sync.entries()).toEqual([]);
    expect(sync.revision()).toBeGreaterThan(before);
    expect(sync.status()).toMatchObject({ state: 'disabled', remoteEntries: 0 });
    const off = sync.revision();
    expect(sync.revision()).toBe(off); // stable while unchanged
    on = true;
    expect(sync.revision()).toBeGreaterThan(off);
    expect(sync.entries()).toHaveLength(1);
  });
});

describe('retry cadence', () => {
  it('retries soon after a failure and returns to the daily interval after success', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      publish(h, [entry('alpha')], T1);
      h.server.offline = true;
      const sync = h.make({
        initialDelayMs: 10,
        intervalMs: 24 * 3600_000,
        retryMs: 3600_000,
        random: () => 0.5, // jitter 0
      });
      const pulls = () => h.server.requests.filter((r) => r.path === 'index.json').length;
      sync.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(pulls()).toBe(1);
      expect(sync.status().state).toBe('degraded');
      // the next attempt is about an hour later, not a day
      await vi.advanceTimersByTimeAsync(3600_000 - 100);
      expect(pulls()).toBe(1);
      h.server.offline = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(pulls()).toBe(2);
      expect(sync.status().state).toBe('ok');
      // after success: daily again
      await vi.advanceTimersByTimeAsync(3600_000 * 2);
      expect(pulls()).toBe(2);
      await vi.advanceTimersByTimeAsync(24 * 3600_000);
      expect(pulls()).toBe(3);
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a future-dated state.json', () => {
  it('does not freeze the ratchet: with a valid cache it is reset to the cache, without one it is dropped', async () => {
    const h = harness();
    publish(h, [entry('alpha')], T1);
    await h.make().sync();
    const stateFile = path.join(h.dir, 'state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    writeFileSync(stateFile, JSON.stringify({ ...state, generatedAt: NOW + 30 * 24 * 3600_000 }));
    const reloaded = h.make();
    expect(reloaded.entries()).toHaveLength(1); // cache is signed and valid
    publish(h, [entry('alpha'), entry('beta')], T2);
    expect(await reloaded.sync()).toMatchObject({ state: 'ok', version: T2, remoteEntries: 2 });

    // cache gone and state far in the future: the state is treated as corrupt
    rmSync(path.join(h.dir, 'index.json'));
    writeFileSync(stateFile, JSON.stringify({ ...state, generatedAt: NOW + 30 * 24 * 3600_000 }));
    const fresh = h.make();
    expect(await fresh.sync()).toMatchObject({ state: 'ok', version: T2 });
  });
});
