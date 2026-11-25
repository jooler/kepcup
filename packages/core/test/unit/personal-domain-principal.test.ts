import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type TodoEntry, type Memo, type Schedule, type Watch } from '@kepcup/shared';
import { withCaller, type CoreHarness } from '@kepcup/core';
import { createTestStack, makeBot, TestClock, type TestStack } from '@kepcup/testkit';
import { buildWorkbenchTools, type WorkbenchToolFacade } from '../../src/tools/workbench-tools.js';
import { buildScheduleTools, type ScheduleToolFacade } from '../../src/tools/schedule-tools.js';
import { buildWatchTools, type WatchToolFacade } from '../../src/tools/watch-tools.js';
import type { RunIdentity, ToolDefinition } from '../../src/agent/types.js';

/**
 * 62.11 C13（T6 步骤 1–2，docs/design/62-team-server/11-core-seams.md）：
 * 个人域对象（待办 / 备忘 + 分组 / 便签 / 排期 / 监看）按主体归属——创建落
 * 调用者、列表按调用者过滤、按 id 写操作做归属校验（不符 NOT_FOUND，不泄露
 * 存在性）；工具创建的归属当前运行主体；待办派发按归属开直聊；无调用者 =
 * 单用户现状（NULL 归属、全量列表、零校验）。
 */

const PR_A = 'pr_AAA';
const PR_B = 'pr_BBB';

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.cleanup();
});

async function start(): Promise<TestStack> {
  const stack = await createTestStack();
  stacks.push(stack);
  return stack;
}

async function callAs(
  core: CoreHarness,
  method: string,
  input?: Record<string, unknown>,
  principalId?: string,
): Promise<never> {
  const spec = core.services.appMethods[method];
  if (spec === undefined) throw new Error(`method not bound: ${method}`);
  const parsed = input === undefined ? undefined : spec.input.safeParse(input);
  if (parsed !== undefined && !parsed.success) {
    throw new AppError('INVALID_INPUT', `Invalid input for ${method}`);
  }
  const task = async (): Promise<never> =>
    spec.output.parse(await spec.handle(parsed?.data)) as never;
  return principalId === undefined ? task() : withCaller({ principalId }, task);
}

function ownerOf(core: CoreHarness, table: string, id: string): string | null {
  const row = core.services.mainDb!
    .prepare(`select owner_principal_id as owner from ${table} where id = ?`)
    .get(id) as { owner: string | null } | undefined;
  return row?.owner ?? null;
}

