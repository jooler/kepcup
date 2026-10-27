import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SignedIndexSync, verifySignedIndex } from '../../src/infra/signed-index.js';
import { makeKey, signScript, type TestKey } from '../support/directory-fixture.js';

/**
 * `SignedIndexSync` 的直接测试（D104 P1-1 步骤 1.4）：通用签名索引机制脱离连接器目录通道
 * 后的验签 / 棘轮 / 缓存 / ETag / 回落 / 开关 / 定时行为。用最小自定义信封 schema 与内存
 * fetch，不联网；签名用真实脚本导出的 Ed25519 函数。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const T1 = Date.parse('2026-10-09T00:00:00.000Z');
const T2 = Date.parse('2026-10-10T00:00:00.000Z');

const testIndexSchema = z.object({
  version: z.literal(1),
  generatedAt: z.number().int().min(1),
  keyId: z.string().min(1),
  items: z.array(z.string()),
});

type TestIndex = z.infer<typeof testIndexSchema>;

const LIMITS = { maxBytes: 64 * 1024, maxSigBytes: 1024 };
const INTERVALS = {
  sync: 24 * 3600_000,
  retry: 3600_000,
  jitterRatio: 0,
  initialDelay: { min: 10, max: 10 },
  staleAfter: 3 * 24 * 3600_000,
} as const;

/** In-memory index server: serves the two files by URL path, with ETag / 304 and failure injection. */
class FakeServer {
  readonly requests: string[] = [];
  offline = false;
  status: number | null = null;
  #files = new Map<string, { bytes: Buffer; etag: string }>();
  #version = 0;

  publish(signed: { indexBytes: Buffer; sig: string }): void {
    this.#version += 1;
    this.#files.set('/v1/index.json', { bytes: signed.indexBytes, etag: `"v${this.#version}"` });
    this.#files.set('/v1/index.json.sig', {
      bytes: Buffer.from(`${signed.sig}\n`),
      etag: `"s${this.#version}"`,
    });
  }

  tamper(name: '/v1/index.json' | '/v1/index.json.sig', bytes: Buffer): void {
    this.#files.set(name, { bytes, etag: `"t${++this.#version}"` });
  }

  readonly fetch = async (
    input: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response> => {
    const url = new URL(input);
    this.requests.push(url.pathname);
    if (this.offline) throw new TypeError('fetch failed');
    if (this.status !== null) return new Response('boom', { status: this.status });
    const file = this.#files.get(url.pathname);
    if (file === undefined) return new Response('not found', { status: 404 });
    const ifNoneMatch = init?.headers?.['if-none-match'] ?? null;
    if (ifNoneMatch !== null && ifNoneMatch === file.etag) {
      return new Response(null, { status: 304, headers: { etag: file.etag } });
    }
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: { etag: file.etag },
    });
  };
}

interface Harness {
  dir: string;
  server: FakeServer;
  key: TestKey;
  clock: { t: number; now(): number };
  warnings: Array<Record<string, unknown>>;
  make(
    overrides?: Partial<ConstructorParameters<typeof SignedIndexSync<TestIndex>>[0]>,
  ): SignedIndexSync<TestIndex>;
}

function harness(options: { key?: TestKey } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'signed-index-'));
  dirs.push(dir);
  const key = options.key ?? makeKey('sig-test');
  const server = new FakeServer();
  const clock = { t: NOW, now: () => clock.t };
  const warnings: Array<Record<string, unknown>> = [];
  return {
    dir,
    server,
    key,
    clock,
    warnings,
    make: (overrides = {}) =>
      new SignedIndexSync<TestIndex>({
        dir,
        keys: [key.publicEntry],
        fetch: server.fetch,
        clock,
        logger: {
          info() {},
          warn: (record: Record<string, unknown>) => warnings.push(record),
        } as never,
        baseUrl: 'https://idx.example.com/v1',
        indexFile: 'index.json',
        sigFile: 'index.json.sig',
        schema: testIndexSchema,
        limits: LIMITS,
        intervals: INTERVALS,
        ...overrides,
      }),
  };
}

function publish(h: Harness, items: string[], generatedAt: number, key = h.key): void {
  h.server.publish(sign({ items, key, generatedAt }));
}

