import Database from 'better-sqlite3-multiple-ciphers';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMO_TRASH_RETENTION_MS,
  TODO_CLOSED_VISIBLE_MS,
  TODO_NOTES_MAX_CHARS,
  TODO_TITLE_MAX_CHARS,
  todoStatusSchema,
  type Message,
  type TodoAssignee,
  type TodoStatus,
} from '@kepcup/shared';
import { TestClock } from '@kepcup/testkit';
import { runMigrations } from '../../src/infra/migrate.js';
import type { SqliteDatabase } from '../../src/infra/db.js';
import type { JobRow } from '../../src/domain/jobs.js';
import { ScheduleService } from '../../src/schedule/service.js';
import {
  BLOCKED_BOT_DELETED,
  BLOCKED_CONVERSATION_DELETED,
  BLOCKED_CONVERSATION_GONE,
  BLOCKED_PROJECT_GONE,
  BLOCKED_HELD,
  BLOCKED_LEAD_DELETED,
  BLOCKED_LEAD_LEFT,
  BLOCKED_SCHEDULE_CANCELLED,
  BLOCKED_UNCLAIMED,
  TODO_TRANSITIONS,
  TodoService,
  canTransitionTodo,
  humanizeRunError,
} from '../../src/workbench/todo-service.js';
import { MemoService } from '../../src/workbench/memo-service.js';

/**
 * 工作台事项 / 备忘服务（D90，单元）：真实 TodoService + ScheduleService + 迁移后的内存库，
 * Bot / 对话 / 编排器 / 作业队列用最小桩。覆盖状态机迁移表、入参校验与 `when` 口径、排期与
 * 改期 / 改派、派发文案、到点派发（不受主动消息护栏）、对账、交付结算与备忘软删。
 */

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
const mainMigrations = fileURLToPath(new URL('../../migrations/main/', import.meta.url));
const openDbs: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

interface StubBot {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  profile: {
    identity: { name: string };
    behavior: {
      proactive: boolean;
      quiet_hours: [string, string] | null;
      max_proactive_per_day: number | null;
    };
  };
}

interface StubConversation {
  id: string;
  type: 'direct' | 'project';
  title: string | null;
  directBotId: string | null;
  leadBotId?: string | null;
  readOnly: boolean;
}

interface UpdateCall {
  conversationId: string;
  text: string;
  todoId: string;
  todoRunId: string;
  viaButler: boolean;
  butlerDrafted: boolean;
  dispatchMessageId: string | null;
}

interface DispatchCall {
  conversationId: string;
  text: string;
  todoId: string;
  todoRunId: string;
  viaButler: boolean;
  butlerDrafted: boolean;
  leadBotId: string | null;
}

function makeRig() {
  const db = new Database(':memory:') as SqliteDatabase;
  db.pragma('foreign_keys = ON');
  runMigrations(db, mainMigrations);
  openDbs.push(db);
  const clock = new TestClock();
  const bots = new Map<string, StubBot>();
  const conversations = new Map<string, StubConversation>();
  const members = new Map<string, string[]>();
  const published: Array<{ event: string; payload: unknown }> = [];
  const dispatched: DispatchCall[] = [];
  const updates: UpdateCall[] = [];
  const enqueued: Array<{ type: string; payload: unknown }> = [];
  const flags = {
    hasModel: true,
    failDispatch: false,
    failUpdate: false,
    nobodyYet: false,
    held: false,
    /** Runs inside the dispatcher after the message was appended (before routing returns). */
    onDispatch: null as null | ((call: DispatchCall) => void),
  };
  const pendingJobs: Array<{ id: string; type: string }> = [];
  const cancelledJobs: string[] = [];
  let messageSeq = 0;

  const insertConversation = (conv: StubConversation, leadBotId?: string): void => {
    conversations.set(conv.id, conv);
    db.prepare(
      'insert into conversations (id, type, title, direct_bot_id, lead_bot_id, read_only, created_at) values (?, ?, ?, ?, ?, ?, 0)',
    ).run(
      conv.id,
      conv.type,
      conv.title,
      conv.directBotId,
      leadBotId ?? null,
      conv.readOnly ? 1 : 0,
    );
  };

  const rig = {
    db,
    clock,
    bots,
    conversations,
    members,
    published,
    dispatched,
    updates,
    enqueued,
    pendingJobs,
    cancelledJobs,
    flags,
    addBot(id: string, name = id, behavior: Partial<StubBot['profile']['behavior']> = {}): StubBot {
      const bot: StubBot = {
        id,
        name,
        status: 'active',
        profile: {
          identity: { name },
          behavior: {
            proactive: true,
            quiet_hours: null,
            max_proactive_per_day: null,
            ...behavior,
          },
        },
      };
      bots.set(id, bot);
      db.prepare(
        "insert into bots (id, name, profile_json, status, created_at, updated_at) values (?, ?, '{}', 'active', 0, 0)",
      ).run(id, name);
      return bot;
    },
    addGroup(id: string, title: string, memberIds: string[]): StubConversation {
      // The lead defaults to the first member (D92 T1a: the row-level lead is
      // what a no-override workbench dispatch @-mentions).
      const [firstMember] = memberIds;
      const conv: StubConversation = {
        id,
        type: 'project',
        title,
        directBotId: null,
        leadBotId: firstMember ?? null,
        readOnly: false,
      };
      insertConversation(conv, firstMember);
      members.set(id, memberIds);
      return conv;
    },
    /** Deletes the conversation row for real (the group FK is ON DELETE SET NULL). */
    removeConversation(id: string): void {
      todos.onConversationDeleting(id);
      schedules.deleteForConversation(id);
      db.prepare('delete from conversations where id = ?').run(id);
      conversations.delete(id);
    },
    deleteBot(id: string): void {
      bots.get(id)!.status = 'deleted';
    },
    lastDispatch(): DispatchCall {
      return dispatched.at(-1)!;
    },
    directIdOf(botId: string): string {
      return conversationsService.openDirect(botId).conversation.id;
    },
  };

  const botsService = { get: (id: string) => bots.get(id) ?? null };
  const conversationsService = {
    get: (id: string) => conversations.get(id) ?? null,
    memberBotIds: (id: string) => members.get(id) ?? [],
    listDirectByBot: (botId: string) =>
      [...conversations.values()].filter((c) => c.directBotId === botId),
    openDirect: (botId: string) => {
      const existing = [...conversations.values()].find(
        (c) => c.directBotId === botId && !c.readOnly,
      );
      if (existing) return { conversation: existing, created: false };
      const conv: StubConversation = {
        id: `conv_direct_${botId}`,
        type: 'direct',
        title: null,
        directBotId: botId,
        readOnly: false,
      };
      insertConversation(conv);
      members.set(conv.id, [botId]);
      return { conversation: conv, created: true };
    },
  };
  const publish = (event: string, payload: unknown): void => {
    published.push({ event, payload });
    // The real bus: ScheduleService events reach TodoService.reconcile (start.ts).
    if (event === 'schedules.changed') todos.reconcile();
  };

  const schedules: ScheduleService = new ScheduleService({
    db,
    runsDb: {} as never,
    clock,
    timers: clock,
    logger,
    timeZone: 'UTC',
    bots: botsService as never,
    conversations: conversationsService as never,
    jobs: {
      enqueue: (input: { type: string; payload: unknown }) => {
        enqueued.push(input);
        return 'job_1';
      },
      pendingByDedupePrefix: () => pendingJobs,
      cancelPending: (id: string) => {
        cancelledJobs.push(id);
      },
    } as never,
    runs: {} as never,
    memory: {} as never,
    orchestrator: {} as never,
    publish,
  });
  const todos: TodoService = new TodoService({
    db,
    clock,
    logger,
    bots: botsService as never,
    conversations: conversationsService as never,
    schedules,
    timeZone: 'UTC',
    dispatcher: {
      dispatch: (input) => {
        if (flags.failDispatch) throw new Error('dispatch exploded');
        const call: DispatchCall = {
          conversationId: input.conversationId,
          text: input.text,
          todoId: input.todoId,
          todoRunId: input.todoRunId,
          viaButler: input.viaButler,
          butlerDrafted: input.butlerDrafted,
          leadBotId: input.leadBotId,
        };
        dispatched.push(call);
        messageSeq += 1;
        const message = { id: `msg_${messageSeq}` } as Message;
        input.onAppended?.(message);
        flags.onDispatch?.(call);
        return { message, runId: null, held: flags.held };
      },
      dispatchUpdate: (input) => {
        if (flags.failUpdate) throw new Error('update exploded');
        // Nobody to tell yet (a group dispatch not taken up): nothing sent.
        if (flags.nobodyYet) return null;
        updates.push({ ...input });
        messageSeq += 1;
        return { message: { id: `msg_${messageSeq}` } as Message };
      },
      hasTurnModel: () => flags.hasModel,
    },
    publish,
    timers: clock,
  });
  schedules.attachWorkbench(todos);
  schedules.start();

  /** Fires the due schedule jobs the timer enqueued (what jobs-runner does). */
  const fireDue = async (): Promise<void> => {
    const jobs = enqueued.splice(0);
    for (const job of jobs) {
      await schedules.runFireJob({ payload_json: JSON.stringify(job.payload) } as JobRow);
    }
  };

  return { ...rig, schedules, todos, fireDue };
}

type Rig = ReturnType<typeof makeRig>;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
  return 'NO_ERROR';
}

function botAssignee(botId: string): TodoAssignee {
  return { kind: 'bot', botId };
}

function futureIso(rig: Rig, ms = 3_600_000): string {
  return new Date(rig.clock.now() + ms).toISOString();
}

/** A todo forced into `status` (store-level; the service moves are tested separately). */
function todoInStatus(rig: Rig, status: TodoStatus, options: { assignee?: boolean } = {}) {
  if (!rig.bots.has('bot_a')) rig.addBot('bot_a', '阿甲');
  const created = rig.todos.create({
    title: '写周报',
    ...(options.assignee === false ? {} : { assignee: botAssignee('bot_a') }),
  });
  if (status !== 'draft') {
    rig.todos.store.update(created.todo.id, {
      status,
      closedAt: status === 'done' || status === 'cancelled' ? rig.clock.now() : null,
    });
  }
  return created.todo.id;
}

