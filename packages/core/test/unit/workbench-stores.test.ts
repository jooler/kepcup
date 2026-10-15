import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { memoSchema, todoRunSchema, todoSchema } from '@kepcup/shared';

import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { SchedulesStore } from '../../src/schedule/store.js';
import { migrationsUrl } from '../../src/start.js';
import { MemoStore } from '../../src/workbench/memo-store.js';
import { TodoStore } from '../../src/workbench/todo-store.js';

/** D90 workbench stores (todos / todo_runs / memos) and the schedules store changes. */

const dir = mkdtempSync(path.join(tmpdir(), 'workbench-stores-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let now = 1_000;
const clock: Clock = { now: () => now };

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

describe('TodoStore', () => {
  let db: SqliteDatabase;
  let store: TodoStore;
  beforeEach(() => {
    now = 1_000;
    db = openMainDb();
    store = new TodoStore(db, clock);
  });

  it('inserts a draft with defaults and maps the row to the shared Todo shape', () => {
    const todo = store.insert({ title: '整理竞品报告', source: 'user' });
    expect(todo.id.startsWith('todo_')).toBe(true);
    expect(todo).toEqual({
      id: todo.id,
      title: '整理竞品报告',
      notes: '',
      assignee: null,
      status: 'draft',
      source: 'user',
      memoId: null,
      blockedReason: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      closedAt: null,
    });
    expect(todoSchema.parse(todo)).toEqual(todo);
  });

  it('encodes bot / group / none assignees and reads them back', () => {
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_g', 'group', null, 0, 0)",
    ).run();
    const bot = store.insert({
      title: 'a',
      source: 'user',
      assignee: { kind: 'bot', botId: 'bot_1' },
    });
    expect(bot.assignee).toEqual({ kind: 'bot', botId: 'bot_1' });
    const row = db
      .prepare('select assignee_bot_id, assignee_group_id from todos where id = ?')
      .get(bot.id);
    expect(row).toEqual({ assignee_bot_id: 'bot_1', assignee_group_id: null });

    const lead = store.insert({
      title: 'b',
      source: 'butler',
      assignee: { kind: 'group', conversationId: 'conv_g', leadBotId: 'bot_2' },
    });
    expect(lead.assignee).toEqual({ kind: 'group', conversationId: 'conv_g', leadBotId: 'bot_2' });
    const noLead = store.insert({
      title: 'c',
      source: 'user',
      assignee: { kind: 'group', conversationId: 'conv_g', leadBotId: null },
    });
    expect(noLead.assignee).toEqual({ kind: 'group', conversationId: 'conv_g', leadBotId: null });

    // Clearing the assignee clears both columns.
    const cleared = store.update(lead.id, { assignee: null });
    expect(cleared?.assignee).toBeNull();
    expect(
      db.prepare('select assignee_bot_id, assignee_group_id from todos where id = ?').get(lead.id),
    ).toEqual({ assignee_bot_id: null, assignee_group_id: null });
  });

  it('keeps the group assignee when the group conversation is deleted (no FK: TodoService / reconcile own that)', () => {
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_g', 'group', null, 0, 0)",
    ).run();
    const todo = store.insert({
      title: 'a',
      source: 'user',
      assignee: { kind: 'group', conversationId: 'conv_g', leadBotId: null },
    });
    const lead = store.insert({
      title: 'b',
      source: 'user',
      assignee: { kind: 'group', conversationId: 'conv_g', leadBotId: 'bot_2' },
    });
    db.prepare("delete from conversations where id = 'conv_g'").run();
    // Never silently degraded to a bot assignee ("group + lead" read as the lead bot).
    expect(store.get(todo.id)?.assignee).toEqual({
      kind: 'group',
      conversationId: 'conv_g',
      leadBotId: null,
    });
    expect(store.get(lead.id)?.assignee).toEqual({
      kind: 'group',
      conversationId: 'conv_g',
      leadBotId: 'bot_2',
    });
  });

  it('derives closed_at from the status: stamped entering done / cancelled, kept while closed, cleared on reopen', () => {
    const todo = store.insert({ title: 'a', source: 'user' });
    now = 2_000;
    expect(store.update(todo.id, { status: 'done' })?.closedAt).toBe(2_000);
    now = 3_000;
    // Editing a closed todo does not move the closing time.
    expect(store.update(todo.id, { title: 'b' })?.closedAt).toBe(2_000);
    expect(store.update(todo.id, { status: 'cancelled' })?.closedAt).toBe(2_000);
    expect(store.update(todo.id, { status: 'draft' })?.closedAt).toBeNull();
    now = 4_000;
    expect(store.update(todo.id, { status: 'cancelled' })?.closedAt).toBe(4_000);
  });

  it('reassignBot moves only open todos', () => {
    const open = store.insert({ title: 'a', source: 'user', assignee: { kind: 'bot', botId: 'bot_1' } });
    const done = store.insert({
      title: 'b',
      source: 'user',
      assignee: { kind: 'bot', botId: 'bot_1' },
      status: 'done',
    });
    expect(store.reassignBot('bot_1', 'bot_2')).toBe(1);
    expect(store.get(open.id)?.assignee).toEqual({ kind: 'bot', botId: 'bot_2' });
    expect(store.get(done.id)?.assignee).toEqual({ kind: 'bot', botId: 'bot_1' });
  });

  it('updates fields, bumps updated_at and records closure', () => {
    const todo = store.insert({ title: 'a', notes: 'n', source: 'user', memoId: 'memo_1' });
    now = 2_000;
    const scheduled = store.update(todo.id, { status: 'scheduled', title: 'b' });
    expect(scheduled).toMatchObject({
      title: 'b',
      notes: 'n',
      status: 'scheduled',
      memoId: 'memo_1',
      updatedAt: 2_000,
      createdAt: 1_000,
    });
    now = 3_000;
    const blocked = store.update(todo.id, { status: 'draft', blockedReason: '群里无人认领' });
    expect(blocked?.blockedReason).toBe('群里无人认领');
    const done = store.update(todo.id, { status: 'done', blockedReason: null, closedAt: 3_000 });
    expect(done).toMatchObject({ status: 'done', blockedReason: null, closedAt: 3_000 });
    const reopened = store.update(todo.id, { status: 'draft', closedAt: null });
    expect(reopened?.closedAt).toBeNull();
    expect(store.update('todo_missing', { title: 'x' })).toBeNull();
    // Inserting straight into a closed status stamps closed_at.
    expect(store.insert({ title: 'x', source: 'user', status: 'cancelled' }).closedAt).toBe(3_000);
  });

  it('lists by status / query / closed window, newest update first', () => {
    const a = store.insert({ title: '写周报', source: 'user' });
    now = 2_000;
    const b = store.insert({ title: '调研竞品', notes: '关于 100% 的增长', source: 'user' });
    now = 3_000;
    const c = store.insert({ title: '旧事项', source: 'user' });
    store.update(c.id, { status: 'done', closedAt: 3_000 });
    now = 4_000;
    store.update(a.id, { status: 'in_progress' });

    expect(store.list().map((t) => t.id)).toEqual([a.id, c.id, b.id]);
    expect(store.list({ statuses: ['draft'] }).map((t) => t.id)).toEqual([b.id]);
    expect(store.list({ statuses: [] })).toEqual([]);
    expect(store.list({ query: '竞品' }).map((t) => t.id)).toEqual([b.id]);
    // LIKE wildcards in the query are literal.
    expect(store.list({ query: '100%' }).map((t) => t.id)).toEqual([b.id]);
    expect(store.list({ query: '%' }).map((t) => t.id)).toEqual([b.id]);
    expect(store.list({ query: '_' })).toEqual([]);
    // Closed todos older than the window are hidden; open ones always show.
    expect(store.list({ closedAfter: 4_000 }).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(store.list({ closedAfter: 3_000 }).map((t) => t.id)).toEqual([a.id, c.id, b.id]);
  });

  it('queries by assignee and reassigns a bot (D88 handover)', () => {
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_g', 'group', null, 0, 0)",
    ).run();
    const direct = store.insert({
      title: 'a',
      source: 'user',
      assignee: { kind: 'bot', botId: 'bot_1' },
    });
    const lead = store.insert({
      title: 'b',
      source: 'user',
      assignee: { kind: 'group', conversationId: 'conv_g', leadBotId: 'bot_1' },
    });
    store.insert({ title: 'c', source: 'user', assignee: { kind: 'bot', botId: 'bot_9' } });
    expect(
      store
        .listByAssigneeBot('bot_1')
        .map((t) => t.id)
        .sort(),
    ).toEqual([direct.id, lead.id].sort());
    expect(store.listByAssigneeGroup('conv_g').map((t) => t.id)).toEqual([lead.id]);
    expect(store.reassignBot('bot_1', 'bot_2')).toBe(2);
    expect(store.get(direct.id)?.assignee).toEqual({ kind: 'bot', botId: 'bot_2' });
    expect(store.get(lead.id)?.assignee).toEqual({
      kind: 'group',
      conversationId: 'conv_g',
      leadBotId: 'bot_2',
    });
    expect(store.listByAssigneeBot('bot_1')).toEqual([]);
  });

  it('deletes a todo and cascades its runs', () => {
    const todo = store.insert({ title: 'a', source: 'user' });
    const run = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
    expect(store.delete(todo.id)).toBe(true);
    expect(store.delete(todo.id)).toBe(false);
    expect(store.getRun(run.id)).toBeNull();
  });

  describe('runs', () => {
    it('inserts, updates and orders runs', () => {
      const todo = store.insert({ title: 'a', source: 'user' });
      const first = store.insertRun({
        todoId: todo.id,
        conversationId: 'conv_1',
        messageId: 'msg_1',
      });
      expect(first.id.startsWith('tdr_')).toBe(true);
      expect(first).toEqual({
        id: first.id,
        todoId: todo.id,
        conversationId: 'conv_1',
        messageId: 'msg_1',
        status: 'dispatched',
        resultMessageId: null,
        dispatchedAt: 1_000,
        settledAt: null,
      });
      expect(todoRunSchema.parse(first)).toEqual(first);

      now = 2_000;
      const second = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
      expect(second.messageId).toBeNull();
      expect(store.listRuns(todo.id).map((r) => r.id)).toEqual([second.id, first.id]);
      expect(store.lastRun(todo.id)?.id).toBe(second.id);
      expect(store.lastRun('todo_none')).toBeNull();

      const attached = store.updateRun(second.id, { messageId: 'msg_2' });
      expect(attached?.messageId).toBe('msg_2');
      const settled = store.updateRun(second.id, {
        status: 'delivered',
        resultMessageId: 'msg_9',
        settledAt: 2_500,
      });
      expect(settled).toMatchObject({
        status: 'delivered',
        resultMessageId: 'msg_9',
        settledAt: 2_500,
        messageId: 'msg_2',
      });
      expect(store.updateRun('tdr_missing', { status: 'failed' })).toBeNull();
    });

    it('derives settled_at from the status when not given', () => {
      const todo = store.insert({ title: 'a', source: 'user' });
      now = 5_000;
      const run = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
      expect(run.settledAt).toBeNull();
      now = 5_500;
      expect(store.updateRun(run.id, { messageId: 'msg_1' })?.settledAt).toBeNull();
      now = 6_000;
      expect(store.updateRun(run.id, { status: 'failed' })?.settledAt).toBe(6_000);
      now = 7_000;
      // A later result keeps the first settlement time; going back clears it.
      expect(store.updateRun(run.id, { status: 'delivered', resultMessageId: 'm' })?.settledAt).toBe(6_000);
      expect(store.updateRun(run.id, { status: 'dispatched' })?.settledAt).toBeNull();
    });

    it('lists unsettled runs of one conversation in dispatch order', () => {
      const todo = store.insert({ title: 'a', source: 'user' });
      const open1 = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
      now = 1_500;
      const settled = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
      store.updateRun(settled.id, { status: 'delivered', settledAt: 1_600 });
      now = 2_000;
      const open2 = store.insertRun({ todoId: todo.id, conversationId: 'conv_1' });
      store.insertRun({ todoId: todo.id, conversationId: 'conv_other' });
      expect(store.listOpenRunsForConversation('conv_1').map((r) => r.id)).toEqual([
        open1.id,
        open2.id,
      ]);
    });

    it('keeps runs readable after the dispatch conversation is gone (no FK)', () => {
      const todo = store.insert({ title: 'a', source: 'user' });
      const run = store.insertRun({ todoId: todo.id, conversationId: 'conv_deleted' });
      expect(store.getRun(run.id)?.conversationId).toBe('conv_deleted');
    });
  });
});

