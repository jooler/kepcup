import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';

/**
 * 0061_bot_avatar_padding: `bots.avatar_padding`（上传头像内边距，像素 0-16）。
 * 列必须可空且无默认值——旧行保持 NULL，读侧（`BotsService` 的 rowToBot）归一为
 * 0，默认行为与迁移前一致（不内缩）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'bot-avatar-padding-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 11), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

describe('0061 bot avatar padding migration', () => {
  it('adds a nullable avatar_padding column and leaves existing rows on NULL', () => {
    const db = openMainDb();
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(
        migrationTargetVersion(migrationsUrl('main')),
      );
      const column = (
        db.prepare('pragma table_info(bots)').all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((entry) => entry.name === 'avatar_padding');
      expect(column).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });

      // 没有写 avatar_padding 的行（旧数据形状）读回 NULL。
      db.prepare(
        "insert into bots (id, name, avatar, bio, profile_json, status, created_at, updated_at) values (?, ?, NULL, '', '{}', 'active', 1, 1)",
      ).run('bot_legacy', '旧 Bot');
      expect(db.prepare('select avatar_padding from bots where id = ?').get('bot_legacy')).toEqual({
        avatar_padding: null,
      });
    } finally {
      closeDatabase(db);
    }
  });
});