describe('个人域按主体归属（62.11 C13）', () => {
  it('创建落调用者、列表按调用者过滤、按 id 越权 NOT_FOUND；无调用者 = 现状', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '执行者');
    const conv = core.services.domain!.conversations.openDirect(bot.id).conversation;

    // --- todos：创建落调用者 ---
    const aTodo = (await callAs(core, 'todos.create', { title: 'A 的事项' }, PR_A)) as {
      todo: TodoEntry;
    };
    const bTodo = (await callAs(core, 'todos.create', { title: 'B 的事项' }, PR_B)) as {
      todo: TodoEntry;
    };
    const plainTodo = (await callAs(core, 'todos.create', { title: '公共事项' })) as {
      todo: TodoEntry;
    };
    expect(ownerOf(core, 'todos', aTodo.todo.id)).toBe(PR_A);
    expect(ownerOf(core, 'todos', bTodo.todo.id)).toBe(PR_B);
    expect(ownerOf(core, 'todos', plainTodo.todo.id)).toBeNull();

    // --- todos：列表按调用者过滤（只看自己的）；无调用者 = 全量（现状）---
    const listA = (await callAs(core, 'todos.list', {}, PR_A)) as { todos: TodoEntry[] };
    expect(listA.todos.map((todo) => todo.id)).toEqual([aTodo.todo.id]);
    const listAll = (await callAs(core, 'todos.list', {})) as { todos: TodoEntry[] };
    expect(listAll.todos.map((todo) => todo.id).sort()).toEqual(
      [aTodo.todo.id, bTodo.todo.id, plainTodo.todo.id].sort(),
    );

    // --- todos：按 id 写操作越权 → NOT_FOUND（不泄露存在性）---
    await expect(callAs(core, 'todos.update', { id: bTodo.todo.id, title: 'X' }, PR_A)).rejects
      .toMatchObject({ code: 'NOT_FOUND' });
    await expect(callAs(core, 'todos.complete', { id: bTodo.todo.id }, PR_A)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    // 归属主体自己可写；无调用者零校验（现状）。
    await expect(callAs(core, 'todos.update', { id: aTodo.todo.id, title: 'A 改过' }, PR_A)).resolves
      .toMatchObject({ todo: { title: 'A 改过' } });
    await expect(callAs(core, 'todos.update', { id: bTodo.todo.id, title: '无调用者照旧' }))
      .resolves.toBeTruthy();

    // --- memos + 分组同口径 ---
    const aMemo = (await callAs(core, 'memos.create', { body: 'A 的备忘' }, PR_A)) as {
      memo: Memo;
    };
    const bMemo = (await callAs(core, 'memos.create', { body: 'B 的备忘' }, PR_B)) as {
      memo: Memo;
    };
    expect(ownerOf(core, 'memos', aMemo.memo.id)).toBe(PR_A);
    const aGroup = (await callAs(core, 'memos.groups.create', { title: 'A 的组' }, PR_A)) as {
      group: { id: string };
    };
    expect(ownerOf(core, 'memo_groups', aGroup.group.id)).toBe(PR_A);
    const memosA = (await callAs(core, 'memos.list', {}, PR_A)) as { memos: Memo[]; groups: unknown[] };
    expect(memosA.memos.map((memo) => memo.id)).toEqual([aMemo.memo.id]);
    expect(memosA.groups).toHaveLength(1);
    const memosAll = (await callAs(core, 'memos.list', {})) as { memos: Memo[] };
    expect(memosAll.memos.map((memo) => memo.id).sort()).toEqual(
      [aMemo.memo.id, bMemo.memo.id].sort(),
    );
    await expect(callAs(core, 'memos.delete', { id: bMemo.memo.id }, PR_A)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(callAs(core, 'memos.groups.rename', { id: aGroup.group.id, title: '改名' }, PR_B))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    // --- stickies：归属只作用于 scope='global' 行 ---
    const globalA = (await callAs(core, 'stickies.create', {
      conversationId: conv.id,
      text: 'A 的全局便签',
      scope: 'global',
      position: null,
      z: 1,
    }, PR_A)) as { stickie: { id: string } };
    const convA = (await callAs(core, 'stickies.create', {
      conversationId: conv.id,
      text: 'A 的会话便签',
      scope: 'conversation',
      position: null,
      z: 2,
    }, PR_A)) as { stickie: { id: string } };
    expect(ownerOf(core, 'stickies', globalA.stickie.id)).toBe(PR_A);
    // 会话作用域便签不落归属（随会话可见性）。
    expect(ownerOf(core, 'stickies', convA.stickie.id)).toBeNull();
    // B 看不到 A 的全局便签，但会话作用域行照旧全量。
    const stickiesB = (await callAs(core, 'stickies.list', {}, PR_B)) as {
      stickies: Array<{ id: string }>;
    };
    expect(stickiesB.stickies.map((row) => row.id)).toEqual([convA.stickie.id]);
    const stickiesAll = (await callAs(core, 'stickies.list', {})) as {
      stickies: Array<{ id: string }>;
    };
    expect(stickiesAll.stickies).toHaveLength(2);
    // 越权删全局便签 → NOT_FOUND；删会话作用域便签不受归属约束。
    await expect(callAs(core, 'stickies.delete', { id: globalA.stickie.id }, PR_B)).rejects
      .toMatchObject({ code: 'NOT_FOUND' });
    await expect(callAs(core, 'stickies.delete', { id: convA.stickie.id }, PR_B)).resolves.toBeTruthy();

    // --- schedules：列表过滤 + 取消越权（归属排期落在归属主体的直聊里）---
    const schedules = core.services.schedules!;
    const directOfA = core.services.domain!.conversations.openDirect(bot.id, {
      ownerPrincipalId: PR_A,
    }).conversation;
    const runAt = Date.now() + 3_600_000;
    const aSchedule = schedules.createOnce({
      botId: bot.id,
      conversationId: directOfA.id,
      runAt,
      note: 'A 的定时',
      ownerPrincipalId: PR_A,
    });
    const plainSchedule = schedules.createOnce({
      botId: bot.id,
      conversationId: conv.id,
      runAt: runAt + 60_000,
      note: '无主定时',
    });
    expect(ownerOf(core, 'schedules', aSchedule.id)).toBe(PR_A);
    expect(ownerOf(core, 'schedules', plainSchedule.id)).toBeNull();
    const schedulesA = (await callAs(core, 'schedules.list', {}, PR_A)) as {
      schedules: Schedule[];
    };
    expect(schedulesA.schedules.map((row) => row.id)).toEqual([aSchedule.id]);
    const schedulesAll = (await callAs(core, 'schedules.list', {})) as { schedules: Schedule[] };
    expect(schedulesAll.schedules.map((row) => row.id).sort()).toEqual(
      [aSchedule.id, plainSchedule.id].sort(),
    );
    await expect(callAs(core, 'schedules.cancel', { id: aSchedule.id }, PR_B)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(callAs(core, 'schedules.cancel', { id: aSchedule.id }, PR_A)).resolves.toBeTruthy();
    await expect(callAs(core, 'schedules.cancel', { id: plainSchedule.id })).resolves.toBeTruthy();

    // --- watches：service 层创建落归属，RPC 列表过滤 + 暂停越权 ---
    const watches = core.services.watches!;
    const aWatch = watches.create({
      botId: bot.id,
      conversationId: directOfA.id,
      source: { kind: 'web_page', url: 'https://example.com/a' },
      condition: { kind: 'changed' },
      intervalSec: 600,
      ownerPrincipalId: PR_A,
    });
    const plainWatch = watches.create({
      botId: bot.id,
      conversationId: conv.id,
      source: { kind: 'web_page', url: 'https://example.com/b' },
      condition: { kind: 'changed' },
      intervalSec: 600,
    });
    expect(ownerOf(core, 'watches', aWatch.id)).toBe(PR_A);
    expect(ownerOf(core, 'watches', plainWatch.id)).toBeNull();
    const watchesA = (await callAs(core, 'watches.list', {}, PR_A)) as { watches: Watch[] };
    expect(watchesA.watches.map((row) => row.id)).toEqual([aWatch.id]);
    const watchesAll = (await callAs(core, 'watches.list', {})) as { watches: Watch[] };
    expect(watchesAll.watches.map((row) => row.id).sort()).toEqual(
      [aWatch.id, plainWatch.id].sort(),
    );
    await expect(callAs(core, 'watches.pause', { id: aWatch.id }, PR_B)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(callAs(core, 'watches.pause', { id: plainWatch.id })).resolves.toBeTruthy();
  });

  it('事件载荷带归属（有 owner 才带字段；无 owner 逐字段不变）', async () => {
    const stack = await start();
    const core = stack.core;
    await makeBot(core, '执行者');
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    core.onEvent('todos.changed', (payload) => {
      events.push({ event: 'todos.changed', payload: payload as Record<string, unknown> });
    });
    core.onEvent('memos.changed', (payload) => {
      events.push({ event: 'memos.changed', payload: payload as Record<string, unknown> });
    });

    await callAs(core, 'todos.create', { title: '归属事项' }, PR_A);
    await callAs(core, 'todos.create', { title: '无主事项' });
    await callAs(core, 'memos.create', { body: '归属备忘' }, PR_A);

    const todoEvents = events.filter((entry) => entry.event === 'todos.changed');
    expect(todoEvents.some((entry) => entry.payload.ownerPrincipalId === PR_A)).toBe(true);
    expect(todoEvents.some((entry) => entry.payload.ownerPrincipalId === undefined)).toBe(true);
    const memoEvent = events.find((entry) => entry.event === 'memos.changed');
    expect(memoEvent?.payload.ownerPrincipalId).toBe(PR_A);
  });

  it('purge 删除归属事项：todos.changed 仍带 ownerPrincipalId（删行后再查只会得到 null）', async () => {
    // T6 审查回归：归属成员彻底删除自己的事项时，事件在删行之后发布——
    // 归属必须在删除前抓取，否则载荷不带 ownerPrincipalId，团队层不会下发，
    // 成员自己的多端就收不到刷新。
    const stack = await start();
    const core = stack.core;
    await makeBot(core, '删除执行者');
    const created = (await callAs(core, 'todos.create', { title: '待删归属事项' }, PR_A)) as {
      todo: TodoEntry;
    };
    const events: Array<Record<string, unknown>> = [];
    core.onEvent('todos.changed', (payload) => {
      events.push(payload as Record<string, unknown>);
    });
    const purged = await callAs(core, 'todos.cancel', { id: created.todo.id }, PR_A);
    expect((purged as { todo: { status: string } }).todo.status).toBe('cancelled');
    // 经 service 层 purge（RPC 面无 todos.purge；成员域入口未来出现时走同一路径）。
    events.length = 0; // 只看 purge 自己发的那一帧
    core.services.todos!.purge(created.todo.id, 'user', PR_A);
    const purgeEvent = events.find(
      (payload) => payload.todoId === created.todo.id && payload.ownerPrincipalId === PR_A,
    );
    expect(purgeEvent).toBeDefined();
  });

  it('工具创建的个人域对象归属当前运行主体（缺省 = 不带归属）', async () => {
    const identity: RunIdentity = {
      runId: 'run_tool_1',
      botId: 'bot_butler',
      conversationId: 'conv_tool',
      loopType: 'turn',
    };
    const seen: Record<string, unknown[]> = { createTodo: [], createMemo: [], schedule: [], watch: [] };

    const workbench = {
      isButler: () => true,
      listTodos: () => [],
      getTodo: () => {
        throw new Error('unused');
      },
      createTodo: (input: { ownerPrincipalId?: string | null }) => {
        seen.createTodo.push(input);
        return {
          todo: { id: 'todo_1', title: 't', status: 'draft', warnings: [] },
          warnings: [],
        } as never;
      },
      updateTodo: () => {
        throw new Error('unused');
      },
      startTodo: () => {
        throw new Error('unused');
      },
      completeTodo: () => {
        throw new Error('unused');
      },
      cancelTodo: () => {
        throw new Error('unused');
      },
      listMemos: () => [],
      createMemo: (input: { ownerPrincipalId?: string | null }) => {
        seen.createMemo.push(input);
        return { id: 'memo_1' } as never;
      },
      updateMemo: () => {
        throw new Error('unused');
      },
      deleteMemo: () => {
        throw new Error('unused');
      },
      describeWhen: () => '',
      describeTime: () => '',
      contextSection: () => '',
      isTainted: () => false,
      now: () => 0,
    } as never as WorkbenchToolFacade;

    const schedule = {
      createFromWhen: (input: { ownerPrincipalId?: string | null }) => {
        seen.schedule.push(input);
        return { id: 'sch_1', kind: 'once' } as never;
      },
      validateWhen: () => ({}),
      describeWhen: () => '',
      fireabilityWarnings: () => [],
      listForBotInConversation: () => [],
      cancelOwn: () => ({ ok: true, message: '' }),
      createOffer: () => ({ ok: true, message: '' }),
      contextSection: () => '',
      displayTitle: () => null,
    } as never as ScheduleToolFacade;

    const watch = {
      create: (input: { ownerPrincipalId?: string | null }) => {
        seen.watch.push(input);
        return { id: 'wat_1' } as never;
      },
      listForBotInConversation: () => [],
      stopOwn: () => ({ ok: true, message: '' }),
    } as never as WatchToolFacade;

    const runTool = async (tools: ToolDefinition[], name: string, params: unknown) => {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) throw new Error(`tool not built: ${name}`);
      return tool.execute(params as never, { signal: new AbortController().signal } as never);
    };

    // 有运行主体：创建输入带 ownerPrincipalId。
    const workbenchTools = buildWorkbenchTools({
      identity,
      workbench,
      triggerFromUser: true,
      principalId: PR_A,
    });
    await runTool(workbenchTools, 'create_todo', { title: '工具事项' });
    await runTool(workbenchTools, 'create_memo', { body: '工具备忘' });
    expect(seen.createTodo[0]).toMatchObject({ ownerPrincipalId: PR_A });
    expect(seen.createMemo[0]).toMatchObject({ ownerPrincipalId: PR_A });

    await runTool(
      buildScheduleTools({ identity, schedule, principalId: PR_A }),
      'schedule',
      { when: new Date(Date.now() + 60_000).toISOString(), note: '工具排期' },
    );
    expect(seen.schedule[0]).toMatchObject({ ownerPrincipalId: PR_A });

    await runTool(buildWatchTools({ identity, watch, principalId: PR_A }), 'watch_create', {
      url: 'https://example.com/watch',
      condition: { kind: 'changed' },
      interval_minutes: 10,
    });
    expect(seen.watch[0]).toMatchObject({ ownerPrincipalId: PR_A });

    // 无运行主体（单用户）：不带归属字段 = 现状。
    await runTool(
      buildWorkbenchTools({ identity, workbench, triggerFromUser: true }),
      'create_todo',
      { title: '无主工具事项' },
    );
    expect(
      (seen.createTodo.at(-1) as { ownerPrincipalId?: string | null }).ownerPrincipalId,
    ).toBeUndefined();
    await runTool(buildScheduleTools({ identity, schedule }), 'schedule', {
      when: new Date(Date.now() + 60_000).toISOString(),
      note: '无主工具排期',
    });
    expect(
      (seen.schedule.at(-1) as { ownerPrincipalId?: string | null }).ownerPrincipalId,
    ).toBeUndefined();
    await runTool(buildWatchTools({ identity, watch }), 'watch_create', {
      url: 'https://example.com/watch2',
      condition: { kind: 'changed' },
      interval_minutes: 10,
    });
    expect((seen.watch.at(-1) as { ownerPrincipalId?: string | null }).ownerPrincipalId).toBeUndefined();
  });

  it('usage.sumByPrincipal：按主体只读日汇总；带会话类型过滤时排除无会话行', async () => {
    // TestClock 基点固定：日分桶断言与运行时刻的服务器时区无关。
    const clock = new TestClock();
    const stack = await createTestStack({ clock, timers: clock });
    stacks.push(stack);
    const core = stack.core;
    const bot = await makeBot(core, '用量执行者');
    const usage = core.services.domain!.usage;
    const db = core.services.mainDb!;
    const conv = core.services.domain!.conversations.openDirect(bot.id, {
      ownerPrincipalId: PR_A,
    }).conversation;
    const insert = db.prepare(
      `insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model,
                                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                 cost_usd, principal_id, created_at)
       values (?, 'run_u', ?, ?, 'turn', 'mock', 'm', ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 同一本地日的两行 + 前一天一行；再加一行无会话、一行别的主体。
    const now = core.services.clock.now();
    insert.run('use_1', bot.id, conv.id, 100, 20, 5, 0, 0.5, PR_A, now);
    insert.run('use_2', bot.id, conv.id, 10, 2, 0, 1, null, PR_A, now - 1);
    insert.run('use_3', bot.id, conv.id, 7, 3, 0, 0, 0.25, PR_A, now - 26 * 3_600_000);
    insert.run('use_4', bot.id, null, 50, 50, 0, 0, 1, PR_A, now);
    insert.run('use_5', bot.id, conv.id, 1, 1, 0, 0, 0, PR_B, now);

    const days = usage.sumByPrincipal(PR_A, { from: now - 48 * 3_600_000, to: now + 1 });
    expect(days).toHaveLength(2);
    const today = days.at(-1)!;
    expect(today.calls).toBe(3); // 含无会话行（未带 filter 时不排除）
    expect(today.inputTokens).toBe(160);
    expect(today.outputTokens).toBe(72);
    expect(today.cacheReadTokens).toBe(5);
    expect(today.cacheWriteTokens).toBe(1);
    // use_1 的 0.5 + use_4（无会话行）的 1：未带 filter 时不排除无会话行。
    expect(today.costUsd).toBeCloseTo(1.5, 6);
    expect(days[0]!.calls).toBe(1);

    // 带 conversationTypes 过滤：inner join conversations，无会话行被排除。
    const filtered = usage.sumByPrincipal(PR_A, { from: now - 48 * 3_600_000, to: now + 1 }, {
      conversationTypes: ['direct'],
    });
    expect(filtered.at(-1)!.calls).toBe(2);
    // 别的主体的账不串。
    expect(usage.sumByPrincipal(PR_B, { from: now - 48 * 3_600_000, to: now + 1 })).toHaveLength(
      1,
    );
  });

  it('待办派发按归属开直聊；事项排期继承归属；无归属 = 现状直聊', async () => {
    const stack = await start();
    const core = stack.core;
    const bot = await makeBot(core, '派发执行者');
    const conversations = core.services.domain!.conversations;
    const todos = core.services.todos!;

    // 归属 A 的事项立即派发 → 落在「A 与执行者」的直聊。
    const dispatched = todos.create({
      title: 'A 派的活',
      assignee: { kind: 'bot', botId: bot.id },
      when: 'now',
      source: 'user',
      actor: 'user',
      ownerPrincipalId: PR_A,
    });
    const directA = conversations
      .listDirectByBot(bot.id)
      .find((row) => row.ownerPrincipalId === PR_A);
    expect(directA).toBeTruthy();
    const runRow = core.services.mainDb!
      .prepare('select conversation_id as id from todo_runs where todo_id = ?')
      .get(dispatched.todo.id) as { id: string };
    expect(runRow.id).toBe(directA!.id);

    // 无归属事项的派发照旧落无主直聊（现状）。
    const plain = todos.create({
      title: '公共的活',
      assignee: { kind: 'bot', botId: bot.id },
      when: 'now',
      source: 'user',
      actor: 'user',
    });
    const plainDirect = conversations
      .listDirectByBot(bot.id)
      .find((row) => row.ownerPrincipalId == null);
    expect(plainDirect).toBeTruthy();
    const plainRun = core.services.mainDb!
      .prepare('select conversation_id as id from todo_runs where todo_id = ?')
      .get(plain.todo.id) as { id: string };
    expect(plainRun.id).toBe(plainDirect!.id);

    // 有执行者 + 未来时间：排期行继承事项归属（到期 run 主体与上限口径）。
    const scheduled = todos.create({
      title: 'A 的排期事项',
      assignee: { kind: 'bot', botId: bot.id },
      when: new Date(Date.now() + 86_400_000).toISOString(),
      source: 'user',
      actor: 'user',
      ownerPrincipalId: PR_A,
    });
    const scheduleRow = core.services.mainDb!
      .prepare(
        "select id, owner_principal_id as owner from schedules where todo_id = ? and status = 'active'",
      )
      .get(scheduled.todo.id) as { id: string; owner: string | null };
    expect(scheduleRow.owner).toBe(PR_A);
    core.services.schedules!.cancel(scheduleRow.id);
  });
});
