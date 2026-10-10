/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies / schema nodes are untyped in tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduled } from '../src/index';
import { DEFAULT_MAX_PAGES, runSync } from '../src/sync';
import { SqliteD1, get, review, seed, serverJson } from './helpers';

const UPSTREAM = 'https://upstream.test';

interface UpEntry {
  name: string;
  version: string;
  isLatest?: boolean;
  status?: string;
  /** null = upstream omits updatedAt / publishedAt / statusChangedAt entirely. */
  updatedAt?: string | null;
  publishedAt?: string;
  description?: string;
  statusMessage?: string;
  extra?: Record<string, unknown>;
}

function entry(e: UpEntry) {
  const updatedAt = e.updatedAt === undefined ? '2026-10-01T10:00:00.123456Z' : e.updatedAt;
  return {
    server: serverJson({
      name: e.name,
      version: e.version,
      description: e.description,
      ...(e.extra ? { extra: e.extra } : {}),
    }),
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: e.status ?? 'active',
        ...(e.statusMessage ? { statusMessage: e.statusMessage } : {}),
        ...(updatedAt === null
          ? {}
          : {
              statusChangedAt: updatedAt,
              publishedAt: e.publishedAt ?? updatedAt,
              updatedAt,
            }),
        isLatest: e.isLatest ?? true,
      },
    },
  };
}