describe('工作台事项：状态机迁移表', () => {
  const statuses = todoStatusSchema.options;

  it('迁移表覆盖全部 6 个状态，且与 canTransitionTodo 一致（表驱动）', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionTodo(from, to), `${from} → ${to}`).toBe(
          TODO_TRANSITIONS[from].includes(to),
        );
      }
    }
    expect(TODO_TRANSITIONS.done).toEqual(['draft']);
    expect(TODO_TRANSITIONS.cancelled).toEqual(['draft']);
    // 待验收不自动完成：只有用户的 complete 才到 done，delivered 不能直接退回草案。
    expect(canTransitionTodo('delivered', 'draft')).toBe(false);
  });

  // [操作, 各状态下是否允许]
  const matrix: Array<[string, (rig: Rig, id: string) => unknown, TodoStatus[]]> = [
    ['start', (rig, id) => rig.todos.start(id), ['draft', 'scheduled']],
    ['complete', (rig, id) => rig.todos.complete(id), ['in_progress', 'delivered']],
    [
      'cancel',
      (rig, id) => rig.todos.cancel(id),
      ['draft', 'scheduled', 'in_progress', 'delivered'],
    ],
    ['reopen', (rig, id) => rig.todos.reopen(id), ['done', 'cancelled']],
    [
      'update title',
      (rig, id) => rig.todos.update(id, { title: '改个标题' }),
      ['draft', 'scheduled', 'in_progress', 'delivered'],
    ],
  ];
  for (const [name, run, allowed] of matrix) {
    for (const status of statuses) {
      const ok = allowed.includes(status);
      it(`${name} 在「${status}」${ok ? '允许' : '被拒绝（INVALID_INPUT）'}`, () => {
        const rig = makeRig();
        const id = todoInStatus(rig, status);
        if (ok) {
          expect(codeOf(() => run(rig, id))).toBe('NO_ERROR');
        } else {
          expect(codeOf(() => run(rig, id))).toBe('INVALID_INPUT');
        }
      });
    }
  }

  it('每次迁移的落点：start → in_progress；complete → done 并记 closedAt；cancel → cancelled；reopen → draft 并清 closedAt', () => {
    const rig = makeRig();
    const id = todoInStatus(rig, 'draft');
    expect(rig.todos.start(id).status).toBe('in_progress');
    const done = rig.todos.complete(id);
    expect(done.status).toBe('done');
    expect(done.closedAt).toBe(rig.clock.now());
    const reopened = rig.todos.reopen(id);
    expect(reopened).toMatchObject({ status: 'draft', closedAt: null });
    expect(rig.todos.cancel(id)).toMatchObject({ status: 'cancelled', closedAt: rig.clock.now() });
    expect(rig.todos.reopen(id).status).toBe('draft');
  });

  it('没有执行者的草案不能立即开始', () => {
    const rig = makeRig();
    const id = todoInStatus(rig, 'draft', { assignee: false });
    expect(codeOf(() => rig.todos.start(id))).toBe('INVALID_INPUT');
    expect(rig.dispatched).toHaveLength(0);
  });

  it('已派发（进行中 / 待验收）的事项不能改派或改期', () => {
    const rig = makeRig();
    rig.addBot('bot_b', '阿乙');
    for (const status of ['in_progress', 'delivered'] as const) {
      const id = todoInStatus(rig, status);
      expect(codeOf(() => rig.todos.update(id, { assignee: botAssignee('bot_b') }))).toBe(
        'INVALID_INPUT',
      );
      expect(codeOf(() => rig.todos.update(id, { when: futureIso(rig) }))).toBe('INVALID_INPUT');
    }
  });
});

describe('工作台事项：创建与入参校验', () => {
  it('标题必填且 ≤ 120 字，说明 ≤ 4000 字', () => {
    const rig = makeRig();
    expect(codeOf(() => rig.todos.create({ title: '   ' }))).toBe('INVALID_INPUT');
    expect(codeOf(() => rig.todos.create({ title: 'x'.repeat(TODO_TITLE_MAX_CHARS + 1) }))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(() => rig.todos.create({ title: 'x'.repeat(TODO_TITLE_MAX_CHARS) }))).toBe(
      'NO_ERROR',
    );
    expect(
      codeOf(() => rig.todos.create({ title: 'a', notes: 'n'.repeat(TODO_NOTES_MAX_CHARS + 1) })),
    ).toBe('INVALID_INPUT');
  });

  it('只写标题 = 草案：无执行者、无排期、source 默认 user', () => {
    const rig = makeRig();
    const { todo, warnings } = rig.todos.create({ title: ' 调研  竞品 ' });
    expect(todo).toMatchObject({
      title: '调研 竞品',
      notes: '',
      assignee: null,
      status: 'draft',
      source: 'user',
      schedule: null,
      lastRun: null,
      assigneeName: null,
    });
    expect(warnings).toEqual([]);
  });

  it('有时间必须有执行者；when 无法解析 / 在过去被拒绝，且不留下半成品', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    expect(codeOf(() => rig.todos.create({ title: 't', when: futureIso(rig) }))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(() => rig.todos.create({ title: 't', when: 'now' }))).toBe('INVALID_INPUT');
    expect(
      codeOf(() =>
        rig.todos.create({ title: 't', assignee: botAssignee('bot_a'), when: 'not a cron' }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: botAssignee('bot_a'),
          when: new Date(rig.clock.now() - 1000).toISOString(),
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(rig.todos.list({ includeClosed: true })).toHaveLength(0);
  });

  it('执行者校验：Bot 须 active；项目组须存在、未只读；负责 Bot 须是 active 成员', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addBot('bot_out', '外人');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    rig.deleteBot('bot_b');
    expect(codeOf(() => rig.todos.create({ title: 't', assignee: botAssignee('bot_b') }))).toBe(
      'NOT_FOUND',
    );
    expect(codeOf(() => rig.todos.create({ title: 't', assignee: botAssignee('nope') }))).toBe(
      'NOT_FOUND',
    );
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: { kind: 'project', projectId: 'conv_none', leadBotId: null },
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_out' },
        }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
        }),
      ),
    ).toBe('NOT_FOUND');
    rig.conversations.get('conv_g')!.readOnly = true;
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
        }),
      ),
    ).toBe('CONVERSATION_READ_ONLY');
    // 单聊的 id 不能当「项目组」用。
    rig.todos.create({ title: 'ok', assignee: botAssignee('bot_a') });
    expect(
      codeOf(() =>
        rig.todos.create({
          title: 't',
          assignee: { kind: 'project', projectId: rig.directIdOf('bot_a'), leadBotId: null },
        }),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('memoId 必须指向存在的备忘，并记入事项', () => {
    const rig = makeRig();
    expect(codeOf(() => rig.todos.create({ title: 't', memoId: 'memo_none' }))).toBe('NOT_FOUND');
    const memos = new MemoService({ store: rig.todos.memos, clock: rig.clock, logger });
    const memo = memos.create({ body: '下周和 A 公司谈价' });
    expect(rig.todos.create({ title: '谈价', memoId: memo.id }).todo.memoId).toBe(memo.id);
  });

  it('警告（只提示不拦截）：执行者没有可用模型；排期落在免打扰时段，但没有「主动消息」警告', () => {
    const rig = makeRig();
    rig.addBot('bot_q', '阿静', { proactive: false, quiet_hours: ['00:00', '00:00'] });
    rig.flags.hasModel = false;
    const draft = rig.todos.create({ title: '早报', assignee: botAssignee('bot_q') });
    expect(draft.warnings.join('\n')).toContain('未配置模型');
    const scheduled = rig.todos.create({
      title: '深夜整理',
      assignee: botAssignee('bot_q'),
      when: futureIso(rig),
    });
    const text = scheduled.warnings.join('\n');
    expect(text).toContain('免打扰');
    expect(text).toContain('不受免打扰限制');
    expect(text).not.toContain('主动消息');
    expect(scheduled.todo.status).toBe('scheduled');
  });
});

