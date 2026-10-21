import type { Memo, ScheduleEntry, ScheduleOrigin, TodoEntry, TodoStatus } from '@kepcup/shared';
import { TODO_NOTES_MAX_CHARS, TODO_TITLE_MAX_CHARS } from '@kepcup/shared';

/**
 * 工作台的纯数据逻辑（D90 §5.2 / §5.4）：事项按成员分道与排序、
 * 自排任务归道、备忘的排序 / 本地过滤 / 转事项预填、派发消息正文解析。
 * 不碰 store / RPC，渲染层只负责呈现，单测覆盖这里。
 */

// ---------------------------------------------------------------------------
// 事项 · 按成员分道
// ---------------------------------------------------------------------------

/** 还没结束的状态（会出现在道里）；done / cancelled 归「最近结束」。 */
export const OPEN_TODO_STATUSES: readonly TodoStatus[] = [
  'draft',
  'scheduled',
  'in_progress',
  'delivered',
];

export function isOpenTodo(todo: Pick<TodoEntry, 'status'>): boolean {
  return todo.status !== 'done' && todo.status !== 'cancelled';
}

export type BlockedKind = 'error' | 'warn' | 'note';

/**
 * `blockedReason` 的呈现：执行 / 派发失败是错误；草案上的其它原因（退回草案的说明）是警示；
 * 非草案状态上的（如进行中的「该 Bot 正在设置中，完成设置后才会处理」）只是说明。
 * 已结束的事项不显示。
 */
export function blockedNotice(
  todo: Pick<TodoEntry, 'status' | 'blockedReason'>,
): { kind: BlockedKind; reason: string } | null {
  const reason = todo.blockedReason;
  if (reason === null || reason.trim().length === 0 || !isOpenTodo(todo)) return null;
  if (/^(执行失败|派发失败)/.test(reason)) return { kind: 'error', reason };
  return { kind: todo.status === 'draft' ? 'warn' : 'note', reason };
}

export type LaneKind = 'unassigned' | 'bot' | 'project';

export const UNASSIGNED_LANE_ID = 'unassigned';

export function botLaneId(botId: string): string {
  return `bot:${botId}`;
}

export function projectLaneId(projectId: string): string {
  return `project:${projectId}`;
}

/** 事项落在哪条道：未指派 / Bot / 项目组（负责 Bot 只是项目组道里的卡片标注，不另起道）。 */
export function laneIdOfTodo(todo: Pick<TodoEntry, 'assignee'>): string {
  const assignee = todo.assignee;
  if (assignee === null) return UNASSIGNED_LANE_ID;
  return assignee.kind === 'bot'
    ? botLaneId(assignee.botId)
    : projectLaneId(assignee.projectId);
}

/** 成员（Bot / 项目组）的最小信息：道名、管家标记。 */
export interface MemberInfo {
  id: string;
  name: string;
  /** Bot 才有：管家（可被指派；执行者选择器里带「管家」后缀）。 */
  isButler?: boolean;
}

export interface WorkbenchLane {
  id: string;
  kind: LaneKind;
  /** Bot id（kind = bot）或项目组会话 id（kind = project）；未指派为 null。 */
  memberId: string | null;
  name: string;
  todos: TodoEntry[];
  /** 该 Bot 自己安排的定时任务（只有 Bot 道有；项目组道恒空）。 */
  selfSchedules: ScheduleEntry[];
  counts: { draft: number; scheduled: number; inProgress: number; delivered: number };
  /** 最近的下一次触发（事项排期与自排任务取最早）；没有为 null。 */
  nextAt: number | null;
}

export interface LaneInput {
  todos: readonly TodoEntry[];
  /** `schedules.list` 全量；这里只取 origin !== 'workbench' 的行（自排）。 */
  schedules: readonly ScheduleEntry[];
  /** 名称兜底：事项 `assigneeName` 缺失（执行者已删）时查这里。 */
  bots: readonly MemberInfo[];
  projects: readonly MemberInfo[];
}

/**
 * 周期事项自身停在 scheduled，但最近一次执行可能正在跑 / 已交付：卡片与道头按这次执行的
 * 状态呈现（进行中 / 待验收），一条事项只计一次。
 */
export function effectiveStatus(todo: Pick<TodoEntry, 'status' | 'lastRun'>): TodoStatus {
  if (todo.status !== 'scheduled' || todo.lastRun === null) return todo.status;
  if (todo.lastRun.status === 'dispatched') return 'in_progress';
  if (todo.lastRun.status === 'delivered') return 'delivered';
  return todo.status;
}

/** 同一道内的事项顺序：待验收 → 进行中 → 已排期（下次时间近者在前）→ 草案（新改动在前）。 */
const STATUS_RANK: Record<TodoStatus, number> = {
  delivered: 0,
  in_progress: 1,
  scheduled: 2,
  draft: 3,
  done: 4,
  cancelled: 5,
};

