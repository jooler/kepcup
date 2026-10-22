import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';
import { JobsService } from '../../src/domain/jobs.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeHarness(): {
  db: SqliteDatabase;
  jobs: JobsService;
  now: () => number;
} {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  const now = 1_000_000;
  return { db, jobs: new JobsService(db, { now: () => now } as never), now: () => now };
}

function payloadOf(db: SqliteDatabase, key: string): { payload_json: string; run_after: number } {
  return db
    .prepare('select payload_json, run_after from jobs where dedupe_key = ? and status = ?')
    .get(key, 'pending') as { payload_json: string; run_after: number };
}

describe('JobsService.mergePendingPayload (reflection debounce)', () => {
  it('accumulates payload entries without moving run_after', () => {
    const { db, jobs, now } = makeHarness();
    const key = 'reflection_debounce:bot:conv';
    jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_1' }] },
      priority: 2,
      dedupeKey: key,
      runAfter: now() + 60_000,
    });
    const before = payloadOf(db, key).run_after;

    const merged = jobs.mergePendingPayload(key, (payload) => ({
      ...payload,
      entries: [...(payload['entries'] as unknown[]), { runId: 'run_2' }],
    }));
    expect(merged).toBe(true);
    const after = payloadOf(db, key);
    expect(after.run_after).toBe(before);
    expect(JSON.parse(after.payload_json)).toEqual({
      entries: [{ runId: 'run_1' }, { runId: 'run_2' }],
    });
  });

  it('returns false once the job is running (a fresh pending job is allowed)', () => {
    const { db, jobs } = makeHarness();
    const key = 'reflection_debounce:bot:conv';
    jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_1' }] },
      priority: 2,
      dedupeKey: key,
    });
    expect(jobs.claimNext()?.dedupe_key).toBe(key);
    expect(jobs.mergePendingPayload(key, (payload) => payload)).toBe(false);

    // Partial unique index only covers pending: a new pending row may coexist.
    jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_2' }] },
      priority: 2,
      dedupeKey: key,
    });
    const pending = db
      .prepare('select count(*) as n from jobs where dedupe_key = ? and status = ?')
      .get(key, 'pending') as { n: number };
    expect(pending.n).toBe(1);
  });

  it('hasten pulls the merged window forward to now', () => {
    const { db, jobs, now } = makeHarness();
    const key = 'reflection_debounce:bot:conv';
    jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [] },
      priority: 2,
      dedupeKey: key,
      runAfter: now() + 600_000,
    });
    expect(jobs.hasten(key, now())).toBe(1);
    expect(payloadOf(db, key).run_after).toBe(now());
  });
});