describe('工作台事项：排期、改期、改派', () => {
  it('一次性：建 origin=workbench 的排期并停在 scheduled；周期：cron 排期', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const iso = futureIso(rig);
    const once = rig.todos.create({
      title: '周报',
      notes: '汇总本周',
      assignee: botAssignee('bot_a'),
      when: iso,
    }).todo;
    expect(once.status).toBe('scheduled');
    expect(once.schedule).toMatchObject({
      kind: 'once',
      runAt: Date.parse(iso),
      nextFireAt: Date.parse(iso),
    });
    const row = rig.schedules.store.get(once.schedule!.id)!;
    expect(row).toMatchObject({
      origin: 'workbench',
      todoId: once.id,
      botId: 'bot_a',
      conversationId: rig.directIdOf('bot_a'),
      title: '周报',
      note: '汇总本周',
      status: 'active',
    });

    const weekly = rig.todos.create({
      title: '日报',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * 1-5',
    }).todo;
    expect(weekly.schedule).toMatchObject({ kind: 'cron', cron: '0 9 * * 1-5' });
    expect(rig.schedules.store.listActiveForTodo(weekly.id)).toHaveLength(1);
  });

  it('改期原地更新同一条 schedule（不取消重建），一次性 ↔ 周期可互换', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const scheduleId = todo.schedule!.id;
    const later = futureIso(rig, 7_200_000);
    const moved = rig.todos.update(todo.id, { when: later }).todo;
    expect(moved.schedule).toMatchObject({ id: scheduleId, runAt: Date.parse(later) });
    const cron = rig.todos.update(todo.id, { when: '30 8 * * *' }).todo;
    expect(cron.schedule).toMatchObject({
      id: scheduleId,
      kind: 'cron',
      cron: '30 8 * * *',
      runAt: null,
    });
    expect(rig.schedules.store.get(scheduleId)!.kind).toBe('cron');
    expect(rig.schedules.store.listActiveForTodo(todo.id)).toHaveLength(1);
    // 总共只有一条 schedule 行。
    expect((rig.db.prepare('select count(*) as n from schedules').get() as { n: number }).n).toBe(
      1,
    );
  });

  it('改派：旧排期取消，在新目标建新排期并沿用原时间；原时间已过则退回草案', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const oldId = todo.schedule!.id;
    const moved = rig.todos.update(todo.id, { assignee: botAssignee('bot_b') }).todo;
    expect(moved.status).toBe('scheduled');
    expect(moved.schedule!.id).not.toBe(oldId);
    expect(moved.schedule!.runAt).toBe(todo.schedule!.runAt);
    expect(rig.schedules.store.get(oldId)!.status).toBe('cancelled');
    expect(rig.schedules.store.get(moved.schedule!.id)).toMatchObject({
      botId: 'bot_b',
      conversationId: rig.directIdOf('bot_b'),
    });

    // 草案改派只是换人。
    const draft = rig.todos.create({ title: '草案', assignee: botAssignee('bot_a') }).todo;
    expect(rig.todos.update(draft.id, { assignee: botAssignee('bot_b') }).todo.assignee).toEqual(
      botAssignee('bot_b'),
    );

    // 原定时间在应用关闭期间已过：不能原样搬，退回草案并写明原因。
    rig.clock.advance(7_200_000);
    rig.enqueued.length = 0;
    const stale = rig.todos.get(todo.id).todo;
    expect(stale.status).toBe('scheduled');
    rig.addBot('bot_c', '阿丙');
    const back = rig.todos.update(todo.id, { assignee: botAssignee('bot_c') }).todo;
    expect(back.status).toBe('draft');
    expect(back.blockedReason).toContain('时间已过');
  });

  it('已排期事项改派时同时带 assignee 与 when：在新执行者处按新时间重建，旧排期取消（回执卡「已改派」）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const later = futureIso(rig, 10_800_000);
    const moved = rig.todos.update(todo.id, { assignee: botAssignee('bot_b'), when: later }).todo;
    expect(moved).toMatchObject({ status: 'scheduled', assigneeName: '阿乙' });
    expect(moved.schedule).toMatchObject({ runAt: Date.parse(later) });
    expect(moved.schedule!.id).not.toBe(todo.schedule!.id);
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('cancelled');
    expect(rig.schedules.store.get(moved.schedule!.id)).toMatchObject({
      botId: 'bot_b',
      conversationId: rig.directIdOf('bot_b'),
    });
    // 退回草案（界面的「退回草案」）：update({when:null}) 取消排期、保留执行者。
    const back = rig.todos.update(todo.id, { when: null }).todo;
    expect(back).toMatchObject({ status: 'draft', schedule: null, assignee: botAssignee('bot_b') });
    expect(rig.schedules.store.listActiveForTodo(todo.id)).toHaveLength(0);
  });

  it("assignee:null 清执行者并连带清排期；when:null 清排期；when:'now' 取消排期并立即派发", () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const a = rig.todos.create({
      title: 'a',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    const cleared = rig.todos.update(a.id, { assignee: null }).todo;
    expect(cleared).toMatchObject({ status: 'draft', assignee: null, schedule: null });
    expect(rig.schedules.store.listActiveForTodo(a.id)).toHaveLength(0);
    // 清执行者的同时给时间：时间与执行者相互独立，时间记成待指派的意图。
    const whenIso = futureIso(rig);
    const clearedWithWhen = rig.todos.update(a.id, { assignee: null, when: whenIso }).todo;
    expect(clearedWithWhen).toMatchObject({
      status: 'draft',
      assignee: null,
      pendingWhen: whenIso,
      schedule: { kind: 'once', runAt: Date.parse(whenIso) },
    });
    expect(rig.schedules.store.listActiveForTodo(a.id)).toHaveLength(0);

    const b = rig.todos.create({
      title: 'b',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    expect(rig.todos.update(b.id, { when: null }).todo).toMatchObject({
      status: 'draft',
      schedule: null,
    });

    const c = rig.todos.create({
      title: 'c',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    const started = rig.todos.update(c.id, { when: 'now' }).todo;
    expect(started).toMatchObject({ status: 'in_progress', schedule: null });
    expect(rig.dispatched.filter((d) => d.todoId === c.id)).toHaveLength(1);
    // 「立即执行一次」落到对话里派发，仍然离不开执行者。
    const d = rig.todos.create({ title: 'd' }).todo;
    expect(codeOf(() => rig.todos.update(d.id, { when: 'now' }))).toBe('INVALID_INPUT');
  });

  it('未指派先定时间（看板）：意图停在 pendingWhen，指派完成即建排期', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const whenIso = futureIso(rig);
    const a = rig.todos.create({ title: 'a' }).todo;
    expect(a).toMatchObject({ status: 'draft', assignee: null, pendingWhen: null, schedule: null });

    const pending = rig.todos.update(a.id, { when: whenIso }).todo;
    expect(pending).toMatchObject({
      status: 'draft',
      assignee: null,
      pendingWhen: whenIso,
      schedule: { kind: 'once', runAt: Date.parse(whenIso), nextFireAt: Date.parse(whenIso) },
    });
    expect(rig.schedules.store.listActiveForTodo(a.id)).toHaveLength(0);

    // 指派完成：把意图落成真正的排期。
    const assigned = rig.todos.update(a.id, { assignee: botAssignee('bot_a') }).todo;
    expect(assigned).toMatchObject({
      status: 'scheduled',
      assignee: botAssignee('bot_a'),
      pendingWhen: null,
    });
    expect(assigned.schedule).toMatchObject({ kind: 'once', runAt: Date.parse(whenIso) });
    expect(rig.schedules.store.listActiveForTodo(a.id)).toHaveLength(1);

    // 清时间连意图一起清掉。
    const cleared = rig.todos.update(a.id, { assignee: null }).todo;
    expect(cleared.pendingWhen).toBeNull();
    const repending = rig.todos.update(a.id, { when: whenIso, assignee: null }).todo;
    expect(repending.pendingWhen).toBe(whenIso);
    expect(rig.todos.update(repending.id, { when: null }).todo).toMatchObject({
      pendingWhen: null,
    });
  });

  it('pendingWhen 只属于「未指派草案」：显式排期、取消/重开都会清掉它', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');

    // 指派与时间同一次提交：新时间直接落成排期，旧的 pending 不得残留。
    const a = rig.todos.create({ title: 'a' }).todo;
    const first = futureIso(rig);
    expect(rig.todos.update(a.id, { when: first }).todo.pendingWhen).toBe(first);
    const second = futureIso(rig, 7_200_000);
    const scheduled = rig.todos.update(a.id, {
      assignee: botAssignee('bot_a'),
      when: second,
    }).todo;
    expect(scheduled).toMatchObject({ status: 'scheduled', pendingWhen: null });
    expect(scheduled.schedule?.runAt).toBe(Date.parse(second));

    // 取消后重开：取消过的意图不能复活。
    const b = rig.todos.create({ title: 'b' }).todo;
    rig.todos.update(b.id, { when: futureIso(rig) });
    rig.todos.cancel(b.id);
    expect(rig.todos.reopen(b.id)).toMatchObject({
      status: 'draft',
      pendingWhen: null,
      schedule: null,
    });
    expect(rig.todos.update(b.id, { assignee: botAssignee('bot_a') }).todo).toMatchObject({
      status: 'draft',
      schedule: null,
    });
  });

  it('待指派时间到点后才指派：退回草案并说明原定时间已过', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const a = rig.todos.create({ title: 'a' }).todo;
    rig.todos.update(a.id, { when: futureIso(rig, 60_000) });
    rig.clock.advance(120_000);

    const assigned = rig.todos.update(a.id, { assignee: botAssignee('bot_a') }).todo;
    expect(assigned).toMatchObject({
      status: 'draft',
      assignee: botAssignee('bot_a'),
      pendingWhen: null,
      schedule: null,
    });
    expect(assigned.blockedReason).toContain('原定时间已过');
    expect(rig.schedules.store.listActiveForTodo(a.id)).toHaveLength(0);
  });

  it('待指派 cron 的预览时区来自服务配置（与真正排期一致）', () => {
    const rig = makeRig();
    const a = rig.todos.create({ title: 'a' }).todo;
    const pending = rig.todos.update(a.id, { when: '0 9 * * *' }).todo;
    expect(pending.schedule).toMatchObject({ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' });
    expect(typeof pending.schedule?.nextFireAt).toBe('number');
  });

  it('改标题 / 说明同步到排期行', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '旧标题',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    rig.todos.update(todo.id, { title: '新标题', notes: '新说明' });
    expect(rig.schedules.store.get(todo.schedule!.id)).toMatchObject({
      title: '新标题',
      note: '新说明',
    });
  });

  it('取消事项连带取消排期（回执卡 / 排期行同步）；周期事项取消 = 已停止', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '日报',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    });
    const cancelled = rig.todos.cancel(todo.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.schedule).toBeNull();
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('cancelled');
  });
});

describe('工作台事项：派发', () => {
  it('立即开始：Bot 执行者经 openDirect（新建私聊时发会话事件）派到其私聊，写 todo_runs 与 message_id，事项进行中', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '整理竞品报告',
      notes: '重点看定价',
      assignee: botAssignee('bot_a'),
      when: 'now',
    });
    expect(todo.status).toBe('in_progress');
    const call = rig.lastDispatch();
    expect(call).toMatchObject({
      conversationId: 'conv_direct_bot_a',
      text: '【工作台】整理竞品报告\n\n重点看定价',
      viaButler: false,
      leadBotId: null,
    });
    expect(call.todoId).toBe(todo.id);
    expect(rig.published.some((e) => e.event === 'conversation.updated')).toBe(true);
    const run = rig.todos.store.listRuns(todo.id)[0]!;
    expect(run).toMatchObject({
      id: call.todoRunId,
      conversationId: 'conv_direct_bot_a',
      status: 'dispatched',
      messageId: 'msg_1',
    });
    expect(todo.lastRun?.id).toBe(run.id);
    expect(rig.published.filter((e) => e.event === 'todos.changed').length).toBeGreaterThan(0);
  });

  it('管家创建的事项加「（管家代你安排）」并标 viaButler；无说明时只有一行', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.todos.create({
      title: '查资料',
      assignee: botAssignee('bot_a'),
      when: 'now',
      source: 'butler',
    });
    expect(rig.lastDispatch()).toMatchObject({
      text: '【工作台】查资料（管家代你安排）',
      viaButler: true,
    });
  });

  it('派给项目组：带覆盖项时 @ 覆盖项，未指定时 @ 项目负责人（都不走路由）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    rig.todos.create({
      title: '带头人',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
      when: 'now',
    });
    expect(rig.lastDispatch()).toMatchObject({ conversationId: 'conv_g', leadBotId: 'bot_b' });
    rig.todos.create({
      title: '无人带头',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    });
    // 未指定覆盖项 → @ 项目负责人。
    expect(rig.lastDispatch()).toMatchObject({ conversationId: 'conv_g', leadBotId: 'bot_a' });
  });

  it('派发失败（路由抛错）时执行记录标 failed 并向上报错', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.flags.failDispatch = true;
    expect(
      codeOf(() => rig.todos.create({ title: 't', assignee: botAssignee('bot_a'), when: 'now' })),
    ).toBe('UNKNOWN');
    const todo = rig.todos.list()[0]!;
    expect(rig.todos.store.listRuns(todo.id)[0]!.status).toBe('failed');
  });

  it('到点派发不受主动消息开关 / 免打扰约束：Bot 关闭主动消息且处于 24 小时免打扰，仍按时派发', async () => {
    const rig = makeRig();
    rig.addBot('bot_q', '阿静', {
      proactive: false,
      quiet_hours: ['00:00', '00:00'],
      max_proactive_per_day: 0,
    });
    const { todo } = rig.todos.create({
      title: '深夜整理',
      assignee: botAssignee('bot_q'),
      when: futureIso(rig, 60_000),
    });
    rig.clock.advance(60_000);
    await rig.fireDue();
    expect(rig.dispatched).toHaveLength(1);
    expect(rig.lastDispatch()).toMatchObject({ todoId: todo.id, text: '【工作台】深夜整理' });
    expect(rig.todos.get(todo.id).todo.status).toBe('in_progress');
    // 单次排期推进为 done，不再触发。
    expect(rig.schedules.store.get(todo.schedule!.id)).toMatchObject({
      status: 'done',
      nextFireAt: null,
    });
    // 不写 internal schedule_fired 触发（orchestrator 桩没有被调用：调用即抛错）。
  });

  it('到点时执行者 Bot 已不在：不派发，事项退回草案并写明原因，排期取消', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 60_000),
    });
    // 绕过钩子直接让 Bot 消失（对账之前）。
    rig.bots.get('bot_a')!.status = 'deleted';
    rig.clock.advance(60_000);
    await rig.fireDue();
    expect(rig.dispatched).toHaveLength(0);
    const after = rig.todos.get(todo.id).todo;
    expect(after).toMatchObject({
      status: 'draft',
      assignee: null,
      blockedReason: BLOCKED_BOT_DELETED,
    });
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('cancelled');
  });

  it('补发迟到：派发消息注明「原定 X，延迟派发」', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 60_000),
    });
    // 应用关闭 / 睡眠期间错过：时钟一次跳过 3 小时。
    rig.schedules.disarmTimerForTest();
    rig.clock.advance(3 * 3_600_000);
    rig.schedules.catchUpMissed();
    await rig.fireDue();
    expect(rig.dispatched).toHaveLength(1);
    expect(rig.lastDispatch().text).toMatch(/^【工作台】周报\n\n（原定 .+，延迟派发）$/);
  });

  it('周期事项：每次触发新增一条执行记录，事项本身停在 scheduled，排期推进到下一次', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '日报',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    });
    const first = todo.schedule!.nextFireAt!;
    rig.clock.setNow(first);
    await rig.fireDue();
    expect(rig.dispatched).toHaveLength(1);
    const mid = rig.todos.get(todo.id);
    expect(mid.todo.status).toBe('scheduled');
    expect(mid.runs).toHaveLength(1);
    expect(mid.todo.schedule!.nextFireAt).toBe(first + 24 * 3_600_000);
    rig.clock.setNow(first + 24 * 3_600_000);
    await rig.fireDue();
    expect(rig.todos.get(todo.id).runs).toHaveLength(2);
    expect(rig.todos.get(todo.id).todo.status).toBe('scheduled');
  });

  it('立即开始一个已排期的一次性事项：取消排期后派发；周期事项则保留排期', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const once = rig.todos.create({
      title: 'once',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    expect(rig.todos.start(once.id)).toMatchObject({ status: 'in_progress', schedule: null });
    const cron = rig.todos.create({
      title: 'cron',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    }).todo;
    expect(rig.todos.start(cron.id)).toMatchObject({ status: 'scheduled' });
    expect(rig.todos.get(cron.id).todo.schedule).not.toBeNull();
    expect(rig.todos.get(cron.id).runs).toHaveLength(1);
  });
});

