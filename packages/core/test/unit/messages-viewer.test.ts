import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService } from '../../src/domain/messages.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * D75 W1-B 按视角的读法（docs/design/30 §2.4.3）：Bot X = 共享行 + X 的私有
 * 条目；共享视角 = owner_bot_id IS NULL；用户 = 共享且非内部事务。过滤在
 * SQL 层完成，分页按视角取满。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'messages-viewer-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  db: SqliteDatabase;
  messages: MessagesService;
  conversationId: string;
}

let rigCount = 0;

function withRig(fn: (rig: Rig) => void): void {
  const home = path.join(dir, `home-${rigCount++}`);
  mkdirSync(home, { recursive: true });
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  let tick = 0;
  const clock: Clock = { now: () => 1_000_000 + tick++ };
  const conversationId = `conv_${rigCount}`;
  db.prepare(
    "insert into conversations (id, type, last_seq, created_at) values (?, 'group', 0, ?)",
  ).run(conversationId, clock.now());
  try {
    fn({ db, messages: new MessagesService(db, clock), conversationId });
  } finally {
    closeDatabase(db);
  }
}

/**
 * seq 1 用户「找斑马」、2 X 交代、3 Y 交代、4 X 进度（可见）、5 X 结果、
 * 6 Y 结果、7 内部事件、8 用户「斑马呢」。
 */
function seed(rig: Rig): void {
  const { messages, conversationId } = rig;
  messages.append({ conversationId, senderType: 'user', kind: 'text', text: '帮我找斑马' });
  messages.appendTaskEvent({
    conversationId,
    ownerBotId: 'bot_x',
    taskId: 'run_tx',
    phase: 'brief',
    title: '找斑马',
    text: 'X 去找斑马',
  });
  messages.appendTaskEvent({
    conversationId,
    ownerBotId: 'bot_y',
    taskId: 'run_ty',
    phase: 'brief',
    text: 'Y 也去找斑马',
  });
  messages.append({
    conversationId,
    senderType: 'bot',
    senderBotId: 'bot_x',
    kind: 'text',
    text: '正在找斑马',
    taskOrigin: { taskId: 'run_tx' },
  });
  messages.appendTaskEvent({
    conversationId,
    ownerBotId: 'bot_x',
    taskId: 'run_tx',
    phase: 'result',
    text: '斑马在动物园',
  });
  messages.appendTaskEvent({
    conversationId,
    ownerBotId: 'bot_y',
    taskId: 'run_ty',
    phase: 'result',
    text: '斑马在草原',
  });
  messages.append({
    conversationId,
    senderType: 'system',
    kind: 'system_event',
    event: 'environment_installed',
    text: '已就绪',
    internal: true,
  });
  messages.append({ conversationId, senderType: 'user', kind: 'text', text: '斑马呢' });
}

const seqs = (rows: Array<{ seq: number }>) => rows.map((m) => m.seq);

describe('listForBot / listShared', () => {
  it('Bot 视角 = 共享行 + 自己的私有条目，按 seq 交错；共享视角不含任何私有行', () => {
    withRig((rig) => {
      seed(rig);
      expect(seqs(rig.messages.listForBot(rig.conversationId, 'bot_x'))).toEqual([
        1, 2, 4, 5, 7, 8,
      ]);
      expect(seqs(rig.messages.listForBot(rig.conversationId, 'bot_y'))).toEqual([
        1, 3, 4, 6, 7, 8,
      ]);
      expect(seqs(rig.messages.listShared(rig.conversationId))).toEqual([1, 4, 7, 8]);
      // list 仍是不分视角的原始读（宿主内部 / 测试用）。
      expect(rig.messages.list(rig.conversationId)).toHaveLength(8);
    });
  });

  it('分页在 SQL 层按视角取满，beforeSeq 续拉', () => {
    withRig((rig) => {
      seed(rig);
      expect(seqs(rig.messages.listForBot(rig.conversationId, 'bot_y', { limit: 3 }))).toEqual([
        6, 7, 8,
      ]);
      expect(
        seqs(rig.messages.listForBot(rig.conversationId, 'bot_y', { limit: 3, beforeSeq: 6 })),
      ).toEqual([1, 3, 4]);
      expect(seqs(rig.messages.listShared(rig.conversationId, { limit: 2, beforeSeq: 7 }))).toEqual(
        [1, 4],
      );
    });
  });
});

describe('search / around 按视角', () => {
  it('search 按 owner 过滤 FTS 命中（task_event 文本同样入索引）', () => {
    withRig((rig) => {
      seed(rig);
      expect(
        seqs(rig.messages.search(rig.conversationId, '斑马', { viewerBotId: 'bot_x' })),
      ).toEqual([1, 2, 4, 5, 8]);
      expect(
        seqs(rig.messages.search(rig.conversationId, '斑马', { viewerBotId: 'bot_y' })),
      ).toEqual([1, 3, 4, 6, 8]);
      expect(seqs(rig.messages.search(rig.conversationId, '斑马', { viewerBotId: null }))).toEqual([
        1, 4, 8,
      ]);
    });
  });

  it('around 取视角内前后各 N 条，看不到的行不占名额', () => {
    withRig((rig) => {
      seed(rig);
      expect(seqs(rig.messages.around(rig.conversationId, 4, 2, 'bot_y'))).toEqual([1, 3, 4, 6, 7]);
      expect(seqs(rig.messages.around(rig.conversationId, 4, 1, 'bot_x'))).toEqual([2, 4, 5]);
      expect(seqs(rig.messages.around(rig.conversationId, 4, 1, null))).toEqual([1, 4, 7]);
      // 锚点对该视角不可见：只给前后各 N 条可见行。
      expect(seqs(rig.messages.around(rig.conversationId, 5, 1, 'bot_y'))).toEqual([4, 6]);
    });
  });
});

describe('摘要、预览、未读', () => {
  it('unsummarized 只返回共享行', () => {
    withRig((rig) => {
      seed(rig);
      expect(seqs(rig.messages.unsummarized(rig.conversationId, 8))).toEqual([1, 4, 7, 8]);
    });
  });

  it('latestTextByConversation 不取私有行；私有行不推进 last_message_at', () => {
    withRig((rig) => {
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '最后一句可见',
      });
      const before = rig.db
        .prepare('select last_message_at as t, last_seq as s from conversations where id = ?')
        .get(rig.conversationId) as { t: number; s: number };
      // 带 owner 的文本行（防御：私有行无论 kind 都不进预览）。
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: 'bot_x',
        kind: 'text',
        text: '私有文本',
        ownerBotId: 'bot_x',
      });
      rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t',
        phase: 'result',
        text: '私有结果',
      });
      expect(rig.messages.latestTextByConversation()[rig.conversationId]).toBe('最后一句可见');
      const after = rig.db
        .prepare('select last_message_at as t, last_seq as s from conversations where id = ?')
        .get(rig.conversationId) as { t: number; s: number };
      expect(after.s).toBe(before.s + 2);
      expect(after.t).toBe(before.t);
    });
  });

  it('countVisibleAfter 只数用户可见行（私有条目与内部事件不计）', () => {
    withRig((rig) => {
      seed(rig);
      expect(rig.messages.countVisibleAfter(rig.conversationId, 0)).toBe(3);
      expect(rig.messages.countVisibleAfter(rig.conversationId, 4)).toBe(1);
      expect(rig.messages.countVisibleAfter(rig.conversationId, 8)).toBe(0);
    });
  });
});
