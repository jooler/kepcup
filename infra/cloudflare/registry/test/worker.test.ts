/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies / schema nodes are untyped in tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildListQuery,
  decodeCursor,
  encodeCursor,
  handleRequest,
  matchRoute,
} from '../src/worker';
import type { HandlerDeps } from '../src/worker';
import { BASE, MapCache, SqliteD1, get, review, seed } from './helpers';

let d1: SqliteD1;
let deps: HandlerDeps;

beforeEach(() => {
  d1 = new SqliteD1();
  deps = { db: d1 };
});

function names(body: any): string[] {
  return body.servers.map((s: any) => `${s.server.name}@${s.server.version}`);
}

describe('routing', () => {
  it('matches the official paths, encoded and unencoded names, /v0 alias', () => {
    expect(matchRoute('/v0.1/servers')).toEqual({ kind: 'list' });
    expect(matchRoute('/v0/servers')).toEqual({ kind: 'list' });
    expect(matchRoute('/v0.1/servers/com.example%2Fmy-server/versions')).toEqual({
      kind: 'versions',
      name: 'com.example/my-server',
    });
    expect(matchRoute('/v0.1/servers/com.example/my-server/versions/1.0.0')).toEqual({
      kind: 'version-detail',
      name: 'com.example/my-server',
      version: '1.0.0',
    });
    expect(matchRoute('/v0.1/servers/io.github.x%2Fversions/versions/latest')).toEqual({
      kind: 'version-detail',
      name: 'io.github.x/versions',
      version: 'latest',
    });
    expect(matchRoute('/v0.1/servers/com.example%2Fmy-server')).toBeNull();
    expect(matchRoute('/v1/servers')).toBeNull();
    expect(matchRoute('/')).toBeNull();
  });

  it('unknown endpoint is a 404 problem document', async () => {
    const { res, body } = await get('/nope', deps);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(body).toMatchObject({ title: 'Not Found', status: 404 });
  });

  it('health / ping / version', async () => {
    expect((await get('/v0.1/health', deps)).body).toEqual({ status: 'ok' });
    expect((await get('/v0.1/ping', deps)).body).toEqual({ pong: true });
    const v = await get('/v0.1/version', {
      ...deps,
      buildInfo: { version: '1.2.3', commit: 'abc' },
    });
    expect(v.body).toEqual({ version: '1.2.3', git_commit: 'abc', build_time: 'unknown' });
  });
});

