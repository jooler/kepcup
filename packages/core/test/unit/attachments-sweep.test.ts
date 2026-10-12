import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import {
  AttachmentsService,
  ORPHAN_FILE_GRACE_MS,
  UNBOUND_ATTACHMENT_TTL_MS,
} from '../../src/domain/attachments.js';
import type { AppPaths } from '../../src/infra/paths.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * 孤儿附件回收（AttachmentsService.sweepOrphans）：未绑定过期行 + 无行引用的文件。
 * 重点是「不误删」：已绑定消息的附件、未过期的上传（输入框 chip）、刚写下
 * 尚未插行的文件都必须原样保留。
 */

const root = mkdtempSync(path.join(tmpdir(), 'attachments-sweep-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = 100 * 24 * 3600 * 1000;
const clock: Clock = { now: () => NOW };
const DAY = 24 * 3600 * 1000;

let db: SqliteDatabase;
let home: string;
let service: AttachmentsService;

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('main');
  const target = mkdtempSync(path.join(root, 'migrations-'));
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

beforeEach(() => {
  home = mkdtempSync(path.join(root, 'home-'));
  db = openDatabase({
    path: path.join(root, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUpTo(31));
  for (const id of ['conv_a', 'conv_b']) {
    db.prepare("insert into conversations (id, type, created_at) values (?, 'group', 1)").run(id);
  }
  // 已绑定消息的附件行需要 messages 行；这里只关心回收逻辑，关闭外键。
  db.pragma('foreign_keys = OFF');
  service = new AttachmentsService({ db, paths: { home } as AppPaths, clock });
});

function dirOf(conversationId: string): string {
  return path.join(home, 'conversations', conversationId, 'attachments');
}

function insertRow(input: {
  id: string;
  conversationId?: string;
  messageId?: string | null;
  createdAt: number;
  size?: number;
  withFile?: boolean;
}): string {
  const conversationId = input.conversationId ?? 'conv_a';
  const relPath = `${input.id}_f.txt`;
  db.prepare(
    'insert into attachments (id, conversation_id, message_id, file_name, mime, size, sha256, rel_path, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    input.id,
    conversationId,
    input.messageId ?? null,
    'f.txt',
    'text/plain',
    input.size ?? 3,
    'x',
    relPath,
    input.createdAt,
  );
  const file = path.join(dirOf(conversationId), relPath);
  if (input.withFile !== false) {
    mkdirSync(dirOf(conversationId), { recursive: true });
    writeFileSync(file, 'abc');
  }
  return file;
}

function age(file: string, ageMs: number): void {
  const when = (NOW - ageMs) / 1000;
  utimesSync(file, when, when);
}

function rowExists(id: string): boolean {
  return db.prepare('select 1 from attachments where id = ?').get(id) !== undefined;
}

describe('AttachmentsService.sweepOrphans', () => {
  it('回收过期的未绑定附件（行 + 文件），保留未过期的上传与已绑定消息的附件', () => {
    const stale = insertRow({ id: 'att_stale', createdAt: NOW - UNBOUND_ATTACHMENT_TTL_MS - 1000 });
    const fresh = insertRow({ id: 'att_fresh', createdAt: NOW - UNBOUND_ATTACHMENT_TTL_MS + DAY });
    const justNow = insertRow({ id: 'att_now', createdAt: NOW });
    // 已绑定消息：再老也不能动。
    const bound = insertRow({
      id: 'att_bound',
      messageId: 'msg_1',
      createdAt: NOW - 90 * DAY,
    });

    const result = service.sweepOrphans();

    expect(result.expiredRows).toBe(1);
    expect(rowExists('att_stale')).toBe(false);
    expect(existsSync(stale)).toBe(false);
    for (const [id, file] of [
      ['att_fresh', fresh],
      ['att_now', justNow],
      ['att_bound', bound],
    ] as const) {
      expect(rowExists(id)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
  });

  it('删除无行引用且足够旧的文件；有行引用的、刚写下的、子目录/其它会话的引用都不误删', () => {
    // 被未绑定新行引用的文件（正在使用）——哪怕 mtime 很旧也要留。
    const inUse = insertRow({ id: 'att_inuse', createdAt: NOW - DAY });
    age(inUse, 30 * DAY);
    // 被已绑定行引用。
    const boundFile = insertRow({ id: 'att_b', messageId: 'msg_2', createdAt: NOW - 50 * DAY });
    age(boundFile, 50 * DAY);

    mkdirSync(dirOf('conv_a'), { recursive: true });
    const orphanOld = path.join(dirOf('conv_a'), 'att_gone_x.png');
    writeFileSync(orphanOld, 'zz');
    age(orphanOld, ORPHAN_FILE_GRACE_MS + DAY);
    // 刚写下、行还没插：在宽限期内不动。
    const orphanFresh = path.join(dirOf('conv_a'), 'att_new_x.png');
    writeFileSync(orphanFresh, 'zz');
    age(orphanFresh, 60 * 1000);
    // 同名文件在另一个会话目录下：按会话分别判断，不被 conv_a 的行「借」保护。
    mkdirSync(dirOf('conv_b'), { recursive: true });
    const sameNameOtherConv = path.join(dirOf('conv_b'), 'att_inuse_f.txt');
    writeFileSync(sameNameOtherConv, 'zz');
    age(sameNameOtherConv, 30 * DAY);
    // 已删会话（无 conversations 行）残留的文件。
    mkdirSync(dirOf('conv_deleted'), { recursive: true });
    const deletedConvFile = path.join(dirOf('conv_deleted'), 'att_old_x.png');
    writeFileSync(deletedConvFile, 'zz');
    age(deletedConvFile, 30 * DAY);
    // 子目录不是附件文件，整体不碰。
    const nested = path.join(dirOf('conv_a'), 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'keep.bin'), 'zz');
    age(path.join(nested, 'keep.bin'), 30 * DAY);

    const result = service.sweepOrphans();

    expect(result.orphanFiles).toBe(3);
    expect(existsSync(orphanOld)).toBe(false);
    expect(existsSync(sameNameOtherConv)).toBe(false);
    expect(existsSync(deletedConvFile)).toBe(false);
    expect(existsSync(orphanFresh)).toBe(true);
    expect(existsSync(inUse)).toBe(true);
    expect(existsSync(boundFile)).toBe(true);
    expect(existsSync(path.join(nested, 'keep.bin'))).toBe(true);
    expect(rowExists('att_inuse')).toBe(true);
  });

  it('过期行回收后其文件同批被删，第二次运行是空操作；没有 conversations 目录也不抛', () => {
    expect(service.sweepOrphans()).toEqual({ expiredRows: 0, orphanFiles: 0, freedBytes: 0 });
    const stale = insertRow({
      id: 'att_s2',
      createdAt: NOW - 30 * DAY,
      size: 3,
    });
    const first = service.sweepOrphans();
    expect(first.expiredRows).toBe(1);
    expect(first.freedBytes).toBe(3);
    expect(existsSync(stale)).toBe(false);
    expect(service.sweepOrphans()).toEqual({ expiredRows: 0, orphanFiles: 0, freedBytes: 0 });
  });

  it('upload 产生的真实附件：刚上传不回收；绑定消息后即使很老也保留', () => {
    const uploaded = service.upload({
      conversationId: 'conv_a',
      fileName: 'a.txt',
      mime: 'text/plain',
      bytes: Buffer.from('hello'),
    });
    expect(service.sweepOrphans()).toEqual({ expiredRows: 0, orphanFiles: 0, freedBytes: 0 });
    expect(existsSync(service.absolutePath(uploaded))).toBe(true);
    service.attachToMessage([uploaded.id], 'msg_real');
    db.prepare('update attachments set created_at = 1 where id = ?').run(uploaded.id);
    age(service.absolutePath(uploaded), 90 * DAY);
    expect(service.sweepOrphans()).toEqual({ expiredRows: 0, orphanFiles: 0, freedBytes: 0 });
    expect(existsSync(service.absolutePath(uploaded))).toBe(true);
  });
});

describe('AttachmentsService.statusOf（草稿 chip 存在性批量查询）', () => {
  it('区分 pending / sent / missing；跨对话、已过期被回收、文件被删都算 missing', () => {
    insertRow({ id: 'att_pending', createdAt: NOW });
    insertRow({ id: 'att_sent', messageId: 'msg_1', createdAt: NOW });
    insertRow({ id: 'att_other', conversationId: 'conv_b', createdAt: NOW });
    insertRow({ id: 'att_nofile', createdAt: NOW, withFile: false });
    const stale = insertRow({ id: 'att_stale', createdAt: NOW - UNBOUND_ATTACHMENT_TTL_MS - 1000 });
    service.sweepOrphans();
    expect(existsSync(stale)).toBe(false);

    expect(
      service.statusOf(
        ['att_pending', 'att_sent', 'att_other', 'att_nofile', 'att_stale', 'att_unknown'],
        'conv_a',
      ),
    ).toEqual([
      { id: 'att_pending', state: 'pending' },
      { id: 'att_sent', state: 'sent' },
      { id: 'att_other', state: 'missing' },
      { id: 'att_nofile', state: 'missing' },
      { id: 'att_stale', state: 'missing' },
      { id: 'att_unknown', state: 'missing' },
    ]);
  });
});

afterAll(() => {
  try {
    closeDatabase(db);
  } catch {
    // already closed
  }
});
