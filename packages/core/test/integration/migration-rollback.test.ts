import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, createMemoryKeystore, type CoreHarness } from '@kepcup/core';
import { closeDatabase, openDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { listBackups } from '../../src/infra/backup.js';
import { readUserVersion } from '../../src/infra/migrate.js';

/**
 * P13 任务 5 (docs/dev/phases/P13-release.md 迁移与备份): a failing data
 * migration at startup must restore the automatic pre-migration backup of
 * main.db and surface a structured error — the user's data stays exactly as
 * it was before the upgrade attempt. The backup must be taken BEFORE any
 * migration step runs.
 */

const homes: string[] = [];
const cores: CoreHarness[] = [];

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** Real migration files plus a broken next-version file (duplicate CREATE TABLE). */
function brokenMigrationsDir(home: string): string {
  const sourceDir = new URL('../../migrations/main/', import.meta.url).pathname;
  const dir = path.join(home, 'migrations-bad');
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(sourceDir).filter((name) => /^\d{4}_.*\.sql$/.test(name));
  for (const name of names) copyFileSync(path.join(sourceDir, name), path.join(dir, name));
  // settings already exists at 0001 — this statement fails mid-migration,
  // AFTER the backup has been taken (broken version > stored version).
  // The broken file always takes the version AFTER the highest real one,
  // so adding real migrations doesn't collide with this fixture.
  const next = String(Math.max(...names.map((name) => Number(name.slice(0, 4)))) + 1).padStart(
    4,
    '0',
  );
  copyFileSync(path.join(sourceDir, '0001_settings.sql'), path.join(dir, `${next}_p13_bad.sql`));
  return dir;
}

describe('pre-migration backup and rollback (P13 任务 5)', () => {
  it('a broken new migration fails the boot, restores the backup and keeps data intact', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-migr-'));
    homes.push(home);
    const keystore = createMemoryKeystore();

    // Boot 1: full migration to the current version, then write a marker row
    // (launchAtLogin also proves the new P13 settings key round-trips).
    const first = await createCore({ home, keystore });
    expect(first.services.status).toBe('ready');
    await first.rpc.call('settings.update', { launchAtLogin: false });
    const mainDbVersion = readUserVersion(first.services.mainDb!);
    expect(mainDbVersion).toBeGreaterThanOrEqual(11);
    await first.close();

    // Boot 2: a broken migration file arrives with the "new version" —
    // the backup is taken first, the migration fails, the backup is restored.
    const badDir = brokenMigrationsDir(home);
    const second = await createCore({ home, keystore, migrationsDirs: { main: badDir } });
    cores.push(second);
    expect(second.services.status).toBe('error');
    expect(second.services.statusReason).toContain('数据迁移失败');
    expect(second.services.statusReason).toContain('已恢复');

    // Exactly one backup, named for the version it was taken from.
    const backups = listBackups(path.join(home, 'backups'), 'main.db');
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain(`v${mainDbVersion}.`);

    // The on-disk database is the restored pre-migration file: same version,
    // marker row intact, decryptable with the same key.
    const masterKey = Buffer.from(keystore.getSecret()!, 'base64');
    const restored = openDatabase({
      path: path.join(home, 'main.db'),
      key: deriveKey(masterKey, KEY_INFO.mainDb),
    });
    try {
      expect(readUserVersion(restored)).toBe(mainDbVersion);
      const row = restored.prepare("select value_json from settings where key = 'app'").get() as {
        value_json: string;
      };
      expect(JSON.parse(row.value_json).launchAtLogin).toBe(false);
    } finally {
      closeDatabase(restored);
    }

    // Boot 3 with the real migrations: the restored database boots clean, and
    // an equal version takes NO additional backup.
    const third = await createCore({ home, keystore });
    cores.push(third);
    expect(third.services.status).toBe('ready');
    expect(listBackups(path.join(home, 'backups'), 'main.db')).toHaveLength(1);
  });

  it('a stale user_version (schema ahead of the marker) recovers via backup+restore too', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-migr2-'));
    homes.push(home);
    const keystore = createMemoryKeystore();

    const first = await createCore({ home, keystore });
    expect(first.services.status).toBe('ready');
    await first.close();

    // Corrupt the version marker backwards: re-running real migrations hits
    // "table already exists" — the same restore path as a broken new file.
    const masterKey = Buffer.from(keystore.getSecret()!, 'base64');
    const db = openDatabase({
      path: path.join(home, 'main.db'),
      key: deriveKey(masterKey, KEY_INFO.mainDb),
    });
    db.pragma('user_version = 2');
    closeDatabase(db);
    // (first was already closed above; afterEach only closes `second`.)

    const second = await createCore({ home, keystore });
    cores.push(second);
    expect(second.services.status).toBe('error');
    expect(second.services.statusReason).toContain('已恢复');
    const backups = listBackups(path.join(home, 'backups'), 'main.db');
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain('.v2.');
    expect(existsSync(path.join(home, 'main.db-wal'))).toBe(false);
  });

  it('when the automatic restore ALSO fails, the reason says so (BR-P13-007)', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kepcup-migr3-'));
    homes.push(home);
    const keystore = createMemoryKeystore();

    const first = await createCore({ home, keystore });
    expect(first.services.status).toBe('ready');
    await first.close();

    // Broken new migration AND a restore that fails (injected via the test
    // seam — a real-machine equivalent is an unreadable backup file). The
    // surfaced reason must NOT claim the data was put back.
    const badDir = brokenMigrationsDir(home);
    const second = await createCore({
      home,
      keystore,
      migrationsDirs: { main: badDir },
      restoreBackup: () => {
        throw new Error('EACCES: backup file unreadable');
      },
    });
    cores.push(second);
    expect(second.services.status).toBe('error');
    const reason = second.services.statusReason ?? '';
    expect(reason).toContain('迁移失败');
    expect(reason).toContain('自动恢复');
    expect(reason).toContain('未成功');
    expect(reason).toContain('backups/');
    // 不再声称「已恢复」「应用未改动你的数据」。
    expect(reason).not.toContain('已恢复升级前的 main.db 备份');
    expect(reason).not.toContain('应用未改动你的数据');
  });
});