describe('工作台事项：交付结算', () => {
  it('settleDelivered：执行记录 delivered 并记结果消息，事项进入 delivered；周期事项停在 scheduled', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const todo = rig.todos.create({ title: 't', assignee: botAssignee('bot_a'), when: 'now' }).todo;
    const runId = rig.lastDispatch().todoRunId;
    rig.todos.settleDelivered(runId, 'msg_result');
    expect(rig.todos.get(todo.id).todo.status).toBe('delivered');
    expect(rig.todos.store.getRun(runId)).toMatchObject({
      status: 'delivered',
      resultMessageId: 'msg_result',
    });
    expect(rig.todos.store.getRun(runId)!.settledAt).not.toBeNull();
    // 后到的回复以最后结算者为准。
    rig.todos.settleDelivered(runId, 'msg_result_2');
    expect(rig.todos.store.getRun(runId)!.resultMessageId).toBe('msg_result_2');
    // 用户验收后不再被拖回。
    rig.todos.complete(todo.id);
    rig.todos.settleDelivered(runId, 'msg_result_3');
    expect(rig.todos.get(todo.id).todo.status).toBe('done');

    const cron = rig.todos.create({
      title: 'c',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    }).todo;
    rig.todos.start(cron.id);
    rig.todos.settleDelivered(rig.lastDispatch().todoRunId, 'msg_c');
    expect(rig.todos.get(cron.id).todo.status).toBe('scheduled');
    expect(rig.todos.get(cron.id).todo.lastRun).toMatchObject({
      status: 'delivered',
      resultMessageId: 'msg_c',
    });
  });

  it('settleUnclaimed：事项退回草案，原因「项目里无人回应」；已结算的执行记录不被覆盖', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addGroup('conv_g', '项目组', ['bot_a']);
    const todo = rig.todos.create({
      title: '无人领',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    }).todo;
    const runId = rig.lastDispatch().todoRunId;
    rig.todos.settleUnclaimed(runId);
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: BLOCKED_UNCLAIMED,
    });
    expect(rig.todos.store.getRun(runId)!.status).toBe('unclaimed');
    // 之后的回复不复活已认领失败的记录。
    rig.todos.settleDelivered(runId, 'msg_late');
    expect(rig.todos.store.getRun(runId)!.status).toBe('unclaimed');
    expect(rig.todos.get(todo.id).todo.status).toBe('draft');
  });

  it('settleFailed：执行记录标 failed，事项退回草案并写「执行失败：原因」/「执行已被取消」，可重新开始', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const todo = rig.todos.create({ title: 't', assignee: botAssignee('bot_a'), when: 'now' }).todo;
    const runId = rig.lastDispatch().todoRunId;
    rig.todos.settleFailed(runId, { kind: 'failed', error: 'provider unavailable' });
    expect(rig.todos.store.getRun(runId)).toMatchObject({ status: 'failed' });
    expect(rig.todos.store.getRun(runId)!.settledAt).not.toBeNull();
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: '执行失败：provider unavailable',
      assignee: botAssignee('bot_a'),
    });
    // 失败的记录不被迟到的回复复活；用户可以重新开始。
    rig.todos.settleDelivered(runId, 'msg_late');
    expect(rig.todos.store.getRun(runId)!.status).toBe('failed');
    expect(rig.todos.start(todo.id).status).toBe('in_progress');

    const second = rig.lastDispatch().todoRunId;
    rig.todos.settleFailed(second, { kind: 'cancelled' });
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: '执行已被取消',
    });
    // 已结算（交付）的记录不会被后来的失败改写。
    const third = rig.todos.start(todo.id);
    expect(third.status).toBe('in_progress');
    rig.todos.settleDelivered(rig.lastDispatch().todoRunId, 'msg_ok');
    rig.todos.settleFailed(rig.lastDispatch().todoRunId, { kind: 'failed', error: 'x' });
    expect(rig.todos.get(todo.id).todo.status).toBe('delivered');
  });

  it('humanizeRunError：取出 JSON 里的 message，HTTP 状态码加前缀，去换行并限 120 字', () => {
    expect(humanizeRunError('500: {"message":"模型服务暂时不可用"}')).toBe(
      '模型服务出错（500）：模型服务暂时不可用',
    );
    expect(humanizeRunError('429 {"error":{"message":"Rate limit reached","type":"x"}}')).toBe(
      '模型服务出错（429）：Rate limit reached',
    );
    expect(humanizeRunError('provider unavailable')).toBe('provider unavailable');
    expect(humanizeRunError('第一行\n  第二行\r\n第三行')).toBe('第一行 第二行 第三行');
    expect(humanizeRunError('503')).toBe('模型服务出错（503）：无详细信息');
    expect(humanizeRunError('{not json')).toBe('{not json');
    expect(humanizeRunError(null)).toBe('未知原因');
    expect(humanizeRunError('   ')).toBe('未知原因');
    const long = humanizeRunError(`500: ${'x'.repeat(300)}`);
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith('…')).toBe(true);
  });

  it('settleFailed 写入 blocked_reason 前清洗原始错误', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const todo = rig.todos.create({ title: 't', assignee: botAssignee('bot_a'), when: 'now' }).todo;
    rig.todos.settleFailed(rig.lastDispatch().todoRunId, {
      kind: 'failed',
      error: '500: {"message":"模型服务暂时不可用"}',
    });
    expect(rig.todos.get(todo.id).todo.blockedReason).toBe(
      '执行失败：模型服务出错（500）：模型服务暂时不可用',
    );
  });

  it('只有该事项最新的一次派发能推进事项：迟到的旧执行记录只更新自己', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const cron = rig.todos.create({
      title: 'c',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    }).todo;
    rig.todos.start(cron.id);
    const oldRun = rig.lastDispatch().todoRunId;
    rig.todos.start(cron.id);
    const newRun = rig.lastDispatch().todoRunId;
    expect(newRun).not.toBe(oldRun);
    rig.todos.settleDelivered(oldRun, 'msg_old');
    expect(rig.todos.store.getRun(oldRun)).toMatchObject({
      status: 'delivered',
      resultMessageId: 'msg_old',
    });

    // 一次性事项被退回草案后重新开始：第一次派发的迟到回复不能把第二次的事项推到待验收。
    const once = rig.todos.create({ title: 'o', assignee: botAssignee('bot_a'), when: 'now' }).todo;
    const first = rig.lastDispatch().todoRunId;
    rig.todos.store.update(once.id, { status: 'draft' });
    rig.todos.start(once.id);
    const second = rig.lastDispatch().todoRunId;
    rig.todos.settleDelivered(first, 'msg_stale');
    expect(rig.todos.get(once.id).todo.status).toBe('in_progress');
    rig.todos.settleDelivered(second, 'msg_fresh');
    expect(rig.todos.get(once.id).todo.status).toBe('delivered');
  });

  it('派发过程中同步结算（空项目组 → 无人认领）：事项先进入进行中再被退回草案，不会卡在进行中', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addGroup('conv_g', '空群', ['bot_a']);
    // 路由同步走到静默收场：编排器在 dispatch 返回之前就调了 settleUnclaimed。
    rig.flags.onDispatch = (call) => rig.todos.settleUnclaimed(call.todoRunId);
    const { todo } = rig.todos.create({
      title: '没人在的群',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    });
    expect(todo).toMatchObject({ status: 'draft', blockedReason: BLOCKED_UNCLAIMED });
    expect(todo.lastRun).toMatchObject({ status: 'unclaimed' });
    // 同样的路径经 start 重新开始。
    const again = rig.todos.start(todo.id);
    expect(again).toMatchObject({ status: 'draft', blockedReason: BLOCKED_UNCLAIMED });
  });

  it('访谈态的执行者：派发被闸口扣住，事项保持进行中并写 blocked_reason，create/update 返回警告；交付后清掉', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.flags.held = true;
    const { todo, warnings } = rig.todos.create({
      title: '等设置',
      assignee: botAssignee('bot_a'),
      when: 'now',
    });
    expect(todo).toMatchObject({ status: 'in_progress', blockedReason: BLOCKED_HELD });
    expect(warnings).toContain(BLOCKED_HELD);
    rig.todos.settleDelivered(rig.lastDispatch().todoRunId, 'msg_done');
    expect(rig.todos.get(todo.id).todo).toMatchObject({ status: 'delivered', blockedReason: null });
  });
});

