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

  it('dismissFailure 把失败标成已读，后续 update 不冲掉；非失败与缺失不动', () => {
    withRuns((runs) => {
      const turn = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: ['msg_1'],
      });
      const failed = runs.update(turn.id, {
        status: 'failed',
        error: '429 quota',
        errorReason: 'quota',
        setup: { kind: 'main-model' },
      });
      expect(failed.failureDismissed).toBeUndefined();

      const dismissed = runs.dismissFailure(failed.id);
      expect(dismissed).not.toBeNull();
      expect(dismissed).toMatchObject({
        status: 'failed',
        error: '429 quota',
        errorReason: 'quota',
        setup: { kind: 'main-model' },
        failureDismissed: true,
      });
      expect(runSchema.parse(dismissed!)).toMatchObject({ failureDismissed: true });
      expect(runs.dismissFailure(failed.id)?.failureDismissed).toBe(true);

      const patched = runs.update(failed.id, { summary: 'noted' });
      expect(patched.failureDismissed).toBe(true);
      expect(patched.error).toBe('429 quota');
      expect(patched.errorReason).toBe('quota');
      expect(patched.setup).toEqual({ kind: 'main-model' });

      const running = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: ['msg_2'],
      });
      expect(runs.dismissFailure(running.id)?.failureDismissed).toBeUndefined();
      expect(runs.dismissFailure('missing')).toBeNull();
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

describe('listByBotInConversation（list_my_runs 的窗口）', () => {
  it('在 SQL 里按 Bot 与 loop_type 过滤：别人的 run 不挤占本 Bot 的窗口', () => {
    withRuns((runs) => {
      const mine = createTask(runs, { botId: 'bot_x' });
      const turn = runs.create({
        botId: 'bot_x',
        conversationId: 'conv_a',
        loopType: 'turn',
        triggerReason: 'direct',
        triggerMessageIds: [],
      });
      // 之后到达的 25 条：别的 Bot 的 run 与本 Bot 的后台 run，足以占满对话级 LIMIT 20。
      for (let i = 0; i < 20; i += 1) createTask(runs, { botId: 'bot_y' });
      for (let i = 0; i < 5; i += 1) {
        runs.create({
          botId: 'bot_x',
          conversationId: 'conv_a',
          loopType: 'background',
          triggerReason: null,
          triggerMessageIds: [],
        });
      }
      // 别的对话的同 Bot run 也不进来。
      createTask(runs, { botId: 'bot_x', conversationId: 'conv_b' });

      const listed = runs.listByBotInConversation('conv_a', 'bot_x', ['turn', 'task'], 20);
      expect(listed.map((r) => r.id).sort()).toEqual([mine.id, turn.id].sort());
      expect(runs.listByBotInConversation('conv_a', 'bot_x', [], 20)).toEqual([]);
      expect(runs.listByBotInConversation('conv_a', 'bot_x', ['turn', 'task'], 1)).toHaveLength(1);
    });
  });
});

describe('turnBotIdsTriggeredBy（D90：群里谁接了那条派发）', () => {
  const turn = (runs: RunsService, overrides: Partial<Parameters<RunsService['create']>[0]> = {}) =>
    runs.create({
      botId: 'bot_a',
      conversationId: 'conv_g',
      loopType: 'turn',
      triggerReason: 'broadcast',
      triggerMessageIds: [],
      ...overrides,
    });

  it('按触发消息 id 找对话轮的 Bot：只认对话轮、只认本对话、去重并按先后；合批的 parts 里的也算', () => {
    withRuns((runs) => {
      turn(runs, { botId: 'bot_a', triggerMessageIds: ['msg_1'] });
      turn(runs, { botId: 'bot_b', triggerMessageIds: ['msg_1', 'msg_2'] });
      turn(runs, { botId: 'bot_a', triggerMessageIds: ['msg_1'] });
      // 合批：msg_1 只在 parts 里。
      turn(runs, {
        botId: 'bot_c',
        triggerMessageIds: ['msg_9'],
        triggerParts: [
          { reason: 'task', messageIds: ['msg_9'] },
          { reason: 'broadcast', messageIds: ['msg_1'] },
        ],
      });
      // 不算：别的消息、别的对话、任务、id 只是前缀相同（msg_10 ≠ msg_1）。
      turn(runs, { botId: 'bot_x', triggerMessageIds: ['msg_2'] });
      turn(runs, { botId: 'bot_y', conversationId: 'conv_other', triggerMessageIds: ['msg_1'] });
      turn(runs, { botId: 'bot_z', loopType: 'task', triggerMessageIds: ['msg_1'] });
      turn(runs, { botId: 'bot_w', triggerMessageIds: ['msg_10'] });
      expect(runs.turnBotIdsTriggeredBy('conv_g', 'msg_1')).toEqual(['bot_a', 'bot_b', 'bot_c']);
      expect(runs.turnBotIdsTriggeredBy('conv_g', 'msg_404')).toEqual([]);
    });
  });
});
