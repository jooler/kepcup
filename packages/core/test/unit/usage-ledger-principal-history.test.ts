import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { ConversationsService } from '../../src/domain/conversations.js';
import { UsageService } from '../../src/domain/usage.js';

/**
 * T9 只读缝（62.03 D137）：`ConversationsService.principalHistory`（含离开行的
 * 全量名册历史）与 `UsageService.ledgerSince`（rowid 游标分批账行读取）。纯
 * SELECT——不调用 = 与从前完全一致（休眠已有测试背书）；空库行为、按窗口
 * 取在册名单、游标推进语义在这里冻结。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'usage-ledger-principal-history-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock: Clock = { now: () => ++now };

let db: SqliteDatabase;
let conversations: ConversationsService;
let usage: UsageService;

beforeEach(() => {
  db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 21), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  conversations = new ConversationsService(db, clock);
  usage = new UsageService(db, clock);
});

describe('ConversationsService.principalHistory', () => {
  it('空会话 / 未知会话返回空数组（纯读，无写入）', () => {
    db.prepare(
      "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_a', '甲', '{}', 'active', 0, 0)",
    ).run();
    const { conversation } = conversations.openDirect('bot_a');
    expect(conversations.principalHistory(conversation.id)).toEqual([]);
    expect(conversations.principalHistory('conv_missing')).toEqual([]);
  });

  it('返回全部行（含 left_at 非空的离开行），按 joined_at 排序，leftAt 可空', () => {
    const { conversation } = conversations.openDm(['p_alice', 'p_bob']);
    // p_alice 在 1001 加入；p_bob 在 1002 加入（clock 递增）。
    db.prepare('update conversation_principals set left_at = ? where principal_id = ?').run(5_000, 'p_alice');
    const history = conversations.principalHistory(conversation.id);
    expect(history.map((row) => [row.principalId, row.leftAt])).toEqual([
      ['p_alice', 5_000],
      ['p_bob', null],
    ]);
    expect(history.every((row) => row.conversationId === conversation.id)).toBe(true);
    // 在册读口不受影响（仍只返回未离开行）。
    expect(conversations.principals(conversation.id).map((row) => row.principalId)).toEqual(['p_bob']);
  });
});

describe('UsageService.ledgerSince', () => {
  function record(conversationId: string | null, costUsd: number): void {
    usage.record({
      runId: 'run_1',
      botId: 'bot_a',
      conversationId,
      loopType: 'turn',
      provider: 'mock',
      model: 'mock-main',
      inputTokens: 10,
      outputTokens: 20,
      costUsd,
    });
  }

  it('空库：rowid 0 之后无行（空数组）', () => {
    expect(usage.ledgerSince(0, 100)).toEqual([]);
  });

  it('按 rowid 升序增量读取；游标推进后不重不漏；limit 分批', () => {
    record('conv_1', 0.1);
    record('conv_1', 0.2);
    record(null, 0.3); // 无会话行（principal 归属形态）

    const first = usage.ledgerSince(0, 2);
    expect(first).toHaveLength(2);
    expect(first[0]!.rowid).toBeLessThan(first[1]!.rowid);
    expect(first[0]!.costUsd).toBeCloseTo(0.1, 6);
    expect(first[0]!.conversationId).toBe('conv_1');
    expect(first[0]!.principalId).toBeNull(); // 显式无归属 → NULL（单用户形态）
    expect(first[0]!.botId).toBe('bot_a');
    expect(first[0]!.inputTokens).toBe(10);
    expect(first[0]!.outputTokens).toBe(20);
    expect(first[0]!.loopType).toBe('turn');
    expect(typeof first[0]!.createdAt).toBe('number');

    const second = usage.ledgerSince(first[1]!.rowid, 2);
    expect(second).toHaveLength(1);
    expect(second[0]!.costUsd).toBeCloseTo(0.3, 6);
    expect(second[0]!.conversationId).toBeNull();
  });

  it('新增账行对已消费游标可见（增量语义），不影响更早行', () => {
    record('conv_1', 1);
    const first = usage.ledgerSince(0, 10);
    expect(first).toHaveLength(1);
    const cursor = first[0]!.rowid;
    record('conv_1', 2);
    expect(usage.ledgerSince(cursor, 10)).toHaveLength(1);
    expect(usage.ledgerSince(cursor, 10)[0]!.costUsd).toBeCloseTo(2, 6);
    expect(usage.ledgerSince(0, 10)).toHaveLength(2);
  });
});
