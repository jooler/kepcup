import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  backupBeforeMigration,
  backupDatabase,
  backupFileName,
  listBackups,
  pruneBackups,
  restoreDatabaseBackup,
} from '../../src/infra/backup.js';
import { closeDatabase, openDatabase } from '../../src/infra/db.js';
import { deriveKey, generateMasterKey } from '../../src/infra/crypto.js';

/**
 * Pre-migration backup mechanics (P13 任务 5). The full startup integration
 * (failed migration → automatic restore) lives in
 * test/integration/migration-rollback.test.ts.
 */
describe('migration backup (infra/backup)', () => {
  let home: string;
  let backupsDir: string;
  let dbPath: string;
  let masterKey: Buffer;
  let mainDb: ReturnType<typeof openDatabase>;
  let mainDbClosed = false;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kepcup-backup-'));
    backupsDir = path.join(home, 'backups');
    dbPath = path.join(home, 'main.db');
    masterKey = generateMasterKey();
    mainDb = openDatabase({ path: dbPath, key: deriveKey(masterKey, 'db:main') });
    mainDbClosed = false;
    mainDb.exec('create table settings (key text primary key, value_json text not null)');
  });

  afterEach(() => {
    if (!mainDbClosed) closeDatabase(mainDb);
    return rm(home, { recursive: true, force: true });
  });

  it('backupFileName sorts lexically by epoch and round-trips the version', () => {
    const a = backupFileName('main.db', 2, 1_000);
    const b = backupFileName('main.db', 2, 2_000);
    expect(a).toBe('main.db.v2.1000.bak');
    expect(a < b).toBe(true);
  });

  it('does not back up when the database is already at the target version', async () => {
    const record = await backupBeforeMigration(mainDb, {
      dbPath,
      backupsDir,
      currentVersion: 11,
      targetVersion: 11,
      nowMs: 1_000,
    });
    expect(record).toBeNull();
    expect(existsSync(backupsDir)).toBe(false);
  });

  it('backs up before a pending migration and keeps the record', async () => {
    const record = await backupBeforeMigration(mainDb, {
      dbPath,
      backupsDir,
      currentVersion: 11,
      targetVersion: 12,
      nowMs: 1_000,
    });
    expect(record).not.toBeNull();
    expect(record!.fromVersion).toBe(11);
    expect(listBackups(backupsDir, 'main.db')).toHaveLength(1);
  });

  it('prunes to the newest 3 backups (P13 任务 5: 保留最近 3 份)', async () => {
    for (let version = 0; version < 5; version++) {
      await backupBeforeMigration(mainDb, {
        dbPath,
        backupsDir,
        currentVersion: version,
        targetVersion: version + 1,
        nowMs: 1_000 + version,
      });
      // Simulate the version advancing between boots (each backup needs a
      // distinct current version; the db itself is reused).
    }
    const backups = listBackups(backupsDir, 'main.db');
    expect(backups).toHaveLength(3);
    // The oldest two (v0, v1) are gone.
    expect(backups.some((name) => name.includes('.v0.'))).toBe(false);
    expect(backups.some((name) => name.includes('.v1.'))).toBe(false);
    expect(backups.some((name) => name.includes('.v2.'))).toBe(true);
  });

  it('pruneBackups ignores files that do not match the backup naming scheme', async () => {
    mkdirSync(backupsDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(backupsDir, backupFileName('main.db', i, 1_000 + i)), 'x');
    }
    writeFileSync(path.join(backupsDir, 'main.db-wal'), 'x');
    writeFileSync(path.join(backupsDir, 'notes.txt'), 'x');
    expect(pruneBackups(backupsDir, 'main.db', 3)).toBe(2);
    expect(listBackups(backupsDir, 'main.db')).toHaveLength(3);
    // Unrelated files are never touched.
    expect(existsSync(path.join(backupsDir, 'notes.txt'))).toBe(true);
  });

  it('restore puts back the exact pre-migration bytes (WAL sidecars removed)', async () => {
    mainDb.exec("insert into settings (key, value_json) values ('app', '{}')");
    const record = await backupBeforeMigration(mainDb, {
      dbPath,
      backupsDir,
      currentVersion: 11,
      targetVersion: 12,
      nowMs: 1_000,
    });
    expect(record).not.toBeNull();
    // "Failed migration" wrote something after the backup was taken.
    mainDb.exec("insert into settings (key, value_json) values ('extra', '{\"mutated\":true}')");
    closeDatabase(mainDb);
    mainDbClosed = true;
    restoreDatabaseBackup({ dbPath, backupPath: record!.path });
    expect(existsSync(dbPath + '-wal')).toBe(false);
    // The restored file decrypts with the SAME key and holds the pre-migration
    // state only (the post-backup mutation is gone).
    const restored = openDatabase({ path: dbPath, key: deriveKey(masterKey, 'db:main') });
    const rows = restored
      .prepare('select value_json from settings')
      .all() as Array<{ value_json: string }>;
    expect(rows).toEqual([{ value_json: '{}' }]);
    closeDatabase(restored);
  });

  it('refuses the byte copy while the WAL checkpoint is busy (BR-P13-008)', () => {
    closeDatabase(mainDb);
    mainDbClosed = true;
    // 1ms busy timeout：busy 探测立即返回（避免默认 5s 重试拖慢测试）。
    const fast = openDatabase({ path: dbPath, key: deriveKey(masterKey, 'db:main'), busyTimeoutMs: 1 });
    const reader = openDatabase({ path: dbPath, key: deriveKey(masterKey, 'db:main'), busyTimeoutMs: 1 });
    const destination = path.join(home, 'inconsistent.bak');
    try {
      // reader 先持有读快照，写入随后追加 WAL 帧——TRUNCATE checkpoint
      // 因此拿不到独占（确定的 busy，而非时序运气）。
      reader.exec('begin');
      reader.prepare('select count(*) from settings').get();
      fast.exec("insert into settings (key, value_json) values ('busy', '{}')");
      expect(() => backupDatabase(fast, dbPath, destination)).toThrow(/busy/);
      // busy 时如实报错，绝不继续字节拷贝。
      expect(existsSync(destination)).toBe(false);

      // 排空读事务后同一路径恢复可用（happy path 回归）。
      reader.exec('commit');
      backupDatabase(fast, dbPath, destination);
      expect(existsSync(destination)).toBe(true);
    } finally {
      // reader close() does not run our explicit TRUNCATE checkpoint (which
      // can still see the other connection's state mid-teardown).
      reader.close();
      closeDatabase(fast);
    }
  });
});
