/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies / schema nodes are untyped in tests */
/**
 * Contract tests: every response shape the Worker produces is validated against the
 * hand-maintained subset of the official MCP Registry OpenAPI
 * (test/openapi-v0.1.subset.json), so a drift in either direction is caught.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../src/worker';
import type { HandlerDeps } from '../src/worker';
import {
  SqliteD1,
  assertSupportedKeywords,
  get,
  loadSubset,
  review,
  seed,
  validate,
  type OpenApiSubset,
} from './helpers';

const subset: OpenApiSubset = loadSubset();

function schemaFor(path: string, status: string): any {
  const op = subset.paths[path]!.get!;
  const response = op.responses[status] ?? op.responses.default;
  const content = response.content;
  return (content['application/json'] ?? content['application/problem+json']).schema;
}

function expectConforms(path: string, status: number, body: unknown, label = path) {
  const key = status === 200 ? '200' : 'default';
  expect(validate(subset, schemaFor(path, key), body), label).toEqual([]);
}

let d1: SqliteD1;
let deps: HandlerDeps;

beforeEach(() => {
  d1 = new SqliteD1();
  deps = { db: d1 };
  seed(d1, {
    name: 'io.github.acme/files',
    title: 'Acme Files',
    version: '1.0.0',
    isLatest: false,
  });
  seed(d1, {
    name: 'io.github.acme/files',
    title: 'Acme Files',
    version: '1.1.0',
    statusMessage: 'ok',
    extra: {
      repository: { url: 'https://github.com/acme/files', source: 'github' },
      websiteUrl: 'https://acme.example',
      packages: [
        {
          registryType: 'npm',
          identifier: '@acme/files',
          version: '1.1.0',
          transport: { type: 'stdio' },
        },
      ],
      _meta: { 'app.kepcup/connector': { slug: 'acmefiles', category: 'productivity' } },
    },
  });
  seed(d1, { name: 'com.example/gone', status: 'deleted' });
  seed(d1, { name: 'com.example/old', status: 'deprecated', statusMessage: 'moved' });
  review(d1, { name: 'io.github.acme/files', version: '1.1.0', tier: 'verified' });
  review(d1, { name: 'com.example/old', tier: 'community', hash: null });
});

describe('subset sanity', () => {
  it('mirrors the official parameter contract the Worker implements', () => {
    const params = subset.paths['/v0.1/servers']!.get!.parameters!;
    const limit = params.find((p) => p.name === 'limit')!.schema;
    expect(limit).toMatchObject({ default: DEFAULT_LIMIT, minimum: 1, maximum: MAX_LIMIT });
    expect(params.map((p) => p.name).sort()).toEqual(
      ['cursor', 'include_deleted', 'limit', 'search', 'updated_since', 'version'].sort(),
    );
  });

  it('the validator throws on keywords it does not implement (never passes vacuously)', () => {
    for (const keyword of [
      'oneOf',
      'anyOf',
      'allOf',
      'not',
      'const',
      'minItems',
      'maxItems',
      'uniqueItems',
      'patternProperties',
      'if',
    ]) {
      expect(() => validate(subset, { type: 'string', [keyword]: [] }, 'x'), keyword).toThrow(
        /unsupported/,
      );
    }
    expect(() => validate(subset, { type: 'string', format: 'ipv4' }, 'x')).toThrow(
      /unsupported format/,
    );
    expect(() =>
      validate(subset, { type: 'string', description: 'ok', examples: ['x'] }, 'x'),
    ).not.toThrow();
    // nested schemas are checked too
    expect(() =>
      validate(subset, { type: 'object', properties: { a: { oneOf: [] } } }, { a: 1 }),
    ).toThrow(/oneOf/);
  });

  it('every schema in the subset only uses keywords the validator enforces', () => {
    for (const [name, schema] of Object.entries(subset.components.schemas)) {
      expect(() => assertSupportedKeywords(schema, name), name).not.toThrow();
    }
    for (const [path, ops] of Object.entries(subset.paths)) {
      for (const param of ops.get!.parameters ?? []) {
        expect(() => assertSupportedKeywords(param.schema, path), path).not.toThrow();
      }
    }
    expect(() => assertSupportedKeywords({ properties: { a: { oneOf: [] } } })).toThrow(/oneOf/);
  });

  it('the validator really rejects nonconforming documents', () => {
    const schema = schemaFor('/v0.1/servers', '200');
    const ok = { servers: [], metadata: { count: 0 } };
    expect(validate(subset, schema, ok)).toEqual([]);
    expect(validate(subset, schema, { servers: [] })).not.toEqual([]); // metadata required
    expect(validate(subset, schema, { ...ok, extra: 1 })).not.toEqual([]); // additionalProperties
    expect(
      validate(subset, schema, { servers: [{ server: {}, _meta: {} }], metadata: { count: 1 } }),
    ).not.toEqual([]);
    const entry = {
      server: { $schema: 'https://x.test/s.json', name: 'a.b/c', description: 'd', version: '1' },
      _meta: {
        'io.modelcontextprotocol.registry/official': {
          status: 'weird',
          statusChangedAt: 'x',
          publishedAt: 'x',
          isLatest: true,
        },
      },
    };
    expect(
      validate(subset, schema, { servers: [entry], metadata: { count: 1 } }).length,
    ).toBeGreaterThan(1);
  });
});

describe('every response conforms to the OpenAPI subset', () => {
  it('GET /v0.1/servers (default, paged, filtered, empty)', async () => {
    for (const q of [
      '',
      '?limit=1',
      '?limit=100',
      '?search=acme',
      '?version=latest',
      '?updated_since=2026-09-01T00:00:00Z',
      '?include_deleted=true',
      '?search=zzzz-no-match',
    ]) {
      const { res, body } = await get(`/v0.1/servers${q}`, deps);
      expect(res.status, q).toBe(200);
      expectConforms('/v0.1/servers', 200, body, q);
    }
    const p1 = await get('/v0.1/servers?limit=1', deps);
    const p2 = await get(`/v0.1/servers?limit=1&cursor=${p1.body.metadata.nextCursor}`, deps);
    expectConforms('/v0.1/servers', 200, p2.body);
  });

  it('GET /v0.1/servers/{serverName}/versions', async () => {
    const { res, body } = await get('/v0.1/servers/io.github.acme%2Ffiles/versions', deps);
    expect(res.status).toBe(200);
    expectConforms('/v0.1/servers/{serverName}/versions', 200, body);
  });

  it('GET /v0.1/servers/{serverName}/versions/{version} (exact and latest)', async () => {
    for (const v of ['1.1.0', '1.0.0', 'latest']) {
      const { res, body } = await get(`/v0.1/servers/io.github.acme%2Ffiles/versions/${v}`, deps);
      expect(res.status, v).toBe(200);
      expectConforms('/v0.1/servers/{serverName}/versions/{version}', 200, body, v);
    }
  });

  it('health / ping / version bodies', async () => {
    expectConforms('/v0.1/health', 200, (await get('/v0.1/health', deps)).body);
    expectConforms('/v0.1/ping', 200, (await get('/v0.1/ping', deps)).body);
    expectConforms(
      '/v0.1/version',
      200,
      (
        await get('/v0.1/version', {
          ...deps,
          buildInfo: { version: 'v1', commit: 'c', time: 't' },
        })
      ).body,
    );
  });

  it('error documents (404, 405, 422) conform to ErrorModel', async () => {
    const cases: [string, RequestInit | undefined, number][] = [
      ['/v0.1/servers/no.such%2Fserver/versions', undefined, 404],
      ['/v0.1/servers/no.such%2Fserver/versions/latest', undefined, 404],
      ['/v0.1/servers?limit=500', undefined, 422],
      ['/v0.1/servers?cursor=@@', undefined, 422],
      ['/v0.1/servers', { method: 'DELETE' }, 405],
      ['/v0.1/nothing', undefined, 404],
    ];
    for (const [path, init, status] of cases) {
      const { res, body } = await get(path, deps, init);
      expect(res.status, path).toBe(status);
      expect(validate(subset, { $ref: '#/components/schemas/ErrorModel' }, body), path).toEqual([]);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    }
  });

  it('approved reviews add only the declared KepCup extension keys', async () => {
    const { body } = await get('/v0.1/servers?version=latest', deps);
    const reviewed = body.servers.find((s: any) => s.server.name === 'io.github.acme/files');
    expect(Object.keys(reviewed._meta).sort()).toEqual([
      'app.kepcup/connector',
      'app.kepcup/review',
      'io.modelcontextprotocol.registry/official',
    ]);
  });
});
