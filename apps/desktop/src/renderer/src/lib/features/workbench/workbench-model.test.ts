import { describe, expect, it } from 'vitest';
import type { Memo, MemoGroup, ScheduleEntry, TodoEntry } from '@kepcup/shared';
import {
  ageOf,
  blockedNotice,
  botMembers,
  buildLanes,
  canReassignTodo,
  closedTodos,
  cutUtf16,
  effectiveMemoTab,
  effectiveStatus,
  filterMemos,
  laneIdOfTodo,
  MEMO_MOVE_INLINE_LIMIT,
  memoConverted,
  memosInGroup,
  projectMembers,
  memoToTodoDraft,
  parseDispatchText,
  runningBotSet,
  selfScheduleSource,
  showUngroupedTab,
  sortMemos,
  splitMoveTargets,
  todoStartAt,
  type MemberInfo,
} from './workbench-model';

function todo(id: string, patch: Partial<TodoEntry> = {}): TodoEntry {
  return {
    id,
    title: id,
    notes: '',
    assignee: null,
    status: 'draft',
    source: 'user',
    memoId: null,
    blockedReason: null,
    pendingWhen: null,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    position: 1,
    assigneeName: null,
    leadBotName: null,
    schedule: null,
    lastRun: null,
    board: null,
    ...patch,
  };
}

function toBot(botId: string, patch: Partial<TodoEntry> = {}): Partial<TodoEntry> {
  return { assignee: { kind: 'bot', botId }, assigneeName: botId.toUpperCase(), ...patch };
}

function self(id: string, botId: string, patch: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id,
    botId,
    conversationId: `c_${botId}`,
    kind: 'cron',
    runAt: null,
    cron: '0 8 * * *',
    timezone: 'Asia/Shanghai',
    note: '',
    title: id,
    origin: 'tool',
    commitmentId: null,
    todoId: null,
    status: 'active',
    nextFireAt: null,
    lastFiredAt: null,
    createdAt: 1,
    botName: botId.toUpperCase(),
    deferredReason: null,
    ...patch,
  };
}

const bots: MemberInfo[] = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
  { id: 'd', name: 'D' },
  { id: 'butler', name: '管家', isButler: true },
];
const projects: MemberInfo[] = [{ id: 'g1', name: '产品组' }];

