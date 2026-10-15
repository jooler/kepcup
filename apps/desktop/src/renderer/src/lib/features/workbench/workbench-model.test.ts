import { describe, expect, it } from 'vitest';
import type { Memo, ScheduleEntry, TodoEntry } from '@kepcup/shared';
import {
  ageOf,
  blockedNotice,
  botMembers,
  buildLanes,
  closedTodos,
  cutUtf16,
  effectiveStatus,
  filterMemos,
  groupMembers,
  laneIdOfTodo,
  memoToTodoDraft,
  parseDispatchText,
  runningBotSet,
  selfScheduleSource,
  sortMemos,
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
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    assigneeName: null,
    leadBotName: null,
    schedule: null,
    lastRun: null,
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
const groups: MemberInfo[] = [{ id: 'g1', name: '产品组' }];

describe('buildLanes', () => {
  it('未指派在最前，之后 Bot 在群之前', () => {
    const lanes = buildLanes({
      todos: [
        todo('t1', {
          assignee: { kind: 'group', conversationId: 'g1', leadBotId: null },
          assigneeName: '产品组',
        }),
        todo('t2', toBot('a')),
        todo('t3'),
      ],
      schedules: [],
      bots,
      groups,
    });
    expect(lanes.map((lane) => lane.id)).toEqual(['unassigned', 'bot:a', 'group:g1']);
  });

  it('没有未指派事项时不出现未指派道；已结束的事项不进道', () => {
    const lanes = buildLanes({
      todos: [todo('t1', toBot('a', { status: 'done' })), todo('t2', toBot('b'))],
      schedules: [],
      bots,
      groups,
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
      groups,
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
      groups,
    });
    expect(lanes.map((lane) => lane.memberId)).toEqual(['c', 'a', 'b']);
  });

  it('道内事项顺序与计数；下次时间取事项排期与自排任务的最早者', () => {
    const lanes = buildLanes({
      todos: [
        todo('draft-old', toBot('a', { updatedAt: 1 })),
        todo('draft-new', toBot('a', { updatedAt: 9 })),
        todo('sch-late', toBot('a', { status: 'scheduled', schedule: sched(8_000) })),
        todo('sch-soon', toBot('a', { status: 'scheduled', schedule: sched(7_000) })),
        todo('run', toBot('a', { status: 'in_progress' })),
        todo('deliv', toBot('a', { status: 'delivered' })),
      ],
      schedules: [self('s1', 'a', { nextFireAt: 3_000 })],
      bots,
      groups,
    });
    const lane = lanes[0]!;
    expect(lane.todos.map((item) => item.id)).toEqual([
      'deliv',
      'run',
      'sch-soon',
      'sch-late',
      'draft-new',
      'draft-old',
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
      groups,
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
      groups: [],
    });
    expect(lanes.map((lane) => lane.name).sort()).toEqual(['A', 'x']);
  });

  it('群事项的负责 Bot 不另起道', () => {
    const t = todo('t1', {
      assignee: { kind: 'group', conversationId: 'g1', leadBotId: 'a' },
      assigneeName: '产品组',
      leadBotName: 'A',
    });
    expect(laneIdOfTodo(t)).toBe('group:g1');
    expect(buildLanes({ todos: [t], schedules: [], bots, groups }).map((l) => l.id)).toEqual([
      'group:g1',
    ]);
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
    deletedAt: null,
    ...patch,
  };
}

describe('备忘', () => {
  it('置顶在前，其余按更新时间倒序', () => {
    const out = sortMemos([
      memo('a', { updatedAt: 5 }),
      memo('b', { updatedAt: 9 }),
      memo('c', { updatedAt: 1, pinned: true }),
      memo('d', { updatedAt: 3, pinned: true }),
    ]);
    expect(out.map((m) => m.id)).toEqual(['d', 'c', 'b', 'a']);
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

  it('groupMembers：只要群；创建中的不算；assignableOnly 去掉只读群', () => {
    const conversations = [
      { id: 'g1', type: 'group', title: '产品组', readOnly: false },
      { id: 'g2', type: 'group', title: null, readOnly: true },
      { id: 'g3', type: 'group', title: '新群', readOnly: false, setupState: 'creating' as const },
      { id: 'd1', type: 'direct', title: null, readOnly: false },
    ];
    expect(groupMembers(conversations).map((m) => m.id)).toEqual(['g1', 'g2']);
    expect(groupMembers(conversations, true).map((m) => m.id)).toEqual(['g1']);
    expect(groupMembers(conversations)[1]!.name).toBe('g2');
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
      groups,
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
    expect(n('draft', '派发失败：群已只读')?.kind).toBe('error');
    expect(n('draft', '执行已被取消')?.kind).toBe('warn');
    expect(n('draft', '对话已删除')?.kind).toBe('warn');
    expect(n('in_progress', '该 Bot 正在设置中，完成设置后才会处理')?.kind).toBe('note');
    expect(n('done', '执行失败：x')).toBeNull();
    expect(n('draft', null)).toBeNull();
    expect(n('draft', '  ')).toBeNull();
  });
});
