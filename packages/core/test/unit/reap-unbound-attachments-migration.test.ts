import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

/**
 * 0033_reap_unbound_attachments：只删创建超过 7 天且仍未绑定消息的附件行；
 * 未过期的上传（输入框 chip）与已绑定消息的附件原样保留。
 * 直接执行该迁移的 SQL（不依赖相邻迁移编号是否连续）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'reap-attachments-migration-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('main');
  const target = mkdtempSync(path.join(dir, 'migrations-'));
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

describe('0033 reap_unbound_attachments', () => {
  it('删除过期未绑定附件行；新近上传与已绑定消息的附件保留', () => {
    const db = openDatabase({
      path: path.join(dir, 'main.db'),
      key: deriveKey(Buffer.alloc(32, 3), KEY_INFO.mainDb),
    });
    runMigrations(db, migrationsUpTo(31));
    db.prepare(
      "insert into conversations (id, type, created_at) values ('conv_1', 'group', 1)",
    ).run();
    db.pragma('foreign_keys = OFF');
    const now = Date.now();
    const insert = db.prepare(
      "insert into attachments (id, conversation_id, message_id, file_name, mime, size, sha256, rel_path, created_at) values (?, 'conv_1', ?, 'f', 'text/plain', 1, 'x', ?, ?)",
    );
    insert.run('att_old_unbound', null, 'att_old_unbound_f', now - 8 * DAY);
    insert.run('att_new_unbound', null, 'att_new_unbound_f', now - 6 * DAY);
    insert.run('att_old_bound', 'msg_1', 'att_old_bound_f', now - 400 * DAY);

    const sql = readFileSync(
      path.join(migrationsUrl('main'), '0033_reap_unbound_attachments.sql'),
      'utf8',
    );
    db.exec(sql);

    const ids = (
      db.prepare('select id from attachments order by id').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(ids).toEqual(['att_new_unbound', 'att_old_bound']);
  });
});