function sign(input: { items: string[]; key: TestKey; generatedAt: number }): {
  indexBytes: Buffer;
  sig: string;
} {
  const index: TestIndex = {
    version: 1,
    generatedAt: input.generatedAt,
    keyId: input.key.keyId,
    items: input.items,
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  return { indexBytes, sig: signScript.signBytes(indexBytes, input.key.privateKey) };
}

describe('verifySignedIndex (generic)', () => {
  it('verifies a correctly signed index', () => {
    const h = harness();
    const { indexBytes, sig } = sign({ items: ['a', 'b'], key: h.key, generatedAt: T1 });
    const result = verifySignedIndex(indexBytes, sig, [h.key.publicEntry], testIndexSchema, LIMITS);
    expect(result).toMatchObject({ ok: true, keyId: 'sig-test', index: { items: ['a', 'b'] } });
  });

  it('rejects a tampered index (bad signature)', () => {
    const h = harness();
    const { indexBytes, sig } = sign({ items: ['a'], key: h.key, generatedAt: T1 });
    const tampered = Buffer.from(indexBytes.toString('utf8').replace('"a"', '"omega"'));
    expect(
      verifySignedIndex(tampered, sig, [h.key.publicEntry], testIndexSchema, LIMITS),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown key, a revoked key and an expired key', () => {
    const h = harness();
    const other = makeKey('other');
    const { indexBytes, sig } = sign({ items: ['a'], key: h.key, generatedAt: T1 });
    expect(
      verifySignedIndex(indexBytes, sig, [other.publicEntry], testIndexSchema, LIMITS),
    ).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(
      verifySignedIndex(
        indexBytes,
        sig,
        [{ ...h.key.publicEntry, revoked: true }],
        testIndexSchema,
        LIMITS,
      ),
    ).toMatchObject({ ok: false, reason: 'revoked_key' });
    expect(
      verifySignedIndex(
        indexBytes,
        sig,
        [{ ...h.key.publicEntry, validUntil: T1 - 1 }],
        testIndexSchema,
        LIMITS,
      ),
    ).toMatchObject({ ok: false, reason: 'key_not_valid_at' });
  });
});

describe('sync and the adopted index', () => {
  it('verifies, adopts, caches atomically and exposes the index', async () => {
    const h = harness();
    publish(h, ['alpha', 'beta'], T1);
    const sync = h.make();
    expect(sync.index()).toBeNull();
    expect(sync.syncState()).toMatchObject({ state: 'stale', lastSync: null, generatedAt: null });
    expect(sync.revision()).toBe(0);

    const status = await sync.sync();
    expect(status).toMatchObject({
      state: 'ok',
      generatedAt: T1,
      keyId: 'sig-test',
      error: null,
      lastSync: NOW,
    });
    expect(sync.index()).toMatchObject({ items: ['alpha', 'beta'] });
    expect(sync.revision()).toBe(1);
    for (const file of ['index.json', 'index.json.sig', 'state.json']) {
      expect(existsSync(path.join(h.dir, file)), file).toBe(true);
    }
    const state = JSON.parse(readFileSync(path.join(h.dir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ version: 1, generatedAt: T1, keyId: 'sig-test' });
  });

  it('a fresh instance re-verifies the cache and loads it without any network', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    await h.make().sync();
    const servedBefore = h.server.requests.length;
    h.server.offline = true;
    const reloaded = h.make();
    expect(reloaded.index()).toMatchObject({ items: ['alpha'] });
    expect(reloaded.syncState()).toMatchObject({ state: 'ok', generatedAt: T1 });
    expect(reloaded.revision()).toBe(1);
    expect(h.server.requests).toHaveLength(servedBefore);
  });

  it('a tampered cache on disk is ignored (re-verified at load), not trusted', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    await h.make().sync();
    const file = path.join(h.dir, 'index.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('alpha', 'omega'));
    const reloaded = h.make();
    expect(reloaded.index()).toBeNull();
    expect(h.warnings.some((w) => String(w['error']).includes('bad_signature'))).toBe(true);
  });
});

describe('ETag / 304', () => {
  it('sends If-None-Match and treats 304 as a successful, unchanged check', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 3600_000;
    const status = await sync.sync();
    const requests = h.server.requests.filter((r) => r === '/v1/index.json');
    expect(requests).toHaveLength(2);
    expect(status).toMatchObject({ state: 'ok', error: null, lastSync: NOW + 3600_000 });
    expect(sync.revision()).toBe(1); // nothing changed, no re-adopt
    // the signature file is not downloaded again on 304
    expect(h.server.requests.filter((r) => r === '/v1/index.json.sig')).toHaveLength(1);
  });

  it('a ratchet kept from state.json alone (index files gone) blocks a same-version replay', async () => {
    const h = harness();
    const { indexBytes, sig } = sign({ items: ['a'], key: h.key, generatedAt: T1 });
    h.server.publish({ indexBytes, sig });
    // The client only sends if-none-match when the cache is loaded, so seed the ratchet
    // state with an ETag but no cached index files.
    const state = {
      version: 1,
      generatedAt: T1,
      keyId: h.key.keyId,
      sha256: '0'.repeat(64),
      etag: '"v1"',
      lastSuccessAt: NOW,
    };
    writeFileSync(path.join(h.dir, 'state.json'), `${JSON.stringify(state)}\n`);
    const reloaded = h.make(); // cache rejected (files missing) but ratchet kept
    expect(reloaded.index()).toBeNull();
    const status = await reloaded.sync();
    expect(status.error).toContain('rollback');
  });
});

describe('anti-rollback ratchet', () => {
  it('rejects an older index and keeps the previous view', async () => {
    const h = harness();
    publish(h, ['alpha'], T2);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 1000;
    publish(h, ['older'], T1);
    const rolled = await sync.sync();
    expect(rolled.error).toContain('rollback');
    expect(rolled.state).toBe('degraded');
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });

  it('the same bytes at the same generatedAt count as unchanged', async () => {
    const h = harness();
    const signed = sign({ items: ['alpha'], key: h.key, generatedAt: T1 });
    h.server.publish(signed);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 1000;
    // Same bytes again (no ETag change on the fake keeps it simple: a new etag still works).
    h.server.publish(signed);
    const again = await sync.sync();
    expect(again).toMatchObject({ state: 'ok', error: null });
    expect(sync.revision()).toBe(1); // not re-adopted
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });

  it('the same generatedAt with different bytes is rejected as a replay', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 1000;
    publish(h, ['beta'], T1); // same generatedAt, different content
    const replay = await sync.sync();
    expect(replay.error).toContain('rollback');
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });

  it('rejects an index dated more than one day ahead', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    const sync = h.make();
    await sync.sync();
    h.clock.t = NOW + 1000;
    publish(h, ['future'], NOW + 25 * 3600_000);
    expect((await sync.sync()).error).toContain('future_dated');
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });

  it('the ratchet survives a lost cache (state only) and blocks an older index', async () => {
    const h = harness();
    publish(h, ['alpha'], T2);
    await h.make().sync();
    rmSync(path.join(h.dir, 'index.json'), { force: true });
    rmSync(path.join(h.dir, 'index.json.sig'), { force: true });
    const restarted = h.make();
    expect(restarted.index()).toBeNull();
    publish(h, ['older'], T1);
    expect((await restarted.sync()).error).toContain('rollback');
    publish(h, ['newer'], T2 + 1000);
    expect((await restarted.sync()).state).toBe('ok');
    expect(restarted.index()).toMatchObject({ items: ['newer'] });
  });
});

