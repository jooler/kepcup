import { Type } from '@earendil-works/pi-ai';
import {
  AppError,
  TASK_INSTRUCTION_MAX_CHARS,
  TASK_SOURCE_MESSAGES_MAX,
  TASK_TITLE_MAX_CHARS,
  type RunStatus,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 任务管理工具（D75，docs/design/30-supervisor-and-tasks.md §4.1）：对话层用
 * `start_task` / `inject_task` / `cancel_task` / `list_tasks` 枚举化地路由，
 * `forward_task_result` 原文转发任务结果（§6.1）。宿主（TaskHost）逐项校验
 * 归属、状态与配额；这里只做参数校验与执行期的深度校验——任务内调用
 * `start_task` 一律拒绝（深度 1，§2.2）。本文件只定义工具，不注册进任何
 * 工具面（对话轮工具面由 W2 组装）。
 */

/** Task state as tools report it: `queued` rows are `submitted` (§3.1). */
export type TaskState =
  'submitted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface StartTaskInput {
  title: string;
  instruction: string;
  /** The user's original messages the task works from (verbatim in its brief, §2.4.5). */
  sourceMessageIds: string[];
  /** Write task: takes the workdir write lease for its whole run (§5.1). */
  writes: boolean;
  /** Workdir root; default = the bound project when available, else the workspace. */
  workdir?: 'workspace' | 'project' | undefined;
  /** Replay this settled task's process into the new one (D56 budget, §7.1). */
  continuesTaskId?: string | undefined;
}

export interface StartTaskResult {
  taskId: string;
  /** The row's true state: terminal when it settled synchronously. */
  state: TaskState;
  /** Why a submitted task waits (concurrency / write lease); null otherwise. */
  queueReason: string | null;
  /**
   * The turn being retried had already started this very task (审查 L6): it
   * is returned instead of a duplicate.
   */
  alreadyStarted?: boolean;
}

export interface InjectTaskInput {
  taskId: string;
  text: string;
  sourceMessageIds?: string[] | undefined;
}

export interface InjectTaskResult {
  /**
   * delivered = the task sees it (steered now, or folded into its brief / the
   * next steer); queued = the run could not take it (it is ending, or an
   * engine without steering, §8.2) — recorded only, no later delivery here.
   */
  delivery: 'delivered' | 'queued';
}

export interface CancelTaskResult {
  taskId: string;
  state: TaskState;
  message: string;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  state: TaskState;
  status: RunStatus;
  writes: boolean;
  workdir: string | null;
  createdAt: number;
  endedAt: number | null;
  queueReason: string | null;
  awaitingInput: boolean;
  injectable: boolean;
  /** Latest visible progress line of the task (clipped), if any. */
  lastProgress: string | null;
  error: string | null;
}

export interface ForwardTaskResultOutput {
  messageId: string;
}

/**
 * The host the task tools drive (implemented by `TaskHost`). Validation
 * failures throw `AppError` (codes INVALID_INPUT / NOT_FOUND /
 * RUN_ALREADY_FINISHED / TASK_LIMIT_REACHED / NOT_SUPPORTED); the tools turn
 * them into tool errors.
 */
export interface TaskToolFacade {
  start(identity: RunIdentity, input: StartTaskInput): StartTaskResult;
  inject(identity: RunIdentity, input: InjectTaskInput): InjectTaskResult;
  cancel(identity: RunIdentity, input: { taskId: string; reason: string }): CancelTaskResult;
  list(identity: RunIdentity): TaskSummary[];
  forwardResult(identity: RunIdentity, taskId: string): ForwardTaskResultOutput;
  /**
   * §2.4.6 (task side): asks the user on a visible question card and waits for
   * the answer (a card option, or the turn's inject_task). Optional: only the
   * task host provides it; `ask_user` is registered for tasks when present.
   */
  ask?(
    identity: RunIdentity,
    input: { question: string; options: string[] },
    signal: AbortSignal,
  ): Promise<string>;
}

/** Bounds of the ask_user options (the card renders them as buttons). */
export const ASK_USER_OPTIONS_MAX = 6;

/**
 * `ask_user` (design 30 §2.4.6): a task that cannot go on without the user's
 * decision asks on a question card bound to it and waits; the user's pick goes
 * straight into the task. Tasks only — a turn asks in its reply.
 */
