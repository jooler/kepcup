import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { INTERNAL_SYSTEM_EVENTS, type Message } from '@kepcup/shared';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService, isVisibleToUser } from '../../src/domain/messages.js';
import type { Clock } from '../../src/infra/clock.js';

const dir = mkdtempSync(path.join(tmpdir(), 'messages-visible-'));
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

function append(rig: Rig, input: Parameters<MessagesService['append']>[0]): Message {
  return rig.messages.append({ conversationId: rig.conversationId, ...input });
}

describe('messages.listVisible（消息原则的存储层过滤）', () => {
  it('SQL 过滤与 isVisibleToUser 谓词在各类消息形态上一致', () => {
    const rig = makeRig();
    try {
      append(rig, { senderType: 'user', kind: 'text', text: '用户的发言' });
      append(rig, { senderType: 'bot', kind: 'text', text: 'Bot 的发言' });
      // internal 标记（事件名也在集合内）：隐藏
      append(rig, {
        senderType: 'system',
        kind: 'system_event',
        event: 'environment_installed',
        text: '已就绪',
        internal: true,
      });
      // 历史存量行（无标记，事件名在集合内）：隐藏
      append(rig, {
        senderType: 'system',
        kind: 'system_event',
        event: 'wiki_ingested',
        text: '旧版本入库事件',
      });
      // 不在集合内的系统事件（run_interrupted）：可见
      append(rig, {
        senderType: 'system',
        kind: 'system_event',
        event: 'run_interrupted',
        text: '执行被中断',
      });
      // 标记优先于事件名（事件名不在集合内但带 internal）：隐藏
      append(rig, {
        senderType: 'system',
        kind: 'system_event',
        event: 'deploy_done',
        text: '标记生效',
        internal: true,
      });
      // 审批卡：可见
      append(rig, { senderType: 'system', kind: 'card', cardType: 'environment' });
      // 空 event 名的 system_event：可见（与谓词的 `?? ''` 行为一致）
      append(rig, { senderType: 'system', kind: 'system_event', event: '', text: '无名事件' });

      const all = rig.messages.list(rig.conversationId, { limit: 200 });
      expect(all).toHaveLength(8);
      const visible = rig.messages.listVisible(rig.conversationId, { limit: 200 });
      expect(visible).toEqual(all.filter(isVisibleToUser));
      expect(visible).toHaveLength(5);
      // list 不变：Bot 上下文仍含内部事件。
      expect(all.filter((m) => m.kind === 'system_event')).toHaveLength(5);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('分页计数只含可见消息：内部事件密集处不出现短页，续拉完整覆盖历史', () => {
    const rig = makeRig();
    try {
      // 30 组「内部事件 + 可见发言」交错；旧实现（先取原始行再过滤）在
      // limit=10 的页里只能取到 5 条可见消息。
      for (let i = 0; i < 30; i++) {
        append(rig, {
          senderType: 'system',
          kind: 'system_event',
          event: 'environment_installed',
          text: `安装完成 ${i}`,
          internal: true,
        });
        append(rig, { senderType: 'user', kind: 'text', text: `发言 ${i}` });
      }
      expect(rig.messages.list(rig.conversationId, { limit: 200 })).toHaveLength(60);

      const page = rig.messages.listVisible(rig.conversationId, { limit: 10 });
      expect(page).toHaveLength(10);
      expect(page.every((m) => isVisibleToUser(m))).toBe(true);
      // 首页是「最新」的 10 条可见消息（可见消息占偶数 seq）。
      expect(page.map((m) => m.seq)).toEqual([42, 44, 46, 48, 50, 52, 54, 56, 58, 60]);

      // beforeSeq 续拉（UI 的 prepend 拼接）走完整个历史：无重复、无遗漏、
      // 拼完后全局严格升序。
      let history: Message[] = [];
      let cursor: number | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const batch = rig.messages.listVisible(rig.conversationId, {
          ...(cursor !== undefined ? { beforeSeq: cursor } : {}),
          limit: 10,
        });
        if (batch.length === 0) break;
        history = [...batch, ...history];
        cursor = batch[0]!.seq;
      }
      expect(history).toHaveLength(30);
      expect(history.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => (i + 1) * 2));
      expect(new Set(history.map((m) => m.id)).size).toBe(30);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('INTERNAL_SYSTEM_EVENTS 的 SQL 镜像覆盖集合内每个事件名（防漏网）', () => {
    const rig = makeRig();
    try {
      for (const event of INTERNAL_SYSTEM_EVENTS) {
        append(rig, {
          senderType: 'system',
          kind: 'system_event',
          event,
          text: `${event} 无标记存量行`,
        });
      }
      append(rig, { senderType: 'system', kind: 'system_event', event: 'run_interrupted', text: '可见' });
      const visible = rig.messages.listVisible(rig.conversationId, { limit: 200 });
      expect(visible.map((m) => (m.content as { event?: string }).event)).toEqual(['run_interrupted']);
    } finally {
      closeDatabase(rig.db);
    }
  });
});