export function compareTodos(a: TodoEntry, b: TodoEntry): number {
  const rank = STATUS_RANK[effectiveStatus(a)] - STATUS_RANK[effectiveStatus(b)];
  if (rank !== 0) return rank;
  if (a.status === 'scheduled') {
    const an = a.schedule?.nextFireAt ?? Number.POSITIVE_INFINITY;
    const bn = b.schedule?.nextFireAt ?? Number.POSITIVE_INFINITY;
    if (an !== bn) return an - bn;
  }
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function earliest(values: Array<number | null | undefined>): number | null {
  let min: number | null = null;
  for (const value of values) {
    if (typeof value === 'number' && (min === null || value < min)) min = value;
  }
  return min;
}

/** 自排任务 = 员工自己的日程（tool / proposal / commitment / offer），工作台事项的排期不在此列。 */
export function selfSchedulesOf(schedules: readonly ScheduleEntry[]): ScheduleEntry[] {
  return schedules.filter(
    (schedule) =>
      schedule.origin !== 'workbench' && schedule.status === 'active' && schedule.botId !== null,
  );
}

/**
 * 按成员分道。顺序：「未指派」在最前（有事项才出现）；之后是有事的 Bot，再是有事的项目组；
 * Bot / 项目组各自按「有待验收 → 有进行中 → 下次时间最近（无下次的靠后）→ 名称」排序。
 * 「有事」= 有未结束的事项，或（仅 Bot）有自排的 active 定时任务。
 */
export function buildLanes(input: LaneInput): WorkbenchLane[] {
  const open = input.todos.filter(isOpenTodo);
  const selfByBot = new Map<string, ScheduleEntry[]>();
  for (const schedule of selfSchedulesOf(input.schedules)) {
    const botId = schedule.botId as string;
    const list = selfByBot.get(botId);
    if (list === undefined) selfByBot.set(botId, [schedule]);
    else list.push(schedule);
  }

  const lanes = new Map<string, WorkbenchLane>();
  const botNames = new Map(input.bots.map((bot) => [bot.id, bot.name]));
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));

  function laneFor(todo: TodoEntry): WorkbenchLane {
    const id = laneIdOfTodo(todo);
    const existing = lanes.get(id);
    if (existing !== undefined) return existing;
    const assignee = todo.assignee;
    const created: WorkbenchLane =
      assignee === null
        ? emptyLane(UNASSIGNED_LANE_ID, 'unassigned', null, '')
        : assignee.kind === 'bot'
          ? emptyLane(
              id,
              'bot',
              assignee.botId,
              todo.assigneeName ?? botNames.get(assignee.botId) ?? assignee.botId,
            )
          : emptyLane(
              id,
              'project',
              assignee.projectId,
              todo.assigneeName ??
                projectNames.get(assignee.projectId) ??
                assignee.projectId,
            );
    lanes.set(id, created);
    return created;
  }

  for (const todo of open) laneFor(todo).todos.push(todo);
  for (const [botId, list] of selfByBot) {
    const id = botLaneId(botId);
    let lane = lanes.get(id);
    if (lane === undefined) {
      const name = botNames.get(botId) ?? list[0]?.botName ?? botId;
      lane = emptyLane(id, 'bot', botId, name);
      lanes.set(id, lane);
    }
    lane.selfSchedules = [...list].sort(
      (a, b) =>
        (a.nextFireAt ?? Number.POSITIVE_INFINITY) - (b.nextFireAt ?? Number.POSITIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    );
  }

  for (const lane of lanes.values()) {
    lane.todos.sort(compareTodos);
    for (const todo of lane.todos) {
      const status = effectiveStatus(todo);
      if (status === 'draft') lane.counts.draft += 1;
      else if (status === 'scheduled') lane.counts.scheduled += 1;
      else if (status === 'in_progress') lane.counts.inProgress += 1;
      else if (status === 'delivered') lane.counts.delivered += 1;
    }
    lane.nextAt = earliest([
      ...lane.todos.map((todo) => todo.schedule?.nextFireAt),
      ...lane.selfSchedules.map((schedule) => schedule.nextFireAt),
    ]);
  }

  const unassigned = lanes.get(UNASSIGNED_LANE_ID);
  const members = [...lanes.values()].filter((lane) => lane.kind !== 'unassigned');
  members.sort(compareLanes);
  return unassigned === undefined ? members : [unassigned, ...members];
}

function emptyLane(
  id: string,
  kind: LaneKind,
  memberId: string | null,
  name: string,
): WorkbenchLane {
  return {
    id,
    kind,
    memberId,
    name,
    todos: [],
    selfSchedules: [],
    counts: { draft: 0, scheduled: 0, inProgress: 0, delivered: 0 },
    nextAt: null,
  };
}

