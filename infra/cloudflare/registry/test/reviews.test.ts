/* eslint-disable @typescript-eslint/no-explicit-any -- JSON response bodies are untyped in tests */
import { beforeEach, describe, expect, it } from 'vitest';
import { getServerForReview, revokeReview, submitReview } from '../src/reviews';
import type { HandlerDeps } from '../src/worker';
import { SqliteD1, get, seed, sha256 } from './helpers';

let d1: SqliteD1;
let deps: HandlerDeps;
const T0 = new Date('2026-10-05T00:00:00.000Z');
const at = (iso: string) => () => new Date(iso);

beforeEach(() => {
  d1 = new SqliteD1();
  deps = { db: d1 };
  seed(d1, { name: 'a.a/x' });
});

const tierOf = (body: any) => body._meta['app.kepcup/connector']?.tier;
const detail = () => get('/v0.1/servers/a.a%2Fx/versions/1.0.0', deps);

describe('schema constraints on reviews', () => {
  const insert = (reviewedAt: unknown, status = 'approved', sha: unknown = 'a'.repeat(64)) =>
    d1.db
      .prepare(
        `INSERT INTO reviews (name, version, tier, review_status, reviewed_at, server_json_sha256)
         VALUES ('a.a/x', '1.0.0', 'community', ?, ?, ?)`,
      )
      .run(status, reviewedAt as any, sha as any);

  it('reviewed_at is mandatory for every status and must be ISO-ms UTC', () => {
    expect(() => insert('2026-10-05T00:00:00.000Z')).not.toThrow();
    d1.db.exec('DELETE FROM reviews');
    for (const status of ['pending', 'approved', 'rejected']) {
      expect(() => insert(null, status), `null/${status}`).toThrow();
    }
    for (const bad of [
      '2026-10-05',
      '2026-10-05T00:00:00Z',
      '2026-10-05 00:00:00.000Z',
      'yesterday',
      '',
    ]) {
      expect(() => insert(bad), bad).toThrow();
    }
  });

  it('an approved review must carry the server_json sha256 (64 chars)', () => {
    expect(() => insert('2026-10-05T00:00:00.000Z', 'approved', null)).toThrow();
    expect(() => insert('2026-10-05T00:00:00.000Z', 'approved', 'short')).toThrow();
    expect(() => insert('2026-10-05T00:00:00.000Z', 'rejected', null)).not.toThrow();
  });
});

