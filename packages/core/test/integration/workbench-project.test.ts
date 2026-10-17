import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Message, Run, TodoEntry } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  listRuns,
  makeBot,
  makeProject,
  step,
  waitFor,
  type TestStack,
} from '@kepcup/testkit';
import { openDatabase as openSqlite, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * WP4 §4.3（D92 T1a）：事项派给项目组总是结构化 @ 实际生效的负责 Bot
 * （assignee 覆盖项 ?? 项目负责人），不经路由；覆盖项不是成员校验失败；
 * 项目组只读后退回草案并带新文案；main 0042 列改名且值保留。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

async function getTodo(stack: TestStack, id: string): Promise<TodoEntry> {
  const result = (await stack.core.rpc.call('todos.get', { id })) as { todo: TodoEntry };
  return result.todo;
}

async function createTodo(
  stack: TestStack,
  input: Record<string, unknown>,
): Promise<TodoEntry> {
  const result = (await stack.core.rpc.call('todos.create', input)) as { todo: TodoEntry };
  return result.todo;
}

async function dispatchMessageOf(stack: TestStack, conversationId: string): Promise<Message> {
  return waitFor(
    async () =>
      (await listAllMessages(stack.core, conversationId)).find(
        (m) => (m.content as { origin?: string }).origin === 'workbench',
      ) ?? null,
    { label: 'workbench dispatch message' },
  );
}

function turnRuns(runs: Run[]): Run[] {
  return runs.filter((run) => run.loopType === 'turn');
}

describe('派发给项目组（WP4 §4.3）', () => {
  it('覆盖项不是成员 / 项目组不存在：todos.create 校验失败', async () => {
    const stack = await start();
    const { core } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const outsider = await makeBot(core, '组外人');
    const conv = await makeProject(core, '项目组', [a.id, b.id]);

    await expect(
      core.rpc.call('todos.create', {
        title: '给外人的活',
        assignee: { kind: 'project', projectId: conv.id, leadBotId: outsider.id },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      core.rpc.call('todos.create', {
        title: '给空项目的活',
        assignee: { kind: 'project', projectId: 'conv_missing', leadBotId: null },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 30_000);

  it('未指定覆盖项：派发 @ 项目负责人、不经路由（没有 routing_gate / continuation 轮）', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeProject(core, '项目组', [a.id, b.id]);
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('【工作台】盘点的活'))
        .replyText('盘点完成。'),
    ]);

    const todo = await createTodo(stack, {
      title: '盘点的活',
      assignee: { kind: 'project', projectId: conv.id, leadBotId: null },
      when: 'now',
    });
    const message = await dispatchMessageOf(stack, conv.id);
    // 项目必有负责人：结构化 @ 落在项目负责人身上。
    expect(message.mentions).toEqual([a.id]);
    await waitFor(
      async () => ((await getTodo(stack, todo.id)).status === 'delivered' ? true : null),
      { label: 'todo delivered' },
    );
    const runs = turnRuns(await listRuns(core, conv.id));
    expect(runs.map((run) => [run.botId, run.triggerReason])).toEqual([[a.id, 'mention']]);
    // 不经路由：没有负责人网关轮，也没有续接判断轮。
    expect(runs.some((run) => run.triggerReason === 'routing_gate')).toBe(false);
    expect(runs.some((run) => run.triggerReason === 'continuation')).toBe(false);
    expect(runs.some((run) => run.botId === b.id)).toBe(false);
  }, 30_000);

  it('指定覆盖项：@ 覆盖的负责 Bot（不是项目负责人）', async () => {
    const stack = await start();
    const { core, llm } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeProject(core, '项目组', [a.id, b.id]);
    llm.script('mock-main', [
      step()
        .expect((r) => r.lastUserText().includes('【工作台】插队的活'))
        .replyText('阿乙做完了。'),
    ]);

    const todo = await createTodo(stack, {
      title: '插队的活',
      assignee: { kind: 'project', projectId: conv.id, leadBotId: b.id },
      when: 'now',
    });
    const message = await dispatchMessageOf(stack, conv.id);
    expect(message.mentions).toEqual([b.id]);
    await waitFor(
      async () => ((await getTodo(stack, todo.id)).status === 'delivered' ? true : null),
      { label: 'todo delivered' },
    );
    const runs = turnRuns(await listRuns(core, conv.id));
    expect(runs.map((run) => [run.botId, run.triggerReason])).toEqual([[b.id, 'mention']]);
    expect(runs.some((run) => run.botId === a.id)).toBe(false);
  }, 30_000);

  it('项目组变只读：不能再派发（CONVERSATION_READ_ONLY），对账把已排期事项退回草案「项目组已解散」', async () => {
    const stack = await start();
    const { core } = stack;
    const a = await makeBot(core, '阿甲');
    const b = await makeBot(core, '阿乙');
    const conv = await makeProject(core, '要只读的项目组', [a.id, b.id]);
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const todo = await createTodo(stack, {
      title: '排期的活',
      assignee: { kind: 'project', projectId: conv.id, leadBotId: null },
      when,
    });
    expect(todo.status).toBe('scheduled');

    // 只读（项目组被删后的残留形态；executorProblem 对 只读 / 不存在 用同一文案）。
    stack.core.services.domain!.conversations.setReadOnly(conv.id, true);
    await expect(core.rpc.call('todos.start', { id: todo.id })).rejects.toMatchObject({
      code: 'CONVERSATION_READ_ONLY',
    });
    // 对账（启动 / schedules.changed / 删除时也会跑）把无法执行的事项退回草案。
    stack.core.services.todos!.reconcile();
    const draft = await waitFor(
      async () => {
        const current = await getTodo(stack, todo.id);
        return current.status === 'draft' ? current : null;
      },
      { label: 'todo back to draft' },
    );
    expect(draft.blockedReason).toBe('项目组已解散');
    expect(draft.schedule).toBeNull();
  }, 30_000);
});

// --- main 0042 迁移 -----------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), 'todos-assignee-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openSqlite({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
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

describe('main 0042 assignee_project（WP4 §4.3）', () => {
  it('assignee_group_id 改名 assignee_project_id，值保留', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(41));

    db.prepare(
      `insert into todos (id, title, notes, assignee_bot_id, assignee_group_id, status, source,
         blocked_reason, created_at, updated_at)
       values ('todo_1', '标题', '', 'bot_a', 'conv_p', 'draft', 'user', null, 0, 0)`,
    ).run();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([42]);

    const columns = (
      db.prepare('pragma table_info(todos)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain('assignee_project_id');
    expect(columns).not.toContain('assignee_group_id');

    const row = db.prepare('select * from todos where id = ?').get('todo_1') as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ assignee_bot_id: 'bot_a', assignee_project_id: 'conv_p' });
    db.close();
  });
});
