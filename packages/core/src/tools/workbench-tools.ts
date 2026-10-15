import { Type } from '@earendil-works/pi-ai';
import {
  MEMO_BODY_MAX_CHARS,
  TODO_NOTES_MAX_CHARS,
  TODO_TITLE_MAX_CHARS,
  type Memo,
  type TodoAssignee,
  type TodoEntry,
  type TodoStatus,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';
import { untrustedBlock } from '../infra/data-boundary.js';

/**
 * 工作台的管家工具（D90，docs/design/39-workbench.md §6，todo/workbench.md §6.1）：事项
 * （`list_todos` / `create_todo` / `update_todo` / `close_todo`）与备忘（`list_memos` /
 * `create_memo` / `update_memo` / `delete_memo`）。**只注册给管家**，只在对话轮工具面。
 *
 * 权限边界由宿主强制（§6.2），不靠提示词：这一轮不是用户本人触发（`triggerFromUser` 为假——
 * 定时、事件、委派回执、工作台派发……）时，只允许读、记备忘、改备忘正文 / 置顶、建草案、改草案的
 * 标题和说明；指派、排期、立即开始、改派、改期、收尾、删除备忘一律拒绝（`ok:false`），管家改在
 * 回复里向用户提建议，用户同意后的下一轮就是用户本人触发的。工具执行处再次核对调用者是管家
 * （`facade.isButler`），与 `dispatch/butler.ts` 同口径。
 *
 * 工具名写成字面量（external-agent-engine / tool-effects 测试按 `name: '…'` 核对注册表）。
 */

/** TodoService 入参的子集（工具层不依赖服务类）。 */
export interface WorkbenchTodoInput {
  title?: string | undefined;
  notes?: string | undefined;
  /** undefined = 不变，null = 清空（同时清排期）。 */
  assignee?: TodoAssignee | null | undefined;
  /** undefined = 不变，null = 清空排期，'now' = 立即开始。 */
  when?: string | null | undefined;
}

export interface WorkbenchToolFacade {
  /** 宿主侧二次校验：调用者是管家。 */
  isButler(botId: string): boolean;
  listTodos(filter: {
    statuses?: readonly TodoStatus[] | undefined;
    query?: string | undefined;
    includeClosed?: boolean | undefined;
  }): TodoEntry[];
  getTodo(id: string): TodoEntry;
  createTodo(
    input: WorkbenchTodoInput & { title: string; memoId?: string | undefined; source: 'butler' },
  ): { todo: TodoEntry; warnings: string[] };
  updateTodo(id: string, input: WorkbenchTodoInput): { todo: TodoEntry; warnings: string[] };
  completeTodo(id: string): TodoEntry;
  cancelTodo(id: string): TodoEntry;
  listMemos(filter: { query?: string | undefined; trashed?: boolean | undefined }): Memo[];
  createMemo(input: { body: string; source: 'butler' }): Memo;
  updateMemo(id: string, patch: { body?: string | undefined; pinned?: boolean | undefined }): Memo;
  deleteMemo(id: string): Memo;
  /** 排期的人话写法（「每个工作日 09:00」）。 */
  describeWhen(row: {
    kind: 'once' | 'cron';
    runAt: number | null;
    cron: string | null;
    timezone: string;
  }): string;
  /** 某个时刻的人话写法（「今天 10:12」，用户时区）。 */
  describeTime(ms: number): string;
  /** `<workbench>` 上下文段；'' = 没什么可说。 */
  contextSection(): string;
}

/** 非本人触发的一轮被拒绝时的统一说明（§6.2）。 */
export const WORKBENCH_NOT_FROM_USER_MESSAGE =
  '这一轮不是用户本人发起的，不能直接执行；请在回复里向用户提出建议，用户同意后再执行';

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;
const MEMO_LINE_CHARS = 300;
const TODO_STATUSES: readonly TodoStatus[] = [
  'draft',
  'scheduled',
  'in_progress',
  'delivered',
  'done',
  'cancelled',
];

const STATUS_LABEL: Record<TodoStatus, string> = {
  draft: '草案',
  scheduled: '已排期',
  in_progress: '进行中',
  delivered: '待验收',
  done: '已完成',
  cancelled: '已取消',
};

const RUN_STATUS_LABEL = {
  dispatched: '已派发，等待交付',
  delivered: '已交付',
  unclaimed: '群里无人认领',
  failed: '执行失败',
} as const;

const assigneeSchema = Type.Union(
  [
    Type.Object(
      { bot_id: Type.String({ description: '执行的 Bot（先用 list_bots 查 id）' }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        group_id: Type.String({ description: '执行的群（对话 id，形如 conv_...）' }),
        lead_bot_id: Type.Optional(
          Type.String({ description: '群里的负责 Bot；不填 = 群里自己决定谁认领' }),
        ),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      '执行者：{ "bot_id": "bot_…" } 派给一个 Bot，或 { "group_id": "conv_…", "lead_bot_id"?: "bot_…" } 派给一个群',
  },
);

const WHEN_DESCRIPTION =
  '"now"（现在就以「工作台代你发出」的消息派给执行者）、ISO 8601 时间（如 2026-10-16T09:00:00+08:00，一次性）或 cron 表达式（如 "0 9 * * 1-5"，周期）。设置时间必须同时有执行者。';

const invalid = (content: string): ToolResult => ({
  ok: false,
  content,
  errorCode: 'INVALID_INPUT',
});

function failure(error: unknown, prefix: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    ok: false,
    content: `${prefix}：${message}`,
    errorCode: code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_INPUT',
  };
}

/** 工具入参里的执行者 → TodoAssignee；null = 清空，undefined = 不变；形状不对返回说明。 */
function parseAssignee(raw: unknown): TodoAssignee | null | undefined | string {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object')
    return 'assignee 要么是 { bot_id }，要么是 { group_id, lead_bot_id? }';
  const value = raw as { bot_id?: unknown; group_id?: unknown; lead_bot_id?: unknown };
  const hasBot = value.bot_id !== undefined;
  const hasGroup = value.group_id !== undefined;
  if (hasBot === hasGroup)
    return 'assignee 要么是 { bot_id }，要么是 { group_id, lead_bot_id? }，不能两个都填或都不填';
  if (hasBot) {
    if (typeof value.bot_id !== 'string' || value.bot_id.trim() === '') return 'bot_id 不能为空';
    return { kind: 'bot', botId: value.bot_id.trim() };
  }
  if (typeof value.group_id !== 'string' || value.group_id.trim() === '')
    return 'group_id 不能为空';
  if (
    value.lead_bot_id !== undefined &&
    (typeof value.lead_bot_id !== 'string' || value.lead_bot_id.trim() === '')
  ) {
    return 'lead_bot_id 不能为空字符串（不指定就不要填）';
  }
  return {
    kind: 'group',
    conversationId: value.group_id.trim(),
    leadBotId: typeof value.lead_bot_id === 'string' ? value.lead_bot_id.trim() : null,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIST_LIMIT_DEFAULT;
  return Math.min(LIST_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function describeAssignee(todo: TodoEntry): string {
  if (todo.assignee === null) return '无';
  if (todo.assignee.kind === 'bot') {
    return `${todo.assigneeName ?? '（已删除的 Bot）'}（${todo.assignee.botId}）`;
  }
  const group = `群「${todo.assigneeName ?? '（已解散）'}」（${todo.assignee.conversationId}）`;
  if (todo.assignee.leadBotId === null) return group;
  return `${group}，负责 Bot：${todo.leadBotName ?? '（已删除）'}（${todo.assignee.leadBotId}）`;
}

function describeTiming(todo: TodoEntry, facade: WorkbenchToolFacade): string {
  const { schedule } = todo;
  if (schedule === null) return '未排期';
  const raw = schedule.kind === 'cron' ? `（cron「${schedule.cron}」${schedule.timezone}）` : '';
  const next =
    schedule.nextFireAt !== null ? `，下次 ${facade.describeTime(schedule.nextFireAt)}` : '';
  return `${facade.describeWhen(schedule)}${raw}${next}`;
}

function describeLastRun(todo: TodoEntry, facade: WorkbenchToolFacade): string {
  const { lastRun } = todo;
  if (lastRun === null) return '无';
  const at = lastRun.settledAt ?? lastRun.dispatchedAt;
  return `${RUN_STATUS_LABEL[lastRun.status]}（${facade.describeTime(at)}）`;
}

function todoLine(todo: TodoEntry, facade: WorkbenchToolFacade): string {
  const parts = [
    `[${todo.id}] ${todo.title}`,
    `状态：${STATUS_LABEL[todo.status]}`,
    `执行者：${describeAssignee(todo)}`,
    `时间：${describeTiming(todo, facade)}`,
  ];
  if (todo.blockedReason !== null) parts.push(`blocked_reason：${todo.blockedReason}`);
  parts.push(`最近执行：${describeLastRun(todo, facade)}`);
  if (todo.source === 'butler') parts.push('来源：管家');
  if (todo.notes.trim() !== '') {
    const flat = todo.notes.replace(/\s+/g, ' ').trim();
    parts.push(
      `说明：${Array.from(flat).length > 80 ? `${Array.from(flat).slice(0, 80).join('')}…` : flat}`,
    );
  }
  return `- ${parts.join('｜')}`;
}

function memoLine(memo: Memo, facade: WorkbenchToolFacade): string {
  const chars = Array.from(memo.body.replace(/\s+/g, ' ').trim());
  const text =
    chars.length > MEMO_LINE_CHARS
      ? `${chars.slice(0, MEMO_LINE_CHARS).join('')}…`
      : chars.join('');
  const flags = [
    memo.pinned ? '置顶' : null,
    memo.deletedAt !== null ? '已删除（最近删除）' : null,
    memo.source === 'butler' ? '管家记的' : null,
  ].filter((flag): flag is string => flag !== null);
  return `- [${memo.id}]${flags.length > 0 ? `（${flags.join('，')}）` : ''} ${facade.describeTime(memo.updatedAt)}：${text}`;
}

function statusSentence(todo: TodoEntry, facade: WorkbenchToolFacade): string {
  switch (todo.status) {
    case 'draft':
      return '现在是草案（没有执行者或时间，不会自动执行）';
    case 'scheduled':
      return `已排期给 ${todo.assigneeName ?? '执行者'}：${describeTiming(todo, facade)}`;
    case 'in_progress':
      return `已派发给 ${todo.assigneeName ?? '执行者'}，进行中`;
    default:
      return `状态：${STATUS_LABEL[todo.status]}`;
  }
}

function warningLines(warnings: readonly string[]): string[] {
  return warnings.map((warning) => `注意：${warning}请告诉用户。`);
}

export function buildWorkbenchTools(input: {
  identity: RunIdentity;
  workbench: WorkbenchToolFacade;
  /** 这一轮是不是用户本人触发（`triggerFromUser`，settings/context.ts；run 开始时由宿主算定）。 */
  triggerFromUser: boolean;
}): ToolDefinition[] {
  const { identity, workbench, triggerFromUser } = input;

  /** 宿主二次校验：只有管家能用；返回 null = 通过。 */
  const butlerOnly = (): ToolResult | null => {
    if (identity.botId === null || !workbench.isButler(identity.botId)) {
      return { ok: false, content: '只有管家可以使用工作台工具', errorCode: 'INVALID_INPUT' };
    }
    return null;
  };
  const needsUser = (): ToolResult => ({
    ok: false,
    content: WORKBENCH_NOT_FROM_USER_MESSAGE,
    errorCode: 'NOT_FROM_USER',
  });

  const listTodos: ToolDefinition<{
    status?: string;
    assignee?: string;
    query?: string;
    limit?: number;
  }> = {
    name: 'list_todos',
    description:
      '查看用户工作台里的事项（待办 + 定时派活）：每行有 id、标题、状态、执行者、时间或下次时间、blocked_reason、最近一次执行记录。用户问「我有哪些事 / 谁在忙什么 / 草案有哪些」，或你要整理、指派、排期、收尾之前先用它了解现状。不填 status = 未关闭的事项加 7 天内刚关闭的。',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({
          description: `只看某个状态：${TODO_STATUSES.join(' / ')}（草案 / 已排期 / 进行中 / 待验收 / 已完成 / 已取消）`,
        }),
      ),
      assignee: Type.Optional(
        Type.String({ description: '只看某个执行者：Bot id、群 id，或名字里的关键词' }),
      ),
      query: Type.Optional(Type.String({ description: '标题或说明里的关键词' })),
      limit: Type.Optional(
        Type.Number({
          description: `最多返回几条（默认 ${LIST_LIMIT_DEFAULT}，最多 ${LIST_LIMIT_MAX}）`,
        }),
      ),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      let status: TodoStatus | undefined;
      if (params.status !== undefined && params.status !== '') {
        if (!TODO_STATUSES.includes(params.status as TodoStatus)) {
          return invalid(`status 只能是：${TODO_STATUSES.join(' / ')}`);
        }
        status = params.status as TodoStatus;
      }
      try {
        let todos = workbench.listTodos({
          ...(status !== undefined ? { statuses: [status] } : {}),
          ...(params.query !== undefined ? { query: params.query } : {}),
          ...(status === 'done' || status === 'cancelled' ? { includeClosed: true } : {}),
        });
        const needle = params.assignee?.trim().toLowerCase();
        if (needle !== undefined && needle !== '') {
          todos = todos.filter((todo) => {
            const ids =
              todo.assignee === null
                ? []
                : todo.assignee.kind === 'bot'
                  ? [todo.assignee.botId]
                  : [todo.assignee.conversationId, todo.assignee.leadBotId ?? ''];
            return (
              ids.some((id) => id.toLowerCase() === needle) ||
              (todo.assigneeName ?? '').toLowerCase().includes(needle) ||
              (todo.leadBotName ?? '').toLowerCase().includes(needle)
            );
          });
        }
        if (todos.length === 0) return { ok: true, content: '没有符合条件的事项。' };
        const limit = clampLimit(params.limit);
        const shown = todos.slice(0, limit);
        // 标题 / 说明可能来自网页摘录或用户粘贴的材料：包 <untrusted> 边界。
        const lines = [
          `共 ${todos.length} 条事项${todos.length > shown.length ? `，显示前 ${shown.length} 条` : ''}：`,
          untrustedBlock(shown.map((todo) => todoLine(todo, workbench)).join('\n')),
        ];
        return { ok: true, content: lines.join('\n') };
      } catch (error) {
        return failure(error, '查询事项失败');
      }
    },
  };

  const createTodo: ToolDefinition<{
    title: string;
    notes?: string;
    assignee?: unknown;
    when?: string;
    from_memo?: string;
  }> = {
    name: 'create_todo',
    description:
      '在用户的工作台里建一条事项。不填 assignee 和 when = 草案（只是记下要做的事，不会自动执行）；有明确的执行者（assignee）和时间（when）才排期：when="now" 立即由工作台以用户的名义把事项发给执行者，ISO 时间 / cron 到点发。' +
      '与委派的区别：用户要你在当前对话里等结果、拿到结果贴回来，用 delegate_to_bot；「交给谁去办、回头再看」才用事项。用户说「记一下 / 别忘了」先考虑 create_memo 或建草案，有明确的人和时间才排期。' +
      '排期、立即开始只能在用户本人发起的这一轮做；其它轮只能建草案（不带 assignee 和 when），被拒绝时在回复里向用户提议。执行者的 id 先用 list_bots 查，不要凭记忆写。',
    parameters: Type.Object({
      title: Type.String({ description: `事项标题（最多 ${TODO_TITLE_MAX_CHARS} 字）` }),
      notes: Type.Optional(
        Type.String({
          description: `说明（最多 ${TODO_NOTES_MAX_CHARS} 字）：派发时执行者会看到，写清要什么结果`,
        }),
      ),
      assignee: Type.Optional(assigneeSchema),
      when: Type.Optional(Type.String({ description: WHEN_DESCRIPTION })),
      from_memo: Type.Optional(
        Type.String({ description: '来源备忘 id（把某条备忘转成事项时填；备忘保留）' }),
      ),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      const assignee = parseAssignee(params.assignee);
      if (typeof assignee === 'string') return invalid(assignee);
      const when =
        params.when === undefined || params.when === null ? undefined : String(params.when).trim();
      if (when === '') return invalid('when 不能为空字符串（不排期就不要填）');
      if (typeof params.title !== 'string' || params.title.trim() === '')
        return invalid('title 不能为空');
      // 非本人触发的一轮只能建草案：有执行者或有时间就是指派 / 排期 / 立即开始。
      if (!triggerFromUser && (assignee != null || when !== undefined)) return needsUser();
      try {
        const { todo, warnings } = workbench.createTodo({
          title: params.title,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(when !== undefined ? { when } : {}),
          ...(params.from_memo !== undefined && params.from_memo !== ''
            ? { memoId: params.from_memo }
            : {}),
          source: 'butler',
        });
        return {
          ok: true,
          content: [
            `已创建事项「${todo.title}」（id：${todo.id}）：${statusSentence(todo, workbench)}。工作台里已显示（带「管家」标记），回复里用一句话告诉用户你做了什么。`,
            ...warningLines(warnings),
          ].join('\n'),
        };
      } catch (error) {
        return failure(error, '创建事项失败');
      }
    },
  };

  const updateTodo: ToolDefinition<{
    id: string;
    title?: string;
    notes?: string;
    assignee?: unknown;
    when?: string | null;
  }> = {
    name: 'update_todo',
    description:
      '修改一条未关闭的事项：改标题 / 说明，指派或改派执行者（assignee），排期或改期（when）。assignee 传 null = 清空执行者（同时清掉排期，退回草案）；when 传 null = 取消排期（退回草案）；when="now" = 立即开始。已派发（进行中 / 待验收）的事项不能再改派或改期。' +
      '只能在用户本人发起的这一轮改派 / 改期 / 立即开始，也只有这样的轮次才能改已排期事项的标题和说明；其它轮只能改草案的标题和说明。',
    parameters: Type.Object({
      id: Type.String({ description: '事项 id（形如 todo_...，先用 list_todos 查）' }),
      title: Type.Optional(
        Type.String({ description: `新标题（最多 ${TODO_TITLE_MAX_CHARS} 字）` }),
      ),
      notes: Type.Optional(
        Type.String({ description: `新说明（最多 ${TODO_NOTES_MAX_CHARS} 字）` }),
      ),
      assignee: Type.Optional(
        Type.Union([assigneeSchema, Type.Null()], { description: '新执行者；null = 清空' }),
      ),
      when: Type.Optional(
        Type.Union([Type.String({ description: WHEN_DESCRIPTION }), Type.Null()], {
          description: '新时间；null = 取消排期',
        }),
      ),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      if (typeof params.id !== 'string' || params.id.trim() === '') return invalid('id 不能为空');
      const assignee = parseAssignee(params.assignee);
      if (typeof assignee === 'string') return invalid(assignee);
      const when = params.when;
      if (typeof when === 'string' && when.trim() === '')
        return invalid('when 不能为空字符串（取消排期传 null）');
      const timingTouched = assignee !== undefined || when !== undefined;
      if (params.title === undefined && params.notes === undefined && !timingTouched) {
        return invalid('没有要修改的内容：至少给出 title / notes / assignee / when 之一');
      }
      try {
        if (!triggerFromUser) {
          // 非本人触发：只允许改草案的标题和说明。
          if (timingTouched) return needsUser();
          if (workbench.getTodo(params.id).status !== 'draft') return needsUser();
        }
        const { todo, warnings } = workbench.updateTodo(params.id, {
          ...(params.title !== undefined ? { title: params.title } : {}),
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(when !== undefined ? { when: typeof when === 'string' ? when.trim() : when } : {}),
        });
        return {
          ok: true,
          content: [
            `已更新事项「${todo.title}」（id：${todo.id}）：${statusSentence(todo, workbench)}。`,
            ...warningLines(warnings),
          ].join('\n'),
        };
      } catch (error) {
        return failure(error, '修改事项失败');
      }
    },
  };

  const closeTodo: ToolDefinition<{ id: string; outcome: string; reason?: string }> = {
    name: 'close_todo',
    description:
      '给事项收尾：outcome="done" 标为已完成（用于已交付待验收、或用户确认做完了的事项），outcome="cancelled" 取消（任何未关闭的事项；已排期的会同时取消排期）。没有硬删除；取消后用户可在工作台重新打开。只能在用户本人发起的这一轮做（用户说「这件算完成了 / 取消它」）；其它轮在回复里建议用户收尾。',
    parameters: Type.Object({
      id: Type.String({ description: '事项 id（形如 todo_...）' }),
      outcome: Type.Union([Type.Literal('done'), Type.Literal('cancelled')], {
        description: 'done = 完成，cancelled = 取消',
      }),
      reason: Type.Optional(
        Type.String({ description: '一句话原因（用于你给用户的回复，不会写进事项）' }),
      ),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      if (params.outcome !== 'done' && params.outcome !== 'cancelled') {
        return invalid('outcome 只能是 done 或 cancelled');
      }
      if (typeof params.id !== 'string' || params.id.trim() === '') return invalid('id 不能为空');
      if (!triggerFromUser) return needsUser();
      try {
        const todo =
          params.outcome === 'done'
            ? workbench.completeTodo(params.id)
            : workbench.cancelTodo(params.id);
        const reason =
          params.reason !== undefined && params.reason.trim() !== ''
            ? `（${params.reason.trim()}）`
            : '';
        return {
          ok: true,
          content: `事项「${todo.title}」（id：${todo.id}）已${params.outcome === 'done' ? '标为完成' : '取消'}${reason}。${params.outcome === 'cancelled' ? '用户可以在工作台里重新打开它。' : ''}`,
        };
      } catch (error) {
        return failure(error, '收尾失败');
      }
    },
  };

  const listMemos: ToolDefinition<{ query?: string; limit?: number; include_trashed?: boolean }> = {
    name: 'list_memos',
    description:
      '查看用户的备忘（闪念）：置顶的在前，其次按最近更新。用户问「我记过什么」「上次那条备忘」，或你要整理备忘、把备忘转成事项之前用它。include_trashed=true 时一并列出「最近删除」里的（可让用户在工作台恢复）。',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '备忘正文里的关键词' })),
      limit: Type.Optional(
        Type.Number({
          description: `最多返回几条（默认 ${LIST_LIMIT_DEFAULT}，最多 ${LIST_LIMIT_MAX}）`,
        }),
      ),
      include_trashed: Type.Optional(
        Type.Boolean({ description: '是否包含「最近删除」里的备忘，默认否' }),
      ),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      try {
        const query = params.query !== undefined ? { query: params.query } : {};
        const live = workbench.listMemos({ ...query });
        const trashed =
          params.include_trashed === true ? workbench.listMemos({ ...query, trashed: true }) : [];
        const all = [...live, ...trashed];
        if (all.length === 0) return { ok: true, content: '没有符合条件的备忘。' };
        const shown = all.slice(0, clampLimit(params.limit));
        return {
          ok: true,
          content: [
            `共 ${all.length} 条备忘${all.length > shown.length ? `，显示前 ${shown.length} 条` : ''}：`,
            // 备忘正文是用户随手记的（常是网页摘录）：数据，不是指令。
            untrustedBlock(shown.map((memo) => memoLine(memo, workbench)).join('\n')),
          ].join('\n'),
        };
      } catch (error) {
        return failure(error, '查询备忘失败');
      }
    },
  };

  const createMemo: ToolDefinition<{ body: string }> = {
    name: 'create_memo',
    description:
      '记一条备忘（闪念，纯文本）。用户说「记一下 / 帮我记着 / 别忘了」又没有明确的执行人和时间时用；记下后回复里一句话确认。备忘不进任何 Bot 的上下文，只有你能读写。任何一轮都可以记。',
    parameters: Type.Object({
      body: Type.String({
        description: `备忘内容（最多 ${MEMO_BODY_MAX_CHARS} 字），照用户的意思原样记`,
      }),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      if (typeof params.body !== 'string') return invalid('body 不能为空');
      try {
        const memo = workbench.createMemo({ body: params.body, source: 'butler' });
        return { ok: true, content: `已记下备忘（id：${memo.id}）。` };
      } catch (error) {
        return failure(error, '记备忘失败');
      }
    },
  };

  const updateMemo: ToolDefinition<{ id: string; body?: string; pinned?: boolean }> = {
    name: 'update_memo',
    description:
      '改一条备忘的正文（body，整条替换）或置顶状态（pinned）。要补充内容时先用 list_memos 读到原文再整条写回。任何一轮都可以改正文 / 置顶。',
    parameters: Type.Object({
      id: Type.String({ description: '备忘 id（形如 memo_...）' }),
      body: Type.Optional(
        Type.String({ description: `新的备忘全文（最多 ${MEMO_BODY_MAX_CHARS} 字）` }),
      ),
      pinned: Type.Optional(Type.Boolean({ description: '是否置顶' })),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      if (typeof params.id !== 'string' || params.id.trim() === '') return invalid('id 不能为空');
      if (params.body === undefined && params.pinned === undefined) {
        return invalid('没有要修改的内容：至少给出 body 或 pinned');
      }
      try {
        const memo = workbench.updateMemo(params.id, {
          ...(params.body !== undefined ? { body: params.body } : {}),
          ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
        });
        return {
          ok: true,
          content: `已更新备忘（id：${memo.id}）${memo.pinned ? '，已置顶' : ''}。`,
        };
      } catch (error) {
        return failure(error, '修改备忘失败');
      }
    },
  };

  const deleteMemo: ToolDefinition<{ id: string }> = {
    name: 'delete_memo',
    description:
      '删除一条备忘：移入「最近删除」，30 天内用户可以在工作台恢复。只能在用户本人发起的这一轮做（用户说「删掉那条备忘」）；其它轮在回复里建议用户删除。',
    parameters: Type.Object({
      id: Type.String({ description: '备忘 id（形如 memo_...）' }),
    }),
    execute: async (params) => {
      const denied = butlerOnly();
      if (denied !== null) return denied;
      if (typeof params.id !== 'string' || params.id.trim() === '') return invalid('id 不能为空');
      if (!triggerFromUser) return needsUser();
      try {
        const memo = workbench.deleteMemo(params.id);
        return {
          ok: true,
          content: `已把备忘（id：${memo.id}）移入最近删除，用户可在工作台恢复。`,
        };
      } catch (error) {
        return failure(error, '删除备忘失败');
      }
    },
  };

  return [
    listTodos,
    createTodo,
    updateTodo,
    closeTodo,
    listMemos,
    createMemo,
    updateMemo,
    deleteMemo,
  ] as ToolDefinition[];
}