describe('工作台事项：对账', () => {
  it('scheduled 却没有 active schedule（排期被用户取消 / 外部取消）→ 退回草案并写原因', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    // 回执卡上的「取消」走 schedules.cancel → schedules.changed → reconcile。
    rig.schedules.cancel(todo.schedule!.id);
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: BLOCKED_SCHEDULE_CANCELLED,
      assignee: botAssignee('bot_a'),
    });
  });

  it('启动对账：绕过服务把 schedule 改成 cancelled / 删除后，reconcile 兜底退回草案', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const a = rig.todos.create({
      title: 'a',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    const b = rig.todos.create({
      title: 'b',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    rig.db.prepare("update schedules set status = 'cancelled' where id = ?").run(a.schedule!.id);
    rig.db.prepare('delete from schedules where id = ?').run(b.schedule!.id);
    expect(rig.todos.reconcile().sort()).toEqual([a.id, b.id].sort());
    expect(rig.todos.get(a.id).todo.status).toBe('draft');
    expect(rig.todos.get(b.id).todo.status).toBe('draft');
    expect(rig.todos.reconcile()).toEqual([]);
  });

  it('项目 + 覆盖项：负责 Bot 被删 → 保留项目组、清覆盖项；整个项目组被删 → 清执行者（不会退化成「Bot 执行者」）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    rig.addGroup('conv_h', '另一组', ['bot_a', 'bot_b']);
    const led = rig.todos.create({
      title: 'led',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
      when: futureIso(rig),
    }).todo;
    const doomed = rig.todos.create({
      title: 'doomed',
      assignee: { kind: 'project', projectId: 'conv_h', leadBotId: 'bot_b' },
      when: futureIso(rig),
    }).todo;
    rig.removeConversation('conv_h');
    expect(rig.todos.get(doomed.id).todo).toMatchObject({
      status: 'draft',
      assignee: null,
      blockedReason: BLOCKED_PROJECT_GONE,
    });
    rig.deleteBot('bot_b');
    rig.todos.onExecutorChanged();
    expect(rig.todos.get(led.id).todo).toMatchObject({
      status: 'draft',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      blockedReason: BLOCKED_LEAD_DELETED,
      schedule: null,
    });
  });

  it('漏掉删除钩子时对账兜底：会话不存在或已只读都退回草案「项目组已解散」', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    rig.addGroup('conv_r', '只读组', ['bot_a', 'bot_b']);
    const gone = rig.todos.create({
      title: 'gone',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
    }).todo;
    const readOnly = rig.todos.create({
      title: 'ro',
      assignee: { kind: 'project', projectId: 'conv_r', leadBotId: null },
    }).todo;
    // 绕过 TodoService 钩子直接删（无外键置空）。
    rig.db.prepare("delete from conversations where id = 'conv_g'").run();
    rig.conversations.delete('conv_g');
    rig.conversations.get('conv_r')!.readOnly = true;
    expect(rig.todos.reconcile().sort()).toEqual([gone.id, readOnly.id].sort());
    for (const id of [gone.id, readOnly.id]) {
      expect(rig.todos.get(id).todo).toMatchObject({
        status: 'draft',
        assignee: null,
        blockedReason: BLOCKED_PROJECT_GONE,
      });
    }
  });

  it('硬删事项先取消其 active 排期；漏掉时孤儿排期（todo_id 为空）被对账取消，到点也不派发', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const a = rig.todos.create({
      title: 'a',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 60_000),
    }).todo;
    expect(rig.todos.purge(a.id)).toBe(true);
    expect(rig.schedules.store.get(a.schedule!.id)!.status).toBe('cancelled');
    expect(rig.todos.purge(a.id)).toBe(false);

    // 绕过服务硬删：schedule.todo_id 置空但仍 active。
    const b = rig.todos.create({
      title: 'b',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 120_000),
    }).todo;
    rig.db.prepare('delete from todos where id = ?').run(b.id);
    const orphan = rig.schedules.store.get(b.schedule!.id)!;
    expect(orphan).toMatchObject({ status: 'active', todoId: null, origin: 'workbench' });
    rig.todos.reconcile();
    expect(rig.schedules.store.get(orphan.id)!.status).toBe('cancelled');

    // 对账之前就到点：#fire 的 workbench 分支遇到 todo_id 为空直接取消，不派发。
    const c = rig.todos.create({
      title: 'c',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 180_000),
    }).todo;
    rig.db.prepare('delete from todos where id = ?').run(c.id);
    rig.clock.advance(300_000);
    await rig.fireDue();
    expect(rig.dispatched).toHaveLength(0);
    expect(rig.schedules.store.get(c.schedule!.id)!.status).toBe('cancelled');
  });

  it('删 Bot：Bot 执行者的事项（含进行中）退回草案、清执行者、写原因，进行中的执行记录标 failed', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const scheduled = rig.todos.create({
      title: 's',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    const running = rig.todos.create({
      title: 'r',
      assignee: botAssignee('bot_a'),
      when: 'now',
    }).todo;
    const delivered = rig.todos.create({
      title: 'd',
      assignee: botAssignee('bot_a'),
      when: 'now',
    }).todo;
    rig.todos.settleDelivered(rig.lastDispatch().todoRunId, 'msg_d');
    rig.deleteBot('bot_a');
    rig.todos.onExecutorChanged();
    for (const id of [scheduled.id, running.id]) {
      expect(rig.todos.get(id).todo).toMatchObject({
        status: 'draft',
        assignee: null,
        blockedReason: BLOCKED_BOT_DELETED,
        schedule: null,
      });
    }
    expect(rig.todos.get(running.id).runs[0]!.status).toBe('failed');
    expect(rig.schedules.store.get(scheduled.schedule!.id)!.status).toBe('cancelled');
    // 待验收的保留结果，等用户验收。
    expect(rig.todos.get(delivered.id).todo.status).toBe('delivered');
  });

  it('删项目组（外键把 assignee_project_id 置空之前）：项目执行者的事项退回草案、清执行者、原因「项目组已解散」', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addGroup('conv_g', '项目组', ['bot_a']);
    const scheduled = rig.todos.create({
      title: 's',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_a' },
      when: futureIso(rig),
    }).todo;
    const draft = rig.todos.create({
      title: 'd',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
    }).todo;
    rig.removeConversation('conv_g');
    for (const id of [scheduled.id, draft.id]) {
      expect(rig.todos.get(id).todo).toMatchObject({
        status: 'draft',
        assignee: null,
        blockedReason: BLOCKED_PROJECT_GONE,
      });
    }
  });

  it('删除 Bot 的私聊：排期随之消失，事项退回草案「对话已删除，排期已取消」，Bot 仍是执行者', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const todo = rig.todos.create({
      title: 's',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    rig.removeConversation(rig.directIdOf('bot_a'));
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      assignee: botAssignee('bot_a'),
      blockedReason: BLOCKED_CONVERSATION_DELETED,
    });
  });

  it('负责 Bot 被移出项目组：保留项目组、清覆盖项、事项退回草案', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    const todo = rig.todos.create({
      title: 's',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
      when: futureIso(rig),
    }).todo;
    rig.members.set('conv_g', ['bot_a']);
    rig.schedules.cancelForBotInConversation('bot_b', 'conv_g');
    rig.todos.onExecutorChanged();
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'draft',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      blockedReason: BLOCKED_LEAD_LEFT,
    });
  });

  it('不属于 scheduled 的事项持有的 active 排期被取消（孤儿排期）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const todo = rig.todos.create({
      title: 's',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    rig.todos.store.update(todo.id, { status: 'draft' });
    rig.todos.reconcile();
    expect(rig.schedules.store.listActiveForTodo(todo.id)).toHaveLength(0);
  });

  it('D88 移交后排期搬到接手方：事项执行者随之改变（schedule.todo_id 保留）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const target = rig.todos.create({ title: 'x', assignee: botAssignee('bot_b') }); // 建出 B 的私聊
    expect(target.todo.assignee).toEqual(botAssignee('bot_b'));
    const moved = rig.schedules.transferTo(todo.schedule!.id, {
      botId: 'bot_b',
      botName: '阿乙',
      conversationId: rig.directIdOf('bot_b'),
    });
    expect(moved).toMatchObject({ origin: 'workbench', todoId: todo.id, botId: 'bot_b' });
    // transferTo 发的 schedules.changed 已让对账跟上；适配器的显式钩子是幂等的补充。
    expect(rig.todos.get(todo.id).todo.assignee).toEqual(botAssignee('bot_b'));
    rig.todos.onScheduleTransferred(moved);
    expect(rig.todos.get(todo.id).todo).toMatchObject({
      status: 'scheduled',
      assignee: botAssignee('bot_b'),
    });
    expect(rig.todos.get(todo.id).todo.schedule!.id).toBe(moved.id);
  });
});

describe('工作台事项：列表与来源', () => {
  it('默认不含关闭超过 7 天的事项，includeClosed 取回；按状态 / 关键字过滤', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const old = rig.todos.create({ title: '旧事项' }).todo;
    rig.todos.cancel(old.id);
    rig.clock.advance(TODO_CLOSED_VISIBLE_MS + 1000);
    const fresh = rig.todos.create({ title: '新事项竞品' }).todo;
    const recentDone = rig.todos.create({
      title: '刚完成',
      assignee: botAssignee('bot_a'),
      when: 'now',
    }).todo;
    rig.todos.complete(recentDone.id);
    expect(
      rig.todos
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual([fresh.id, recentDone.id].sort());
    expect(rig.todos.list({ includeClosed: true })).toHaveLength(3);
    expect(rig.todos.list({ statuses: ['draft'] }).map((t) => t.id)).toEqual([fresh.id]);
    expect(rig.todos.list({ query: '竞品' }).map((t) => t.id)).toEqual([fresh.id]);
  });

  it('TodoEntry 填执行者名 / 负责 Bot 名 / 排期 / 最近一次执行记录', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '产品组', ['bot_a', 'bot_b']);
    const bot = rig.todos.create({
      title: '1',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    expect(bot).toMatchObject({ assigneeName: '阿甲', leadBotName: null });
    expect(bot.schedule).not.toBeNull();
    const group = rig.todos.create({
      title: '2',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_b' },
      when: 'now',
    }).todo;
    expect(group).toMatchObject({ assigneeName: '产品组', leadBotName: '阿乙', schedule: null });
    expect(group.lastRun).toMatchObject({ conversationId: 'conv_g', status: 'dispatched' });
  });

  it('未知事项：get / start / complete 等报 NOT_FOUND', () => {
    const rig = makeRig();
    expect(codeOf(() => rig.todos.get('todo_none'))).toBe('NOT_FOUND');
    expect(codeOf(() => rig.todos.start('todo_none'))).toBe('NOT_FOUND');
    expect(codeOf(() => rig.todos.update('todo_none', { title: 'x' }))).toBe('NOT_FOUND');
  });
});