/** A fake upstream: serves `data` in pages of `pageSize` and records every request URL. */
function fakeUpstream(data: UpEntry[], pageSize = 100) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const since = url.searchParams.get('updated_since');
    const rows = data
      .filter(
        (e) =>
          !since || e.updatedAt === null || (e.updatedAt ?? '2026-10-01T10:00:00.123456Z') > since,
      )
      .sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const page = rows.slice(offset, offset + pageSize);
    const next = offset + pageSize < rows.length ? String(offset + pageSize) : undefined;
    return new Response(
      JSON.stringify({
        servers: page.map(entry),
        metadata: { count: page.length, ...(next ? { nextCursor: next } : {}) },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetch: impl, urls };
}

let d1: SqliteD1;
const START = new Date('2026-10-01T12:00:00.000Z');
/** The injected clock; entries default to being updated at 2026-10-01T10:00Z, before START. */
let clock = START;
const sync = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  runSync({ db: d1, upstream: UPSTREAM, fetch: fetchImpl, now: () => clock, ...extra });
const state = (key: string) =>
  d1.rows<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', key)[0]?.value;
const count = () => d1.rows<{ n: number }>('SELECT count(*) AS n FROM servers')[0]!.n;

beforeEach(() => {
  d1 = new SqliteD1();
  clock = START;
});

describe('upsert', () => {
  it('stores server.json, lifecycle fields and normalized timestamps', async () => {
    const up = fakeUpstream([
      { name: 'io.github.a/one', version: '1.0.0', updatedAt: '2026-10-01T10:00:00.123456Z' },
      { name: 'com.b/two', version: '2.0.0', status: 'deprecated' },
    ]);
    const result = await sync(up.fetch);
    expect(result).toMatchObject({ ok: true, complete: true, pages: 1, upserted: 2, skipped: 0 });
    expect(up.urls[0]!.pathname).toBe('/v0.1/servers');
    expect(up.urls[0]!.searchParams.has('updated_since')).toBe(false); // first run = backfill
    expect(up.urls[0]!.searchParams.get('limit')).toBe('100');

    const row = d1.rows<any>(`SELECT * FROM servers WHERE name = 'io.github.a/one'`)[0];
    expect(row.updated_at).toBe('2026-10-01T10:00:00.123Z');
    expect(row.is_latest).toBe(1);
    expect(JSON.parse(row.server_json).name).toBe('io.github.a/one');
    expect(d1.rows(`SELECT status FROM servers WHERE name = 'com.b/two'`)).toEqual([
      { status: 'deprecated' },
    ]);
    // watermark = RUN START minus the overlap (not the max updatedAt seen)
    expect(state('watermark')).toBe('2026-10-01T11:55:00.000Z');
    expect(state('last_error')).toBeUndefined();
    expect(state('last_success_at')).toBe(START.toISOString());
  });

  it('follows cursors across pages', async () => {
    const data = Array.from({ length: 7 }, (_, i) => ({ name: `n.s/${i}`, version: '1.0.0' }));
    const up = fakeUpstream(data, 3);
    const result = await sync(up.fetch);
    expect(result).toMatchObject({ pages: 3, upserted: 7, complete: true });
    expect(count()).toBe(7);
    expect(up.urls.map((u) => u.searchParams.get('cursor'))).toEqual([null, '3', '6']);
  });

  it('is idempotent: re-running the same data changes nothing', async () => {
    const up = fakeUpstream([
      { name: 'a.a/x', version: '1.0.0', isLatest: false },
      { name: 'a.a/x', version: '2.0.0' },
    ]);
    await sync(up.fetch);
    const before = d1.rows('SELECT * FROM servers ORDER BY name, version');
    await sync(up.fetch);
    await sync(up.fetch);
    expect(d1.rows('SELECT * FROM servers ORDER BY name, version')).toEqual(before);
    expect(count()).toBe(2);
  });

  it('later runs ask only for the delta (run start minus overlap)', async () => {
    const data: UpEntry[] = [
      { name: 'a.a/x', version: '1.0.0', updatedAt: '2026-10-01T11:57:00.000Z' },
    ];
    await sync(fakeUpstream(data).fetch);
    data.push({ name: 'b.b/y', version: '1.0.0', updatedAt: '2026-10-05T00:00:00.000Z' });
    clock = new Date('2026-10-05T06:00:00.000Z');
    const up = fakeUpstream(data);
    const result = await sync(up.fetch);
    expect(up.urls[0]!.searchParams.get('updated_since')).toBe('2026-10-01T11:55:00.000Z');
    expect(result.upserted).toBe(2); // the overlap re-delivers a.a/x (11:57 > 11:55); harmless
    expect(count()).toBe(2);
    expect(state('watermark')).toBe('2026-10-05T05:55:00.000Z');
  });

  it('does not lose an entry updated mid-run behind the page cursor (watermark = run start)', async () => {
    // A sorts first, B last. Run 1 fetches only page 1 (A). Then A changes upstream
    // (10:05, after the run started at 10:02) and the run finishes with B (10:10).
    // A "max updatedAt seen" watermark would be 10:10 and A@10:05 would be lost forever.
    const data: UpEntry[] = [
      { name: 'a.a/x', version: '1.0.0', description: 'v1', updatedAt: '2026-10-01T10:00:00.000Z' },
      { name: 'z.z/y', version: '1.0.0', updatedAt: '2026-10-01T10:10:00.000Z' },
    ];
    clock = new Date('2026-10-01T10:02:00.000Z');
    const first = await sync(fakeUpstream(data, 1).fetch, { maxPages: 1, pageLimit: 1 });
    expect(first.complete).toBe(false);

    data[0] = { ...data[0]!, description: 'v2', updatedAt: '2026-10-01T10:05:00.000Z' };
    clock = new Date('2026-10-01T10:20:00.000Z');
    const second = await sync(fakeUpstream(data, 1).fetch, { pageLimit: 1 });
    expect(second.complete).toBe(true);
    // the completed run started at 10:02 (kept from run 1), not 10:20
    expect(state('watermark')).toBe('2026-10-01T09:57:00.000Z');

    clock = new Date('2026-10-01T10:30:00.000Z');
    const up = fakeUpstream(data);
    await sync(up.fetch);
    expect(up.urls[0]!.searchParams.get('updated_since')).toBe('2026-10-01T09:57:00.000Z');
    const row = d1.rows<{ server_json: string }>(
      `SELECT server_json FROM servers WHERE name = 'a.a/x'`,
    )[0]!;
    expect(JSON.parse(row.server_json).description).toBe('v2');
  });

  it('applies updates and deletions (status change) to existing rows', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0', description: 'first' }]).fetch);
    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '1.0.0',
          description: 'second',
          status: 'deleted',
          updatedAt: '2026-10-03T00:00:00Z',
        },
      ]).fetch,
    );
    const row = d1.rows<any>(`SELECT * FROM servers`)[0];
    expect(JSON.parse(row.server_json).description).toBe('second');
    expect(row.status).toBe('deleted');
    expect((await get('/v0.1/servers', { db: d1 })).body.servers).toEqual([]);
  });

  it('never lets older upstream data overwrite newer stored data', async () => {
    seed(d1, { name: 'a.a/x', description: 'newer local', updatedAt: '2026-10-09T00:00:00.000Z' });
    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '1.0.0',
          description: 'older',
          updatedAt: '2026-10-02T00:00:00Z',
        },
      ]).fetch,
    );
    expect(
      JSON.parse(d1.rows<any>('SELECT server_json FROM servers')[0].server_json).description,
    ).toBe('newer local');
  });

  it('skips malformed entries but keeps the valid ones', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          servers: [
            null,
            { server: { name: 'no-slash', version: '1' } },
            { server: { name: 'a.a/x' } },
            {
              server: { name: 'a.a/y', version: '1' },
              _meta: { 'io.modelcontextprotocol.registry/official': { status: 'bogus' } },
            },
            entry({ name: 'ok.ok/fine', version: '1.0.0' }),
          ],
          metadata: { count: 5 },
        }),
      )) as unknown as typeof fetch;
    const result = await sync(fetchImpl);
    expect(result).toMatchObject({ ok: true, upserted: 1, skipped: 4 });
    expect(count()).toBe(1);
  });

  it('accepts `servers: null` as an empty page', async () => {
    const fetchImpl = (async () =>
      new Response('{"servers":null,"metadata":{"count":0}}')) as unknown as typeof fetch;
    expect(await sync(fetchImpl)).toMatchObject({ ok: true, complete: true, upserted: 0 });
  });
});

