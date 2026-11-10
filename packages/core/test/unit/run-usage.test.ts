import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { UsageService } from '../../src/domain/usage.js';

/**
 * 任务详情页的上下文用量（`tasks.usage`）：UsageService.usageForRun 按 run_id
 * 聚合 usage_ledger。后台任务的账本行 run_id 就是 task.id、loop_type='task'
 * （dispatch/tasks.ts 建 run 与 agent/pi-engine 记账同一条 run），这里直接把
 * 行写进账本以控制 created_at 与 loop_type，不起真实任务。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'run-usage-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

let rowSeq = 0;

function insertRow(
  db: SqliteDatabase,
  row: {
    runId: string;
    loopType?: string;
    provider?: string;
    model?: string;
    input: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    createdAt: number;
  },
): void {
  rowSeq += 1;
  db.prepare(
    `insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model,
                               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                               cost_usd, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `use_${rowSeq}`,
    row.runId,
    'bot_a',
    'conv_a',
    row.loopType ?? 'task',
    row.provider ?? 'custom:mock',
    row.model ?? 'mock-large',
    row.input,
    row.output ?? 0,
    row.cacheRead ?? 0,
    row.cacheWrite ?? 0,
    null,
    row.createdAt,
  );
}

function service(db: SqliteDatabase): UsageService {
  return new UsageService(db, { now: () => 1_000 });
}

describe('UsageService.usageForRun', () => {
  it('aggregates all ledger rows of the run and takes the latest main-loop call as context', () => {
    const db = openMainDb();
    try {
      insertRow(db, { runId: 'task_1', input: 1_000, output: 100, createdAt: 10 });
      insertRow(db, {
        runId: 'task_1',
        input: 2_000,
        output: 200,
        cacheRead: 6_000,
        cacheWrite: 500,
        createdAt: 20,
      });
      // 与任务无关的行不能混进来。
      insertRow(db, { runId: 'task_2', input: 99_999, output: 1, createdAt: 30 });

      const usage = service(db).usageForRun('task_1');
      expect(usage).not.toBeNull();
      expect(usage).toMatchObject({
        calls: 2,
        inputTokens: 3_000,
        outputTokens: 300,
        cacheReadTokens: 6_000,
        cacheWriteTokens: 500,
        // 最新一行（created_at 20）的 prompt 总量：2000 + 6000 + 500。
        contextTokens: 8_500,
        // 加权命中率：6000 / (3000 + 6000 + 500)，分母是全部 prompt token
        // （input + cacheRead + cacheWrite），与 contextTokens 同口径。
        cacheHitRate: 6_000 / 9_500,
      });
      // 没有传解析器 → 窗口未知，不猜默认值。
      expect(usage?.contextWindow).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('counts cache writes in the denominator: a written-but-unread prefix is not a hit', () => {
    const db = openMainDb();
    try {
      // 首轮只写缓存（cache_write 很大、cache_read 为 0）：命中率必须是 0%，
      // 不能因为漏掉 cache_write 而被算成 100%。
      insertRow(db, {
        runId: 'task_1',
        input: 1_000,
        cacheRead: 0,
        cacheWrite: 9_000,
        createdAt: 10,
      });
      const usage = service(db).usageForRun('task_1');
      expect(usage?.cacheHitRate).toBe(0);
      // 第二轮命中 9_000：9000 / (2000 + 9000 + 9000)。
      insertRow(db, { runId: 'task_1', input: 1_000, cacheRead: 9_000, createdAt: 20 });
      expect(service(db).usageForRun('task_1')?.cacheHitRate).toBe(9_000 / 20_000);
    } finally {
      closeDatabase(db);
    }
  });

  it('prefers the latest loop_type=task row over newer rows of other loops', () => {
    const db = openMainDb();
    try {
      insertRow(db, { runId: 'task_1', input: 1_000, cacheRead: 4_000, createdAt: 10 });
      // 同 run 的旁路（如轻判定）在更晚的时间记账，不应被当成主循环上下文。
      insertRow(db, {
        runId: 'task_1',
        loopType: 'light_judgement',
        input: 120,
        output: 10,
        createdAt: 20,
      });

      expect(service(db).usageForRun('task_1')?.contextTokens).toBe(5_000);
    } finally {
      closeDatabase(db);
    }
  });

  it('falls back to the newest row when the run has no task-loop row', () => {
    const db = openMainDb();
    try {
      insertRow(db, {
        runId: 'run_x',
        loopType: 'subagent',
        input: 300,
        cacheRead: 700,
        createdAt: 10,
      });
      insertRow(db, { runId: 'run_x', loopType: 'subagent', input: 50, createdAt: 5 });

      expect(service(db).usageForRun('run_x')?.contextTokens).toBe(1_000);
    } finally {
      closeDatabase(db);
    }
  });

  it('resolves the context window from the latest main-loop provider/model', () => {
    const db = openMainDb();
    try {
      insertRow(db, {
        runId: 'task_1',
        provider: 'anthropic',
        model: 'claude-sonnet',
        input: 10_000,
        cacheRead: 90_000,
        createdAt: 10,
      });
      const seen: Array<[string, string]> = [];
      const usage = service(db).usageForRun('task_1', (provider, model) => {
        seen.push([provider, model]);
        return 200_000;
      });
      expect(seen).toEqual([['anthropic', 'claude-sonnet']]);
      expect(usage?.contextWindow).toBe(200_000);
    } finally {
      closeDatabase(db);
    }
  });

  it('returns null hit rate when no prompt tokens were recorded, and null window when unknown', () => {
    const db = openMainDb();
    try {
      insertRow(db, { runId: 'task_1', input: 0, output: 42, createdAt: 10 });

      const usage = service(db).usageForRun('task_1', () => 0);
      expect(usage).toMatchObject({
        calls: 1,
        contextTokens: 0,
        contextWindow: null,
        cacheHitRate: null,
      });
    } finally {
      closeDatabase(db);
    }
  });

  it('returns null for an unknown task id', () => {
    const db = openMainDb();
    try {
      expect(service(db).usageForRun('task_missing')).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

describe('UsageService tool usage', () => {
  function toolService(db: SqliteDatabase, now: () => number): UsageService {
    return new UsageService(db, { now });
  }

  it('aggregates per-tool content estimates, filtering by time and task loop', () => {
    const db = openMainDb();
    try {
      let now = 1_000;
      const usage = toolService(db, () => now);
      const base = {
        runId: 'task_1',
        botId: 'bot_a',
        conversationId: 'conv_a',
        loopType: 'task' as const,
      };
      usage.recordTool({ ...base, toolName: 'read', callTokens: 10, resultTokens: 100 });
      now = 2_000;
      usage.recordTool({ ...base, toolName: 'read', callTokens: 20, resultTokens: 200 });
      usage.recordTool({ ...base, toolName: 'bash', callTokens: 5, resultTokens: 50 });
      // 其他 loop 即使被写进来，也不能出现在「按工具」页签里。
      usage.recordTool({
        ...base,
        loopType: 'turn',
        toolName: 'read',
        callTokens: 999,
        resultTokens: 999,
      });

      expect(usage.toolTotals(0)).toEqual([
        { toolName: 'read', resultTokens: 300, callTokens: 30, tokens: 330, calls: 2 },
        { toolName: 'bash', resultTokens: 50, callTokens: 5, tokens: 55, calls: 1 },
      ]);
      // 只算 2_000 之后的调用。
      expect(usage.toolTotals(1_500)).toEqual([
        { toolName: 'read', resultTokens: 200, callTokens: 20, tokens: 220, calls: 1 },
        { toolName: 'bash', resultTokens: 50, callTokens: 5, tokens: 55, calls: 1 },
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('clamps negative tokens and never records zero calls', () => {
    const db = openMainDb();
    try {
      const usage = toolService(db, () => 1_000);
      usage.recordTool({
        runId: 'task_1',
        botId: null,
        conversationId: null,
        loopType: 'task',
        toolName: 'glob',
        callTokens: -5,
        resultTokens: -10,
        calls: 0,
      });
      expect(usage.toolTotals(0)).toEqual([
        { toolName: 'glob', resultTokens: 0, callTokens: 0, tokens: 0, calls: 1 },
      ]);
    } finally {
      closeDatabase(db);
    }
  });
});
