import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runSchema } from '@kepcup/shared';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { RunsService } from '../../src/domain/runs.js';
import type { Clock } from '../../src/infra/clock.js';

/** D75 W0：runs 任务字段读写与任务查询（docs/design/30 §3.4、§3.2）。 */

const dir = mkdtempSync(path.join(tmpdir(), 'runs-tasks-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withRuns(fn: (runs: RunsService, db: SqliteDatabase) => void): void {
  const db = openDatabase({
    path: path.join(dir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.runsDb),
  });
  runMigrations(db, migrationsUrl('runs'));
  let tick = 0;
  const clock: Clock = { now: () => 1_000_000 + tick++ };
  try {
    fn(new RunsService(db, clock), db);
  } finally {
    closeDatabase(db);
  }
}

function createTask(
  runs: RunsService,
  overrides: Partial<Parameters<RunsService['create']>[0]> = {},
) {
  return runs.create({
    botId: 'bot_x',
    conversationId: 'conv_a',
    loopType: 'task',
    triggerReason: null,
    triggerMessageIds: [],
    taskTitle: '补测试',
    taskWrites: true,
    taskWorkdir: '/ws/conv_a',
    originRunId: 'run_turn1',
    ...overrides,
  });
}

describe('runs 任务字段', () => {
  it('create 写入任务字段（submitted = queued），读回映射正确并通过 runSchema', () => {
    withRuns((runs) => {
      const task = createTask(runs, { continuedFromRunIds: ['run_prev'] });
      expect(task).toMatchObject({
        loopType: 'task',
        status: 'queued',
        taskTitle: '补测试',
        taskWrites: true,
        taskWorkdir: '/ws/conv_a',
        originRunId: 'run_turn1',
        resultConsumedAt: null,
        awaitingInput: false,
        continuedFromRunIds: ['run_prev'],
      });
      expect(runSchema.parse(task)).toEqual(task);
      const readOnly = createTask(runs, { taskWrites: false });
      expect(readOnly.taskWrites).toBe(false);
    });
  });

  it('非任务 run 的任务字段为 null / false（行为不变）', () => {
    withRuns((runs) => {
      const run = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: ['msg_1'],
      });
      expect(run).toMatchObject({
        taskTitle: null,
        taskWrites: null,
        taskWorkdir: null,
        originRunId: null,
        resultConsumedAt: null,
        awaitingInput: false,
        continuedFromRunIds: [],
      });
      // An unrelated update keeps them untouched.
      expect(runs.update(run.id, { status: 'running' })).toMatchObject({
        taskWrites: null,
        resultConsumedAt: null,
        awaitingInput: false,
      });
    });
  });

  it('update 支持 resultConsumedAt / awaitingInput，未触及的补丁保持原值', () => {
    withRuns((runs) => {
      const task = createTask(runs);
      expect(runs.update(task.id, { status: 'running', awaitingInput: true }).awaitingInput).toBe(
        true,
      );
      // Untouched patch keeps awaitingInput.
      expect(runs.update(task.id, { summary: 's' }).awaitingInput).toBe(true);
      expect(runs.update(task.id, { awaitingInput: false }).awaitingInput).toBe(false);
      const done = runs.update(task.id, { status: 'completed' });
      expect(done.resultConsumedAt).toBeNull();
      expect(runs.update(task.id, { resultConsumedAt: 42 }).resultConsumedAt).toBe(42);
      expect(runs.update(task.id, { summary: 't' }).resultConsumedAt).toBe(42);
      expect(runs.update(task.id, { resultConsumedAt: null }).resultConsumedAt).toBeNull();
      expect(runs.getOrThrow(task.id)).toMatchObject({
        taskTitle: '补测试',
        taskWrites: true,
        originRunId: 'run_turn1',
      });
    });
  });
});

describe('任务查询', () => {
  it('listTasks 只含 loop_type=task，按对话 / Bot / 状态过滤，先建先出', () => {
    withRuns((runs) => {
      runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      const t1 = createTask(runs);
      const t2 = createTask(runs, { botId: 'bot_y' });
      const t3 = createTask(runs, { conversationId: 'conv_b' });
      runs.update(t2.id, { status: 'running' });
      runs.update(t3.id, { status: 'completed' });

      expect(runs.listTasks().map((r) => r.id)).toEqual([t1.id, t2.id, t3.id]);
      expect(runs.listTasks({ conversationId: 'conv_a' }).map((r) => r.id)).toEqual([t1.id, t2.id]);
      expect(runs.listTasks({ botId: 'bot_y' }).map((r) => r.id)).toEqual([t2.id]);
      expect(runs.listTasks({ statuses: ['queued', 'running'] }).map((r) => r.id)).toEqual([
        t1.id,
        t2.id,
      ]);
      expect(
        runs
          .listTasks({ conversationId: 'conv_a', botId: 'bot_x', statuses: ['queued'] })
          .map((r) => r.id),
      ).toEqual([t1.id]);
      expect(runs.listTasks({ statuses: [] })).toEqual([]);
    });
  });

  it('listNonTerminalTasks / listUnconsumedTerminalTasks', () => {
    withRuns((runs) => {
      // Non-task active / terminal runs never show up.
      const response = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      const doneResponse = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      runs.update(doneResponse.id, { status: 'completed' });
      expect(response.status).toBe('queued');

      const queued = createTask(runs);
      const running = createTask(runs);
      const waiting = createTask(runs);
      const completed = createTask(runs);
      const failed = createTask(runs);
      const consumed = createTask(runs);
      const interrupted = createTask(runs);
      runs.update(running.id, { status: 'running' });
      runs.update(waiting.id, { status: 'waiting_lease' });
      runs.update(completed.id, { status: 'completed' });
      runs.update(failed.id, { status: 'failed' });
      runs.update(consumed.id, { status: 'cancelled', resultConsumedAt: 5 });
      runs.update(interrupted.id, { status: 'interrupted' });

      expect(runs.listNonTerminalTasks().map((r) => r.id)).toEqual([
        queued.id,
        running.id,
        waiting.id,
      ]);
      expect(runs.listUnconsumedTerminalTasks().map((r) => r.id)).toEqual([
        completed.id,
        failed.id,
        interrupted.id,
      ]);
    });
  });
});
