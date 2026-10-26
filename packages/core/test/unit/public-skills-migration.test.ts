import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

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
    // 0040 重建了 conversations（goal / lead_bot_id、删 description / setup_state）：
    // 回退到 0002 的原始形态（project_id 也在其中），FK 关闭下重建，回放时才能原样重放。
    db.pragma('foreign_keys = OFF');
    db.exec(`create table conversations_old (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      title             TEXT,
      direct_bot_id     TEXT REFERENCES bots(id),
      project_id        TEXT,
      read_only         INTEGER NOT NULL DEFAULT 0,
      summary           TEXT,
      summary_upto_seq  INTEGER NOT NULL DEFAULT 0,
      last_seq          INTEGER NOT NULL DEFAULT 0,
      last_read_seq     INTEGER NOT NULL DEFAULT 0,
      last_message_at   INTEGER,
      created_at        INTEGER NOT NULL
    );`);
    db.exec(
      `insert into conversations_old
         (id, type, title, direct_bot_id, project_id, read_only, summary, summary_upto_seq,
          last_seq, last_read_seq, last_message_at, created_at)
       select id, type, title, direct_bot_id, workdir_id, read_only, summary, summary_upto_seq,
              last_seq, last_read_seq, last_message_at, created_at
         from conversations;`,
    );
    db.exec('drop table conversations;');
    db.exec('alter table conversations_old rename to conversations;');
    db.exec(
      "create unique index conversations_one_direct_per_bot on conversations(direct_bot_id) where type = 'direct' and read_only = 0;",
    );
    db.pragma('foreign_keys = ON');
    // 0016（管家与委派）的新增物同样摘除，回放时才能原样重建。
    db.exec('drop table delegations;');
    db.exec('drop index bots_one_active_butler;');
    db.exec('alter table bots drop column system_role;');
    // 0017（外部智能体）的新表同样摘除（approvals 重建可原样重放）。
    db.exec('drop table agent_sessions;');
    // 0024（连接应用）的新表同样摘除（纯新增，回放时重建）。
    // 0025（应用工具）的新表先摘除（外键指向 app_connections）。
    db.exec('drop table app_tool_grants;');
    db.exec('drop table app_connection_tools;');
    db.exec('drop table app_connections;');
    db.exec('drop table oauth_clients;');
    // 0022（D80）的 schedules 新列与 0037（D90 工作台）的重建同样回退：schedules 还原成
    // 0011 的形态（0037 的 todo_id 外键列不能直接 drop column），再摘掉工作台三表。
    db.exec(`create table schedules_old (
      id              TEXT PRIMARY KEY,
      bot_id          TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('once', 'cron')),
      run_at          INTEGER,
      cron            TEXT,
      timezone        TEXT NOT NULL,
      note            TEXT NOT NULL,
      commitment_id   TEXT,
      status          TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')),
      next_fire_at    INTEGER,
      last_fired_at   INTEGER,
      created_at      INTEGER NOT NULL
    );`);
    db.exec(
      `insert into schedules_old select id, bot_id, conversation_id, kind, run_at, cron, timezone,
         note, commitment_id, status, next_fire_at, last_fired_at, created_at from schedules;`,
    );
    db.exec('drop table schedules;');
    db.exec('alter table schedules_old rename to schedules;');
    db.exec('create index schedules_next on schedules(status, next_fire_at);');
    // main 0050（看板）的新表同样摘除（先卡片侧表再分栏；纯新增，回放时重建）。
    // board_cards 外键指向 todos，必须先于 todos 摘除。
    db.exec('drop table board_cards;');
    db.exec('drop table board_columns;');
    db.exec('drop table todo_runs;');
    db.exec('drop table todos;');
    db.exec('drop table memos;');
    // main 0023（W7）的 watches 表同样摘除。
    db.exec('drop table watches;');
    // main 0024（辅助阅读便签）的 stickies 表同样摘除。
    db.exec('drop table stickies;');
    // main 0026（D73 P2 污点外发）的 app_taint 表同样摘除（approvals 重建可原样重放）。
    db.exec('drop table app_taint;');
    // main 0043（污点外发的对话级放行）同样摘除（纯新增，回放时重建）。
    db.exec('drop table egress_allows;');
    // main 0044（git 远程持续授权）同样摘除（纯新增，回放时重建）。
    db.exec('drop table git_remote_grants;');
    // main 0047（D94 分享接收）的新表同样摘除（纯新增，回放时重建）。
    db.exec('drop table share_intakes;');
    // main 0049（D96 远程遥控）的新表同样摘除（纯新增，回放时重建；索引随表走）。
    db.exec('drop table remote_devices;');
    // main 0028（D81 bot widgets）的三表与 0029（P2 查询模板）同样摘除（先子后父）。
    db.exec('drop table widget_queries;');
    db.exec('drop table widget_docs;');
    db.exec('drop table widget_versions;');
    db.exec('drop table widgets;');
    // main 0031（D84 邮件）的新表同样摘除，回放时才能重建。
    db.exec('drop table mail_account_bots;');
    db.exec('drop table mail_accounts;');
    // main 0036（D88 资产移交）的两张表同样摘除（先子后父）。
    db.exec('drop table bot_handover_items;');
    db.exec('drop table bot_handovers;');
    // main 0038（D92 T0-2）的改名同样回退，回放时才能原样重放。
    db.exec('alter table workdirs rename to projects;');
    // conversations 的 project_id 已在上面的回退重建中恢复；这里只回退 run_changes。
    db.exec('alter table run_changes rename column workdir_id to project_id;');
    // main 0041（D92 T1a WP2）DROP 掉 chains 换成 episodes：与其它新表相反，
    // 回放要求 chains 以 0006 的原形态**存在**、episodes **不存在**——首轮全量
    // 已经把 chains 删掉、把 episodes 建了出来，这里恢复 / 摘除。
    db.exec('drop table episodes;');
    db.exec(`create table chains (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      root_batch_id   TEXT NOT NULL,
      max_depth_seen  INTEGER NOT NULL,
      tokens_used     INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );`);
    db.exec('create index chains_by_conversation on chains(conversation_id);');
    // main 0030（直发，无待发送队列）已删掉 drafts 表与 attachments.draft_id，
    // 而 0018 的 attachments 重建按列名引用 draft_id——按 0002 的原始形态补回，
    // 才能原样重放 0013 之后的迁移。
    db.exec(`create table drafts (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      text             TEXT NOT NULL,
      mentions_json    TEXT NOT NULL DEFAULT '[]',
      reply_to         TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );`);
    db.exec('alter table attachments add column draft_id TEXT;');
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
    expect(applied.map((m) => m.version)).toEqual(mainVersionsAfter(12));

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