describe('MemoStore', () => {
  let db: SqliteDatabase;
  let store: MemoStore;
  beforeEach(() => {
    now = 1_000;
    db = openMainDb();
    store = new MemoStore(db, clock);
  });

  it('inserts and maps the row to the shared Memo shape', () => {
    const memo = store.insert({ body: '下周和 A 公司谈价', source: 'user' });
    expect(memo.id.startsWith('memo_')).toBe(true);
    expect(memo).toEqual({
      id: memo.id,
      body: '下周和 A 公司谈价',
      pinned: false,
      source: 'user',
      createdAt: 1_000,
      updatedAt: 1_000,
      deletedAt: null,
    });
    expect(memoSchema.parse(memo)).toEqual(memo);
    expect(store.insert({ body: 'x', source: 'butler', pinned: true })).toMatchObject({
      pinned: true,
      source: 'butler',
    });
    expect(store.get('memo_missing')).toBeNull();
  });

  it('lists live memos pinned first then by update time, with search', () => {
    const a = store.insert({ body: 'alpha', source: 'user' });
    now = 2_000;
    const b = store.insert({ body: 'beta 50%', source: 'user' });
    now = 3_000;
    const c = store.insert({ body: 'gamma', source: 'user', pinned: true });
    expect(store.list().map((m) => m.id)).toEqual([c.id, b.id, a.id]);
    now = 4_000;
    store.update(a.id, { body: 'alpha edited' });
    expect(store.list().map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    store.update(b.id, { pinned: true });
    expect(store.list().map((m) => m.id)).toEqual([b.id, c.id, a.id]);

    expect(store.list({ query: 'ALPHA' }).map((m) => m.id)).toEqual([a.id]);
    expect(store.list({ query: '50%' }).map((m) => m.id)).toEqual([b.id]);
    expect(store.list({ query: '%' }).map((m) => m.id)).toEqual([b.id]);
    expect(store.list({ query: 'nothing' })).toEqual([]);
  });

  it('updates body and pin independently', () => {
    const memo = store.insert({ body: 'a', source: 'user' });
    now = 2_000;
    expect(store.update(memo.id, { pinned: true })).toMatchObject({
      body: 'a',
      pinned: true,
      updatedAt: 2_000,
    });
    expect(store.update(memo.id, { body: 'b' })).toMatchObject({ body: 'b', pinned: true });
    expect(store.update(memo.id, { pinned: false })?.pinned).toBe(false);
    expect(store.update('memo_missing', { body: 'x' })).toBeNull();
  });

  it('soft-deletes into 最近删除 and restores in place', () => {
    const a = store.insert({ body: 'a', source: 'user' });
    now = 2_000;
    const b = store.insert({ body: 'b', source: 'user' });
    now = 3_000;
    const deleted = store.softDelete(a.id);
    expect(deleted).toMatchObject({ id: a.id, deletedAt: 3_000, updatedAt: 1_000 });
    expect(store.softDelete(a.id)).toBeNull();
    expect(store.list().map((m) => m.id)).toEqual([b.id]);
    expect(store.list({ trashed: true }).map((m) => m.id)).toEqual([a.id]);
    expect(store.list({ trashed: true, query: 'zzz' })).toEqual([]);
    expect(store.get(a.id)?.deletedAt).toBe(3_000);

    const restored = store.restore(a.id);
    expect(restored).toMatchObject({ id: a.id, deletedAt: null });
    expect(store.restore(a.id)).toBeNull();
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]);
    expect(store.softDelete('memo_missing')).toBeNull();
  });

  it('purgeTrashed removes only memos trashed before the cutoff', () => {
    const old = store.insert({ body: 'old', source: 'user' });
    const recent = store.insert({ body: 'recent', source: 'user' });
    const live = store.insert({ body: 'live', source: 'user' });
    now = 2_000;
    store.softDelete(old.id);
    now = 5_000;
    store.softDelete(recent.id);
    expect(store.purgeTrashed(2_000)).toBe(0); // strictly before
    expect(store.purgeTrashed(3_000)).toBe(1);
    expect(store.get(old.id)).toBeNull();
    expect(store.get(recent.id)).not.toBeNull();
    expect(store.get(live.id)).not.toBeNull();
    expect(store.purgeTrashed(10_000)).toBe(1);
    expect(store.list({ trashed: true })).toEqual([]);
    expect(store.list().map((m) => m.id)).toEqual([live.id]);
  });
});

