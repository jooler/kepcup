import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * 0013_public_skills 升级路径：此前按 Bot 安装的预置技能（skill_library.
 * source_url = preset://... 的 bot_skills 行）整体转为公共技能；非预置来源的
 * 私有行不动。真实迁移目录 + user_version 回拨模拟旧库。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'public-skills-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  return db;
}

describe('0013 public_skills 迁移', () => {
  it('preset:// 的 bot_skills 行转为公共技能，私有行保留', () => {
    const db = openMainDb();
    // 1) 全量迁移到最新，再回拨到 0013 之前的形态（0013 之前也不存在 0014
    //    的 conversations 新列，一并摘除才能原样重放）
    runMigrations(db, migrationsUrl('main'));
    db.exec('drop table public_skills;');
    db.exec('alter table conversations drop column description;');
    db.exec('alter table conversations drop column setup_state;');
    // 0016（管家与委派）的新增物同样摘除，回放时才能原样重建。
    db.exec('drop table delegations;');
    db.exec('drop index bots_one_active_butler;');
    db.exec('alter table bots drop column system_role;');
    // 0017（外部智能体）的新表同样摘除（approvals 重建可原样重放）。
    db.exec('drop table agent_sessions;');
    // 0022（D80）的 schedules 新列同样摘除。
    db.exec('alter table schedules drop column title;');
    db.exec('alter table schedules drop column origin;');
    // main 0023（W7）的 watches 表同样摘除。
    db.exec('drop table watches;');
    db.exec(
      `insert into skill_library (id, name, source_url, commit_oid, content_hash, rel_path, scan_json, imported_at)
       values ('skl_preset', 'docx', 'preset://docx', '1.0.0', 'hashpreset', 'skills-library/docx@hashpreset', '{}', 1),
              ('skl_private', 'docx', 'https://example.com/docx.git', '${'a'.repeat(40)}', 'hashprivate', 'skills-library/docx@hashprivate', '{}', 2);`,
    );
    db.exec(
      `insert into bot_skills (bot_id, name, kind, library_id, status, status_reason, created_at, updated_at) values
         ('bot_a', 'docx', 'imported', 'skl_preset', 'active', null, 10, 10),
         ('bot_b', 'docx', 'imported', 'skl_preset', 'active', null, 11, 11),
         ('bot_a', 'deploy', 'imported', 'skl_private', 'active', null, 12, 12);`,
    );
    db.pragma('user_version = 12');

    // 2) 升级：应用 0013 与其后新增的迁移
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

    // 3) 断言：预置引用 → 一条公共行；bot_skills 的预置行清掉，私有行保留
    const pub = db.prepare('select name, library_id, status from public_skills').all() as Array<{
      name: string;
      library_id: string;
      status: string;
    }>;
    expect(pub).toEqual([{ name: 'docx', library_id: 'skl_preset', status: 'active' }]);
    const botRows = db
      .prepare('select bot_id, name, library_id from bot_skills order by bot_id, name')
      .all() as Array<{ bot_id: string; name: string; library_id: string }>;
    expect(botRows).toEqual([{ bot_id: 'bot_a', name: 'deploy', library_id: 'skl_private' }]);
    // 库条目都还在（引用计数由运行时 GC 负责，迁移不删内容）
    const libs = db.prepare('select count(*) as n from skill_library').get() as { n: number };
    expect(libs.n).toBe(2);
    closeDatabase(db);
  });

  it('全新库直接迁移：public_skills 表存在且为空', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const rows = db.prepare('select count(*) as n from public_skills').get() as { n: number };
    expect(rows.n).toBe(0);
    closeDatabase(db);
  });
});
