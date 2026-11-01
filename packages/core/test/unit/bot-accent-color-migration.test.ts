import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';

/**
 * 0064_bot_accent_color: `bots.accent_color`（Bot 强调色，色板 id 文本）。
 * 列必须可空且无默认值——旧行保持 NULL，读侧（`BotsService` 的 rowToBot）把它读成
 * 「未显式设置」，渲染端再回退到 `preset:{shape}:{color}` 的内嵌色 / mono，外观与
 * 迁移前一致（不做破坏性回填）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'bot-accent-color-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 12), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

describe('0064 bot accent color migration', () => {
  it('adds a nullable accent_color column and leaves existing rows on NULL', () => {
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
      ).find((entry) => entry.name === 'accent_color');
      expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });

      // 没有写 accent_color 的行（旧数据形状）读回 NULL。
      db.prepare(
        "insert into bots (id, name, avatar, bio, profile_json, status, created_at, updated_at) values (?, ?, ?, '', '{}', 'active', 1, 1)",
      ).run('bot_legacy', '旧 Bot', 'preset:orb:orange');
      expect(db.prepare('select accent_color from bots where id = ?').get('bot_legacy')).toEqual({
        accent_color: null,
      });
    } finally {
      closeDatabase(db);
    }
  });
});
