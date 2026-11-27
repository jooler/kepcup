import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { ReactionsService } from '../../src/domain/reactions.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * 消息 reaction（AI 内容举报 §5.6 / §6.6）：本机 main.db，scope 隔离本机与
 * 团队会话，emoji 白名单，(scope, message_id, client_id) 每 client 一条，
 * null 取消；不校验消息存在。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'reactions-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let rigCount = 0;

function makeRig(): { db: SqliteDatabase; reactions: ReactionsService } {
  rigCount += 1;
  const db = openDatabase({
    path: path.join(dir, `main-${rigCount}.db`),
    key: deriveKey(Buffer.alloc(32, rigCount), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const clock: Clock = { now: () => 1_000 };
  return { db, reactions: new ReactionsService(db, clock) };
}

describe('ReactionsService', () => {
  it('sets, aggregates and reports mine per (message, emoji)', () => {
    const { db, reactions } = makeRig();
    try {
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', '👍');
      reactions.set('local', 'conv_1', 'msg_a', 'client-2', '👍');
      reactions.set('local', 'conv_1', 'msg_a', 'client-3', '❤️');
      // emoji 列 BINARY 排序（❤️ U+2764 < 👍 U+1F44D）。
      expect(reactions.list('local', 'conv_1', 'client-1')).toEqual([
        { messageId: 'msg_a', emoji: '❤️', count: 1, mine: false },
        { messageId: 'msg_a', emoji: '👍', count: 2, mine: true },
      ]);
      expect(reactions.list('local', 'conv_1', 'client-3')).toEqual([
        { messageId: 'msg_a', emoji: '❤️', count: 1, mine: true },
        { messageId: 'msg_a', emoji: '👍', count: 2, mine: false },
      ]);
      // 行级形状：每个 client 每条消息一行（upsert 主键）。
      const rows = db
        .prepare(
          "select client_id, emoji from message_reactions where message_id = 'msg_a' order by client_id",
        )
        .all() as Array<{ client_id: string; emoji: string }>;
      expect(rows).toEqual([
        { client_id: 'client-1', emoji: '👍' },
        { client_id: 'client-2', emoji: '👍' },
        { client_id: 'client-3', emoji: '❤️' },
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('re-sets switch the emoji (one reaction per client per message)', () => {
    const { db, reactions } = makeRig();
    try {
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', '👍');
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', '🎉');
      expect(reactions.list('local', 'conv_1', 'client-1')).toEqual([
        { messageId: 'msg_a', emoji: '🎉', count: 1, mine: true },
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('null cancels; cancelling a missing reaction is a no-op', () => {
    const { db, reactions } = makeRig();
    try {
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', '👍');
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', null);
      expect(reactions.list('local', 'conv_1', 'client-1')).toEqual([]);
      expect(() => reactions.set('local', 'conv_1', 'msg_a', 'client-1', null)).not.toThrow();
      expect(db.prepare('select count(*) as n from message_reactions').get()).toEqual({ n: 0 });
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects emojis outside the fixed whitelist', () => {
    const { db, reactions } = makeRig();
    try {
      expect(() => reactions.set('local', 'conv_1', 'msg_a', 'client-1', '🤠')).toThrow(AppError);
      expect(() => reactions.set('local', 'conv_1', 'msg_a', 'client-1', 'thumbs-up')).toThrow(AppError);
      expect(() => reactions.set('local', 'conv_1', 'msg_a', 'client-1', '')).toThrow(AppError);
    } finally {
      closeDatabase(db);
    }
  });

  it('isolates local vs team:<hash> scopes even for identical ids', () => {
    const { db, reactions } = makeRig();
    try {
      reactions.set('local', 'conv_1', 'msg_a', 'client-1', '👍');
      reactions.set('team:0123456789abcdef', 'conv_1', 'msg_a', 'client-1', '👎');
      expect(reactions.list('local', 'conv_1', 'client-1')).toEqual([
        { messageId: 'msg_a', emoji: '👍', count: 1, mine: true },
      ]);
      expect(reactions.list('team:0123456789abcdef', 'conv_1', 'client-1')).toEqual([
        { messageId: 'msg_a', emoji: '👎', count: 1, mine: true },
      ]);
      expect(() => reactions.set('team:zzzz', 'conv_1', 'msg_a', 'client-1', '👍')).toThrow(AppError);
      expect(() => reactions.list('conv_1', 'conv_1', 'client-1')).toThrow(AppError);
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps conversations apart and tolerates unknown (team) messages', () => {
    const { db, reactions } = makeRig();
    try {
      // 团队消息不在本机 messages 表也能点（不校验消息存在，§6.6）。
      reactions.set('team:fedcba9876543210', 'srv_conv_1', 'srv_msg_1', 'client-1', '✅');
      reactions.set('team:fedcba9876543210', 'srv_conv_2', 'srv_msg_2', 'client-1', '🔥');
      expect(reactions.list('team:fedcba9876543210', 'srv_conv_1', 'client-1')).toEqual([
        { messageId: 'srv_msg_1', emoji: '✅', count: 1, mine: true },
      ]);
      expect(reactions.list('team:fedcba9876543210', 'srv_conv_2', 'client-1')).toEqual([
        { messageId: 'srv_msg_2', emoji: '🔥', count: 1, mine: true },
      ]);
      expect(reactions.list('team:fedcba9876543210', 'srv_conv_missing', 'client-1')).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces length limits on scope / ids', () => {
    const { db, reactions } = makeRig();
    try {
      expect(() => reactions.set('local', 'c'.repeat(129), 'msg_a', 'client-1', '👍')).toThrow(AppError);
      expect(() => reactions.set('local', 'conv_1', 'm'.repeat(129), 'client-1', '👍')).toThrow(AppError);
      expect(() =>
        reactions.set(`team:${'a'.repeat(40)}`, 'conv_1', 'msg_a', 'client-1', '👍'),
      ).toThrow(AppError);
    } finally {
      closeDatabase(db);
    }
  });
});