describe('is_latest', () => {
  it('switches to the new latest and keeps exactly one per name', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    expect(d1.rows(`SELECT version FROM servers WHERE is_latest = 1`)).toEqual([
      { version: '1.0.0' },
    ]);

    // upstream publishes 2.0.0 and flips 1.0.0 to not-latest
    await sync(
      fakeUpstream([
        { name: 'a.a/x', version: '1.0.0', isLatest: false, updatedAt: '2026-10-02T00:00:00Z' },
        { name: 'a.a/x', version: '2.0.0', isLatest: true, updatedAt: '2026-10-02T00:00:00Z' },
      ]).fetch,
    );
    expect(d1.rows(`SELECT version FROM servers WHERE is_latest = 1`)).toEqual([
      { version: '2.0.0' },
    ]);
    expect(
      (await get('/v0.1/servers/a.a%2Fx/versions/latest', { db: d1 })).body.server.version,
    ).toBe('2.0.0');
  });

  it('demotes the previous latest even when upstream re-sends only the new version', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    await sync(
      fakeUpstream([{ name: 'a.a/x', version: '1.1.0', updatedAt: '2026-10-04T00:00:00Z' }]).fetch,
    );
    expect(d1.rows(`SELECT version, is_latest FROM servers ORDER BY version`)).toEqual([
      { version: '1.0.0', is_latest: 0 },
      { version: '1.1.0', is_latest: 1 },
    ]);
  });

  it('different names do not interfere', async () => {
    await sync(
      fakeUpstream([
        { name: 'a.a/x', version: '1.0.0' },
        { name: 'b.b/y', version: '1.0.0' },
      ]).fetch,
    );
    expect(d1.rows('SELECT count(*) AS n FROM servers WHERE is_latest = 1')).toEqual([{ n: 2 }]);
  });
});

