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

describe('JobsService dedupe-key collision (fail / defer / startup reset)', () => {
  // 去抖常态：窗口 job 被 claim（running）后，新轮次会在同 key 下再排一条
  // pending 行（部分唯一索引只约束 pending）。此后 running 行复位 pending
  // 会撞索引、行永久卡死 running——fail()/defer()/resetRunningToPending()
  // 必须改走「折进 pending 行 + cancelled」。
  function collide(harness: ReturnType<typeof makeHarness>, firstRunAfter?: number) {
    const { jobs, now } = harness;
    const key = 'reflection_debounce:bot:conv';
    const running = jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_1' }, { runId: 'run_2' }] },
      priority: 2,
      dedupeKey: key,
      ...(firstRunAfter !== undefined ? { runAfter: firstRunAfter } : {}),
    });
    expect(jobs.claimNext()?.id).toBe(running);
    jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_3' }] },
      priority: 2,
      dedupeKey: key,
      runAfter: now() + 600_000,
    });
    return { key, running };
  }

  function statusOf(harness: ReturnType<typeof makeHarness>, id: string): string {
    return (
      harness.db.prepare('select status from jobs where id = ?').get(id) as { status: string }
    ).status;
  }

  it('fail() folds the running batch into the pending row instead of hitting jobs_dedupe', () => {
    const harness = makeHarness();
    const { db, jobs, now } = harness;
    const { key, running } = collide(harness);

    expect(() => jobs.fail(running, 'boom')).not.toThrow();
    expect(statusOf(harness, running)).toBe('cancelled');

    const pending = payloadOf(db, key);
    const payload = JSON.parse(pending.payload_json) as {
      entries: Array<{ runId: string }>;
    };
    // 两批 entries 都在（running 行是更早的一批，排在前）。
    expect(payload.entries.map((entry) => entry.runId)).toEqual(['run_1', 'run_2', 'run_3']);
    // run_after 取较早：running 行本来已到期，合并后立即可执行。
    expect(pending.run_after).toBe(now());
  });

  it('fail() without a pending sibling still retries as pending', () => {
    const harness = makeHarness();
    const { jobs } = harness;
    const id = jobs.enqueue({
      type: 'reflection',
      botId: 'bot',
      conversationId: 'conv',
      payload: { entries: [{ runId: 'run_1' }] },
      priority: 2,
      dedupeKey: 'reflection_debounce:bot:conv',
    });
    jobs.claimNext();
    jobs.fail(id, 'boom');
    expect(statusOf(harness, id)).toBe('pending');
  });

  it('defer() folds into the pending row and keeps the earlier deadline', () => {
    const harness = makeHarness();
    const { db, jobs, now } = harness;
    const { key, running } = collide(harness, now() - 1);

    expect(() => jobs.defer(running, now() + 900_000)).not.toThrow();
    expect(statusOf(harness, running)).toBe('cancelled');

    const pending = payloadOf(db, key);
    const payload = JSON.parse(pending.payload_json) as {
      entries: Array<{ runId: string }>;
    };
    expect(payload.entries.map((entry) => entry.runId)).toEqual(['run_1', 'run_2', 'run_3']);
    // run_after 取较早：推迟目标（now+900s）晚于 pending 行原窗口时不推迟合并行。
    expect(pending.run_after).toBe(now() + 600_000);
  });

  it('non-entries payloads keep the pending row value (conservative merge)', () => {
    const harness = makeHarness();
    const { db, jobs, now } = harness;
    const { key, running } = collide(harness, now() - 1);
    db.prepare("update jobs set payload_json = ? where dedupe_key = ? and status = 'pending'").run(
      JSON.stringify({ summary: 'per-conversation payload' }),
      key,
    );

    expect(() => jobs.fail(running, 'boom')).not.toThrow();
    expect(statusOf(harness, running)).toBe('cancelled');
    expect(JSON.parse(payloadOf(db, key).payload_json)).toEqual({
      summary: 'per-conversation payload',
    });
  });

  it('resetRunningToPending folds crash-leftover running entries into the pending row', () => {
    const harness = makeHarness();
    const { db, jobs } = harness;
    const { key, running } = collide(harness);
    // 直接在 DB 里把 running 行再标 running（模拟崩溃遗留），pending 行仍在。
    db.prepare("update jobs set status = 'running' where id = ?").run(running);
    // 重叠 entry：run_2 两行都有，合并后按 runId 去重。
    db.prepare("update jobs set payload_json = ? where id = ?").run(
      JSON.stringify({ entries: [{ runId: 'run_2' }, { runId: 'run_3' }] }),
      running,
    );

    expect(() => jobs.resetRunningToPending()).not.toThrow();
    expect(statusOf(harness, running)).toBe('cancelled');

    const pending = payloadOf(db, key);
    const payload = JSON.parse(pending.payload_json) as {
      entries: Array<{ runId: string }>;
    };
    expect(payload.entries.map((entry) => entry.runId)).toEqual(['run_2', 'run_3']);
  });
});
