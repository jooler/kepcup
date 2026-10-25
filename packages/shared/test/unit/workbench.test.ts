import { describe, expect, it } from 'vitest';
import {
  MEMO_BODY_MAX_CHARS,
  MEMO_TRASH_RETENTION_MS,
  RPC_EVENT_NAMES,
  TODO_CLOSED_VISIBLE_MS,
  TODO_NOTES_MAX_CHARS,
  TODO_TITLE_MAX_CHARS,
  isId,
  memoSchema,
  newId,
  rpcEventSchemas,
  rpcMethodSchemas,
  scheduleEntrySchema,
  scheduleOriginSchema,
  scheduleSchema,
  todoAssigneeSchema,
  todoEntrySchema,
  todoRunSchema,
  todoRunStatusSchema,
  todoSchema,
  todoSourceSchema,
  todoStatusSchema,
  APP_RPC_METHODS,
} from '../../src/index.js';

/** D90 工作台契约（todo/workbench.md §12.3）。 */

const todo = {
  id: 'todo_1',
  title: '整理竞品报告',
  notes: '',
  assignee: null,
  status: 'draft',
  source: 'user',
  memoId: null,
  blockedReason: null,
  createdAt: 1,
  updatedAt: 1,
  closedAt: null,
};

const run = {
  id: 'tdr_1',
  todoId: 'todo_1',
  conversationId: 'conv_1',
  messageId: 'msg_1',
  status: 'dispatched',
  resultMessageId: null,
  dispatchedAt: 2,
  settledAt: null,
};

describe('todo schemas', () => {
  it('status / source / run status enums', () => {
    expect(todoStatusSchema.options).toEqual([
      'draft',
      'scheduled',
      'in_progress',
      'delivered',
      'done',
      'cancelled',
    ]);
    expect(todoSourceSchema.options).toEqual(['user', 'butler']);
    expect(todoRunStatusSchema.options).toEqual(['dispatched', 'delivered', 'unclaimed', 'failed']);
  });

  it('assignee is a bot or a project with an optional lead override', () => {
    expect(todoAssigneeSchema.parse({ kind: 'bot', botId: 'bot_1' })).toEqual({
      kind: 'bot',
      botId: 'bot_1',
    });
    expect(
      todoAssigneeSchema.parse({ kind: 'project', projectId: 'conv_1', leadBotId: null }),
    ).toEqual({ kind: 'project', projectId: 'conv_1', leadBotId: null });
    expect(todoAssigneeSchema.safeParse({ kind: 'project', projectId: 'conv_1' }).success).toBe(
      false,
    );
    expect(todoAssigneeSchema.safeParse({ kind: 'bot' }).success).toBe(false);
    expect(todoAssigneeSchema.safeParse({ kind: 'me' }).success).toBe(false);
  });

  it('todo and todo run parse; unknown status is rejected', () => {
    expect(todoSchema.parse(todo)).toEqual(todo);
    expect(todoSchema.safeParse({ ...todo, status: 'running' }).success).toBe(false);
    expect(todoSchema.safeParse({ ...todo, source: 'bot' }).success).toBe(false);
    expect(todoRunSchema.parse(run)).toEqual(run);
    expect(todoRunSchema.safeParse({ ...run, status: 'ok' }).success).toBe(false);
  });

  it('todo entry adds assignee names, schedule and last run', () => {
    const entry = {
      ...todo,
      assignee: { kind: 'project', projectId: 'conv_1', leadBotId: 'bot_1' },
      assigneeName: '产品组',
      leadBotName: '研究员',
      schedule: {
        id: 'sch_1',
        kind: 'cron',
        runAt: null,
        cron: '0 9 * * 5',
        timezone: 'Asia/Shanghai',
        nextFireAt: 10,
      },
      lastRun: run,
      board: null,
    };
    expect(todoEntrySchema.parse(entry)).toEqual(entry);
    expect(
      todoEntrySchema.parse({
        ...todo,
        assigneeName: null,
        leadBotName: null,
        schedule: null,
        lastRun: null,
      }).schedule,
    ).toBeNull();
    expect(todoEntrySchema.safeParse(todo).success).toBe(false);
  });
});

describe('memo schema', () => {
  it('parses live and trashed memos', () => {
    const memo = {
      id: 'memo_1',
      body: '下周和 A 公司谈价',
      pinned: false,
      source: 'butler',
      createdAt: 1,
      updatedAt: 1,
      sortAt: 1,
      deletedAt: null,
    };
    expect(memoSchema.parse(memo)).toEqual(memo);
    expect(memoSchema.parse({ ...memo, deletedAt: 5 }).deletedAt).toBe(5);
    expect(memoSchema.safeParse({ ...memo, pinned: 1 }).success).toBe(false);
  });
});

describe('schedule contract changes', () => {
  const schedule = {
    id: 'sch_1',
    botId: null,
    conversationId: 'conv_1',
    kind: 'once',
    runAt: 1,
    cron: null,
    timezone: 'UTC',
    note: 'n',
    title: 't',
    origin: 'workbench',
    commitmentId: null,
    todoId: 'todo_1',
    status: 'active',
    nextFireAt: 1,
    lastFiredAt: null,
    createdAt: 0,
  };

  it("origin accepts 'workbench', botId is nullable, todoId is required (nullable)", () => {
    expect(scheduleOriginSchema.options).toContain('workbench');
    expect(scheduleSchema.parse(schedule)).toEqual(schedule);
    expect(scheduleSchema.parse({ ...schedule, botId: 'bot_1', todoId: null }).todoId).toBeNull();
    expect(scheduleSchema.safeParse({ ...schedule, origin: 'bogus' }).success).toBe(false);
    const { todoId: _omit, ...withoutTodoId } = schedule;
    expect(scheduleSchema.safeParse(withoutTodoId).success).toBe(false);
    expect(
      scheduleEntrySchema.parse({ ...schedule, botName: null, deferredReason: null }),
    ).toBeTruthy();
  });
});

