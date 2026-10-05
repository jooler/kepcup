import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_RETENTION_MS } from '@kepcup/shared';
import { runMigrations } from '../../src/infra/migrate.js';
import { JobsService } from '../../src/domain/jobs.js';
import { JobsRunner } from '../../src/dispatch/jobs-runner.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

/**
 * jobs 表终态行保留期清理（单元，BR-P10-008）：每次 schedule fire、每轮
 * 15 分钟护栏重试都留一行终态，分钟级 cron 一年约 52 万行——过期终态行
 * （done/failed/cancelled）按 JOB_RETENTION_MS 清理，pending/running 永不触碰。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

interface Harness {
  db: SqliteDatabase;
  jobs: JobsService;
  now(): number;
  advance(ms: number): void;
  count(status: string): number;
}

function makeHarness(): Harness {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  let now = 1_000_000;
  const jobs = new JobsService(db, { now: () => now } as never);
  return {
    db,
    jobs,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    count: (status: string) =>
      (db.prepare('select count(*) as n from jobs where status = ?').get(status) as { n: number }).n,
  };
}

function runnerHarness(jobs: JobsService, now: number): JobsRunner {
  // 只触达 start() 的清理与认领路径，其余依赖以最小桩注入。
  return new JobsRunner({
    engine: {} as never,
    scheduler: { submit: () => {} } as never,
    jobs,
    settings: { get: () => ({ defaultLightModel: '', defaultMainModel: '' }) } as never,
    bots: {} as never,
    conversations: {} as never,
    messages: {} as never,
    usage: {} as never,
    runs: {} as never,
    secrets: {} as never,
    orchestrator: {} as never,
    logger,
    memory: {} as never,
    clock: { now: () => now } as never,
  });
}

describe('jobs 终态行保留期清理（BR-P10-008）', () => {
  it('purgeTerminalOlderThan 只删过期终态行，pending 与近期 done 保留', () => {
    const h = makeHarness();
    const oldDone = h.jobs.enqueue({ type: 'conversation_summary', conversationId: 'c1', payload: {}, priority: 2 });
    h.jobs.complete(oldDone);
    const oldCancelled = h.jobs.enqueue({ type: 'reflection', botId: 'b1', payload: {}, priority: 2 });
    h.db.prepare("update jobs set status = 'cancelled' where id = ?").run(oldCancelled);
    // 老 pending（推迟到远期）：即使 updated_at 过期也不得清理
    const pendingFuture = h.jobs.enqueue({
      type: 'memory_vec_rebuild',
      botId: 'b1',
      payload: {},
      priority: 2,
      runAfter: h.now() + 30 * 24 * 60 * 60_000,
    });

    h.advance(JOB_RETENTION_MS + 60 * 60_000);
    const recentDone = h.jobs.enqueue({ type: 'conversation_summary', conversationId: 'c1', payload: {}, priority: 2 });
    h.jobs.complete(recentDone);

    const deleted = h.jobs.purgeTerminalOlderThan(h.now() - JOB_RETENTION_MS);
    expect(deleted).toBe(2); // 过期 done + 过期 cancelled
    expect(h.count('done')).toBe(1); // 近期 done 保留
    expect(h.count('cancelled')).toBe(0);
    expect(h.count('pending')).toBe(1);
    expect(h.db.prepare('select count(*) as n from jobs where id = ?').get(pendingFuture)).toMatchObject({ n: 1 });
  });

  it('runner 启动即清理过期终态行，未到期的 pending 不受影响', () => {
    const h = makeHarness();
    const oldDone = h.jobs.enqueue({ type: 'conversation_summary', conversationId: 'c1', payload: {}, priority: 2 });
    h.jobs.complete(oldDone);
    h.advance(JOB_RETENTION_MS + 24 * 60 * 60_000);
    const pendingFuture = h.jobs.enqueue({
      type: 'memory_vec_rebuild',
      botId: 'b1',
      payload: {},
      priority: 2,
      runAfter: h.now() + 30 * 24 * 60 * 60_000, // 认领不到，不会被 runner 执行
    });

    const runner = runnerHarness(h.jobs, h.now());
    runner.start();
    runner.stop();

    expect(h.count('done')).toBe(0);
    expect(h.count('pending')).toBe(1);
    expect(h.db.prepare('select count(*) as n from jobs where id = ?').get(pendingFuture)).toMatchObject({ n: 1 });
  });
});
