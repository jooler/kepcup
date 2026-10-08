import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { messageSchema } from '@kepcup/shared';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService, isVisibleToUser } from '../../src/domain/messages.js';
import type { Clock } from '../../src/infra/clock.js';

/**
 * D75 W0 写接口（docs/design/30 §2.4、§3.2）：task_event 私有条目、终态幂等、
 * 用户可见读路径排除私有行。按 Bot 视角的读法（list / search / around）归
 * W1-B，这里不断言其语义。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'messages-task-events-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  db: SqliteDatabase;
  messages: MessagesService;
  conversationId: string;
}

let rigCount = 0;

function makeRig(): Rig {
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
  return { db, messages: new MessagesService(db, clock), conversationId };
}

function withRig(fn: (rig: Rig) => void): void {
  const rig = makeRig();
  try {
    fn(rig);
  } finally {
    closeDatabase(rig.db);
  }
}

describe('appendTaskEvent', () => {
  it('写私有条目：system 发送者、owner / taskId 落列、内容通过 schema 不串型', () => {
    withRig((rig) => {
      const { message, created } = rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t1',
        phase: 'brief',
        text: '补全 parser 单测',
        sourceMessageIds: ['msg_u1'],
        title: '补测试',
        writes: true,
      });
      expect(created).toBe(true);
      expect(message).toMatchObject({
        senderType: 'system',
        kind: 'task_event',
        ownerBotId: 'bot_x',
        taskId: 'run_t1',
        content: {
          taskId: 'run_t1',
          phase: 'brief',
          text: '补全 parser 单测',
          sourceMessageIds: ['msg_u1'],
          title: '补测试',
          writes: true,
        },
      });
      const stored = rig.messages.getOrThrow(message.id);
      expect(stored).toEqual(message);
      // Round-trips through the shared schema without losing taskId / phase.
      expect(messageSchema.parse(stored).content).toEqual(message.content);
    });
  });

  it('终态幂等：同任务第二次写 result / failure 不抛错，返回已存条目与 created:false', () => {
    withRig((rig) => {
      const base = { conversationId: rig.conversationId, ownerBotId: 'bot_x', taskId: 'run_t1' };
      rig.messages.appendTaskEvent({ ...base, phase: 'brief', text: '交代' });
      const first = rig.messages.appendTaskEvent({ ...base, phase: 'result', text: '完成了' });
      expect(first.created).toBe(true);
      const again = rig.messages.appendTaskEvent({ ...base, phase: 'result', text: '又完成了' });
      expect(again).toEqual({ message: first.message, created: false });
      const failure = rig.messages.appendTaskEvent({
        ...base,
        phase: 'failure',
        text: '',
        status: 'interrupted',
      });
      expect(failure).toEqual({ message: first.message, created: false });
      // No extra row, no seq consumed by the rejected writes.
      expect(rig.messages.taskEvents('run_t1').map((m) => m.id)).toHaveLength(2);
      expect(rig.messages.countByConversation(rig.conversationId)).toBe(2);
      const conv = rig.db
        .prepare('select last_seq from conversations where id = ?')
        .get(rig.conversationId) as { last_seq: number };
      expect(conv.last_seq).toBe(2);
      // Non-terminal phases are not deduplicated.
      rig.messages.appendTaskEvent({ ...base, phase: 'inject', text: '补充一点' });
      rig.messages.appendTaskEvent({ ...base, phase: 'inject', text: '再补充一点' });
      expect(rig.messages.taskEvents('run_t1')).toHaveLength(4);
    });
  });

  it('唯一索引兜底：绕过预检直接写第二条终态行仍被拒（appendTaskEvent 捕获后返回已存条目）', () => {
    withRig((rig) => {
      const base = { conversationId: rig.conversationId, ownerBotId: 'bot_x', taskId: 'run_t9' };
      const first = rig.messages.appendTaskEvent({
        ...base,
        phase: 'failure',
        text: 'x',
        status: 'failed',
      });
      expect(() =>
        rig.messages.append({
          conversationId: rig.conversationId,
          senderType: 'system',
          kind: 'task_event',
          ownerBotId: 'bot_x',
          taskEvent: { taskId: 'run_t9', phase: 'result', text: 'y' },
        }),
      ).toThrow(/UNIQUE/);
      expect(rig.messages.terminalTaskEvent('run_t9')).toEqual(first.message);
    });
  });

  it('terminalTaskEvent / taskEvents：按任务取条目，按 seq 排序，其他任务互不干扰', () => {
    withRig((rig) => {
      const base = { conversationId: rig.conversationId, ownerBotId: 'bot_x' };
      expect(rig.messages.terminalTaskEvent('run_a')).toBeNull();
      expect(rig.messages.taskEvents('run_a')).toEqual([]);
      rig.messages.appendTaskEvent({ ...base, taskId: 'run_a', phase: 'brief', text: 'a1' });
      rig.messages.appendTaskEvent({ ...base, taskId: 'run_b', phase: 'brief', text: 'b1' });
      rig.messages.appendTaskEvent({
        ...base,
        taskId: 'run_a',
        phase: 'question',
        text: '用哪个分支？',
        questionMessageId: 'msg_card',
      });
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: 'main',
      });
      const failure = rig.messages.appendTaskEvent({
        ...base,
        taskId: 'run_a',
        phase: 'failure',
        text: '最后几步摘要',
        status: 'failed',
        error: 'boom',
      });
      expect(
        rig.messages.taskEvents('run_a').map((m) => (m.content as { phase: string }).phase),
      ).toEqual(['brief', 'question', 'failure']);
      expect(rig.messages.terminalTaskEvent('run_a')).toEqual(failure.message);
      expect(rig.messages.terminalTaskEvent('run_b')).toBeNull();
      expect(failure.message.content).toMatchObject({ status: 'failed', error: 'boom' });
    });
  });

  it('FTS 照常同步 task_event 正文', () => {
    withRig((rig) => {
      const { message } = rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t1',
        phase: 'result',
        text: '覆盖率提升到八十三',
      });
      const rows = rig.db
        .prepare('select message_id, conversation_id from messages_fts where message_id = ?')
        .all(message.id);
      expect(rows).toEqual([{ message_id: message.id, conversation_id: rig.conversationId }]);
      // Empty text (skip_reply result) writes no FTS row.
      const empty = rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t2',
        phase: 'result',
        text: '',
      });
      expect(
        rig.db
          .prepare('select count(*) as n from messages_fts where message_id = ?')
          .get(empty.message.id),
      ).toEqual({ n: 0 });
    });
  });
});

describe('append 扩展', () => {
  it("文本消息 taskOrigin 落 origin:'task' + taskId；普通消息 owner / taskId 为 null", () => {
    withRig((rig) => {
      const progress = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: 'bot_x',
        kind: 'text',
        text: '先跑一遍现有测试',
        taskOrigin: { taskId: 'run_t1' },
      });
      expect(progress.content).toEqual({
        text: '先跑一遍现有测试',
        origin: 'task',
        taskId: 'run_t1',
      });
      expect(progress.ownerBotId).toBeNull();
      expect(progress.taskId).toBeNull();
      expect(messageSchema.parse(rig.messages.getOrThrow(progress.id)).content).toEqual(
        progress.content,
      );
      expect(isVisibleToUser(progress)).toBe(true);
    });
  });

  it('task_event 缺载荷或载荷非法时拒绝写入', () => {
    withRig((rig) => {
      expect(() =>
        rig.messages.append({
          conversationId: rig.conversationId,
          senderType: 'system',
          kind: 'task_event',
        }),
      ).toThrow(/taskEvent/);
      expect(() =>
        rig.messages.append({
          conversationId: rig.conversationId,
          senderType: 'system',
          kind: 'task_event',
          taskEvent: { taskId: 'run_t1', phase: 'nope', text: 'x' } as never,
        }),
      ).toThrow();
      expect(rig.messages.countByConversation(rig.conversationId)).toBe(0);
    });
  });
});

describe('用户可见读路径排除私有条目', () => {
  it('isVisibleToUser 与 listVisible 排除 task_event 与带 owner 的行；list 不变', () => {
    withRig((rig) => {
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: '帮我补测试',
      });
      rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t1',
        phase: 'brief',
        text: '交代',
      });
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: 'bot_x',
        kind: 'text',
        text: '进度',
        taskOrigin: { taskId: 'run_t1' },
      });
      // A bot-owned non-task_event row (not produced in W0, but the predicate covers it).
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'system',
        kind: 'system_event',
        event: 'run_interrupted',
        text: '私有',
        ownerBotId: 'bot_x',
      });
      rig.messages.appendTaskEvent({
        conversationId: rig.conversationId,
        ownerBotId: 'bot_x',
        taskId: 'run_t1',
        phase: 'result',
        text: '结果',
      });
      rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'bot',
        senderBotId: 'bot_x',
        kind: 'text',
        text: '做完了',
      });

      const all = rig.messages.list(rig.conversationId, { limit: 100 });
      expect(all).toHaveLength(6);
      const visible = rig.messages.listVisible(rig.conversationId, { limit: 100 });
      expect(visible).toEqual(all.filter(isVisibleToUser));
      expect(visible.map((m) => m.seq)).toEqual([1, 3, 6]);
      expect(all.filter((m) => !isVisibleToUser(m)).map((m) => m.seq)).toEqual([2, 4, 5]);
      // Pagination counts visible rows only.
      expect(rig.messages.listVisible(rig.conversationId, { limit: 2 }).map((m) => m.seq)).toEqual([
        3, 6,
      ]);
    });
  });

  it('isVisibleToUser 对未带 ownerBotId 字段的旧形态对象保持原判定', () => {
    withRig((rig) => {
      const message = rig.messages.append({
        conversationId: rig.conversationId,
        senderType: 'user',
        kind: 'text',
        text: 'hi',
      });
      const legacy = { ...message } as Partial<typeof message>;
      delete legacy.ownerBotId;
      delete legacy.taskId;
      expect(isVisibleToUser(legacy as typeof message)).toBe(true);
    });
  });
});