describe('reviews are never touched', () => {
  it('survives upserts, status changes and is_latest flips', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    review(d1, { name: 'a.a/x', tier: 'verified', hash: 'sha256:keep', notes: 'n' });
    review(d1, { name: 'orphan.o/never-synced', tier: 'community', status: 'pending' });
    const before = d1.rows('SELECT * FROM reviews ORDER BY name');

    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '1.0.0',
          isLatest: false,
          status: 'deprecated',
          updatedAt: '2026-10-03T00:00:00Z',
          description: 'changed',
        },
        { name: 'a.a/x', version: '2.0.0', updatedAt: '2026-10-03T00:00:00Z' },
      ]).fetch,
    );
    expect(d1.rows('SELECT * FROM reviews ORDER BY name')).toEqual(before);
    // The review ROW is untouched, but its recorded server_json sha256 no longer matches the
    // re-synced content, so no tier is exposed until the entry is re-approved.
    const { body } = await get('/v0.1/servers/a.a%2Fx/versions/1.0.0', { db: d1 });
    expect(body.server.description).toBe('changed');
    expect(body._meta['app.kepcup/review']).toBeUndefined();
    expect(body._meta['app.kepcup/connector']).toBeUndefined();
  });

  it('keeps the tier when a re-sync delivers byte-identical content', async () => {
    const data: UpEntry[] = [{ name: 'a.a/x', version: '1.0.0' }];
    await sync(fakeUpstream(data).fetch);
    review(d1, { name: 'a.a/x', tier: 'verified', hash: 'sha256:keep' });
    clock = new Date('2026-10-02T00:00:00.000Z');
    await sync(fakeUpstream(data).fetch);
    const { body } = await get('/v0.1/servers/a.a%2Fx/versions/1.0.0', { db: d1 });
    expect(body._meta['app.kepcup/review']).toMatchObject({ tier: 'verified' });
  });

  it('a sync statement never mentions the reviews table', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    expect(d1.executed.filter((s) => /\breviews\b/i.test(s))).toEqual([]);
  });
});

describe('failure tolerance and bounded work', () => {
  it('network failure: no throw, recorded, existing data and watermark untouched', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    const before = d1.rows('SELECT * FROM servers');
    const watermark = state('watermark');

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await sync(down);
    expect(result).toMatchObject({ ok: false, complete: false, error: 'fetch failed' });
    expect(state('last_error')).toContain('fetch failed');
    expect(d1.rows('SELECT * FROM servers')).toEqual(before);
    expect(state('watermark')).toBe(watermark);
  });

  it.each([
    ['HTTP 500', () => new Response('boom', { status: 500 }), /HTTP 500/],
    ['HTTP 429', () => new Response('slow down', { status: 429 }), /HTTP 429/],
    ['invalid JSON', () => new Response('<html>'), /invalid JSON/],
    ['non-object', () => new Response('42'), /non-object/],
  ])('%s is reported, not thrown', async (_label, make, pattern) => {
    const result = await sync((async () => make()) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(pattern);
    expect(count()).toBe(0);
  });

  it('a failure half-way keeps the pages already stored and resumes from the cursor', async () => {
    const data = Array.from({ length: 6 }, (_, i) => ({ name: `n.s/${i}`, version: '1.0.0' }));
    const good = fakeUpstream(data, 2);
    let calls = 0;
    const flaky = (async (input: string | URL | Request) => {
      if (++calls === 2) throw new Error('connection reset');
      return good.fetch(input);
    }) as unknown as typeof fetch;

    const first = await sync(flaky);
    expect(first.ok).toBe(false);
    expect(count()).toBe(2); // page 1 persisted
    expect(state('run_cursor')).toBe('2');
    expect(state('watermark')).toBeUndefined();

    const second = await sync(good.fetch);
    expect(second).toMatchObject({ ok: true, complete: true });
    expect(count()).toBe(6);
    expect(state('run_cursor')).toBeUndefined();
    expect(state('watermark')).toBeDefined();
  });

  it('recovery clears last_error', async () => {
    await sync((async () => new Response('x', { status: 503 })) as unknown as typeof fetch);
    expect(state('last_error')).toBeDefined();
    await sync(fakeUpstream([]).fetch);
    expect(state('last_error')).toBeUndefined();
  });

  it('is bounded per run (maxPages) and continues on the next run', async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      name: `n.s/${String(i).padStart(2, '0')}`,
      version: '1.0.0',
    }));
    const up = fakeUpstream(data, 2);

    const first = await sync(up.fetch, { maxPages: 2, pageLimit: 2 });
    expect(first).toMatchObject({ ok: true, complete: false, pages: 2, upserted: 4 });
    expect(up.urls).toHaveLength(2);
    expect(state('watermark')).toBeUndefined(); // not advanced while incomplete
    expect(state('run_cursor')).toBe('4');

    const second = await sync(up.fetch, { maxPages: 2, pageLimit: 2 });
    expect(second.complete).toBe(false);
    expect(up.urls[2]!.searchParams.get('cursor')).toBe('4');

    const third = await sync(up.fetch, { maxPages: 2, pageLimit: 2 });
    expect(third).toMatchObject({ complete: true, upserted: 2 });
    expect(count()).toBe(10);
    expect(state('watermark')).toBeDefined();
    expect(state('run_cursor')).toBeUndefined();
  });

  it('refuses a non-https upstream', async () => {
    const up = fakeUpstream([]);
    const result = await runSync({ db: d1, upstream: 'http://evil.test', fetch: up.fetch });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-https/);
    expect(up.urls).toHaveLength(0);
  });

  it('does not throw even when the database itself fails', async () => {
    d1.db.exec('DROP TABLE sync_state');
    const result = await sync(fakeUpstream([]).fetch);
    expect(result.ok).toBe(false);
  });
});

