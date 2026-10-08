import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loopTypeSchema } from '@kepcup/shared';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { UsageService } from '../../src/domain/usage.js';
import { BudgetService } from '../../src/usage/budget.js';
import type { SettingsService } from '../../src/domain/settings.js';

/**
 * main 0020_usage_turn_loop_type（D75 W2 审查 H1）：usage_ledger 里 D75 之前的
 * 'response' 行改为 'turn'——usage.summary 的输出能过 loopTypeSchema，且每日
 * 后台预算不再把它们算作后台用量。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'usage-turn-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
}

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('main');
  const target = mkdtempSync(path.join(dir, 'migrations-'));
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

describe('main 0020 usage_ledger loop_type response → turn', () => {
  it('rewrites the pre-D75 response rows; summary validates and the budget skips them', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(19));
    const now = Date.now();
    const insert = db.prepare(
      'insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model, input_tokens, output_tokens, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('use_1', 'run_1', 'bot_a', 'conv_a', 'response', 'custom:mock', 'm', 100, 50, now);
    insert.run('use_2', 'run_2', 'bot_a', 'conv_a', 'reflection', 'custom:mock', 'm', 7, 3, now);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(20);

    const rows = db.prepare('select id, loop_type from usage_ledger order by id').all();
    expect(rows).toEqual([
      { id: 'use_1', loop_type: 'turn' },
      { id: 'use_2', loop_type: 'reflection' },
    ]);
    const summary = new UsageService(db, { now: () => now }).entriesSince(0);
    for (const entry of summary) expect(loopTypeSchema.safeParse(entry.loopType).success).toBe(true);

    const budget = new BudgetService({
      db,
      settings: { get: () => ({ backgroundBudgetTokens: 1_000 }) } as unknown as SettingsService,
      clock: { now: () => now },
      timeZone: 'UTC',
    });
    // Only the reflection row is background usage.
    expect(budget.usedToday('bot_a')).toBe(10);
    closeDatabase(db);
  });
});