export function buildAskUserTool(input: {
  identity: RunIdentity;
  ask: NonNullable<TaskToolFacade['ask']>;
}): ToolDefinition {
  const { identity, ask } = input;
  const tool: ToolDefinition<{ question: string; options: string[] }> = {
    name: 'ask_user',
    description:
      '任务无法继续、必须由用户做决定时向用户提问：问题与候选答案以卡片形式出现在对话里，本次调用会一直等到用户回答（用户点选的选项，或在对话里自由回答后由对话中的你转交），返回用户的回答。' +
      '只问真正需要用户拍板的事，一次一个问题；能自己判断的不要问。',
    parameters: Type.Object(
      {
        question: Type.String({ description: '要问用户的问题（说明背景与影响）' }),
        options: Type.Array(Type.String(), {
          description: `候选答案，1~${ASK_USER_OPTIONS_MAX} 个；用户也可以在对话里另行回答`,
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, ctx) => {
      if (identity.loopType !== 'task') {
        return fail('NOT_SUPPORTED', '只有任务可以用 ask_user；对话中直接在回复里问用户');
      }
      let question: string;
      try {
        question = nonEmpty(params.question, 'question', TASK_INSTRUCTION_MAX_CHARS);
      } catch (error) {
        return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error));
      }
      const options = Array.isArray(params.options)
        ? [
            ...new Set(
              params.options
                .filter((option): option is string => typeof option === 'string')
                .map((option) => option.trim())
                .filter((option) => option.length > 0),
            ),
          ]
        : [];
      if (options.length < 1 || options.length > ASK_USER_OPTIONS_MAX) {
        return fail('INVALID_INPUT', `options 需要 1~${ASK_USER_OPTIONS_MAX} 个非空候选答案`);
      }
      try {
        const answer = await ask(identity, { question, options }, ctx.signal);
        return { ok: true, content: `用户的回答：${answer}` };
      } catch (error) {
        if (error instanceof AppError) return fail(String(error.code), error.message);
        return fail('INTERNAL', error instanceof Error ? error.message : String(error));
      }
    },
  };
  return tool as ToolDefinition;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, content: message, errorCode: code };
}

function guarded(run: () => ToolResult): ToolResult {
  try {
    return run();
  } catch (error) {
    if (error instanceof AppError) return fail(String(error.code), error.message);
    return fail('INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

function sourceIds(value: unknown): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return 'source_message_ids 必须是消息 id 字符串数组';
  }
  const ids = [...new Set((value as string[]).map((id) => id.trim()))];
  if (ids.length > TASK_SOURCE_MESSAGES_MAX) {
    return `source_message_ids 最多 ${TASK_SOURCE_MESSAGES_MAX} 条`;
  }
  return ids;
}

function nonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_INPUT', `${field} 不能为空`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AppError('INVALID_INPUT', `${field} 最多 ${max} 字`);
  return trimmed;
}

function stateLine(summary: TaskSummary): string {
  const parts = [`[${summary.taskId}] ${summary.title}`, summary.state];
  if (summary.queueReason) parts.push(summary.queueReason);
  if (summary.awaitingInput) parts.push('等待用户输入');
  if (summary.lastProgress) parts.push(`最近：${summary.lastProgress}`);
  if (summary.error) parts.push(`错误：${summary.error}`);
  if (summary.state === 'submitted' || summary.state === 'running') {
    parts.push(`可注入：${summary.injectable ? '是' : '否'}`);
  }
  return parts.join('  ');
}

