import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main 0022_schedule_title_origin（D80，todo/schedule-nudges.md §3.1）：
 * schedules 加 title / origin；旧行 title 为空串，带 commitment_id 的回填
 * origin='commitment'，其余 'tool'；origin 受 CHECK 约束。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'schedule-title-origin-migration-'));
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

describe('main 0022 schedules title / origin', () => {
  it('backfills origin from commitment_id and constrains new values', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(21));
    db.prepare(
      "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_1', 'a', '{}', 'active', 0, 0)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_1', 'direct', 'bot_1', 0, 0)",
    ).run();
    const insert = db.prepare(
      "insert into schedules (id, bot_id, conversation_id, kind, run_at, cron, timezone, note, commitment_id, status, next_fire_at, last_fired_at, created_at) values (?, 'bot_1', 'conv_1', 'once', 1, null, 'UTC', 'n', ?, 'active', 1, null, 0)",
    );
    insert.run('sch_tool', null);
    insert.run('sch_commit', 'mem_1');

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(22);

    const rows = db.prepare('select id, title, origin from schedules order by id').all();
    expect(rows).toEqual([
      { id: 'sch_commit', title: '', origin: 'commitment' },
      { id: 'sch_tool', title: '', origin: 'tool' },
    ]);
    expect(() =>
      db.prepare("update schedules set origin = 'bogus' where id = 'sch_tool'").run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