/** Bot 道在前、项目组道在后；同类内：有待验收 → 有进行中 → 下次时间近 → 名称。 */
export function compareLanes(a: WorkbenchLane, b: WorkbenchLane): number {
  if (a.kind !== b.kind) return a.kind === 'bot' ? -1 : 1;
  const delivered = Number(b.counts.delivered > 0) - Number(a.counts.delivered > 0);
  if (delivered !== 0) return delivered;
  const inProgress = Number(b.counts.inProgress > 0) - Number(a.counts.inProgress > 0);
  if (inProgress !== 0) return inProgress;
  const an = a.nextAt ?? Number.POSITIVE_INFINITY;
  const bn = b.nextAt ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
}

/** 最近结束（done / cancelled）的事项，新关闭的在前。 */
export function closedTodos(todos: readonly TodoEntry[]): TodoEntry[] {
  return todos
    .filter((todo) => !isOpenTodo(todo))
    .sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
}

// ---------------------------------------------------------------------------
// 成员名单（来自通讯录与会话列表）
// ---------------------------------------------------------------------------

/** active 的 Bot（已删除的占位不列）；管家带 isButler 标记。保持传入顺序。 */
export function botMembers(
  bots: ReadonlyArray<{ id: string; name: string; status: string; systemRole?: string | null }>,
): MemberInfo[] {
  return bots
    .filter((bot) => bot.status === 'active')
    .map((bot) => ({ id: bot.id, name: bot.name, isButler: bot.systemRole === 'butler' }));
}

/**
 * 项目组成员名单：项目会话（创建问答进行中的不算）。`assignableOnly` 为真时再去掉只读的
 * 项目组（执行者选择器只列非只读项目组；道头需要显示所有有事项的项目组，不过滤）。
 */
export function projectMembers(
  conversations: ReadonlyArray<{
    id: string;
    type: string;
    title: string | null;
    readOnly: boolean;
  }>,
  assignableOnly = false,
): MemberInfo[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.type === 'project' && (!assignableOnly || !conversation.readOnly),
    )
    .map((conversation) => ({ id: conversation.id, name: conversation.title ?? conversation.id }));
}

