import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

/** 0072_composer_drafts：共享草稿表随迁移创建，版本号推进到目标。 */

const dir = mkdtempSync(path.join(tmpdir(), 'composer-drafts-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('0072 composer_drafts migration', () => {
  it('creates the table and advances the schema version', () => {
    const db = openDatabase({
      path: path.join(dir, 'main.db'),
      key: deriveKey(Buffer.alloc(32, 31), KEY_INFO.mainDb),
    });
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toContain(72);
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );
    expect(
      db
        .prepare("select name from sqlite_master where type = 'table' and name = 'composer_drafts'")
        .get(),
    ).toEqual({ name: 'composer_drafts' });
    const columns = db.prepare('pragma table_info(composer_drafts)').all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      'conversation_id',
      'doc_json',
      'mentions_json',
      'reply_to',
      'attachments_json',
      'version',
      'updated_at',
    ]);
    expect(columns.find((column) => column.name === 'version')).toMatchObject({
      dflt_value: '0',
      notnull: 1,
    });
    const foreignKeys = db.prepare('pragma foreign_key_list(composer_drafts)').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(foreignKeys[0]).toMatchObject({
      table: 'conversations',
      from: 'conversation_id',
      to: 'id',
      on_delete: 'CASCADE',
    });
    db.close();
  });
});