describe('workbench rpc contract', () => {
  const methods = [
    'todos.list',
    'todos.get',
    'todos.create',
    'todos.update',
    'todos.start',
    'todos.complete',
    'todos.cancel',
    'todos.reopen',
    'memos.list',
    'memos.create',
    'memos.update',
    'memos.delete',
    'memos.restore',
  ] as const;

  it('every method is defined and exposed to the renderer', () => {
    for (const name of methods) {
      expect(rpcMethodSchemas[name]).toBeDefined();
      expect(APP_RPC_METHODS).toContain(name);
    }
  });

  it('todos.create validates title length, notes length and assignee', () => {
    const { input } = rpcMethodSchemas['todos.create'];
    expect(input.parse({ title: 'x' })).toEqual({ title: 'x' });
    expect(
      input.parse({
        title: 'x',
        notes: 'n',
        assignee: { kind: 'bot', botId: 'bot_1' },
        when: 'now',
        memoId: 'memo_1',
      }).when,
    ).toBe('now');
    expect(input.parse({ title: 'x', assignee: null, when: null }).assignee).toBeNull();
    expect(input.safeParse({ title: '' }).success).toBe(false);
    expect(input.safeParse({ title: 'x'.repeat(TODO_TITLE_MAX_CHARS + 1) }).success).toBe(false);
    expect(
      input.safeParse({ title: 'x', notes: 'n'.repeat(TODO_NOTES_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(input.safeParse({ title: 'x', assignee: { kind: 'bot' } }).success).toBe(false);
  });

  it('todos.update distinguishes omitted from null', () => {
    const { input } = rpcMethodSchemas['todos.update'];
    const omitted = input.parse({ id: 'todo_1', title: 'y' });
    expect('assignee' in omitted).toBe(false);
    expect('when' in omitted).toBe(false);
    const cleared = input.parse({ id: 'todo_1', assignee: null, when: null });
    expect(cleared.assignee).toBeNull();
    expect(cleared.when).toBeNull();
    expect(input.safeParse({ title: 'y' }).success).toBe(false);
  });

  it('todos outputs carry the entry (and warnings for create / update)', () => {
    const entry = {
      ...todo,
      assigneeName: null,
      leadBotName: null,
      schedule: null,
      lastRun: null,
      board: null,
    };
    expect(rpcMethodSchemas['todos.create'].output.parse({ todo: entry, warnings: ['w'] })).toEqual(
      {
        todo: entry,
        warnings: ['w'],
      },
    );
    expect(rpcMethodSchemas['todos.create'].output.safeParse({ todo: entry }).success).toBe(false);
    expect(
      rpcMethodSchemas['todos.get'].output.parse({ todo: entry, runs: [run] }).runs,
    ).toHaveLength(1);
    expect(rpcMethodSchemas['todos.start'].output.parse({ todo: entry })).toEqual({ todo: entry });
    expect(rpcMethodSchemas['todos.list'].input.parse({})).toEqual({});
    expect(rpcMethodSchemas['todos.list'].input.safeParse({ statuses: ['bogus'] }).success).toBe(
      false,
    );
  });

  it('memos methods validate body bounds', () => {
    expect(rpcMethodSchemas['memos.create'].input.parse({ body: 'a' })).toEqual({ body: 'a' });
    expect(rpcMethodSchemas['memos.create'].input.safeParse({ body: '' }).success).toBe(false);
    expect(
      rpcMethodSchemas['memos.create'].input.safeParse({
        body: 'a'.repeat(MEMO_BODY_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(rpcMethodSchemas['memos.update'].input.parse({ id: 'memo_1', pinned: true })).toEqual({
      id: 'memo_1',
      pinned: true,
    });
    expect(rpcMethodSchemas['memos.list'].input.parse({ trashed: true })).toEqual({
      trashed: true,
    });
  });

  it('changed events are registered', () => {
    expect(RPC_EVENT_NAMES).toContain('todos.changed');
    expect(RPC_EVENT_NAMES).toContain('memos.changed');
    expect(rpcEventSchemas['todos.changed'].parse({ todoId: 'todo_1' })).toEqual({
      todoId: 'todo_1',
    });
    expect(rpcEventSchemas['memos.changed'].safeParse({}).success).toBe(false);
  });
});

describe('workbench ids and constants', () => {
  it('ids use their own prefixes (memo_ is not mem_)', () => {
    expect(isId('todo', newId('todo'))).toBe(true);
    expect(newId('tdr').startsWith('tdr_')).toBe(true);
    expect(newId('memo').startsWith('memo_')).toBe(true);
    expect(isId('mem', newId('memo'))).toBe(false);
  });

  it('constants', () => {
    expect(TODO_TITLE_MAX_CHARS).toBe(120);
    expect(TODO_NOTES_MAX_CHARS).toBe(4000);
    expect(MEMO_BODY_MAX_CHARS).toBe(10_000);
    expect(MEMO_TRASH_RETENTION_MS).toBe(30 * 24 * 3600_000);
    expect(TODO_CLOSED_VISIBLE_MS).toBe(7 * 24 * 3600_000);
  });
});