describe('registry-owned _meta is stripped before storing', () => {
  it('removes review / official / tier|status|reviewedAt|toolContractHash from _meta and publisher-provided', async () => {
    const holder = () => ({
      'app.kepcup/connector': {
        slug: 'evil',
        tier: 'builtin',
        status: 'approved',
        reviewedAt: '2099-01-01T00:00:00.000Z',
        toolContractHash: 'x',
      },
      'app.kepcup/review': { tier: 'verified', status: 'approved' },
      'io.modelcontextprotocol.registry/official': { status: 'active' },
      'com.vendor/ok': 1,
    });
    await sync(
      fakeUpstream([
        {
          name: 'f.f/forged',
          version: '1.0.0',
          extra: {
            _meta: { ...holder(), 'io.modelcontextprotocol.registry/publisher-provided': holder() },
          },
        },
      ]).fetch,
    );
    const stored = JSON.parse(d1.rows<any>('SELECT server_json FROM servers')[0].server_json);
    for (const h of [
      stored._meta,
      stored._meta['io.modelcontextprotocol.registry/publisher-provided'],
    ]) {
      expect(h['app.kepcup/review']).toBeUndefined();
      expect(h['io.modelcontextprotocol.registry/official']).toBeUndefined();
      expect(h['app.kepcup/connector']).toEqual({ slug: 'evil' });
      expect(h['com.vendor/ok']).toBe(1);
    }
    expect(d1.rows<any>('SELECT server_json_sha256 AS s FROM servers')[0].s).toHaveLength(64);
  });
});