describe('submitReview / revokeReview', () => {
  it('approves, records the CURRENT sha256 itself and exposes the tier', async () => {
    const r = await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'verified',
      status: 'approved',
      toolContractHash: 'sha256:tools',
      notes: 'ok',
      now: at('2026-10-05T00:00:00.000Z'),
    });
    expect(r).toEqual({ ok: true, reviewedAt: '2026-10-05T00:00:00.000Z' });
    const row = d1.rows<any>('SELECT * FROM reviews')[0];
    const stored = d1.rows<any>('SELECT server_json, server_json_sha256 FROM servers')[0];
    expect(row.server_json_sha256).toBe(stored.server_json_sha256);
    expect(row.server_json_sha256).toBe(sha256(stored.server_json));
    const { body } = await detail();
    expect(tierOf(body)).toBe('verified');
    expect(body._meta['app.kepcup/review']).toMatchObject({
      toolContractHash: 'sha256:tools',
      notes: 'ok',
    });
  });

  it('rejects unknown servers, invalid input, and approval without a tool contract hash', async () => {
    expect(
      await submitReview(d1, {
        name: 'no.no/such',
        version: '1.0.0',
        tier: 'community',
        status: 'approved',
        toolContractHash: 'h',
      }),
    ).toMatchObject({ ok: false, error: 'not_found' });
    expect(
      await submitReview(d1, {
        name: 'a.a/x',
        version: '9.9.9',
        tier: 'community',
        status: 'pending',
      }),
    ).toMatchObject({ ok: false, error: 'not_found' });
    expect(
      await submitReview(d1, {
        name: 'a.a/x',
        version: '1.0.0',
        tier: 'community',
        status: 'approved',
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(
      await submitReview(d1, {
        name: 'a.a/x',
        version: '1.0.0',
        tier: 'builtin' as any,
        status: 'approved',
        toolContractHash: 'h',
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect(d1.rows('SELECT * FROM reviews')).toEqual([]);
  });

  it('getServerForReview returns the registry-held content + sha; expectedSha256 guards against content that changed', async () => {
    const fetched = await getServerForReview(d1, 'a.a/x', '1.0.0');
    expect(fetched?.sha256).toBe(sha256(fetched!.serverJson));
    expect(await getServerForReview(d1, 'a.a/x', '9.9.9')).toBeNull();

    const changed = JSON.stringify({
      ...JSON.parse(fetched!.serverJson),
      description: 'swapped after review',
    });
    d1.db
      .prepare('UPDATE servers SET server_json = ?, server_json_sha256 = ?')
      .run(changed, sha256(changed));
    const stale = await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'community',
      status: 'approved',
      toolContractHash: 'h',
      expectedSha256: fetched!.sha256,
    });
    expect(stale).toMatchObject({ ok: false, error: 'stale' });
    expect(d1.rows('SELECT * FROM reviews')).toEqual([]);
    const fresh = await getServerForReview(d1, 'a.a/x', '1.0.0');
    expect(
      await submitReview(d1, {
        name: 'a.a/x',
        version: '1.0.0',
        tier: 'community',
        status: 'approved',
        toolContractHash: 'h',
        expectedSha256: fresh!.sha256,
      }),
    ).toMatchObject({ ok: true });
  });

  it('reviewed_at is strictly increasing even when the clock does not advance', async () => {
    const now = at('2026-10-05T00:00:00.000Z');
    const a = await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'community',
      status: 'approved',
      toolContractHash: 'h',
      now,
    });
    const b = await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'verified',
      status: 'approved',
      toolContractHash: 'h',
      now,
    });
    const c = await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'verified',
      status: 'approved',
      toolContractHash: 'h',
      now: at('2026-01-01T00:00:00.000Z'),
    });
    expect(a.reviewedAt).toBe('2026-10-05T00:00:00.000Z');
    expect(b.reviewedAt).toBe('2026-10-05T00:00:00.001Z');
    expect(c.reviewedAt).toBe('2026-10-05T00:00:00.002Z');
  });

  it('revocation hides the tier, bumps updatedAt, and is visible to updated_since pullers', async () => {
    await seedApproved();
    const before = (await detail()).body;
    expect(tierOf(before)).toBe('community');
    const pulledBefore = await get('/v0.1/servers?updated_since=2026-10-05T12:00:00Z', deps);
    expect(pulledBefore.body.servers).toEqual([]);

    const r = await revokeReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      notes: 'tools changed',
      now: at('2026-10-06T00:00:00.000Z'),
    });
    expect(r.ok).toBe(true);
    const row = d1.rows<any>('SELECT * FROM reviews')[0];
    expect(row).toMatchObject({
      review_status: 'rejected',
      tier: 'community',
      reviewed_at: '2026-10-06T00:00:00.000Z',
    });

    const after = (await detail()).body;
    expect(tierOf(after)).toBeUndefined();
    expect(after._meta['app.kepcup/review']).toBeUndefined();
    expect(after._meta['io.modelcontextprotocol.registry/official'].updatedAt).toBe(
      '2026-10-06T00:00:00.000Z',
    );
    const pulled = await get('/v0.1/servers?updated_since=2026-10-05T12:00:00Z', deps);
    expect(pulled.body.servers.map((s: any) => s.server.name)).toEqual(['a.a/x']);
    expect(tierOf(pulled.body.servers[0])).toBeUndefined();
  });

  it('pending reviews also bump updatedAt but expose nothing', async () => {
    await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'verified',
      status: 'pending',
      now: at('2026-10-07T00:00:00.000Z'),
    });
    const pulled = await get('/v0.1/servers?updated_since=2026-10-06T00:00:00Z', deps);
    expect(pulled.body.servers).toHaveLength(1);
    expect(tierOf(pulled.body.servers[0])).toBeUndefined();
  });

  it('a stale review (server_json changed since approval) drops the tier until re-approved', async () => {
    await seedApproved();
    const changed = JSON.stringify({
      ...JSON.parse(d1.rows<any>('SELECT server_json FROM servers')[0].server_json),
      description: 'new',
    });
    d1.db
      .prepare('UPDATE servers SET server_json = ?, server_json_sha256 = ?')
      .run(changed, sha256(changed));
    expect(tierOf((await detail()).body)).toBeUndefined();

    await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'community',
      status: 'approved',
      toolContractHash: 'h2',
      now: at('2026-10-08T00:00:00.000Z'),
    });
    const { body } = await detail();
    expect(tierOf(body)).toBe('community');
    expect(body.server.description).toBe('new');
  });

  it('a review row with a missing or foreign sha256 is never honoured', async () => {
    d1.db
      .prepare(
        `INSERT INTO reviews (name, version, tier, review_status, reviewed_at, server_json_sha256)
      VALUES ('a.a/x', '1.0.0', 'verified', 'rejected', '2026-10-05T00:00:00.000Z', NULL)`,
      )
      .run();
    d1.db.exec(`UPDATE reviews SET review_status = 'pending'`);
    expect(tierOf((await detail()).body)).toBeUndefined();
    d1.db.exec(`DELETE FROM reviews`);
    d1.db
      .prepare(
        `INSERT INTO reviews (name, version, tier, review_status, reviewed_at, server_json_sha256)
      VALUES ('a.a/x', '1.0.0', 'verified', 'approved', '2026-10-05T00:00:00.000Z', ?)`,
      )
      .run('f'.repeat(64));
    expect(tierOf((await detail()).body)).toBeUndefined();
  });

  async function seedApproved() {
    await submitReview(d1, {
      name: 'a.a/x',
      version: '1.0.0',
      tier: 'community',
      status: 'approved',
      toolContractHash: 'h',
      now: () => T0,
    });
  }
});