describe('read-only, HEAD and CORS preflight', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s -> 405', async (method) => {
    for (const path of ['/v0.1/servers', '/v0.1/servers/a.b%2Fc/versions/1.0.0', '/v0.1/publish']) {
      const res = await handleRequest(
        new Request(`https://registry.test${path}`, { method }),
        deps,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    }
  });

  it('a rejected write never touches the database', async () => {
    seed(d1, { name: 'a.b/c' });
    await get('/v0.1/servers', deps, { method: 'POST', body: '{}' });
    expect(d1.executed).toHaveLength(0);
  });

  it('HEAD has GET semantics (status, headers, ETag) without a body', async () => {
    seed(d1, { name: 'a.b/c' });
    const g = await get('/v0.1/servers', deps);
    const res = await handleRequest(new Request(`${BASE}/v0.1/servers`, { method: 'HEAD' }), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(g.res.headers.get('etag'));
    expect(res.headers.get('content-type')).toBe('application/json');
    const missing = await handleRequest(
      new Request(`${BASE}/v0.1/servers/no.such%2Fx/versions`, { method: 'HEAD' }),
      deps,
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('');
  });

  it('OPTIONS answers the CORS preflight with 204', async () => {
    const res = await handleRequest(
      new Request(`${BASE}/v0.1/servers`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
      }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(d1.executed).toHaveLength(0);
  });

  it('access-control-allow-origin: * is deliberate on every response kind (public, cookie-less)', async () => {
    seed(d1, { name: 'a.b/c' });
    const etag = (await get('/v0.1/servers', deps)).res.headers.get('etag')!;
    for (const [path, init] of [
      ['/v0.1/servers', undefined],
      ['/v0.1/servers', { headers: { 'if-none-match': etag } }], // 304
      ['/v0.1/servers/no.such%2Fx/versions', undefined], // 404
      ['/v0.1/servers?limit=999', undefined], // 422
      ['/v0.1/servers', { method: 'POST' }], // 405
      ['/v0.1/health', undefined],
    ] as [string, RequestInit | undefined][]) {
      const { res } = await get(path, deps, init);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      expect(res.headers.has('access-control-allow-credentials'), path).toBe(false);
      expect(res.headers.has('set-cookie'), path).toBe(false);
    }
  });
});

describe('list: pagination', () => {
  it('orders by (name, version) and pages with an opaque base64url cursor', async () => {
    for (const n of ['d.e/four', 'a.b/one', 'c.d/three', 'b.c/two']) seed(d1, { name: n });
    seed(d1, { name: 'a.b/one', version: '0.9.0', isLatest: false });

    const p1 = await get('/v0.1/servers?limit=2', deps);
    expect(names(p1.body)).toEqual(['a.b/one@0.9.0', 'a.b/one@1.0.0']);
    expect(p1.body.metadata.count).toBe(2);
    const cursor = p1.body.metadata.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ name: 'a.b/one', version: '1.0.0' });

    const p2 = await get(`/v0.1/servers?limit=2&cursor=${cursor}`, deps);
    expect(names(p2.body)).toEqual(['b.c/two@1.0.0', 'c.d/three@1.0.0']);
    const p3 = await get(`/v0.1/servers?limit=2&cursor=${p2.body.metadata.nextCursor}`, deps);
    expect(names(p3.body)).toEqual(['d.e/four@1.0.0']);
    expect(p3.body.metadata).toEqual({ count: 1 });
  });

  it('exactly-full last page has no nextCursor', async () => {
    seed(d1, { name: 'a.b/one' });
    seed(d1, { name: 'a.b/two' });
    const { body } = await get('/v0.1/servers?limit=2', deps);
    expect(body.metadata).toEqual({ count: 2 });
  });

  it('cursor stays stable across inserts and deletes between pages', async () => {
    for (const n of ['b.b/one', 'd.d/two', 'f.f/three', 'h.h/four']) seed(d1, { name: n });
    const p1 = await get('/v0.1/servers?limit=2', deps);
    expect(names(p1.body)).toEqual(['b.b/one@1.0.0', 'd.d/two@1.0.0']);

    // an entry sorting BEFORE the cursor, one right AFTER it, and removal of a seen row
    seed(d1, { name: 'a.a/early' });
    seed(d1, { name: 'e.e/between' });
    d1.db.prepare(`DELETE FROM servers WHERE name = 'b.b/one'`).run();

    const p2 = await get(`/v0.1/servers?limit=10&cursor=${p1.body.metadata.nextCursor}`, deps);
    expect(names(p2.body)).toEqual(['e.e/between@1.0.0', 'f.f/three@1.0.0', 'h.h/four@1.0.0']);
  });

  it.each(['!!!', 'e30', Buffer.from('["only-one"]').toString('base64url'), 'a'.repeat(2000)])(
    'invalid cursor %s -> 422 with location',
    async (cursor) => {
      const { res, body } = await get(`/v0.1/servers?cursor=${cursor}`, deps);
      expect(res.status).toBe(422);
      expect(body.errors[0].location).toBe('query.cursor');
    },
  );

  it('cursor round-trips unicode and separators', () => {
    const c = encodeCursor('a.b/ü-名', '1.0.0+build/x:y');
    expect(decodeCursor(c)).toEqual({ name: 'a.b/ü-名', version: '1.0.0+build/x:y' });
  });
});

describe('list: limit bounds', () => {
  beforeEach(() => {
    for (let i = 0; i < 105; i++) seed(d1, { name: `n.s/${String(i).padStart(3, '0')}` });
  });

  it('defaults to 30, honours 1 and 100', async () => {
    expect((await get('/v0.1/servers', deps)).body.servers).toHaveLength(30);
    expect((await get('/v0.1/servers?limit=1', deps)).body.servers).toHaveLength(1);
    const max = await get('/v0.1/servers?limit=100', deps);
    expect(max.body.servers).toHaveLength(100);
    expect(max.body.metadata.nextCursor).toBeTruthy();
  });

  it.each([['101'], ['500'], ['0'], ['-3'], ['abc'], ['1.5']])('limit=%s -> 422', async (limit) => {
    const { res, body } = await get(`/v0.1/servers?limit=${limit}`, deps);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(body.title).toBe('Unprocessable Entity');
    expect(body.errors[0].location).toBe('query.limit');
  });
});