/** 此刻有 loop 在跑的 Bot（侧栏 runningBotIds 的并集）。 */
export function runningBotSet(
  conversations: ReadonlyArray<{ runningBotIds?: readonly string[] | undefined }>,
): Set<string> {
  const out = new Set<string>();
  for (const conversation of conversations) {
    for (const id of conversation.runningBotIds ?? []) out.add(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 自排任务 · 来源标签
// ---------------------------------------------------------------------------

export type SelfScheduleSource = 'tool' | 'routine' | 'commitment' | 'offer';

/** 自排卡的来源标签：tool = 自排，proposal = 例行，commitment = 承诺，offer = 提议。 */
export function selfScheduleSource(origin: ScheduleOrigin): SelfScheduleSource {
  switch (origin) {
    case 'proposal':
      return 'routine';
    case 'commitment':
      return 'commitment';
    case 'offer':
      return 'offer';
    default:
      return 'tool';
  }
}

// ---------------------------------------------------------------------------
// 备忘
// ---------------------------------------------------------------------------

/**
 * 置顶在前，其余按排序键 `sortAt` 倒序（id 兜底，保证稳定）。
 * 排序键只随置顶变化，改正文不会让卡片换位。
 */
export function sortMemos(memos: readonly Memo[]): Memo[] {
  return [...memos].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.sortAt - a.sortAt ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/** 本地即时过滤：忽略大小写与首尾空白，按正文子串匹配；空查询返回全部。 */
export function filterMemos(memos: readonly Memo[], query: string): Memo[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...memos];
  return memos.filter((memo) => memo.body.toLowerCase().includes(needle));
}

/**
 * 备忘 → 事项预填：首个非空行作标题（超长截断），全文作说明（超长截断）。
 * 标题已是全文时说明为空，避免重复。
 */
export function memoToTodoDraft(body: string): { title: string; notes: string } {
  const lines = body.split(/\r?\n/);
  const first = lines.find((line) => line.trim().length > 0) ?? '';
  const title = cutUtf16(first.trim(), TODO_TITLE_MAX_CHARS);
  const rest = body.trim();
  // 标题已是全文时说明为空，避免重复；标题被截断时说明保留全文（否则超出的部分就丢了）。
  return { title, notes: rest === title ? '' : cutUtf16(rest, TODO_NOTES_MAX_CHARS) };
}

/**
 * 按 UTF-16 长度截断（与 zod 的 `.max()` 同口径，shared 的上限就是按 `.length` 校验的），
 * 且不把代理对从中间切开。
 */
export function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, cut);
}

// ---------------------------------------------------------------------------
// 相对时间（备忘卡）
// ---------------------------------------------------------------------------

export type Age =
  | { unit: 'justNow' }
  | { unit: 'minutes' | 'hours' | 'days'; n: number }
  | { unit: 'date'; at: number };

/** 距今多久：<1 分钟 / 分钟 / 小时 / 天（<7）/ 其后给出具体日期（由界面格式化）。 */
export function ageOf(at: number, now: number): Age {
  const diff = now - at;
  if (diff < 60_000) return { unit: 'justNow' };
  if (diff < 3_600_000) return { unit: 'minutes', n: Math.floor(diff / 60_000) };
  if (diff < 86_400_000) return { unit: 'hours', n: Math.floor(diff / 3_600_000) };
  if (diff < 7 * 86_400_000) return { unit: 'days', n: Math.floor(diff / 86_400_000) };
  return { unit: 'date', at };
}

// ---------------------------------------------------------------------------
// 派发消息（对话内派发卡）
// ---------------------------------------------------------------------------

const DISPATCH_PREFIX = '【工作台】';
const BUTLER_NOTE = '（管家代你安排）';

export interface DispatchText {
  title: string;
  notes: string;
  /** 事项由管家建的（正文带「（管家代你安排）」）；界面优先用 `content.viaButler`，这里只作兜底。 */
  byButler: boolean;
  /** 补发迟到时末尾的「（原定 X，延迟派发）」；单独成行显示，不混进说明。 */
  lateNote: string | null;
  /** 「事项更新」通知（`【工作台】事项更新：标题` …）；派发正文没有这个字段。 */
  update?: boolean;
  /** 事项更新：谁改的（正文末尾「（由用户 / 管家修改；…）」）；认不出时为 null。 */
  updatedBy?: 'user' | 'butler' | null;
}

const UPDATE_PREFIX = '【工作台】事项更新：';
// 末尾一行：「（由用户修改；这是对你已在做的这件事的补充，…）」，整行去掉不显示。
const UPDATE_FOOTER = /\n*（由(用户|管家)修改；[^\n]*）\s*$/;

// X 里可能带全角括号（「10月12日（周一）09:00」），所以不能排除括号，用非贪婪匹配到「延迟派发）」。
const LATE_NOTE = /（原定[^\n]*?延迟派发）/;

/**
 * 解析派发消息正文（core 的实际格式）：
 *   `【工作台】标题` + 空行 + 说明
 *   管家来源：第一行是 `【工作台】标题（管家代你安排）`
 *   补发迟到：末尾再空一行加 `（原定 X，延迟派发）`
 * 容错：没有前缀 / 没有说明 / 标注在任意行都能解析；项目组派发的 @ 提及不影响标题。
 * 事项更新通知（`update`，D90）：`【工作台】事项更新：标题` + 空行 + 说明 + 空行 + `（由用户 / 管家修改；…）`，
 * 末尾那一行取出为 `updatedBy` 不进说明。
 */
export function parseDispatchText(text: string, update?: boolean): DispatchText {
  const trimmed = text.replace(/^\s+/, '');
  // `update`：消息内容里的 `todoUpdate` 标记（权威）；没给时按正文前缀判断。标题恰好以「事项更新：」
  // 开头的派发会和更新正文撞车，所以有标记时以标记为准。
  if (update ?? trimmed.startsWith(UPDATE_PREFIX)) {
    // 事项更新：`【工作台】事项更新：标题` + 空行 + 说明 + 空行 + `（由用户 / 管家修改；…）`。
    const footer = UPDATE_FOOTER.exec(trimmed);
    const withoutFooter = footer === null ? trimmed : trimmed.slice(0, footer.index);
    const body = (
      withoutFooter.startsWith(UPDATE_PREFIX)
        ? withoutFooter.slice(UPDATE_PREFIX.length)
        : withoutFooter
    ).replace(/^\s+|\s+$/g, '');
    const [headLine = '', ...rest] = body.split(/\r?\n/);
    const updatedBy = footer === null ? null : footer[1] === '管家' ? 'butler' : 'user';
    return {
      title: headLine.trim(),
      notes: rest.join('\n').trim(),
      byButler: updatedBy === 'butler',
      lateNote: null,
      update: true,
      updatedBy,
    };
  }
  const byButler = text.includes(BUTLER_NOTE);
  let body = text.split(BUTLER_NOTE).join('');
  const late = LATE_NOTE.exec(body);
  const lateNote = late === null ? null : late[0];
  if (late !== null) body = body.replace(late[0], '');
  const [headLine = '', ...rest] = body.replace(/^\s+|\s+$/g, '').split(/\r?\n/);
  let title = headLine.trim();
  if (title.startsWith(DISPATCH_PREFIX)) title = title.slice(DISPATCH_PREFIX.length).trim();
  const notes = rest.join('\n').trim();
  return { title, notes, byButler, lateNote };
}
