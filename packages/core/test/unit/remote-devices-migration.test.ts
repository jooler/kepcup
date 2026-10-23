import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * 0049_remote_devices（D96 §5.3）：remote_devices 表。升级路径用「真实迁移目录
 * 截到 0047」建旧库再跑全量（真库，不用 stub）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'remote-devices-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
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

describe('0049 remote_devices 迁移', () => {
  it('旧库（0047）升级后出现 remote_devices，列与约束符合设计 46 §5.3', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(47));
    expect(
      db.prepare("select 1 from sqlite_master where name = 'remote_devices'").get(),
    ).toBeUndefined();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied[applied.length - 1]?.version).toBe(49);
    expect(
      db.prepare("select 1 from sqlite_master where name = 'remote_devices'").get(),
    ).toBeDefined();

    // psk_mode 约束生效；token_hash 可空（撤销时清空）。
    db.prepare(
      "insert into remote_devices (device_id, name, key_fingerprint, psk_mode, token_hash, created_at) values ('dev_x', '手机', 'a', 'x25519', null, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "insert into remote_devices (device_id, name, key_fingerprint, psk_mode, created_at) values ('dev_bad', 'x', 'a', 'ecdh', 1)",
        )
        .run(),
    ).toThrow();
    // 同设备重配对（upsert 路径）不炸主键。
    db.prepare("update remote_devices set last_seen_at = 2 where device_id = 'dev_x'").run();
    const row = db
      .prepare('select device_id, revoked_at, last_seen_at from remote_devices')
      .get() as { device_id: string; revoked_at: number | null; last_seen_at: number | null };
    expect(row).toMatchObject({ device_id: 'dev_x', revoked_at: null, last_seen_at: 2 });
    closeDatabase(db);
  });
});