describe('failure fallback', () => {
  it('keeps using the last verified index after a failed pull', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    const sync = h.make();
    await sync.sync();
    h.server.offline = true;
    const status = await sync.sync();
    expect(status.state).toBe('degraded');
    expect(status.error).toContain('fetch failed');
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });
});

describe('enabled switch', () => {
  it('does not touch the network while disabled and recovers when re-enabled', async () => {
    const h = harness();
    publish(h, ['alpha'], T1);
    let on = false;
    const sync = h.make({ enabled: () => on });
    expect(sync.index()).toBeNull();
    expect(sync.syncState()).toMatchObject({ state: 'disabled', disabledReason: 'setting_off' });
    await sync.sync();
    expect(h.server.requests).toEqual([]);
    on = true;
    expect((await sync.sync()).state).toBe('ok');
    expect(h.server.requests.filter((r) => r === '/v1/index.json')).toHaveLength(1);
    expect(sync.index()).toMatchObject({ items: ['alpha'] });
  });
});

describe('timers', () => {
  it('start() pulls after the initial delay and stop() ends the loop', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      publish(h, ['alpha'], T1);
      const sync = h.make({
        intervalMs: INTERVALS.sync,
        retryMs: INTERVALS.retry,
        random: () => 0.5,
      });
      const pulls = () => h.server.requests.filter((r) => r === '/v1/index.json').length;
      sync.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(pulls()).toBe(1);
      expect(sync.index()).toMatchObject({ items: ['alpha'] });
      await vi.advanceTimersByTimeAsync(INTERVALS.sync - 50);
      expect(pulls()).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(pulls()).toBe(2);
      sync.stop();
      await vi.advanceTimersByTimeAsync(INTERVALS.sync * 2);
      expect(pulls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() does nothing with an empty key list', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      publish(h, ['alpha'], T1);
      const disabled = h.make({ keys: [] });
      disabled.start();
      await vi.advanceTimersByTimeAsync(INTERVALS.sync * 3);
      expect(h.server.requests).toEqual([]);
      disabled.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
