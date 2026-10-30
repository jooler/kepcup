import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { BotsService } from '../../src/domain/bots.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * bot.kind（0059）：初始化访谈中由 LLM 设置的内置 / 自定义分类。
 * 迁移列默认为 NULL；只有访谈中的 Bot 能被写入；内置 id 归一大小写。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'bot-kind-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const clock: Clock = { now: () => 1_000 };

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 11), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

function makeRig(): { db: SqliteDatabase; bots: BotsService } {
  const db = openMainDb();
  return { db, bots: new BotsService(db, clock) };
}

describe('0059 bot.kind migration', () => {
  it('adds the kind column and reaches the latest version', () => {
    const db = openMainDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );
    const columns = db.prepare('pragma table_info(bots)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('kind');
    closeDatabase(db);
  });

  it('leaves existing / non-interview bots unclassified (NULL)', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '旧写法', bio: '写代码' } });
    expect(bot.kind).toBeNull();
    const row = db.prepare('select kind from bots where id = ?').get(bot.id) as {
      kind: string | null;
    };
    expect(row.kind).toBeNull();
    closeDatabase(db);
  });

  it('读缺少 0059 的库（已跑到 0060 而跳过 0059）：缺列不报错，归为未分类', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '旧库里的 Bot' } });
    db.exec('alter table bots drop column kind;');
    expect(bots.get(bot.id)?.kind ?? null).toBeNull();
    expect(bots.listActive().map((entry) => entry.kind ?? null)).toEqual([null]);
    closeDatabase(db);
  });
});

describe('BotsService.setKindDuringSetup', () => {
  it('stores a built-in id and normalizes case', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '' } }, { interview: true });
    expect(bots.setKindDuringSetup(bot.id, 'Coding').kind).toBe('coding');
    expect(bots.setKindDuringSetup(bot.id, ' coding ').kind).toBe('coding');
    // 模型直接回内置标签时同样归一成稳定 id。
    expect(bots.setKindDuringSetup(bot.id, '编程与开发').kind).toBe('coding');
    expect(bots.setKindDuringSetup(bot.id, 'Programming & development').kind).toBe('coding');
    closeDatabase(db);
  });

  it('keeps a custom kind as written (after trimming) and rejects an empty one', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '' } }, { interview: true });
    expect(bots.setKindDuringSetup(bot.id, '  法务  ').kind).toBe('法务');
    expect(() => bots.setKindDuringSetup(bot.id, '   ')).toThrow(/分类不能为空/);
    closeDatabase(db);
  });

  it('rejects kinds over the length limit', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '' } }, { interview: true });
    expect(() => bots.setKindDuringSetup(bot.id, 'x'.repeat(33))).toThrow(/32/);
    closeDatabase(db);
  });

  it('rejects bots that are not in the setup interview', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '已成型的' } });
    expect(() => bots.setKindDuringSetup(bot.id, 'coding')).toThrow(/not in setup interview/);
    closeDatabase(db);
  });

  it('survives finish_setup and is cleared when the bot is deleted', () => {
    const { db, bots } = makeRig();
    const bot = bots.create({ identity: { name: '' } }, { interview: true });
    bots.setKindDuringSetup(bot.id, 'coding');
    expect(bots.finishSetup(bot.id).kind).toBe('coding');
    bots.markDeleted(bot.id);
    expect(bots.get(bot.id)?.kind).toBeNull();
    closeDatabase(db);
  });
});