describe('buildLanes', () => {
  it('未指派在最前，之后 Bot 在项目组之前', () => {
    const lanes = buildLanes({
      todos: [
        todo('t1', {
          assignee: { kind: 'project', projectId: 'g1', leadBotId: null },
          assigneeName: '产品组',
        }),
        todo('t2', toBot('a')),
        todo('t3'),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.id)).toEqual(['unassigned', 'bot:a', 'project:g1']);
  });

  it('没有未指派事项时不出现未指派道；已结束的事项不进道', () => {
    const lanes = buildLanes({
      todos: [todo('t1', toBot('a', { status: 'done' })), todo('t2', toBot('b'))],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.id)).toEqual(['bot:b']);
  });

  it('Bot 道排序：待验收 > 进行中 > 下次时间近 > 无下次；同级按名称', () => {
    const lanes = buildLanes({
      todos: [
        todo('t-a', toBot('a', { status: 'scheduled', schedule: sched(5_000) })),
        todo('t-b', toBot('b', { status: 'in_progress' })),
        todo('t-c', toBot('c', { status: 'delivered' })),
        todo('t-d', toBot('d', { status: 'scheduled', schedule: sched(1_000) })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.memberId)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('同级无下次时间的靠后，名称兜底', () => {
    const lanes = buildLanes({
      todos: [
        todo('t1', toBot('b')),
        todo('t2', toBot('a')),
        todo('t3', toBot('c', { status: 'scheduled', schedule: sched(9) })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.memberId)).toEqual(['c', 'a', 'b']);
  });

  it('道内事项顺序（自定义排序）= 手动 position 升序（同位按更新时间倒序）；计数与 nextAt 不变', () => {
    const lanes = buildLanes({
      customOrder: true,
      todos: [
        todo('run', toBot('a', { status: 'in_progress', position: 2 })),
        todo('draft-old', toBot('a', { updatedAt: 1, position: 5 })),
        todo('sch-late', toBot('a', { status: 'scheduled', schedule: sched(8_000), position: 3 })),
        todo('deliv', toBot('a', { status: 'delivered', position: 1 })),
        todo('sch-soon', toBot('a', { status: 'scheduled', schedule: sched(7_000), position: 4 })),
        todo('draft-new', toBot('a', { updatedAt: 9, position: 6 })),
      ],
      schedules: [self('s1', 'a', { nextFireAt: 3_000 })],
      bots,
      projects,
    });
    const lane = lanes[0]!;
    expect(lane.todos.map((item) => item.id)).toEqual([
      'deliv',
      'run',
      'sch-late',
      'sch-soon',
      'draft-old',
      'draft-new',
    ]);
    expect(lane.counts).toEqual({ draft: 2, scheduled: 2, inProgress: 1, delivered: 1 });
    expect(lane.nextAt).toBe(3_000);
    expect(lane.selfSchedules.map((item) => item.id)).toEqual(['s1']);
  });

  it('自排任务按 botId 归道（没有事项的 Bot 也成道）；workbench 排期、已结束、botId 为空的行不算自排', () => {
    const lanes = buildLanes({
      todos: [],
      schedules: [
        self('s1', 'b', { origin: 'commitment' }),
        self('s2', 'b', { origin: 'workbench', todoId: 't1' }),
        self('s3', 'c', { status: 'cancelled' }),
        self('s4', 'c', { botId: null }),
      ],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.id)).toEqual(['bot:b']);
    expect(lanes[0]!.selfSchedules.map((item) => item.id)).toEqual(['s1']);
  });

  it('执行者已不在名单时用事项上的名称，再退回 id', () => {
    const lanes = buildLanes({
      todos: [
        todo('t1', { assignee: { kind: 'bot', botId: 'x' }, assigneeName: null }),
        todo('t2', { assignee: { kind: 'bot', botId: 'a' }, assigneeName: null }),
      ],
      schedules: [],
      bots,
      projects: [],
    });
    expect(lanes.map((lane) => lane.name).sort()).toEqual(['A', 'x']);
  });

  it('项目组事项的负责 Bot 不另起道', () => {
    const t = todo('t1', {
      assignee: { kind: 'project', projectId: 'g1', leadBotId: 'a' },
      assigneeName: '产品组',
      leadBotName: 'A',
    });
    expect(laneIdOfTodo(t)).toBe('project:g1');
    expect(buildLanes({ todos: [t], schedules: [], bots, projects }).map((l) => l.id)).toEqual([
      'project:g1',
    ]);
  });
});

describe('道内排序：按开始时间（默认）/ 自定义排序', () => {
  it('默认按开始时间升序：越早要执行的在前，与 position 无关', () => {
    const lanes = buildLanes({
      todos: [
        todo('late', toBot('a', { position: 1, schedule: sched(9_000) })),
        todo('soon', toBot('a', { position: 5, schedule: sched(1_000) })),
        todo('middle', toBot('a', { position: 3, schedule: sched(5_000) })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes[0]!.todos.map((item) => item.id)).toEqual(['soon', 'middle', 'late']);
  });

  it('没有开始时间的排最后，之间按创建时间升序（越早创建越前）', () => {
    const lanes = buildLanes({
      todos: [
        todo('no-time-new', toBot('a', { createdAt: 30, position: 1 })),
        todo('timed', toBot('a', { createdAt: 99, schedule: sched(5_000), position: 2 })),
        todo('no-time-old', toBot('a', { createdAt: 10, position: 3 })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes[0]!.todos.map((item) => item.id)).toEqual(['timed', 'no-time-old', 'no-time-new']);
  });

  it('开始时间相同时按创建时间升序；全部无时间时也按创建时间升序', () => {
    const lanes = buildLanes({
      todos: [
        todo('b-same', toBot('a', { createdAt: 20, schedule: sched(7) })),
        todo('a-same', toBot('a', { createdAt: 10, schedule: sched(7) })),
        todo('c-none', toBot('a', { createdAt: 30 })),
        todo('d-none', toBot('a', { createdAt: 40 })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes[0]!.todos.map((item) => item.id)).toEqual([
      'a-same',
      'b-same',
      'c-none',
      'd-none',
    ]);
  });

  it('周期事项取下次触发时间（runAt 为空时用 nextFireAt）', () => {
    const lanes = buildLanes({
      todos: [
        todo(
          'daily',
          toBot('a', { schedule: { ...sched(9_000), kind: 'cron', cron: '0 8 * * *' } }),
        ),
        todo('once', toBot('a', { schedule: sched(3_000) })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes[0]!.todos.map((item) => item.id)).toEqual(['once', 'daily']);
  });

  it('两种排序互不影响：切回自定义排序仍回到 position 顺序，且都不改写 position', () => {
    const todos = [
      todo('late', toBot('a', { position: 1, schedule: sched(9_000) })),
      todo('soon', toBot('a', { position: 2, schedule: sched(1_000) })),
    ];
    const positions = todos.map((item) => [item.id, item.position]);
    const start = buildLanes({ todos, schedules: [], bots, projects });
    expect(start[0]!.todos.map((item) => item.id)).toEqual(['soon', 'late']);
    const custom = buildLanes({ todos, schedules: [], bots, projects, customOrder: true });
    expect(custom[0]!.todos.map((item) => item.id)).toEqual(['late', 'soon']);
    expect(todos.map((item) => [item.id, item.position])).toEqual(positions);
  });

  it('todoStartAt：单次取 runAt，周期 / 无 runAt 取 nextFireAt，无排期为 null', () => {
    expect(todoStartAt(todo('a', { schedule: sched(7) }))).toBe(7);
    expect(todoStartAt(todo('a'))).toBeNull();
    expect(
      todoStartAt(
        todo('a', {
          schedule: {
            id: 's',
            kind: 'cron',
            runAt: null,
            cron: '0 8 * * *',
            timezone: 'UTC',
            nextFireAt: 42,
          },
        }),
      ),
    ).toBe(42);
  });
});

describe('closedTodos', () => {
  it('done / cancelled，新关闭的在前', () => {
    const out = closedTodos([
      todo('open'),
      todo('old', { status: 'done', closedAt: 10 }),
      todo('new', { status: 'cancelled', closedAt: 20 }),
    ]);
    expect(out.map((item) => item.id)).toEqual(['new', 'old']);
  });
});

describe('selfScheduleSource', () => {
  it('来源标签', () => {
    expect(selfScheduleSource('tool')).toBe('tool');
    expect(selfScheduleSource('proposal')).toBe('routine');
    expect(selfScheduleSource('commitment')).toBe('commitment');
    expect(selfScheduleSource('offer')).toBe('offer');
  });
});

function memo(id: string, patch: Partial<Memo> = {}): Memo {
  return {
    id,
    body: id,
    pinned: false,
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    sortAt: 1,
    deletedAt: null,
    groupId: null,
    position: 1,
    ...patch,
  };
}

function group(id: string, title: string, position: number): MemoGroup {
  return { id, title, position, createdAt: 1, updatedAt: 1 };
}

describe('备忘', () => {
  it('置顶在前，其余按 position 升序（拖拽顺序）；id 兜底', () => {
    const out = sortMemos([
      memo('a', { position: 5 }),
      memo('b', { position: 9 }),
      memo('c', { position: 1, pinned: true }),
      memo('d', { position: 3, pinned: true }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('本地过滤：忽略大小写与首尾空白，空查询全部返回', () => {
    const all = [memo('1', { body: '下周和 A 公司谈价' }), memo('2', { body: 'Buy Milk' })];
    expect(filterMemos(all, '  ').length).toBe(2);
    expect(filterMemos(all, 'a 公司').map((m) => m.id)).toEqual(['1']);
    expect(filterMemos(all, 'milk').map((m) => m.id)).toEqual(['2']);
    expect(filterMemos(all, '不存在')).toEqual([]);
  });

  it('转事项预填：首个非空行作标题，全文作说明', () => {
    expect(memoToTodoDraft('周报交给研究员')).toEqual({ title: '周报交给研究员', notes: '' });
    expect(memoToTodoDraft('\n\n整理竞品\n  - 价格\n  - 渠道\n')).toEqual({
      title: '整理竞品',
      notes: '整理竞品\n  - 价格\n  - 渠道',
    });
    const long = memoToTodoDraft('字'.repeat(300));
    expect(Array.from(long.title).length).toBe(120);
    expect(Array.from(long.notes).length).toBe(300);
  });
});

describe('memoConverted（备忘「已转事项」判定）', () => {
  const linked = (id: string, status: TodoEntry['status'], memoId = 'm1'): TodoEntry =>
    todo(id, { memoId, status });

  it('草案 / 待执行 / 进行中 / 待验收都算已转事项', () => {
    for (const status of ['draft', 'scheduled', 'in_progress', 'delivered'] as const) {
      expect(memoConverted([linked('t1', status)], 'm1')).toBe(true);
    }
  });

  it('关联事项取消后不再算已转事项（恢复普通备忘）', () => {
    expect(memoConverted([linked('t1', 'cancelled')], 'm1')).toBe(false);
  });

  it('done 仍算已转事项（保留历史标记，不跟着取消一起排除）', () => {
    expect(memoConverted([linked('t1', 'done')], 'm1')).toBe(true);
  });

  it('同一备忘有多个事项：只要有一个没取消就算已转，全取消才恢复', () => {
    expect(memoConverted([linked('t1', 'cancelled'), linked('t2', 'draft')], 'm1')).toBe(true);
    expect(memoConverted([linked('t1', 'cancelled'), linked('t2', 'cancelled')], 'm1')).toBe(false);
  });

  it('没有关联事项、或只有别的备忘的事项，都不算已转', () => {
    expect(memoConverted([], 'm1')).toBe(false);
    expect(memoConverted([todo('t1', { status: 'draft' })], 'm1')).toBe(false);
    expect(memoConverted([linked('t1', 'draft', 'm2')], 'm1')).toBe(false);
    // 别的备忘的已取消事项也不能把本备忘的标签弄没。
    expect(
      memoConverted([linked('t1', 'cancelled', 'm2'), linked('t2', 'draft', 'm1')], 'm1'),
    ).toBe(true);
  });
});

describe('备忘 tab（D90 §5.4 分组用 tab 组织）', () => {
  it('memosInGroup：只取该分组的备忘（null = 未分组），按显示顺序（置顶在前、position 升序）', () => {
    const memos = [
      memo('a'),
      memo('b', { groupId: 'g2', position: 1 }),
      memo('c', { groupId: 'g1', position: 3 }),
      memo('d', { groupId: 'g1', position: 2 }),
      memo('e', { groupId: 'g1', position: 9, pinned: true }),
    ];
    expect(memosInGroup(memos, null).map((m) => m.id)).toEqual(['a']);
    expect(memosInGroup(memos, 'g1').map((m) => m.id)).toEqual(['e', 'd', 'c']);
    expect(memosInGroup(memos, 'g2').map((m) => m.id)).toEqual(['b']);
    expect(memosInGroup(memos, 'g_missing')).toEqual([]);
  });

  it('showUngroupedTab：有未分组条目才显示；空着时只在拖拽中显示（可拖回未分组）', () => {
    expect(showUngroupedTab([memo('a', { groupId: 'g1' })])).toBe(false);
    expect(showUngroupedTab([memo('a', { groupId: 'g1' })], true)).toBe(true);
    expect(showUngroupedTab([memo('a', { groupId: 'g1' }), memo('b')])).toBe(true);
    expect(showUngroupedTab([])).toBe(false);
    expect(showUngroupedTab([], true)).toBe(true);
  });

  it('effectiveMemoTab：记住的 tab 有效就用它', () => {
    const groups = [group('g1', '工作', 1024), group('g2', '生活', 2048)];
    expect(effectiveMemoTab('g2', groups, true)).toBe('g2');
    expect(effectiveMemoTab('g2', groups, false)).toBe('g2');
    expect(effectiveMemoTab('ungrouped', groups, true)).toBe('ungrouped');
  });

  it('effectiveMemoTab：失效（组被删 / 伪分组隐藏 / 从未选过）按 tab 序回落——未分组在先，再第一个命名分组', () => {
    const groups = [group('g1', '工作', 1024), group('g2', '生活', 2048)];
    // 组被删：伪分组显示时回落到它（恒在第一位），否则第一个命名分组。
    expect(effectiveMemoTab('g_gone', groups, true)).toBe('ungrouped');
    expect(effectiveMemoTab('g_gone', groups, false)).toBe('g1');
    // 记住的是伪分组，但它已隐藏（未分组条目没了）。
    expect(effectiveMemoTab('ungrouped', groups, false)).toBe('g1');
    // 从未选过。
    expect(effectiveMemoTab(null, groups, true)).toBe('ungrouped');
    expect(effectiveMemoTab(null, groups, false)).toBe('g1');
  });

  it('effectiveMemoTab：没有任何 tab（无未分组条目、无命名分组）为 null', () => {
    expect(effectiveMemoTab(null, [], false)).toBeNull();
    expect(effectiveMemoTab('ungrouped', [], false)).toBeNull();
    expect(effectiveMemoTab('g_gone', [], false)).toBeNull();
    // 只有未分组条目：就一个伪分组 tab。
    expect(effectiveMemoTab(null, [], true)).toBe('ungrouped');
  });

  it('splitMoveTargets：前 5 个直接列出（「未分组」也算一个），超过 5 个才有「更多」', () => {
    const targets = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(MEMO_MOVE_INLINE_LIMIT).toBe(5);
    expect(splitMoveTargets(targets(1))).toEqual({ inline: ['t0'], more: [] });
    // 恰好 5 个：全部直列，没有「更多」。
    expect(splitMoveTargets(targets(5))).toEqual({ inline: targets(5), more: [] });
    // 6 个起：第 6 个开始进「更多」，顺序不变。
    expect(splitMoveTargets(targets(6))).toEqual({ inline: targets(5), more: ['t5'] });
    expect(splitMoveTargets(targets(8)).more).toEqual(['t5', 't6', 't7']);
    expect(splitMoveTargets([])).toEqual({ inline: [], more: [] });
    expect(splitMoveTargets(targets(3), 2)).toEqual({ inline: ['t0', 't1'], more: ['t2'] });
  });
});

describe('canReassignTodo（跨道拖拽 = 改派执行者）', () => {
  const run = (status: 'dispatched' | 'delivered' | 'unclaimed') =>
    ({
      id: 'r',
      todoId: 't',
      conversationId: 'c',
      messageId: null,
      status,
      resultMessageId: null,
      dispatchedAt: 1,
      settledAt: null,
    }) as TodoEntry['lastRun'];

  it('草案 / 已排期可以改派', () => {
    expect(canReassignTodo(todo('t'))).toBe(true);
    expect(canReassignTodo(todo('t', { status: 'scheduled' }))).toBe(true);
  });

  it('进行中 / 待验收不行；已排期但最近一次执行在跑（周期事项）也不行', () => {
    expect(canReassignTodo(todo('t', { status: 'in_progress' }))).toBe(false);
    expect(canReassignTodo(todo('t', { status: 'delivered' }))).toBe(false);
    expect(canReassignTodo(todo('t', { status: 'scheduled', lastRun: run('dispatched') }))).toBe(
      false,
    );
    expect(canReassignTodo(todo('t', { status: 'scheduled', lastRun: run('delivered') }))).toBe(
      false,
    );
    expect(canReassignTodo(todo('t', { status: 'scheduled', lastRun: run('unclaimed') }))).toBe(
      true,
    );
  });
});

describe('ageOf', () => {
  const now = 1_000_000_000;
  it('刚刚 / 分钟 / 小时 / 天 / 日期', () => {
    expect(ageOf(now - 5_000, now)).toEqual({ unit: 'justNow' });
    expect(ageOf(now + 5_000, now)).toEqual({ unit: 'justNow' });
    expect(ageOf(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', n: 5 });
    expect(ageOf(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', n: 3 });
    expect(ageOf(now - 2 * 86_400_000, now)).toEqual({ unit: 'days', n: 2 });
    expect(ageOf(now - 9 * 86_400_000, now)).toEqual({ unit: 'date', at: now - 9 * 86_400_000 });
  });
});

describe('parseDispatchText', () => {
  it('标题 + 说明', () => {
    expect(parseDispatchText('【工作台】整理竞品\n看价格与渠道\n第二行')).toEqual({
      title: '整理竞品',
      notes: '看价格与渠道\n第二行',
      byButler: false,
      lateNote: null,
    });
  });
  it('管家代安排的标注被剥掉并记为 byButler', () => {
    expect(parseDispatchText('【工作台】整理竞品\n（管家代你安排）')).toEqual({
      title: '整理竞品',
      notes: '',
      byButler: true,
      lateNote: null,
    });
    expect(parseDispatchText('【工作台】整理竞品（管家代你安排）\n说明').byButler).toBe(true);
  });
  it('容错：没有前缀 / 空文本', () => {
    expect(parseDispatchText('随便一句').title).toBe('随便一句');
    expect(parseDispatchText('')).toEqual({
      title: '',
      notes: '',
      byButler: false,
      lateNote: null,
    });
  });

  it('recognizes a board dispatch and keeps the card text', () => {
    expect(parseDispatchText('【看板】调研竞品定价\n输出一页对比表')).toEqual({
      title: '调研竞品定价',
      notes: '输出一页对比表',
      byButler: false,
      lateNote: null,
      board: true,
    });
    expect(parseDispatchText('【看板】周期核对\n（上一次执行尚未交付）').notes).toBe(
      '（上一次执行尚未交付）',
    );
    expect(parseDispatchText('【看板】迟到的卡\n\n（原定 今天 08:00，延迟派发）')).toMatchObject({
      title: '迟到的卡',
      board: true,
      lateNote: '（原定 今天 08:00，延迟派发）',
    });
    expect(parseDispatchText('【工作台】整理竞品\n说明').board).toBeUndefined();
  });
});

function sched(nextFireAt: number): NonNullable<TodoEntry['schedule']> {
  return {
    id: `s${nextFireAt}`,
    kind: 'once',
    runAt: nextFireAt,
    cron: null,
    timezone: 'UTC',
    nextFireAt,
  };
}

describe('成员名单', () => {
  it('botMembers 只留 active，并标出管家', () => {
    expect(
      botMembers([
        { id: 'a', name: 'A', status: 'active' },
        { id: 'x', name: 'X', status: 'deleted' },
        { id: 'm', name: '管家', status: 'active', systemRole: 'butler' },
      ]),
    ).toEqual([
      { id: 'a', name: 'A', isButler: false },
      { id: 'm', name: '管家', isButler: true },
    ]);
  });

  it('projectMembers：只要项目组；assignableOnly 去掉只读项目组', () => {
    const conversations = [
      { id: 'g1', type: 'project', title: '产品组', readOnly: false },
      { id: 'g2', type: 'project', title: null, readOnly: true },
      { id: 'd1', type: 'direct', title: null, readOnly: false },
    ];
    expect(projectMembers(conversations).map((m) => m.id)).toEqual(['g1', 'g2']);
    expect(projectMembers(conversations, true).map((m) => m.id)).toEqual(['g1']);
    expect(projectMembers(conversations)[1]!.name).toBe('g2');
  });

  it('runningBotSet 取各会话 runningBotIds 的并集', () => {
    const set = runningBotSet([{ runningBotIds: ['a'] }, {}, { runningBotIds: ['a', 'b'] }]);
    expect([...set].sort()).toEqual(['a', 'b']);
  });
});

describe('周期事项的最近一次执行', () => {
  const run = (status: 'dispatched' | 'delivered' | 'unclaimed') =>
    ({
      id: 'r',
      todoId: 't',
      conversationId: 'c',
      messageId: null,
      status,
      resultMessageId: null,
      dispatchedAt: 1,
      settledAt: null,
    }) as TodoEntry['lastRun'];

  it('effectiveStatus：scheduled 且最近一次在跑 / 已交付，按执行状态算', () => {
    expect(effectiveStatus({ status: 'scheduled', lastRun: run('dispatched') })).toBe(
      'in_progress',
    );
    expect(effectiveStatus({ status: 'scheduled', lastRun: run('delivered') })).toBe('delivered');
    expect(effectiveStatus({ status: 'scheduled', lastRun: run('unclaimed') })).toBe('scheduled');
    expect(effectiveStatus({ status: 'scheduled', lastRun: null })).toBe('scheduled');
    expect(effectiveStatus({ status: 'draft', lastRun: run('delivered') })).toBe('draft');
  });

  it('道头计数与排序体现它（每条只计一次）', () => {
    const lanes = buildLanes({
      todos: [
        todo(
          'weekly',
          toBot('a', { status: 'scheduled', schedule: sched(9), lastRun: run('delivered') }),
        ),
        todo('daily', toBot('b', { status: 'scheduled', schedule: sched(5) })),
      ],
      schedules: [],
      bots,
      projects,
    });
    expect(lanes.map((lane) => lane.memberId)).toEqual(['a', 'b']);
    expect(lanes[0]!.counts).toEqual({ draft: 0, scheduled: 0, inProgress: 0, delivered: 1 });
    expect(lanes[1]!.counts.scheduled).toBe(1);
  });
});

describe('cutUtf16', () => {
  it('按 UTF-16 长度截断，不切开代理对', () => {
    expect(cutUtf16('abc', 5)).toBe('abc');
    expect(cutUtf16('abcdef', 3)).toBe('abc');
    expect(cutUtf16('a😀b', 2)).toBe('a');
    expect(cutUtf16('a😀b', 3)).toBe('a😀');
  });

  it('memoToTodoDraft 的标题不超过 120 个 UTF-16 单元', () => {
    const draft = memoToTodoDraft('😀'.repeat(100));
    expect(draft.title.length).toBeLessThanOrEqual(120);
    expect(draft.title).toBe('😀'.repeat(60));
    expect(draft.notes.length).toBe(200);
  });
});

describe('parseDispatchText：core 的实际格式', () => {
  it('标题 + 空行 + 说明', () => {
    expect(parseDispatchText('【工作台】整理竞品\n\n看价格与渠道')).toEqual({
      title: '整理竞品',
      notes: '看价格与渠道',
      byButler: false,
      lateNote: null,
    });
  });

  it('管家来源：标注在第一行末尾', () => {
    expect(parseDispatchText('【工作台】整理竞品（管家代你安排）\n\n看价格')).toEqual({
      title: '整理竞品',
      notes: '看价格',
      byButler: true,
      lateNote: null,
    });
  });

  it('补发迟到：末尾那一行单独取出，不混进说明', () => {
    const parsed = parseDispatchText(
      '【工作台】整理竞品\n\n看价格\n\n（原定 昨天 09:00，延迟派发）',
    );
    expect(parsed.notes).toBe('看价格');
    expect(parsed.lateNote).toBe('（原定 昨天 09:00，延迟派发）');
  });

  it('没有说明、只有迟到标注；三者同时出现', () => {
    expect(parseDispatchText('【工作台】T\n\n（原定 今天 08:00，延迟派发）')).toEqual({
      title: 'T',
      notes: '',
      byButler: false,
      lateNote: '（原定 今天 08:00，延迟派发）',
    });
    const all = parseDispatchText(
      '【工作台】T（管家代你安排）\n\n说明一\n说明二\n\n（原定 10月12日（周一）09:00，延迟派发）',
    );
    expect(all.byButler).toBe(true);
    expect(all.title).toBe('T');
    expect(all.notes).toBe('说明一\n说明二');
    expect(all.lateNote).toContain('延迟派发');
  });
});

describe('parseDispatchText：事项更新（D90，core 的实际格式）', () => {
  const footer = (by: '用户' | '管家') =>
    `（由${by}修改；这是对你已在做的这件事的补充，不是新任务；仅供参考，是否调整当前做法由你决定）`;

  it('标题 + 说明 + 末尾修改者行：修改者行取出，不进说明', () => {
    expect(
      parseDispatchText(`【工作台】事项更新：整理竞品\n\n只看国内\n第二行\n\n${footer('用户')}`),
    ).toEqual({
      title: '整理竞品',
      notes: '只看国内\n第二行',
      byButler: false,
      lateNote: null,
      update: true,
      updatedBy: 'user',
    });
  });

  it('管家修改：updatedBy=butler，byButler=true', () => {
    const parsed = parseDispatchText(
      `【工作台】事项更新：整理竞品\n\n只看国内\n\n${footer('管家')}`,
    );
    expect(parsed).toMatchObject({
      update: true,
      updatedBy: 'butler',
      byButler: true,
      notes: '只看国内',
    });
  });

  it('没有说明、只有标题和修改者行', () => {
    expect(parseDispatchText(`【工作台】事项更新：整理竞品\n\n${footer('用户')}`)).toMatchObject({
      title: '整理竞品',
      notes: '',
      update: true,
      updatedBy: 'user',
    });
  });

  it('容错：缺修改者行 → updatedBy=null；说明里出现类似括号的文字但不在末尾，不被吃掉', () => {
    expect(parseDispatchText('【工作台】事项更新：T\n\n说明')).toMatchObject({
      title: 'T',
      notes: '说明',
      update: true,
      updatedBy: null,
    });
    const parsed = parseDispatchText(
      `【工作台】事项更新：T\n\n（由用户修改；示例）后面还有字\n\n${footer('用户')}`,
    );
    expect(parsed.notes).toBe('（由用户修改；示例）后面还有字');
  });

  it('派发正文没有 update 字段；content.todoUpdate 标记优先于正文前缀（标题恰好以「事项更新：」开头的派发）', () => {
    expect('update' in parseDispatchText('【工作台】整理竞品\n\n说明')).toBe(false);
    const collide = parseDispatchText('【工作台】事项更新：季度复盘\n\n说明', false);
    expect(collide).toEqual({
      title: '事项更新：季度复盘',
      notes: '说明',
      byButler: false,
      lateNote: null,
    });
    expect(parseDispatchText('事项更新：T\n\n说明', true)).toMatchObject({
      title: '事项更新：T',
      update: true,
    });
    expect(parseDispatchText('【工作台】事项更新：T', undefined).update).toBe(true);
  });
});

describe('blockedNotice', () => {
  it('失败是错误；草案上的其它原因是警示；非草案上的是说明；已结束 / 无原因不显示', () => {
    const n = (status: TodoEntry['status'], blockedReason: string | null) =>
      blockedNotice({ status, blockedReason });
    expect(n('draft', '执行失败：模型不可用')).toEqual({
      kind: 'error',
      reason: '执行失败：模型不可用',
    });
    expect(n('draft', '派发失败：项目组已只读')?.kind).toBe('error');
    expect(n('draft', '执行已被取消')?.kind).toBe('warn');
    expect(n('draft', '对话已删除')?.kind).toBe('warn');
    expect(n('in_progress', '该 Bot 正在设置中，完成设置后才会处理')?.kind).toBe('note');
    expect(n('done', '执行失败：x')).toBeNull();
    expect(n('draft', null)).toBeNull();
    expect(n('draft', '  ')).toBeNull();
  });
});