describe('工作台排期：Bot 自己的工具面不能动用户派的活', () => {
  it('cancelOwn 拒绝取消 workbench 行；contextSection 标「工作台派给你的」', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const outcome = rig.schedules.cancelOwn('bot_a', todo.schedule!.id);
    expect(outcome).toEqual({ ok: false, message: '这是用户在工作台派的事项，不能自行取消' });
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('active');
    expect(rig.todos.get(todo.id).todo.status).toBe('scheduled');
    const section = rig.schedules.contextSection('bot_a', rig.directIdOf('bot_a'));
    expect(section).toContain('工作台派给你的');
    expect(section).toContain(todo.schedule!.id);
    // 别人的、自己的普通任务不受影响。
    const own = rig.schedules.createOnce({
      botId: 'bot_a',
      conversationId: rig.directIdOf('bot_a'),
      runAt: rig.clock.now() + 600_000,
      note: '自己的任务',
    });
    expect(rig.schedules.cancelOwn('bot_a', own.id).ok).toBe(true);
  });

  it('派给项目组的排期行带项目负责人：按它归榜，也能正常到点派发', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addGroup('conv_g', '项目组', ['bot_a']);
    const { todo } = rig.todos.create({
      title: '大家看看',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: futureIso(rig, 60_000),
    });
    // D92 T1a WP4：项目必有负责人，排期行带实际生效的负责 Bot（fixture 的负责人 = 第一个成员）。
    expect(rig.schedules.store.get(todo.schedule!.id)!.botId).toBe('bot_a');
    expect(rig.schedules.listForBotInConversation('bot_a', 'conv_g')).toHaveLength(1);
    expect(rig.schedules.listEntries()[0]).toMatchObject({ botName: '阿甲', deferredReason: null });
    rig.clock.advance(60_000);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({ conversationId: 'conv_g', leadBotId: 'bot_a' });
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('done');
  });
});

describe('工作台备忘', () => {
  function memoRig() {
    const rig = makeRig();
    const published: unknown[] = [];
    const memos = new MemoService({
      store: rig.todos.memos,
      clock: rig.clock,
      logger,
      publish: (event, payload) => published.push({ event, payload }),
    });
    return { rig, memos, published };
  }

  it('创建 / 编辑 / 置顶：长度校验，置顶在前，改正文不换位，事件每次变更都发', () => {
    const { rig, memos, published } = memoRig();
    expect(codeOf(() => memos.create({ body: '  ' }))).toBe('INVALID_INPUT');
    const a = memos.create({ body: '  第一条  ' });
    expect(a).toMatchObject({ body: '第一条', pinned: false, source: 'user', deletedAt: null });
    rig.clock.advance(1000);
    const b = memos.create({ body: '第二条', source: 'butler' });
    expect(b.source).toBe('butler');
    expect(memos.list().map((m) => m.id)).toEqual([b.id, a.id]);
    // 改正文：不动排序键 → 卡片留在原位。
    expect(memos.update(a.id, { body: '改过' }).body).toBe('改过');
    expect(memos.list().map((m) => m.id)).toEqual([b.id, a.id]);
    // 置顶：提到置顶组最前。
    memos.update(a.id, { pinned: true });
    expect(memos.list().map((m) => m.id)).toEqual([a.id, b.id]);
    expect(published.map((p) => (p as { event: string }).event)).toEqual([
      'memos.changed',
      'memos.changed',
      'memos.changed',
      'memos.changed',
    ]);
    expect(codeOf(() => memos.update('memo_none', { body: 'x' }))).toBe('NOT_FOUND');
  });

  it('软删进最近删除、可恢复回原位；删除 / 恢复幂等；最近删除里的备忘不能编辑', () => {
    const { rig, memos } = memoRig();
    const a = memos.create({ body: 'A' });
    rig.clock.advance(1000);
    const b = memos.create({ body: 'B' });
    const deleted = memos.delete(a.id);
    expect(deleted.deletedAt).toBe(rig.clock.now());
    expect(memos.list().map((m) => m.id)).toEqual([b.id]);
    expect(memos.list({ trashed: true }).map((m) => m.id)).toEqual([a.id]);
    expect(codeOf(() => memos.update(a.id, { body: 'x' }))).toBe('INVALID_INPUT');
    expect(memos.delete(a.id).deletedAt).toBe(deleted.deletedAt);
    expect(memos.restore(a.id).deletedAt).toBeNull();
    // 恢复后回到原位（排序键未变）。
    expect(memos.list().map((m) => m.id)).toEqual([b.id, a.id]);
    expect(memos.restore(a.id).deletedAt).toBeNull();
  });

  it('启动清理：只清最近删除里超过 30 天的，其余不动', () => {
    const { rig, memos } = memoRig();
    const stale = memos.create({ body: '很久以前删的' });
    const recent = memos.create({ body: '前几天删的' });
    const live = memos.create({ body: '一直在' });
    memos.delete(stale.id);
    rig.clock.advance(MEMO_TRASH_RETENTION_MS - 1000);
    memos.delete(recent.id);
    rig.clock.advance(2000);
    expect(memos.purgeExpired()).toBe(1);
    expect(memos.list({ trashed: true }).map((m) => m.id)).toEqual([recent.id]);
    expect(memos.list().map((m) => m.id)).toEqual([live.id]);
    expect(codeOf(() => memos.get(stale.id))).toBe('NOT_FOUND');
    expect(memos.purgeExpired()).toBe(0);
  });

  it('转事项的 memoId 在备忘被清理后仍保留（不设外键）', () => {
    const { rig, memos } = memoRig();
    rig.addBot('bot_a', '阿甲');
    const memo = memos.create({ body: '下周谈价' });
    const todo = rig.todos.create({ title: '谈价', memoId: memo.id }).todo;
    memos.delete(memo.id);
    rig.clock.advance(MEMO_TRASH_RETENTION_MS + 1000);
    memos.purgeExpired();
    expect(rig.todos.get(todo.id).todo.memoId).toBe(memo.id);
  });
});

describe('工作台事项：审查修复', () => {
  it('update({assignee, when:null}) 保留改派并退回草案（排期取消）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const back = rig.todos.update(todo.id, { assignee: botAssignee('bot_b'), when: null }).todo;
    expect(back).toMatchObject({ status: 'draft', schedule: null, assignee: botAssignee('bot_b') });
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('cancelled');
  });

  it('update 带上与当前相同的执行者不算改动：已派发的事项仍可只改标题', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({ title: '旧', assignee: botAssignee('bot_a'), when: 'now' });
    const updated = rig.todos.update(todo.id, { title: '新', assignee: botAssignee('bot_a') }).todo;
    expect(updated).toMatchObject({ title: '新', status: 'in_progress' });
    expect(codeOf(() => rig.todos.update(todo.id, { assignee: null }))).toBe('INVALID_INPUT');
  });

  it("update(when:'now')：周期事项「改成立即执行一次」——周期排期结束并派发一次；start 则保留周期", () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const cronA = rig.todos.create({
      title: 'a',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    }).todo;
    const ended = rig.todos.update(cronA.id, { when: 'now' }).todo;
    expect(ended).toMatchObject({ status: 'in_progress', schedule: null });
    expect(rig.schedules.store.get(cronA.schedule!.id)!.status).toBe('cancelled');
    expect(rig.dispatched.filter((d) => d.todoId === cronA.id)).toHaveLength(1);

    const cronB = rig.todos.create({
      title: 'b',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    }).todo;
    const started = rig.todos.start(cronB.id);
    expect(started.status).toBe('scheduled');
    expect(started.schedule).not.toBeNull();
  });

  it('派发抛错时不破坏不变式：start / update(now) 失败后排期仍在、事项仍是 scheduled、执行者不变', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    rig.flags.failDispatch = true;
    expect(codeOf(() => rig.todos.start(todo.id))).toBe('UNKNOWN');
    for (const input of [{ when: 'now' }, { assignee: botAssignee('bot_b'), when: 'now' }]) {
      expect(codeOf(() => rig.todos.update(todo.id, input))).toBe('UNKNOWN');
    }
    const after = rig.todos.get(todo.id).todo;
    expect(after).toMatchObject({ status: 'scheduled', assignee: botAssignee('bot_a') });
    expect(after.schedule!.id).toBe(todo.schedule!.id);
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('active');
    // 每次失败的派发各留一条 failed 的执行记录。
    expect(rig.todos.get(todo.id).runs.every((run) => run.status === 'failed')).toBe(true);
  });

  it('改派时新排期建不出来：旧排期与执行者原样保留（事务回滚）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    const original = rig.schedules.createForTodo.bind(rig.schedules);
    rig.schedules.createForTodo = () => {
      throw new Error('create exploded');
    };
    expect(codeOf(() => rig.todos.update(todo.id, { assignee: botAssignee('bot_b') }))).toBe(
      'UNKNOWN',
    );
    rig.schedules.createForTodo = original;
    const after = rig.todos.get(todo.id).todo;
    expect(after).toMatchObject({ status: 'scheduled', assignee: botAssignee('bot_a') });
    expect(after.schedule!.id).toBe(todo.schedule!.id);
    expect(rig.schedules.store.get(todo.schedule!.id)!.status).toBe('active');
  });

  it('create(now) 派发失败：事项留作草案并写 blocked_reason，错误照常抛给调用方', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.flags.failDispatch = true;
    expect(
      codeOf(() =>
        rig.todos.create({ title: '会失败', assignee: botAssignee('bot_a'), when: 'now' }),
      ),
    ).toBe('UNKNOWN');
    const [todo] = rig.todos.list();
    expect(todo).toMatchObject({ status: 'draft', assignee: botAssignee('bot_a') });
    expect(todo!.blockedReason).toBe('派发失败：dispatch exploded');
    expect(rig.todos.get(todo!.id).runs).toHaveLength(1);
    expect(rig.todos.get(todo!.id).runs[0]!.status).toBe('failed');
  });

  it('操作进行中被跳过的对账，在最外层操作结束后补跑一次', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const other = rig.todos.create({
      title: '另一件',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    }).todo;
    const target = rig.todos.create({ title: '要开始的', assignee: botAssignee('bot_a') }).todo;
    // 派发期间，另一件的排期被外部取消（schedules.changed 触发对账，但此刻服务正忙）。
    rig.flags.onDispatch = () => {
      rig.db
        .prepare("update schedules set status = 'cancelled' where id = ?")
        .run(other.schedule!.id);
      expect(rig.todos.reconcile()).toEqual([]);
      expect(rig.todos.get(other.id).todo.status).toBe('scheduled');
    };
    rig.todos.start(target.id);
    expect(rig.todos.get(other.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: BLOCKED_SCHEDULE_CANCELLED,
    });
  });

  it('删私聊时进行中的事项：执行记录标 failed，事项退回草案「对话已删除」；onExecutorChanged 不重复发事件', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '在做',
      assignee: botAssignee('bot_a'),
      when: 'now',
    });
    const directId = rig.directIdOf('bot_a');
    rig.removeConversation(directId);
    const after = rig.todos.get(todo.id);
    expect(after.todo).toMatchObject({
      status: 'draft',
      blockedReason: BLOCKED_CONVERSATION_GONE,
      assignee: botAssignee('bot_a'),
    });
    expect(after.runs[0]!.status).toBe('failed');

    // 群分支：进行中的群事项同样标记执行记录。
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '项目组', ['bot_a', 'bot_b']);
    const grp = rig.todos.create({
      title: '项目组里在做',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    }).todo;
    rig.removeConversation('conv_g');
    expect(rig.todos.get(grp.id).todo).toMatchObject({
      status: 'draft',
      blockedReason: BLOCKED_PROJECT_GONE,
    });
    expect(rig.todos.get(grp.id).runs[0]!.status).toBe('failed');

    // 删 Bot 后只发一次 todos.changed（reconcile 已发布，onExecutorChanged 不再补发）。
    const running = rig.todos.create({
      title: '另一个在做',
      assignee: botAssignee('bot_b'),
      when: 'now',
    }).todo;
    rig.published.length = 0;
    rig.deleteBot('bot_b');
    rig.todos.onExecutorChanged();
    expect(
      rig.published.filter(
        (e) =>
          e.event === 'todos.changed' && (e.payload as { todoId: string }).todoId === running.id,
      ),
    ).toHaveLength(1);
  });

  it('reopen 重新校验执行者：失效则清空并写原因', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    rig.addBot('bot_b', '阿乙');
    const ok = rig.todos.create({ title: 'ok', assignee: botAssignee('bot_a') }).todo;
    const stale = rig.todos.create({ title: 'stale', assignee: botAssignee('bot_b') }).todo;
    rig.todos.cancel(ok.id);
    rig.todos.cancel(stale.id);
    rig.deleteBot('bot_b');
    expect(rig.todos.reopen(ok.id)).toMatchObject({
      status: 'draft',
      assignee: botAssignee('bot_a'),
      blockedReason: null,
    });
    expect(rig.todos.reopen(stale.id)).toMatchObject({
      status: 'draft',
      assignee: null,
      blockedReason: BLOCKED_BOT_DELETED,
    });
  });

  it('reschedule 取消排队中的旧 schedule_fire 作业（不会在旧时间再触发一次）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '周报',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig),
    });
    rig.pendingJobs.push(
      { id: 'job_old', type: 'schedule_fire' },
      { id: 'job_other', type: 'other' },
    );
    rig.todos.update(todo.id, { when: futureIso(rig, 7_200_000) });
    expect(rig.cancelledJobs).toEqual(['job_old']);
  });
});

