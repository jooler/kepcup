import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Message } from '@kepcup/shared';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MessagesService } from '../../src/domain/messages.js';
import type { Clock } from '../../src/infra/clock.js';
import { insertProjectConversation } from '../support/projects.js';

const dir = mkdtempSync(path.join(tmpdir(), 'messages-last-replier-'));
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
    "insert or ignore into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_lead', 'lead', '{}', 'active', 0, 0)",
  ).run();
  insertProjectConversation(db, { id: conversationId, leadBotId: 'bot_lead' });
  return { db, messages: new MessagesService(db, clock), conversationId };
}

function append(rig: Rig, input: Parameters<MessagesService['append']>[0]): Message {
  return rig.messages.append({ conversationId: rig.conversationId, ...input });
}

describe('MessagesService.lastVisibleBotMessage (D92 T1a routing 的「上一位回话者」)', () => {
  it('returns the newest shared non-recalled bot text message', () => {
    const rig = makeRig();
    try {
      append(rig, { senderType: 'user', kind: 'text', text: '用户的发言' });
      const first = append(rig, { senderType: 'bot', senderBotId: 'bot_a', kind: 'text', text: '第一条' });
      const last = append(rig, { senderType: 'bot', senderBotId: 'bot_b', kind: 'text', text: '第二条' });
      const found = rig.messages.lastVisibleBotMessage(rig.conversationId);
      expect(found?.id).toBe(last.id);
      expect(found?.senderBotId).toBe('bot_b');
      expect(found?.createdAt).toBeGreaterThan(first.createdAt);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('never returns private rows, system events, cards, task events or user messages', () => {
    const rig = makeRig();
    try {
      append(rig, { senderType: 'user', kind: 'text', text: '用户' });
      // A bot's PRIVATE task_event row (owner_bot_id set) never counts.
      append(rig, {
        senderType: 'bot',
        senderBotId: 'bot_a',
        kind: 'task_event',
        ownerBotId: 'bot_a',
        taskEvent: { taskId: 'run_1', phase: 'result', text: '任务条目' },
      });
      expect(rig.messages.lastVisibleBotMessage(rig.conversationId)).toBeNull();
      append(rig, { senderType: 'system', kind: 'system_event', event: 'run_interrupted', text: '中断' });
      append(rig, { senderType: 'system', kind: 'card', text: '卡片' });
      expect(rig.messages.lastVisibleBotMessage(rig.conversationId)).toBeNull();
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('skips recalled bot messages and falls back to the previous one', () => {
    const rig = makeRig();
    try {
      const kept = append(rig, { senderType: 'bot', senderBotId: 'bot_a', kind: 'text', text: '保留' });
      const recalled = append(rig, { senderType: 'bot', senderBotId: 'bot_b', kind: 'text', text: '撤回' });
      rig.db.prepare("update messages set status = 'recalled' where id = ?").run(recalled.id);
      expect(rig.messages.lastVisibleBotMessage(rig.conversationId)?.id).toBe(kept.id);
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('a task interim progress text (origin task) counts as the last replier', () => {
    const rig = makeRig();
    try {
      append(rig, {
        senderType: 'bot',
        senderBotId: 'bot_a',
        kind: 'text',
        text: '正在读取文件',
        taskOrigin: { taskId: 'run_task' },
      });
      expect(rig.messages.lastVisibleBotMessage(rig.conversationId)?.senderBotId).toBe('bot_a');
    } finally {
      closeDatabase(rig.db);
    }
  });

  it('null when the conversation has no bot message at all', () => {
    const rig = makeRig();
    try {
      append(rig, { senderType: 'user', kind: 'text', text: '只有用户' });
      expect(rig.messages.lastVisibleBotMessage(rig.conversationId)).toBeNull();
      expect(rig.messages.lastVisibleBotMessage('conv_missing')).toBeNull();
    } finally {
      closeDatabase(rig.db);
    }
  });
});
