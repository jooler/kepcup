import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { AuditService } from '../../src/domain/audit.js';

/**
 * 污点外发汇总（D73 P2）的读取与关闭：`egressTainted` 只数本 Bot 的 `egress_tainted` 行
 * （`approved: false` 单独计入 refused）；`clearEgressTainted`（用户关闭汇总 =
 * `apps.egressClear`）删除该 Bot 的这些行——其他 Bot、其他 action 不受影响，汇总归零。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): { db: SqliteDatabase; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-egress-'));
  dirs.push(dir);
  const db = openDatabase({
    path: path.join(dir, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return { db, dir };
}

function insertAudit(
  db: SqliteDatabase,
  id: string,
  botId: string | null,
  action: string,
  approved: boolean,
): void {
  db.prepare(
    'insert into audit_log (id, run_id, bot_id, conversation_id, action, detail_json, created_at) values (?, null, ?, null, ?, ?, ?)',
  ).run(id, botId, action, JSON.stringify({ approved, channel: 'web_fetch', target: 't' }), 1);
}

describe('AuditService 污点外发汇总与关闭', () => {
  it('egressTainted 统计放行 / 拒绝并只看本 Bot；clearEgressTainted 删除该 Bot 的 egress 行', () => {
    const { db } = openMainDb();
    const audit = new AuditService({ db, clock: { now: () => 1 } });
    insertAudit(db, 'aud_1', 'bot_a', 'egress_tainted', true);
    insertAudit(db, 'aud_2', 'bot_a', 'egress_tainted', false);
    insertAudit(db, 'aud_3', 'bot_a', 'egress_tainted', true);
    insertAudit(db, 'aud_4', 'bot_b', 'egress_tainted', true);
    insertAudit(db, 'aud_5', 'bot_a', 'fs_write', true);

    expect(audit.egressTainted('bot_a')).toMatchObject({ total: 2, refused: 1 });

    // 关闭汇总：只删本 Bot 的 egress 行，其他 Bot / 其他 action 保留。
    expect(audit.clearEgressTainted('bot_a')).toBe(3);
    expect(audit.egressTainted('bot_a')).toMatchObject({ total: 0, refused: 0 });
    expect(audit.egressTainted('bot_b').total).toBe(1);
    expect(
      db.prepare("select count(*) as n from audit_log where action = 'fs_write'").get(),
    ).toEqual({ n: 1 });
    // 再关一次没有可删的。
    expect(audit.clearEgressTainted('bot_a')).toBe(0);
    closeDatabase(db);
  });
});