describe('工作台事项：派发标注跟随操作者（actor）', () => {
  it('用户亲手开始管家起草的事项：不带「管家代你安排」、viaButler 假，但 butlerDrafted 真（说明按不可信处理）', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const draft = rig.todos.create({
      title: '草案',
      assignee: botAssignee('bot_a'),
      source: 'butler',
    }).todo;
    expect(draft.source).toBe('butler');
    rig.todos.start(draft.id);
    expect(rig.lastDispatch()).toMatchObject({
      text: '【工作台】草案',
      viaButler: false,
      butlerDrafted: true,
    });
  });

  it('管家开始用户建的事项：带「（管家代你安排）」、viaButler 真，butlerDrafted 假', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const mine = rig.todos.create({ title: '我的事', assignee: botAssignee('bot_a') }).todo;
    rig.todos.start(mine.id, 'butler');
    expect(rig.lastDispatch()).toMatchObject({
      text: '【工作台】我的事（管家代你安排）',
      viaButler: true,
      butlerDrafted: false,
    });
    // update(when:'now') 同理。
    const other = rig.todos.create({ title: '另一件', assignee: botAssignee('bot_a') }).todo;
    rig.todos.update(other.id, { when: 'now', actor: 'butler' });
    expect(rig.lastDispatch()).toMatchObject({ viaButler: true, butlerDrafted: false });
    // create 的 actor 缺省取 source（管家建的立即派发带标注）；显式 actor 优先。
    rig.todos.create({
      title: '管家建',
      assignee: botAssignee('bot_a'),
      when: 'now',
      source: 'butler',
    });
    expect(rig.lastDispatch()).toMatchObject({ viaButler: true, butlerDrafted: true });
    rig.todos.create({
      title: '用户让管家起草',
      assignee: botAssignee('bot_a'),
      when: 'now',
      source: 'butler',
      actor: 'user',
    });
    expect(rig.lastDispatch()).toMatchObject({ viaButler: false, butlerDrafted: true });
  });

  it('到点派发取「最后一次设置该排期的操作者」：管家排期 → 带标注；用户改期 → 不带；管家起草用户排期 → 不带但 butlerDrafted', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const mine = rig.todos.create({ title: '我的事', assignee: botAssignee('bot_a') }).todo;
    // 管家排期。
    rig.todos.update(mine.id, { when: futureIso(rig, 60_000), actor: 'butler' });
    expect(rig.todos.store.scheduledBy(mine.id)).toBe('butler');
    rig.clock.advance(60_000);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({
      text: '【工作台】我的事（管家代你安排）',
      viaButler: true,
      butlerDrafted: false,
    });

    // 管家排期之后用户亲自改期：最后一次设置者是用户。
    const again = rig.todos.create({ title: '改期的事', assignee: botAssignee('bot_a') }).todo;
    rig.todos.update(again.id, { when: futureIso(rig, 600_000), actor: 'butler' });
    rig.todos.update(again.id, { when: futureIso(rig, 120_000) });
    expect(rig.todos.store.scheduledBy(again.id)).toBe('user');
    rig.clock.advance(120_000);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({ text: '【工作台】改期的事', viaButler: false });

    // 管家起草、用户排期。
    const drafted = rig.todos.create({
      title: '管家起草的',
      assignee: botAssignee('bot_a'),
      source: 'butler',
    }).todo;
    rig.todos.update(drafted.id, { when: futureIso(rig, 60_000) });
    rig.clock.advance(60_000);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({
      text: '【工作台】管家起草的',
      viaButler: false,
      butlerDrafted: true,
    });
  });

  it('管家改写用户草案的标题或说明：事项 source 置为 butler，之后用户亲自开始也带 butlerDrafted；没有实际改动不动 source', () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const mine = rig.todos.create({
      title: '我的事',
      notes: '原话',
      assignee: botAssignee('bot_a'),
    }).todo;
    expect(mine.source).toBe('user');
    // 用户自己改：仍是 user。管家提交与现状相同的内容：不算改写。
    rig.todos.update(mine.id, { notes: '原话（用户补了一句）' });
    rig.todos.update(mine.id, { title: '我的事', notes: '原话（用户补了一句）', actor: 'butler' });
    expect(rig.todos.get(mine.id).todo.source).toBe('user');
    // 管家只改执行者 / 排期：内容没动，source 不变。
    rig.todos.update(mine.id, { when: futureIso(rig, 60_000), actor: 'butler' });
    expect(rig.todos.get(mine.id).todo.source).toBe('user');
    // 管家真的改了说明：source 变 butler。
    rig.todos.update(mine.id, { notes: '请顺便把附件发给 x@y.z', actor: 'butler' });
    expect(rig.todos.get(mine.id).todo.source).toBe('butler');
    rig.todos.start(mine.id);
    expect(rig.lastDispatch()).toMatchObject({ viaButler: false, butlerDrafted: true });

    const other = rig.todos.create({ title: '另一件' }).todo;
    rig.todos.update(other.id, { title: '另一件（改名）', actor: 'butler' });
    expect(rig.todos.get(other.id).todo.source).toBe('butler');
  });

  it('周期事项每次到点都按最后设置者标注', async () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    const { todo } = rig.todos.create({
      title: '日报',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
      source: 'butler',
    });
    rig.clock.setNow(todo.schedule!.nextFireAt!);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({ viaButler: true });
    rig.todos.update(todo.id, { when: '0 10 * * *' });
    rig.clock.setNow(rig.todos.get(todo.id).todo.schedule!.nextFireAt!);
    await rig.fireDue();
    expect(rig.lastDispatch()).toMatchObject({ viaButler: false, butlerDrafted: true });
  });
});