export function buildTaskTools(input: {
  identity: RunIdentity;
  tasks: TaskToolFacade;
}): ToolDefinition[] {
  const { identity, tasks } = input;

  const startTask: ToolDefinition<{
    title: string;
    instruction: string;
    source_message_ids: string[];
    writes: boolean;
    workdir?: 'workspace' | 'project';
    continues_task_id?: string;
  }> = {
    name: 'start_task',
    description:
      '把一件需要动手或耗时的事派成一个后台任务（文件、命令、浏览器、长时间研究都在任务里做），立即返回 task_id，不等它完成。' +
      '任务完成后它的结果会交回给你，由你决定怎么告诉用户；过程中它的简短进度会直接显示在对话里。' +
      'instruction 写清要做什么、要什么结果、约束；source_message_ids 填用户的原消息 id（任务会看到原文与附件）。' +
      'writes=true 表示要改文件（同一目录同时只有一个写任务，其余排队）；只读调研用 writes=false。' +
      '要接着一条已结束的任务重做，用 continues_task_id（先 cancel_task 进行中的那条）。派出后简短告诉用户你去做了什么。',
    parameters: Type.Object(
      {
        title: Type.String({
          description: `任务标题（≤ ${TASK_TITLE_MAX_CHARS} 字，用户在任务卡上看到）`,
        }),
        instruction: Type.String({ description: '交给任务的完整说明' }),
        source_message_ids: Type.Array(Type.String(), {
          description: '相关的用户原消息 id（msg_…），任务简报会带上原文',
        }),
        writes: Type.Boolean({ description: 'true = 会修改文件的写任务；false = 只读任务' }),
        workdir: Type.Optional(
          Type.Union([Type.Literal('workspace'), Type.Literal('project')], {
            description: '工作目录：project（对话绑定的项目，缺省时有项目即用项目）或 workspace',
          }),
        ),
        continues_task_id: Type.Optional(
          Type.String({ description: '接续的已结束任务 id：回放它的过程，避免重新踩坑' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        // Depth 1 (§2.2): checked at execution time, not only by registration.
        if (identity.loopType === 'task') {
          return fail('NOT_SUPPORTED', '任务内不能再派任务；需要并行的子问题请用 delegate_task');
        }
        const ids = sourceIds(params.source_message_ids);
        if (typeof ids === 'string') return fail('INVALID_INPUT', ids);
        if (typeof params.writes !== 'boolean') return fail('INVALID_INPUT', 'writes 必须是布尔值');
        if (
          params.workdir !== undefined &&
          params.workdir !== 'workspace' &&
          params.workdir !== 'project'
        ) {
          return fail('INVALID_INPUT', 'workdir 只能是 workspace 或 project');
        }
        const started = tasks.start(identity, {
          title: nonEmpty(params.title, 'title', TASK_TITLE_MAX_CHARS),
          instruction: nonEmpty(params.instruction, 'instruction', TASK_INSTRUCTION_MAX_CHARS),
          sourceMessageIds: ids,
          writes: params.writes,
          ...(params.workdir !== undefined ? { workdir: params.workdir } : {}),
          ...(params.continues_task_id !== undefined && params.continues_task_id.trim() !== ''
            ? { continuesTaskId: params.continues_task_id.trim() }
            : {}),
        });
        const line = started.alreadyStarted
          ? `任务 ${started.taskId} 在被重试的上一轮里已经派出过（${started.state}），没有重复派出。`
          : started.state === 'running'
            ? `已派出任务 ${started.taskId}，正在执行。`
            : started.state === 'submitted'
              ? `已派出任务 ${started.taskId}，排队中：${started.queueReason ?? '等待启动'}。`
              : `已派出任务 ${started.taskId}，但它已经结束（${started.state}），详见它的结算条目。`;
        return {
          ok: true,
          content: `${line}\n${JSON.stringify({ task_id: started.taskId, state: started.state, queue_reason: started.queueReason })}`,
        };
      }),
  };

  const injectTask: ToolDefinition<{
    task_id: string;
    text: string;
    source_message_ids?: string[];
  }> = {
    name: 'inject_task',
    description:
      '把新的指令或用户的补充转给一条排队中或进行中的任务（例如用户改了要求、回答了任务的问题）。返回 delivered（任务会收到）或 queued（任务正在收尾、没能转入，需要时等结果回来后接续）。转交后告诉用户你把话转给了哪条任务。',
    parameters: Type.Object(
      {
        task_id: Type.String({ description: '目标任务 id' }),
        text: Type.String({ description: '要转给任务的指令' }),
        source_message_ids: Type.Optional(
          Type.Array(Type.String(), { description: '相关的用户原消息 id，任务会看到原文' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        const ids = sourceIds(params.source_message_ids);
        if (typeof ids === 'string') return fail('INVALID_INPUT', ids);
        const result = tasks.inject(identity, {
          taskId: nonEmpty(params.task_id, 'task_id', 200),
          text: nonEmpty(params.text, 'text', TASK_INSTRUCTION_MAX_CHARS),
          sourceMessageIds: ids,
        });
        return {
          ok: true,
          content:
            result.delivery === 'delivered'
              ? `已转给任务 ${params.task_id}。`
              : `任务 ${params.task_id} 正在收尾，这条指令没能转入当前执行（已记在你与任务的往返里）。如仍需要，等它的结果回来后用 start_task + continues_task_id 接着做。`,
        };
      }),
  };

  const cancelTask: ToolDefinition<{ task_id: string; reason: string }> = {
    name: 'cancel_task',
    description:
      '取消一条排队中或进行中的任务（用户改主意、与新要求冲突）。已经做出的改动不会自动撤销。取消后告诉用户。',
    parameters: Type.Object(
      {
        task_id: Type.String({ description: '要取消的任务 id' }),
        reason: Type.String({ description: '取消理由（记录在任务往返里）' }),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        const result = tasks.cancel(identity, {
          taskId: nonEmpty(params.task_id, 'task_id', 200),
          reason: nonEmpty(params.reason, 'reason', TASK_INSTRUCTION_MAX_CHARS),
        });
        return { ok: true, content: result.message };
      }),
  };

  const listTasks: ToolDefinition<Record<string, never>> = {
    name: 'list_tasks',
    description:
      '列出本对话中你的进行中、排队中与最近结束的任务（状态、排队原因、最近进度、是否可注入）。',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () =>
      guarded(() => {
        const summaries = tasks.list(identity);
        if (summaries.length === 0) return { ok: true, content: '本对话没有任务。' };
        return { ok: true, content: summaries.map(stateLine).join('\n') };
      }),
  };

  const forwardTaskResult: ToolDefinition<{ task_id: string }> = {
    name: 'forward_task_result',
    description:
      '把一条已完成任务的结果原文作为你的消息发给用户（长报告、代码、表格等不必重新转述）。之后你的回复只需写衔接的话，不要再复述结果。',
    parameters: Type.Object(
      { task_id: Type.String({ description: '已完成的任务 id' }) },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        const forwarded = tasks.forwardResult(identity, nonEmpty(params.task_id, 'task_id', 200));
        return {
          ok: true,
          content: `已把任务 ${params.task_id} 的结果原文发给用户（消息 ${forwarded.messageId}）。`,
        };
      }),
  };

  return [startTask, injectTask, cancelTask, listTasks, forwardTaskResult] as ToolDefinition[];
}