describe('SchedulesStore (D90 columns)', () => {
  let db: SqliteDatabase;
  let store: SchedulesStore;
  beforeEach(() => {
    now = 1_000;
    db = openMainDb();
    store = new SchedulesStore(db, clock);
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_g', 'group', null, 0, 0)",
    ).run();
  });

  it('defaults todo_id to null and maps pre-workbench inserts as before', () => {
    const row = store.insert({
      botId: 'bot_1',
      conversationId: 'conv_g',
      kind: 'once',
      runAt: 5_000,
      timezone: 'UTC',
      note: 'n',
      nextFireAt: 5_000,
    });
    expect(row).toMatchObject({ botId: 'bot_1', todoId: null, origin: 'tool', status: 'active' });
  });

  it('stores a workbench schedule with a null bot and a todo link', () => {
    const todos = new TodoStore(db, clock);
    const todo = todos.insert({ title: 't', source: 'user' });
    const row = store.insert({
      botId: null,
      conversationId: 'conv_g',
      kind: 'cron',
      cron: '0 9 * * 5',
      timezone: 'Asia/Shanghai',
      note: 'n',
      title: 't',
      origin: 'workbench',
      todoId: todo.id,
      nextFireAt: 9_000,
    });
    expect(row).toMatchObject({ botId: null, origin: 'workbench', todoId: todo.id });
    expect(store.get(row.id)).toEqual(row);
    expect(store.listActiveForTodo(todo.id).map((r) => r.id)).toEqual([row.id]);
    expect(store.listActiveForTodo('todo_none')).toEqual([]);
    // Bot-keyed queries skip the null-bot row.
    expect(store.listActiveForBot('bot_1')).toEqual([]);
    expect(store.cancelForBotInConversation('bot_1', 'conv_g')).toEqual([]);
    expect(store.listActive().map((r) => r.id)).toEqual([row.id]);
    expect(store.due(9_000).map((r) => r.id)).toEqual([row.id]);
    // Updating through the store keeps the link.
    expect(store.update(row.id, { status: 'cancelled', nextFireAt: null })).toMatchObject({
      todoId: todo.id,
      status: 'cancelled',
    });
    expect(store.listActiveForTodo(todo.id)).toEqual([]);
  });
});