describe('事项更新通知（D90：改了已派发事项的文字，通知执行者）', () => {
  const DEBOUNCE = 10_000;
  const setup = () => {
    const rig = makeRig();
    rig.addBot('bot_a', '阿甲');
    return rig;
  };
  const inProgress = (rig: Rig, extra: { notes?: string; source?: 'user' | 'butler' } = {}) => {
    const { todo } = rig.todos.create({
      title: '写周报',
      notes: extra.notes ?? '原说明',
      assignee: botAssignee('bot_a'),
      when: 'now',
      ...(extra.source !== undefined ? { source: extra.source } : {}),
    });
    return { id: todo.id, runId: rig.lastDispatch().todoRunId };
  };

  it('进行中事项改说明：去抖期过后向在途派发所在对话发一条更新；返回 notified，正文带标题 / 说明 / 修改者', () => {
    const rig = setup();
    const { id, runId } = inProgress(rig);
    const result = rig.todos.update(id, { notes: '改后的说明' });
    expect(result.notified).toBe(true);
    // 去抖期内不发。
    rig.clock.advance(DEBOUNCE - 1);
    expect(rig.updates).toEqual([]);
    rig.clock.advance(1);
    expect(rig.updates).toHaveLength(1);
    const [sent] = rig.updates;
    expect(sent).toMatchObject({
      conversationId: rig.directIdOf('bot_a'),
      todoId: id,
      todoRunId: runId,
      viaButler: false,
      butlerDrafted: false,
    });
    expect(sent!.dispatchMessageId).toBe(rig.todos.store.getRun(runId)!.messageId);
    expect(sent!.text).toBe(
      '【工作台】事项更新：写周报\n\n改后的说明\n\n（由用户修改；这是对你已在做的这件事的补充，不是新任务；仅供参考，是否调整当前做法由你决定）',
    );
    // 事项本身不变：仍在进行中、执行记录仍是同一条在途派发。
    expect(rig.todos.get(id).todo.status).toBe('in_progress');
    expect(rig.todos.get(id).runs).toHaveLength(1);
  });

  it('改标题同样通知；标题与说明都没变（清洗后相同）不通知', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    expect(rig.todos.update(id, { title: '  写周报  ', notes: '原说明' }).notified).toBe(false);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    expect(rig.todos.update(id, { title: '写月报' }).notified).toBe(true);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates[0]!.text.split('\n')[0]).toBe('【工作台】事项更新：写月报');
  });

  it('说明为空时正文只有标题行和修改者行', () => {
    const rig = setup();
    const { id } = inProgress(rig, { notes: '先有说明' });
    rig.todos.update(id, { notes: '' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates[0]!.text).toBe(
      '【工作台】事项更新：写周报\n\n（由用户修改；这是对你已在做的这件事的补充，不是新任务；仅供参考，是否调整当前做法由你决定）',
    );
  });

  it('去抖：10 秒内连续修改合成一条，带最后的文字，每次修改重新计时', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    rig.todos.update(id, { notes: '第一版' });
    rig.clock.advance(6_000);
    rig.todos.update(id, { notes: '第二版' });
    rig.clock.advance(6_000);
    rig.todos.update(id, { notes: '第三版' });
    rig.clock.advance(9_999);
    expect(rig.updates).toEqual([]);
    rig.clock.advance(1);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]!.text).toContain('第三版');
    expect(rig.updates[0]!.text).not.toContain('第一版');
    // 发出之后的下一次修改是新的一条。
    rig.todos.update(id, { notes: '第四版' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(2);
    expect(rig.updates[1]!.text).toContain('第四版');
  });

  it('去抖期内改回执行者已知的文字：不发', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    rig.todos.update(id, { notes: '临时改一下' });
    rig.clock.advance(3_000);
    rig.todos.update(id, { notes: '原说明' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
  });

  it('管家改（任何一次）：通知标注管家、viaButler；事项 source 置 butler，butlerDrafted', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    rig.todos.update(id, { notes: '用户先改' });
    rig.todos.update(id, { notes: '管家再改一次', actor: 'butler' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]).toMatchObject({ viaButler: true, butlerDrafted: true });
    expect(rig.updates[0]!.text).toContain('（由管家修改；');
    expect(rig.todos.get(id).todo.source).toBe('butler');
  });

  it('管家起草过的事项（source=butler），用户之后改说明：不是 viaButler，但仍 butlerDrafted', () => {
    const rig = setup();
    const { id } = inProgress(rig, { source: 'butler' });
    rig.todos.update(id, { notes: '用户补一句' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates[0]).toMatchObject({ viaButler: false, butlerDrafted: true });
    expect(rig.updates[0]!.text).toContain('（由用户修改；');
  });

  it('不通知：草案、未到点的排期、一次性排期；下次派发自然带上新内容', async () => {
    const rig = setup();
    const draft = rig.todos.create({ title: '草案' }).todo;
    const assigned = rig.todos.create({
      title: '有执行者的草案',
      assignee: botAssignee('bot_a'),
    }).todo;
    const scheduled = rig.todos.create({
      title: '排期',
      assignee: botAssignee('bot_a'),
      when: futureIso(rig, 3_600_000),
    }).todo;
    for (const todo of [draft, assigned, scheduled]) {
      expect(rig.todos.update(todo.id, { notes: '改了' }).notified).toBe(false);
    }
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    // 到点时派发带的是新内容。
    rig.clock.advance(3_600_000);
    await rig.fireDue();
    expect(rig.lastDispatch().text).toBe('【工作台】排期\n\n改了');
  });

  it('不通知：已交付、已完成、已取消（交付后改字只改数据）', () => {
    const rig = setup();
    const { id, runId } = inProgress(rig);
    rig.todos.settleDelivered(runId, 'msg_result');
    expect(rig.todos.get(id).todo.status).toBe('delivered');
    expect(rig.todos.update(id, { notes: '交付后改' }).notified).toBe(false);
    rig.todos.complete(id);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
  });

  it('周期事项：停在 scheduled 且最近一次执行仍在途 → 通知；最近一次已交付 → 不通知', async () => {
    const rig = setup();
    const { todo } = rig.todos.create({
      title: '日报',
      notes: '旧',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    });
    // 还没触发过：没有在途派发。
    expect(rig.todos.update(todo.id, { notes: '新一' }).notified).toBe(false);
    rig.clock.setNow(todo.schedule!.nextFireAt!);
    await rig.fireDue();
    const runId = rig.lastDispatch().todoRunId;
    expect(rig.todos.get(todo.id).todo.status).toBe('scheduled');
    expect(rig.todos.update(todo.id, { notes: '新二' }).notified).toBe(true);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]).toMatchObject({ todoId: todo.id, todoRunId: runId });
    // 交付后再改：不通知，下次到点自然带新内容。
    rig.todos.settleDelivered(runId, 'msg_result');
    expect(rig.todos.update(todo.id, { notes: '新三' }).notified).toBe(false);
  });

  it('去抖期内事项被取消 / 交付 / 又发起新的派发：不发过期的通知', async () => {
    const rig = setup();
    const a = inProgress(rig);
    rig.todos.update(a.id, { notes: '改一' });
    rig.todos.cancel(a.id);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);

    const b = inProgress(rig);
    rig.todos.update(b.id, { notes: '改二' });
    rig.todos.settleDelivered(b.runId, 'msg_result');
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);

    // 周期事项：窗口内又起了一次新的派发（新 run 带的是新文字）。
    const { todo } = rig.todos.create({
      title: '日报',
      assignee: botAssignee('bot_a'),
      when: '0 9 * * *',
    });
    rig.clock.setNow(todo.schedule!.nextFireAt!);
    await rig.fireDue();
    rig.todos.update(todo.id, { notes: '改三' });
    rig.todos.settleDelivered(rig.lastDispatch().todoRunId, 'msg_r');
    rig.todos.start(todo.id);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
  });

  it('update(when:now) 本身就是新一次派发：不再另发更新', () => {
    const rig = setup();
    const draft = rig.todos.create({ title: '草案', assignee: botAssignee('bot_a') }).todo;
    const result = rig.todos.update(draft.id, { notes: '带说明立即开始', when: 'now' });
    expect(result.notified).toBe(false);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    expect(rig.lastDispatch().text).toContain('带说明立即开始');
  });

  it('发送失败（对话只读 / 路由抛错）只记日志，不影响事项', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    rig.flags.failUpdate = true;
    expect(() => {
      rig.todos.update(id, { notes: '改了' });
      rig.clock.advance(DEBOUNCE);
    }).not.toThrow();
    expect(rig.todos.get(id).todo).toMatchObject({ status: 'in_progress', notes: '改了' });

    const other = inProgress(rig);
    rig.flags.failUpdate = false;
    rig.conversations.get(rig.directIdOf('bot_a'))!.readOnly = true;
    rig.todos.update(other.id, { notes: '又改了' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
  });

  it('项目执行者：通知发到项目组，带派发消息 id（orchestrator 据它的 @ 与触发过的轮次找实际响应的 Bot）', () => {
    const rig = setup();
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '产品组', ['bot_a', 'bot_b']);
    const { todo } = rig.todos.create({
      title: '项目组里的事',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: 'bot_a' },
      when: 'now',
    });
    rig.todos.update(todo.id, { notes: '补充' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]).toMatchObject({
      conversationId: 'conv_g',
      todoRunId: rig.lastDispatch().todoRunId,
    });
    expect(rig.updates[0]!.dispatchMessageId).not.toBeNull();
  });

  it('项目组派发还没被接手（暂时没人可通知）：发不出去就重试，接手后送达；run 结算了就放弃', () => {
    const rig = setup();
    rig.addBot('bot_b', '阿乙');
    rig.addGroup('conv_g', '产品组', ['bot_a', 'bot_b']);
    const { todo } = rig.todos.create({
      title: '项目组里的事',
      notes: '原说明',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    });
    rig.flags.nobodyYet = true;
    expect(rig.todos.update(todo.id, { notes: '新说明' }).notified).toBe(true);
    rig.clock.advance(DEBOUNCE);
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    // 有 Bot 接手了：下一次重试送达，带最后的文字。
    rig.flags.nobodyYet = false;
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]!.text).toContain('新说明');
    // 送达后不再重发。
    rig.clock.advance(DEBOUNCE * 3);
    expect(rig.updates).toHaveLength(1);

    // 一直没人接手、run 结算了：放弃，不再有定时器。
    const other = rig.todos.create({
      title: '没人接的事',
      assignee: { kind: 'project', projectId: 'conv_g', leadBotId: null },
      when: 'now',
    }).todo;
    const runId = rig.lastDispatch().todoRunId;
    rig.flags.nobodyYet = true;
    rig.todos.update(other.id, { notes: '改了' });
    rig.clock.advance(DEBOUNCE);
    rig.todos.settleUnclaimed(runId);
    rig.flags.nobodyYet = false;
    rig.clock.advance(DEBOUNCE * 3);
    expect(rig.updates).toHaveLength(1);
  });

  it('执行者已知的文字只在送达后才推进：发送失败后再改回，仍会按「已知」文字比较', () => {
    const rig = setup();
    const { id } = inProgress(rig, { notes: '原说明' });
    rig.flags.failUpdate = true;
    rig.todos.update(id, { notes: '甲版' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    // 失败不算送达：改回原文（执行者看到的就是原文）不发；
    rig.todos.update(id, { notes: '原说明' });
    rig.flags.failUpdate = false;
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toEqual([]);
    // 失败后再改成别的：仍然发，且不会因为推进了基线而漏发。
    rig.flags.failUpdate = true;
    rig.todos.update(id, { notes: '乙版' });
    rig.clock.advance(DEBOUNCE);
    rig.flags.failUpdate = false;
    rig.todos.update(id, { notes: '丙版' });
    rig.clock.advance(DEBOUNCE);
    expect(rig.updates).toHaveLength(1);
    expect(rig.updates[0]!.text).toContain('丙版');
  });

  it('硬删（purge）后待发通知被清理，定时器不再触发', () => {
    const rig = setup();
    const { id } = inProgress(rig);
    const idle = rig.clock.armedTimers;
    rig.todos.update(id, { notes: '改了' });
    expect(rig.clock.armedTimers).toBe(idle + 1);
    rig.todos.purge(id);
    expect(rig.clock.armedTimers).toBe(idle);
    rig.clock.advance(DEBOUNCE * 2);
    expect(rig.updates).toEqual([]);
  });
});