describe('list: filters', () => {
  it('updated_since is exclusive, normalizes offsets, and includes deleted entries', async () => {
    seed(d1, { name: 'a.a/old', updatedAt: '2026-09-01T00:00:00.000Z' });
    seed(d1, { name: 'b.b/new', updatedAt: '2026-10-02T00:00:00.000Z' });
    seed(d1, { name: 'c.c/gone', updatedAt: '2026-10-03T00:00:00.000Z', status: 'deleted' });

    expect(names((await get('/v0.1/servers', deps)).body)).toEqual([
      'a.a/old@1.0.0',
      'b.b/new@1.0.0',
    ]);
    const since = await get('/v0.1/servers?updated_since=2026-09-15T00:00:00Z', deps);
    expect(names(since.body)).toEqual(['b.b/new@1.0.0', 'c.c/gone@1.0.0']);
    expect(since.body.servers[1]._meta['io.modelcontextprotocol.registry/official'].status).toBe(
      'deleted',
    );

    const exact = await get('/v0.1/servers?updated_since=2026-10-02T00:00:00.000Z', deps);
    expect(names(exact.body)).toEqual(['c.c/gone@1.0.0']);
    // 2026-10-02T02:00+02:00 == 2026-10-02T00:00Z
    const offset = await get('/v0.1/servers?updated_since=2026-10-02T02:00:00%2B02:00', deps);
    expect(names(offset.body)).toEqual(['c.c/gone@1.0.0']);
  });

  it('a newer review also counts as an update', async () => {
    seed(d1, { name: 'a.a/x', updatedAt: '2026-09-01T00:00:00.000Z' });
    review(d1, { name: 'a.a/x', reviewedAt: '2026-10-05T00:00:00.000Z' });
    const { body } = await get('/v0.1/servers?updated_since=2026-10-01T00:00:00Z', deps);
    expect(names(body)).toEqual(['a.a/x@1.0.0']);
    expect(body.servers[0]._meta['io.modelcontextprotocol.registry/official'].updatedAt).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it.each(['yesterday', '2026-13-45T00:00:00Z', '1700000000'])(
    'bad updated_since %s -> 422',
    async (v) => {
      const { res, body } = await get(`/v0.1/servers?updated_since=${v}`, deps);
      expect(res.status).toBe(422);
      expect(body.errors[0].location).toBe('query.updated_since');
    },
  );

  it('include_deleted', async () => {
    seed(d1, { name: 'a.a/live' });
    seed(d1, { name: 'b.b/gone', status: 'deleted' });
    expect(names((await get('/v0.1/servers?include_deleted=true', deps)).body)).toEqual([
      'a.a/live@1.0.0',
      'b.b/gone@1.0.0',
    ]);
    expect((await get('/v0.1/servers?include_deleted=maybe', deps)).res.status).toBe(422);
  });

  it('search matches name, title and description case-insensitively; % and _ are literal', async () => {
    seed(d1, {
      name: 'io.github.acme/files',
      title: 'Acme Filesystem',
      description: 'Read local files',
    });
    seed(d1, {
      name: 'com.weather/api',
      title: 'Weather',
      description: 'Forecasts for the FILESYSTEM-less',
    });
    seed(d1, { name: 'com.other/thing', title: 'Thing', description: '100% reliable_tool' });

    const s = async (q: string) =>
      names((await get(`/v0.1/servers?search=${encodeURIComponent(q)}`, deps)).body);
    expect(await s('acme')).toEqual(['io.github.acme/files@1.0.0']); // name + title
    expect(await s('filesystem')).toEqual(['com.weather/api@1.0.0', 'io.github.acme/files@1.0.0']);
    expect(await s('forecasts')).toEqual(['com.weather/api@1.0.0']); // description only
    expect(await s('100%')).toEqual(['com.other/thing@1.0.0']);
    expect(await s('%')).toEqual(['com.other/thing@1.0.0']); // not a wildcard
    expect(await s('reliable_t')).toEqual(['com.other/thing@1.0.0']);
    expect(await s('relXable')).toEqual([]);
    expect((await get(`/v0.1/servers?search=${'x'.repeat(201)}`, deps)).res.status).toBe(422);
  });

  it('version filter: latest and exact', async () => {
    seed(d1, { name: 'a.a/x', version: '1.0.0', isLatest: false });
    seed(d1, { name: 'a.a/x', version: '2.0.0' });
    seed(d1, { name: 'b.b/y', version: '0.1.0' });
    expect(names((await get('/v0.1/servers?version=latest', deps)).body)).toEqual([
      'a.a/x@2.0.0',
      'b.b/y@0.1.0',
    ]);
    expect(names((await get('/v0.1/servers?version=1.0.0', deps)).body)).toEqual(['a.a/x@1.0.0']);
    expect((await get('/v0.1/servers?version=9.9.9', deps)).body.servers).toEqual([]);
  });

  it('empty result is an empty array (never null)', async () => {
    const { res, body } = await get('/v0.1/servers', deps);
    expect(res.status).toBe(200);
    expect(body).toEqual({ servers: [], metadata: { count: 0 } });
  });
});

describe('versions endpoints', () => {
  beforeEach(() => {
    seed(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      isLatest: false,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    seed(d1, {
      name: 'a.a/x',
      version: '1.1.0',
      isLatest: false,
      status: 'deprecated',
      statusMessage: 'use 2.0',
      publishedAt: '2026-02-01T00:00:00.000Z',
    });
    seed(d1, { name: 'a.a/x', version: '2.0.0', publishedAt: '2026-03-01T00:00:00.000Z' });
    seed(d1, {
      name: 'a.a/x',
      version: '1.5.0-bad',
      isLatest: false,
      status: 'deleted',
      publishedAt: '2026-02-15T00:00:00.000Z',
    });
  });

  it('lists every live version newest first (name percent-encoded)', async () => {
    const { res, body } = await get('/v0.1/servers/a.a%2Fx/versions', deps);
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(['a.a/x@2.0.0', 'a.a/x@1.1.0', 'a.a/x@1.0.0']);
    expect(body.metadata).toEqual({ count: 3 });
    const dep = body.servers[1]._meta['io.modelcontextprotocol.registry/official'];
    expect(dep).toMatchObject({ status: 'deprecated', statusMessage: 'use 2.0', isLatest: false });
  });

  it('include_deleted shows deleted versions', async () => {
    const { body } = await get('/v0.1/servers/a.a%2Fx/versions?include_deleted=true', deps);
    expect(names(body)).toContain('a.a/x@1.5.0-bad');
  });

  it('unknown server -> 404', async () => {
    const { res, body } = await get('/v0.1/servers/no.such%2Fserver/versions', deps);
    expect(res.status).toBe(404);
    expect(body).toMatchObject({ title: 'Not Found', status: 404, detail: 'Server not found' });
  });

  it('exact version, latest, deleted and unknown versions', async () => {
    const exact = await get('/v0.1/servers/a.a%2Fx/versions/1.1.0', deps);
    expect(exact.body.server.version).toBe('1.1.0');
    const latest = await get('/v0.1/servers/a.a%2Fx/versions/latest', deps);
    expect(latest.body.server.version).toBe('2.0.0');
    expect(latest.body._meta['io.modelcontextprotocol.registry/official'].isLatest).toBe(true);
    expect((await get('/v0.1/servers/a.a%2Fx/versions/9.9.9', deps)).res.status).toBe(404);
    expect((await get('/v0.1/servers/a.a%2Fx/versions/1.5.0-bad', deps)).res.status).toBe(404);
    const withDeleted = await get(
      '/v0.1/servers/a.a%2Fx/versions/1.5.0-bad?include_deleted=true',
      deps,
    );
    expect(withDeleted.res.status).toBe(200);
  });

  it('latest falls back to the newest live version when no row is flagged', async () => {
    d1.db.prepare(`UPDATE servers SET is_latest = 0`).run();
    const { body } = await get('/v0.1/servers/a.a%2Fx/versions/latest', deps);
    expect(body.server.version).toBe('2.0.0');
  });

  it('latest of an unknown server -> 404; malformed encoding -> 400', async () => {
    expect((await get('/v0.1/servers/no.such%2Fserver/versions/latest', deps)).res.status).toBe(
      404,
    );
    const bad = await get('/v0.1/servers/%E0%A4%A/versions', deps);
    expect(bad.res.status).toBe(400);
  });
});

describe('review merge rules', () => {
  beforeEach(() => {
    seed(d1, { name: 'a.a/verified' });
    seed(d1, { name: 'b.b/community' });
    seed(d1, { name: 'c.c/pending' });
    seed(d1, { name: 'd.d/rejected' });
    seed(d1, { name: 'e.e/none' });
    review(d1, {
      name: 'a.a/verified',
      tier: 'verified',
      hash: 'sha256:v',
      notes: 'checked by hand',
    });
    review(d1, { name: 'b.b/community', tier: 'community', hash: null });
    review(d1, { name: 'c.c/pending', tier: 'verified', status: 'pending' });
    review(d1, { name: 'd.d/rejected', tier: 'verified', status: 'rejected' });
  });

  it('exposes tier + status + toolContractHash only for approved reviews', async () => {
    const { body } = await get('/v0.1/servers', deps);
    const by = (n: string) => body.servers.find((s: any) => s.server.name === n)._meta;
    expect(by('a.a/verified')['app.kepcup/connector']).toEqual({ tier: 'verified' });
    expect(by('a.a/verified')['app.kepcup/review']).toEqual({
      tier: 'verified',
      status: 'approved',
      reviewedAt: '2026-10-05T00:00:00.000Z',
      toolContractHash: 'sha256:v',
      notes: 'checked by hand',
    });
    expect(by('b.b/community')['app.kepcup/connector']).toEqual({ tier: 'community' });
    expect(by('b.b/community')['app.kepcup/review'].toolContractHash).toBeNull();
    for (const n of ['c.c/pending', 'd.d/rejected', 'e.e/none']) {
      expect(Object.keys(by(n))).toEqual(['io.modelcontextprotocol.registry/official']);
    }
  });

  it('detail endpoints carry the same merge; a review is per version', async () => {
    seed(d1, { name: 'a.a/verified', version: '2.0.0' });
    const v1 = await get('/v0.1/servers/a.a%2Fverified/versions/1.0.0', deps);
    expect(v1.body._meta['app.kepcup/connector']).toEqual({ tier: 'verified' });
    const v2 = await get('/v0.1/servers/a.a%2Fverified/versions/2.0.0', deps);
    expect(v2.body._meta['app.kepcup/connector']).toBeUndefined();
    const list = await get('/v0.1/servers/a.a%2Fverified/versions', deps);
    expect(list.body.servers.map((s: any) => !!s._meta['app.kepcup/review'])).toHaveLength(2);
  });

  it('strips a publisher-supplied tier from server.json (tier comes from reviews only)', async () => {
    const forged = { 'app.kepcup/connector': { slug: 'evil', tier: 'builtin', category: 'x' } };
    seed(d1, {
      name: 'f.f/forged',
      extra: {
        _meta: {
          ...forged,
          'io.modelcontextprotocol.registry/publisher-provided': { ...forged },
        },
      },
    });
    const { body } = await get('/v0.1/servers/f.f%2Fforged/versions/1.0.0', deps);
    const meta = body.server._meta;
    expect(meta['app.kepcup/connector']).toEqual({ slug: 'evil', category: 'x' });
    expect(
      meta['io.modelcontextprotocol.registry/publisher-provided']['app.kepcup/connector'],
    ).toEqual({
      slug: 'evil',
      category: 'x',
    });
    expect(body._meta['app.kepcup/connector']).toBeUndefined();
  });
});

describe('caching, ETag and 304', () => {
  beforeEach(() => {
    seed(d1, { name: 'a.a/x' });
  });

  it('sets ETag + Cache-Control and answers If-None-Match with a bodyless 304', async () => {
    const first = await get('/v0.1/servers', deps);
    const etag = first.res.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.res.headers.get('cache-control')).toContain('public');
    expect(first.res.headers.get('content-type')).toBe('application/json');

    for (const header of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
      const hit = await get('/v0.1/servers', deps, { headers: { 'if-none-match': header } });
      expect(hit.res.status).toBe(304);
      expect(hit.body).toBeUndefined();
      expect(hit.res.headers.get('etag')).toBe(etag);
    }
    const miss = await get('/v0.1/servers', deps, { headers: { 'if-none-match': '"other"' } });
    expect(miss.res.status).toBe(200);
  });

  it('ETag changes when the data changes and is stable otherwise', async () => {
    const a = (await get('/v0.1/servers', deps)).res.headers.get('etag');
    const b = (await get('/v0.1/servers', deps)).res.headers.get('etag');
    expect(a).toBe(b);
    seed(d1, { name: 'b.b/y' });
    expect((await get('/v0.1/servers', deps)).res.headers.get('etag')).not.toBe(a);
  });

  it('serves repeat GETs from the cache without touching D1, 304 included', async () => {
    const cache = new MapCache();
    const withCache: HandlerDeps = { db: d1, cache };
    const first = await get('/v0.1/servers?limit=5&search=a', withCache);
    expect(cache.puts).toBe(1);
    const queries = d1.executed.length;

    const second = await get('/v0.1/servers?search=a&limit=5', withCache); // param order irrelevant
    expect(second.body).toEqual(first.body);
    expect(d1.executed.length).toBe(queries);
    expect(cache.matches).toBe(1);

    const etag = second.res.headers.get('etag')!;
    const cond = await get('/v0.1/servers?limit=5&search=a', withCache, {
      headers: { 'if-none-match': etag },
    });
    expect(cond.res.status).toBe(304);
    expect(d1.executed.length).toBe(queries);
  });

  it('caches only successful data responses', async () => {
    const cache = new MapCache();
    const withCache: HandlerDeps = { db: d1, cache };
    await get('/v0.1/servers/no.such%2Fserver/versions', withCache);
    await get('/v0.1/servers?limit=999', withCache);
    await get('/v0.1/health', withCache);
    await get('/v0.1/servers', withCache, { method: 'POST' });
    expect(cache.puts).toBe(0);
    await get('/v0.1/servers', withCache);
    expect(cache.puts).toBe(1);
  });

  it('defers the cache write to waitUntil when provided', async () => {
    const cache = new MapCache();
    const pending: Promise<unknown>[] = [];
    await get('/v0.1/servers', { db: d1, cache, waitUntil: (p) => void pending.push(p) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(cache.puts).toBe(1);
  });

  it('a database failure is a 500 problem document, not a crash', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    d1.db.exec('DROP TABLE servers');
    const { res, body } = await get('/v0.1/servers', deps);
    expect(res.status).toBe(500);
    expect(body.title).toBe('Internal Server Error');
    expect(JSON.stringify(body)).not.toContain('servers');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('search: byte cap and D1 LIKE limit', () => {
  beforeEach(() => {
    seed(d1, { name: 'a.a/cjk', title: '日本語のタイトル', description: '検索テスト' });
    seed(d1, { name: 'b.b/plain', title: 'Plain', description: 'ASCII only' });
  });

  it('never emits a LIKE pattern (D1 rejects patterns over 50 bytes; the adapter emulates that)', async () => {
    const long = 'x'.repeat(120); // would be a 122-byte LIKE pattern
    const { res, body } = await get(`/v0.1/servers?search=${long}`, deps);
    expect(res.status).toBe(200);
    expect(body.servers).toEqual([]);
    expect(d1.executed.some((q) => /\bLIKE\b/i.test(q))).toBe(false);
  });

  it('CJK search works, also with a long term (60 chars = 180 bytes)', async () => {
    const s = async (q: string) =>
      names((await get(`/v0.1/servers?search=${encodeURIComponent(q)}`, deps)).body);
    expect(await s('タイトル')).toEqual(['a.a/cjk@1.0.0']);
    expect(await s('検索')).toEqual(['a.a/cjk@1.0.0']);
    expect(await s('日'.repeat(60))).toEqual([]);
  });

  it('caps search at 200 UTF-8 bytes (bytes, not characters) with a clear 422', async () => {
    const tooLongCjk = '日'.repeat(67); // 201 bytes, only 67 characters
    const { res, body } = await get(`/v0.1/servers?search=${encodeURIComponent(tooLongCjk)}`, deps);
    expect(res.status).toBe(422);
    expect(body.errors[0]).toMatchObject({ location: 'query.search' });
    expect(body.errors[0].message).toMatch(/200 UTF-8 bytes/);
    const edge = await get(`/v0.1/servers?search=${encodeURIComponent('日'.repeat(66))}`, deps);
    expect(edge.res.status).toBe(200);
    expect((await get(`/v0.1/servers?search=${'x'.repeat(201)}`, deps)).res.status).toBe(422);
  });

  it('trims and lowercases the term (ASCII, like SQLite lower())', async () => {
    const a = await get('/v0.1/servers?search=%20%20PLAIN%20', deps);
    expect(names(a.body)).toEqual(['b.b/plain@1.0.0']);
    expect((await get('/v0.1/servers?search=%20%20', deps)).body.servers).toHaveLength(2);
  });
});

describe('registry-owned _meta keys are stripped at response time', () => {
  const FORGED_CONNECTOR = {
    slug: 'evil',
    category: 'x',
    tier: 'builtin',
    status: 'approved',
    reviewedAt: '2099-01-01T00:00:00.000Z',
    toolContractHash: 'sha256:forged',
  };
  const forgedHolder = () => ({
    'app.kepcup/connector': { ...FORGED_CONNECTOR },
    'app.kepcup/review': { tier: 'verified', status: 'approved' },
    'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true },
    'com.vendor/other': { keep: true },
  });

  it('unreviewed entry: nothing registry-owned survives, publisher data does', async () => {
    seed(d1, {
      name: 'f.f/forged',
      extra: {
        _meta: {
          ...forgedHolder(),
          'io.modelcontextprotocol.registry/publisher-provided': forgedHolder(),
        },
      },
    });
    const { body } = await get('/v0.1/servers/f.f%2Fforged/versions/1.0.0', deps);
    const meta = body.server._meta;
    for (const holder of [meta, meta['io.modelcontextprotocol.registry/publisher-provided']]) {
      expect(holder['app.kepcup/review']).toBeUndefined();
      expect(holder['io.modelcontextprotocol.registry/official']).toBeUndefined();
      expect(holder['app.kepcup/connector']).toEqual({ slug: 'evil', category: 'x' });
      expect(holder['com.vendor/other']).toEqual({ keep: true });
    }
    expect(Object.keys(body._meta)).toEqual(['io.modelcontextprotocol.registry/official']);
    expect(body._meta['io.modelcontextprotocol.registry/official']).not.toMatchObject({
      isLatest: false,
    });
  });

  it('reviewed entry: the response carries the REGISTRY values, never the forged ones', async () => {
    seed(d1, { name: 'f.f/forged', extra: { _meta: forgedHolder() } });
    review(d1, { name: 'f.f/forged', tier: 'community', hash: 'sha256:real' });
    const { body } = await get('/v0.1/servers/f.f%2Fforged/versions/1.0.0', deps);
    expect(body._meta['app.kepcup/connector']).toEqual({ tier: 'community' });
    expect(body._meta['app.kepcup/review']).toMatchObject({
      tier: 'community',
      toolContractHash: 'sha256:real',
    });
    expect(JSON.stringify(body.server)).not.toMatch(/builtin|sha256:forged|2099/);
  });

  it('a non-object app.kepcup/connector is dropped', async () => {
    seed(d1, { name: 'f.f/odd', extra: { _meta: { 'app.kepcup/connector': 'verified' } } });
    const { body } = await get('/v0.1/servers/f.f%2Fodd/versions/1.0.0', deps);
    expect(body.server._meta['app.kepcup/connector']).toBeUndefined();
  });
});

describe('cache key canonicalisation', () => {
  beforeEach(() => {
    seed(d1, { name: 'a.a/acme', title: 'Acme' });
    seed(d1, { name: 'b.b/other', title: 'Other' });
  });

  it('unknown parameters, duplicates, case and spelling collapse onto one entry', async () => {
    const cache = new MapCache();
    const withCache: HandlerDeps = { db: d1, cache };
    await get('/v0.1/servers?search=acme', withCache);
    const queries = d1.executed.length;
    for (const q of [
      '?search=ACME',
      '?search=%20Acme%20',
      '?search=acme&utm=1',
      '?search=acme&search=other', // first value wins in the handler AND in the key
      '?foo=1&search=acme&bar=2',
      '?search=acme&limit=30',
      '?search=acme&include_deleted=false',
      '?search=acme&cursor=',
    ]) {
      const { body } = await get(`/v0.1/servers${q}`, withCache);
      expect(names(body), q).toEqual(['a.a/acme@1.0.0']);
    }
    expect(cache.puts).toBe(1);
    expect(d1.executed.length).toBe(queries);
    // the path alias shares the entry too
    await get('/v0/servers?search=acme', withCache);
    expect(cache.puts).toBe(1);
  });

  it('random junk parameters cannot mint cache entries', async () => {
    const cache = new MapCache();
    for (let i = 0; i < 25; i++) await get(`/v0.1/servers?junk${i}=${i}&x=${i}`, { db: d1, cache });
    expect(cache.puts).toBe(1);
  });

  it('different effective queries never share an entry (first value wins)', async () => {
    const cache = new MapCache();
    const withCache: HandlerDeps = { db: d1, cache };
    const a = await get('/v0.1/servers?limit=1&limit=5', withCache);
    const b = await get('/v0.1/servers?limit=5&limit=1', withCache);
    expect(a.body.servers).toHaveLength(1);
    expect(b.body.servers).toHaveLength(2);
    expect(cache.puts).toBe(2);
    const x = await get('/v0.1/servers?search=acme', withCache);
    const y = await get('/v0.1/servers?search=other', withCache);
    expect(names(x.body)).not.toEqual(names(y.body));
  });

  it('stores max-age at the edge but labels responses public, max-age=0, s-maxage=300 (no stale-while-revalidate)', async () => {
    const cache = new MapCache();
    const first = await get('/v0.1/servers', { db: d1, cache });
    const stored = [...cache.store.values()][0]!;
    expect(stored.headers.get('cache-control')).toBe('public, max-age=300');
    expect(first.res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
    const hit = await get('/v0.1/servers', { db: d1, cache });
    expect(hit.res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=300');
    expect(hit.res.headers.get('cache-control')).not.toMatch(/stale-while-revalidate/);
  });
});

describe('query plan', () => {
  it('the paginated list query is an index SEARCH on the primary key, not a SCAN', () => {
    for (let i = 0; i < 20; i++) seed(d1, { name: `n.s/${String(i).padStart(2, '0')}` });
    const { sql, binds } = buildListQuery({
      limit: 30,
      cursor: { name: 'n.s/05', version: '1.0.0' },
      updatedSince: null,
      search: null,
      version: null,
      includeDeleted: false,
    });
    const plan = d1
      .rows<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...binds)
      .map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/SEARCH s USING (COVERING )?INDEX sqlite_autoindex_servers_1/);
    expect(plan.filter((d) => /^SCAN s\b/.test(d))).toEqual([]);
    expect(plan.some((d) => /SEARCH r USING/.test(d))).toBe(true);
  });

  it('the schema carries no redundant secondary indexes', () => {
    const indexes = d1.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'`,
    );
    expect(indexes).toEqual([]);
  });
});

describe('versions endpoint pagination (never silently truncated)', () => {
  it('pages with nextCursor when there are more versions than the page size', async () => {
    for (let i = 1; i <= 5; i++) {
      seed(d1, {
        name: 'a.a/x',
        version: `1.0.${i}`,
        isLatest: i === 5,
        publishedAt: `2026-0${i}-01T00:00:00.000Z`,
      });
    }
    const small: HandlerDeps = { db: d1, versionsPageSize: 2 };
    const p1 = await get('/v0.1/servers/a.a%2Fx/versions', small);
    expect(names(p1.body)).toEqual(['a.a/x@1.0.5', 'a.a/x@1.0.4']);
    expect(p1.body.metadata.nextCursor).toBeTruthy();
    const p2 = await get(
      `/v0.1/servers/a.a%2Fx/versions?cursor=${p1.body.metadata.nextCursor}`,
      small,
    );
    expect(names(p2.body)).toEqual(['a.a/x@1.0.3', 'a.a/x@1.0.2']);
    const p3 = await get(
      `/v0.1/servers/a.a%2Fx/versions?cursor=${p2.body.metadata.nextCursor}`,
      small,
    );
    expect(names(p3.body)).toEqual(['a.a/x@1.0.1']);
    expect(p3.body.metadata).toEqual({ count: 1 });
    // an exactly-full page does not advertise a next page
    const full = await get('/v0.1/servers/a.a%2Fx/versions', { db: d1, versionsPageSize: 5 });
    expect(full.body.metadata).toEqual({ count: 5 });
  });
});
