import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '@kepcup/testkit';
import { runMigrations } from '../../src/infra/migrate.js';
import { ScheduleService, TICK_ERROR_RETRY_MS } from '../../src/schedule/service.js';
import type { SqliteDatabase } from '../../src/infra/db.js';

/**
 * 定时服务的单定时器健壮性（单元，BR-P10-003）：修复前回调裸调 #onDue()，
 * 一次 store 读 / jobs 写抛错就让定时链死亡（直到下次启动或下次建任务）。
 * 修复后回调 try/catch（记 error）+ finally 重臂，失败一轮后退避重试——
 * 失败行保留过期的 next_fire_at，无退避的立即重臂会在持续性故障下变成
 * delay-0 热循环。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));

const openDbs: SqliteDatabase[] = [];

function migratedMainDb(): SqliteDatabase {
  const db = new Database(':memory:') as SqliteDatabase;
  runMigrations(db, mainMigrations);
  // schedules 行有对 bots / conversations 的外键：种最小真实行。
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_1', '阿单', '{}', 'active', 0, 0)",
  ).run();
  db.prepare(
    "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_1', 'direct', 'bot_1', 0, 0)",
  ).run();
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

interface ServiceOptions {
  clock: TestClock;
  timers: { setTimer: (delayMs: number, fn: () => void) => () => void };
  jobs: unknown;
}

function makeService({ clock, timers, jobs }: ServiceOptions): ScheduleService {
  const bots = { get: () => ({ id: 'bot_1', status: 'active' }) };
  const conversations = {
    get: () => ({ id: 'conv_1', readOnly: false }),
    memberBotIds: () => ['bot_1'],
  };
  return new ScheduleService({
    db: migratedMainDb(),
    runsDb: {} as never,
    clock,
    timers,
    logger,
    timeZone: 'UTC',
    bots: bots as never,
    conversations: conversations as never,
    jobs: jobs as never,
    runs: {} as never,
    memory: {} as never,
    orchestrator: {} as never,
  });
}

describe('P10 定时服务：单定时器异常防护（BR-P10-003）', () => {
  it('一次 enqueue 抛错后仍重臂（带退避，非 0 延迟热循环），下一轮到点仍触发', () => {
    const clock = new TestClock();
    let failEnqueue = true;
    const enqueued: Array<{ type: string; dedupeKey: string | null }> = [];
    const jobs = {
      enqueue: (input: { type: string; dedupeKey: string | null }) => {
        if (failEnqueue) throw new Error('disk full');
        enqueued.push(input);
        return 'job_1';
      },
    };
    const armed: number[] = [];
    const timers = {
      setTimer: (delayMs: number, fn: () => void) => {
        armed.push(delayMs);
        return clock.setTimer(delayMs, fn);
      },
    };
    const service = makeService({ clock, timers, jobs });
    service.start();
    const row = service.createOnce({
      botId: 'bot_1',
      conversationId: 'conv_1',
      runAt: clock.now() + 120_000,
      note: '任务',
    });
    expect(armed).toEqual([120_000]);

    // 到点 tick：enqueue 抛错 → 不再炸断定时链，退避重臂
    clock.advance(120_000);
    expect(enqueued).toHaveLength(0);
    // 失败行保留过期 next_fire_at（立即重臂 = delay 0 热循环），必须退避
    expect(armed.at(-1)).toBe(TICK_ERROR_RETRY_MS);
    expect(clock.armedTimers).toBe(1);
    expect(service.store.get(row.id)?.nextFireAt).toBe(row.runAt);

    // 故障恢复后：下一轮 tick 正常 enqueue 并推进行状态
    failEnqueue = false;
    clock.advance(TICK_ERROR_RETRY_MS);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: 'schedule_fire' });
    expect(service.store.get(row.id)?.nextFireAt).toBeNull();
  });
});