describe('poison pills never wedge the sync', () => {
  const bad: [string, UpEntry][] = [
    ['name without slash', { name: 'noslash', version: '1.0.0' }],
    ['name with illegal characters', { name: 'a b/c', version: '1.0.0' }],
    ['name over 200 characters', { name: `a.a/${'x'.repeat(200)}`, version: '1.0.0' }],
    ['version "latest"', { name: 'a.a/latest', version: 'latest' }],
    ['empty version', { name: 'a.a/empty', version: '' }],
    ['version over 128 characters', { name: 'a.a/longv', version: 'v'.repeat(129) }],
    ['version with a control character', { name: 'a.a/ctl', version: '1.0\n.0' }],
    ['unknown status', { name: 'a.a/status', version: '1.0.0', status: 'zombie' }],
    [
      'server.json over 512 KB',
      { name: 'a.a/huge', version: '1.0.0', extra: { blob: 'x'.repeat(520 * 1024) } },
    ],
  ];

  it.each(bad)('skips and counts: %s', async (_label, badEntry) => {
    const result = await sync(
      fakeUpstream([badEntry, { name: 'ok.ok/fine', version: '1.0.0' }]).fetch,
    );
    expect(result).toMatchObject({ ok: true, complete: true, upserted: 1, skipped: 1 });
    expect(d1.rows<any>('SELECT name FROM servers').map((r) => r.name)).toEqual(['ok.ok/fine']);
    expect(state('skipped_count')).toBe('1');
    expect(state('last_skip_reason')).toBeTruthy();
  });

  it('skip counters accumulate across runs', async () => {
    await sync(fakeUpstream([{ name: 'noslash', version: '1' }]).fetch);
    clock = new Date('2026-10-03T00:00:00.000Z');
    await sync(
      fakeUpstream([{ name: 'also bad', version: '1', updatedAt: '2026-10-02T00:00:00.000Z' }])
        .fetch,
    );
    expect(state('skipped_count')).toBe('2');
  });

  it('caps statusMessage and accepts the boundary sizes', async () => {
    await sync(
      fakeUpstream([
        {
          name: 'a.a/msg',
          version: 'v'.repeat(128),
          statusMessage: 'm'.repeat(5000),
          status: 'deprecated',
        },
        { name: `a.a/${'x'.repeat(196)}`, version: '1.0.0' }, // 200 chars total
      ]).fetch,
    );
    expect(count()).toBe(2);
    expect(
      d1.rows<any>(`SELECT status_message FROM servers WHERE name = 'a.a/msg'`)[0].status_message,
    ).toHaveLength(500);
  });

  it('a failing batch falls back to per-entry statements: the bad row is skipped, the cursor advances', async () => {
    class FlakyD1 extends SqliteD1 {
      override async batch(statements: Parameters<SqliteD1['batch']>[0]) {
        const poisoned = statements.some((s) =>
          (s as unknown as { params: unknown[] }).params?.includes('bad.bad/boom'),
        );
        if (poisoned) throw new Error('D1_ERROR: row too big');
        return super.batch(statements);
      }
    }
    d1 = new FlakyD1();
    const data = [
      { name: 'a.a/one', version: '1.0.0' },
      { name: 'bad.bad/boom', version: '1.0.0' },
      { name: 'c.c/three', version: '1.0.0' },
    ];
    const result = await sync(fakeUpstream(data, 3).fetch);
    expect(result).toMatchObject({ ok: true, complete: true, upserted: 2, skipped: 1 });
    expect(d1.rows<any>('SELECT name FROM servers ORDER BY name').map((r) => r.name)).toEqual([
      'a.a/one',
      'c.c/three',
    ]);
    expect(state('last_skip_reason')).toMatch(/bad\.bad\/boom/);
    expect(state('watermark')).toBeDefined();
    expect(state('run_cursor')).toBeUndefined();
  });
});

describe('cursor discipline', () => {
  const pages = (sequence: (string | undefined)[]) => {
    let i = 0;
    const urls: URL[] = [];
    const impl = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      const next = sequence[Math.min(i++, sequence.length - 1)];
      return new Response(
        JSON.stringify({
          servers: [entry({ name: `n.s/${i}`, version: '1.0.0' })],
          metadata: { count: 1, ...(next ? { nextCursor: next } : {}) },
        }),
      );
    }) as unknown as typeof fetch;
    return { impl, urls };
  };

  it('an upstream that repeats the cursor is an error, and the cursor is not re-persisted', async () => {
    const { impl, urls } = pages(['X', 'X']);
    const result = await sync(impl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not advance/);
    expect(urls).toHaveLength(2); // stopped immediately, no spinning
    expect(state('run_cursor')).toBe('X');
    expect(state('watermark')).toBeUndefined();
    expect(state('last_error')).toMatch(/did not advance/);
  });

  it('a cursor loop A -> B -> A is detected too', async () => {
    const { impl, urls } = pages(['A', 'B', 'A', 'C']);
    const result = await sync(impl);
    expect(result.ok).toBe(false);
    expect(urls).toHaveLength(3);
    expect(state('run_cursor')).toBe('B');
  });

  it('a first-page cursor equal to the resumed one is refused as well', async () => {
    await d1.prepare(`INSERT INTO sync_state (key, value) VALUES ('run_cursor', 'R')`).run();
    const { impl } = pages(['R']);
    expect((await sync(impl)).ok).toBe(false);
  });
});

describe('is_latest recomputation and first-seen timestamps', () => {
  it('when the flagged latest is deleted, the newest remaining live version becomes latest', async () => {
    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '1.0.0',
          isLatest: false,
          publishedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-10-01T09:00:00.000Z',
        },
        {
          name: 'a.a/x',
          version: '1.1.0',
          isLatest: false,
          status: 'deprecated',
          publishedAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-10-01T09:00:00.000Z',
        },
        {
          name: 'a.a/x',
          version: '2.0.0',
          isLatest: true,
          publishedAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-10-01T09:00:00.000Z',
        },
      ]).fetch,
    );
    expect(d1.rows(`SELECT version FROM servers WHERE is_latest = 1`)).toEqual([
      { version: '2.0.0' },
    ]);

    clock = new Date('2026-10-04T00:00:00.000Z');
    // upstream deletes 2.0.0 and (as the live service does) flags nothing else
    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '2.0.0',
          isLatest: false,
          status: 'deleted',
          updatedAt: '2026-10-03T00:00:00.000Z',
        },
      ]).fetch,
    );
    expect(d1.rows(`SELECT version, is_latest FROM servers WHERE is_latest = 1`)).toEqual([
      { version: '1.0.0', is_latest: 1 },
    ]);
    // active 1.0.0 beats deprecated 1.1.0; and the API agrees
    const { body } = await get('/v0.1/servers/a.a%2Fx/versions/latest', { db: d1 });
    expect(body.server.version).toBe('1.0.0');
  });

  it('a deleted row never keeps the latest flag, even if it is the only version', async () => {
    await sync(fakeUpstream([{ name: 'a.a/x', version: '1.0.0' }]).fetch);
    clock = new Date('2026-10-04T00:00:00.000Z');
    await sync(
      fakeUpstream([
        {
          name: 'a.a/x',
          version: '1.0.0',
          status: 'deleted',
          isLatest: true,
          updatedAt: '2026-10-03T00:00:00.000Z',
        },
      ]).fetch,
    );
    expect(d1.rows(`SELECT count(*) AS n FROM servers WHERE is_latest = 1`)).toEqual([{ n: 0 }]);
  });

  it('entries without upstream timestamps keep their first-seen time across runs', async () => {
    const data: UpEntry[] = [
      { name: 'a.a/x', version: '1.0.0', updatedAt: null, description: 'one' },
    ];
    clock = new Date('2026-10-02T00:00:00.000Z');
    await sync(fakeUpstream(data).fetch);
    const first = d1.rows<any>('SELECT * FROM servers')[0];
    expect(first).toMatchObject({
      updated_at: '2026-10-02T00:00:00.000Z',
      published_at: '2026-10-02T00:00:00.000Z',
      status_changed_at: '2026-10-02T00:00:00.000Z',
      first_seen_at: '2026-10-02T00:00:00.000Z',
    });

    clock = new Date('2026-10-03T00:00:00.000Z');
    await sync(fakeUpstream(data).fetch);
    clock = new Date('2026-10-04T00:00:00.000Z');
    await sync(fakeUpstream(data).fetch);
    expect(d1.rows<any>('SELECT * FROM servers')[0]).toEqual(first); // unchanged, not "now" each run

    // a real content change bumps updated_at to the time it was noticed
    data[0] = { ...data[0]!, description: 'two' };
    clock = new Date('2026-10-05T00:00:00.000Z');
    await sync(fakeUpstream(data).fetch);
    expect(d1.rows<any>('SELECT * FROM servers')[0]).toMatchObject({
      updated_at: '2026-10-05T00:00:00.000Z',
      published_at: '2026-10-02T00:00:00.000Z',
      first_seen_at: '2026-10-02T00:00:00.000Z',
    });
  });
});

describe('upstream guard and response limits', () => {
  it.each([
    'http://127.0.0.1.evil.test',
    'http://localhost.evil.test',
    'http://localhost@evil.test',
    'http://127.0.0.1@evil.test',
    'http://evil.test/http://localhost',
    'http://localhostevil.test',
  ])('refuses %s', async (upstream) => {
    const up = fakeUpstream([]);
    const result = await runSync({ db: d1, upstream, fetch: up.fetch });
    expect(result.ok).toBe(false);
    expect(up.urls).toHaveLength(0);
  });

  it.each([
    'http://127.0.0.1',
    'http://127.0.0.1:8787',
    'http://localhost:3000/',
    'https://registry.example',
  ])('allows %s', async (upstream) => {
    const up = fakeUpstream([]);
    const result = await runSync({ db: d1, upstream, fetch: up.fetch });
    expect(result.ok).toBe(true);
    expect(up.urls).toHaveLength(1);
  });

  it('refuses redirects instead of following them', async () => {
    let seenRedirect: RequestInit['redirect'];
    const redirecting = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as unknown as typeof fetch;
    const result = await sync(redirecting);
    expect(seenRedirect).toBe('manual');
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/redirect refused/);
  });

  it('enforces the size limit on the declared content-length', async () => {
    const big = (async () =>
      new Response('{"servers":[]}', {
        headers: { 'content-length': '999999999' },
      })) as unknown as typeof fetch;
    const result = await sync(big, { maxBodyBytes: 1024 });
    expect(result.error).toMatch(/too large/);
  });

  it('counts BYTES while streaming, not characters', async () => {
    // 60 euro signs: 60 characters but 180 bytes; with the JSON wrapper still < 100 chars.
    const text = JSON.stringify({ servers: [], pad: '€'.repeat(30) });
    expect(text.length).toBeLessThan(60);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(100);
    const streamed = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(text));
            c.close();
          },
        }),
      )) as unknown as typeof fetch;
    expect((await sync(streamed, { maxBodyBytes: 100 })).error).toMatch(/too large/);
    expect((await sync(streamed, { maxBodyBytes: 1000 })).ok).toBe(true);
  });
});

describe('page budget (Workers Free subrequest limit)', () => {
  it('defaults to 8 pages per run', async () => {
    expect(DEFAULT_MAX_PAGES).toBe(8);
    const data = Array.from({ length: 30 }, (_, i) => ({
      name: `n.s/${String(i).padStart(2, '0')}`,
      version: '1.0.0',
    }));
    const up = fakeUpstream(data, 1);
    const result = await sync(up.fetch);
    expect(result).toMatchObject({ pages: 8, complete: false });
  });

  it('SYNC_MAX_PAGES configures the scheduled handler', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({
      name: `n.s/${String(i).padStart(2, '0')}`,
      version: '1.0.0',
    }));
    const up = fakeUpstream(data, 1);
    vi.stubGlobal('fetch', up.fetch);
    try {
      const jobs: Promise<unknown>[] = [];
      await scheduled(
        { scheduledTime: 0, cron: '' },
        { DB: d1, SYNC_MAX_PAGES: '3', UPSTREAM_REGISTRY_URL: UPSTREAM },
        { waitUntil: (p) => void jobs.push(p) },
      );
      await Promise.all(jobs);
      expect(up.urls).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps D1 and fetch calls per page small', async () => {
    const data = Array.from({ length: 4 }, (_, i) => ({ name: `n.s/${i}`, version: '1.0.0' }));
    const up = fakeUpstream(data, 1);
    d1.executed.length = 0;
    await sync(up.fetch, { maxPages: 8 });
    // fixed ~4 + per page: 1 batch + 1 cursor write => stays far below 50 for 8 pages
    expect(d1.executed.length + up.urls.length).toBeLessThan(40);
  });
});
