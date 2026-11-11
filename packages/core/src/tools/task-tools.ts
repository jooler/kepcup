import { Type } from '@earendil-works/pi-ai';
import {
  AppError,
  ASK_USER_FIELDS_MAX,
  ASK_USER_OPTION_MAX_CHARS,
  askUserFieldsSchema,
  TASK_CAPABILITIES_MAX,
  TASK_CLAIM_PATHS_MAX,
  TASK_INSTRUCTION_MAX_CHARS,
  TASK_PEER_MESSAGE_MAX_CHARS,
  TASK_PEER_SEND_MAX_PER_RUN,
  TASK_PEER_WAIT_TTL_MAX_MS,
  TASK_PEER_WAIT_TTL_MS,
  TASK_SOURCE_MESSAGES_MAX,
  TASK_TITLE_MAX_CHARS,
  type AskUserField,
  type AskUserMode,
  type RunStatus,
} from '@kepcup/shared';
import type { RunIdentity, ToolDefinition, ToolResult } from '../agent/types.js';

/**
 * 任务管理工具（D75，docs/design/30-supervisor-and-tasks.md §4.1）：对话层用
 * `start_task` / `inject_task` / `cancel_task` / `list_tasks` 枚举化地路由。
 * 任务结果不进对话（不提供原文转发工具）：用户在任务卡上自行查看执行报告，
 * 对话轮只负责高度总结结果与注意事项（§6.1 2026-11 修订）。宿主（TaskHost）
 * 逐项校验归属、状态与配额；这里只做参数校验与执行期的深度校验——任务内
 * 调用 `start_task` 一律拒绝（深度 1，§2.2）。本文件只定义工具，不注册进任何
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
  /**
   * Write task: takes the cwd write lease for its whole run (§5.1). `true` =
   * the whole cwd, a glob array = declared write domains (D123), `false` /
   * omitted = read-only. A continuation without `writes` inherits the source
   * task's declaration.
   */
  writes?: boolean | string[];
  /** Cwd root; default = the bound workdir when available, else the workspace. */
  cwd?: 'workspace' | 'workdir' | undefined;
  /** Replay this settled task's process into the new one (D56 budget, §7.1). */
  continuesTaskId?: string | undefined;
  /**
   * D91: external capability ids (`<capabilities>` ids such as `app:github`) the task mounts one
   * by one; omitted / empty = none (the rest stays reachable through `capability_search`).
   */
  capabilities?: string[] | undefined;
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
  /**
   * D91: declared capabilities that are not `ready` right now (expired authorization, disabled …):
   * accepted, but the task does not mount them.
   */
  notReadyCapabilities?: string[];
}

export interface InjectTaskInput {
  taskId: string;
  text: string;
  sourceMessageIds?: string[] | undefined;
  /**
   * Replaces the inject tail's「对话中的你追加了新的指令」framing (D114: a
   * delegation supplement comes from another Bot, not the task owner).
   */
  note?: string | undefined;
}

export interface InjectTaskResult {
  /**
   * delivered = the task sees it (steered now, or folded into its brief / the
   * next steer); queued = the run could not take it (it is ending, or an
   * engine without steering, §8.2) — recorded only, no later delivery here.
   */
  delivery: 'delivered' | 'queued';
}

/** D123: `send_to_task` — a message to a sibling task (task tool surface only). */
export interface SendToTaskInput {
  taskId: string;
  text: string;
  sourceMessageIds?: string[] | undefined;
}

/** D123: `wait_for_task` — block on a sibling task's terminal state. */
export interface WaitForTaskInput {
  taskId: string;
  /** Defaults to `TASK_PEER_WAIT_TTL_MS`, capped at `TASK_PEER_WAIT_TTL_MAX_MS`. */
  timeoutMinutes?: number | undefined;
}

export type PeerTaskStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'still_running';

export interface WaitForTaskResult {
  status: PeerTaskStatus;
  /** Terminal result text (clipped to `TASK_PEER_WAIT_RESULT_MAX_CHARS`). */
  resultDigest?: string;
  /** `still_running`: why the target is not running yet. */
  queueReason?: string;
}

/** D123 §5: runtime claim of a path subset inside the task's write domain. */
export interface ClaimTaskInput {
  paths: string[];
  reason: string;
}

export interface ReleaseTaskInput {
  paths?: string[] | undefined;
}

export interface ClaimTaskResult {
  paths: string[];
  reason: string;
  since: number;
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
  /** D123: declared write domains (null = whole cwd / not declared). */
  writeDomains?: string[] | null;
  cwd: string | null;
  createdAt: number;
  endedAt: number | null;
  queueReason: string | null;
  awaitingInput: boolean;
  injectable: boolean;
  /** Latest visible progress line of the task (clipped), if any. */
  lastProgress: string | null;
  error: string | null;
  /** D91: the external capability ids the task declared (absent = none). */
  capabilities?: string[] | undefined;
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
  /** D123 (task surface only): message a sibling task. */
  send?(identity: RunIdentity, input: SendToTaskInput): InjectTaskResult;
  /** D123 (task surface only): wait for a sibling task's terminal state. */
  wait?(
    identity: RunIdentity,
    input: WaitForTaskInput,
    signal: AbortSignal,
  ): Promise<WaitForTaskResult>;
  /** D123 (task surface only): claim a path subset inside the write domain. */
  claim?(identity: RunIdentity, input: ClaimTaskInput): ClaimTaskResult;
  /** D123 (task surface only): release claimed paths (no paths = all). */
  release?(identity: RunIdentity, input: ReleaseTaskInput): string[];
  /**
   * §2.4.6 (task side): asks the user on a visible question card and waits for
   * the answer (a card option, or the turn's inject_task). Optional: only the
   * task host provides it; `ask_user` is registered for tasks when present.
   */
  ask?(
    identity: RunIdentity,
    input: { question: string; options: string[]; mode?: AskUserMode; fields?: AskUserField[] },
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
  const tool: ToolDefinition<{
    question: string;
    options?: string[];
    mode?: AskUserMode;
    fields?: unknown;
  }> = {
    name: 'ask_user',
    description:
      '任务无法继续、必须由用户做决定时向用户提问：问题与候选答案以卡片形式出现在对话里，本次调用会一直等到用户回答（用户点选的选项，或在对话里自由回答后由对话中的你转交），返回用户的回答。' +
      '只问真正需要用户拍板的事，一次一个问题；能自己判断的不要问。' +
      `mode：single（缺省，单选）/ multi（多选，回答是选中项的 JSON 列表；用户也可以自行输入新条目加入多选）/ form（简单表单，fields 至多 ${ASK_USER_FIELDS_MAX} 个字段，回答是「字段名 → 值」的 JSON）。只需补充几项信息时用 form，别连续问多次。`,
    parameters: Type.Object(
      {
        question: Type.String({ description: '要问用户的问题（说明背景与影响）' }),
        options: Type.Optional(
          Type.Array(Type.String(), {
            description: `single / multi 的候选答案，1~${ASK_USER_OPTIONS_MAX} 个（多选至少 2 个）、每个不超过 ${ASK_USER_OPTION_MAX_CHARS} 字；multi 下用户还可以自行补充候选之外的新条目，也可以在对话里另行回答`,
          }),
        ),
        mode: Type.Optional(
          Type.Union([Type.Literal('single'), Type.Literal('multi'), Type.Literal('form')], {
            description: '提问方式，缺省 single',
          }),
        ),
        fields: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({
                description: '字段键（字母 / 数字 / 下划线），回答 JSON 里用它',
              }),
              label: Type.String({ description: '给用户看的字段名' }),
              type: Type.Union(
                [
                  Type.Literal('text'),
                  Type.Literal('number'),
                  Type.Literal('date'),
                  Type.Literal('select'),
                ],
                { description: 'date 为 YYYY-MM-DD；select 需要 options' },
              ),
              options: Type.Optional(
                Type.Array(Type.String(), { description: 'select 的选项（2~12 个）' }),
              ),
              required: Type.Optional(Type.Boolean()),
            }),
            { description: `form 的字段（1~${ASK_USER_FIELDS_MAX} 个）` },
          ),
        ),
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
      const mode: AskUserMode = params.mode ?? 'single';
      if (mode === 'form') {
        const fields = askUserFieldsSchema.safeParse(params.fields);
        if (!fields.success) {
          const issue = fields.error.issues[0];
          const where =
            issue !== undefined && issue.path.length > 0 ? `fields.${issue.path.join('.')}：` : '';
          return fail('INVALID_INPUT', `表单字段不对（${where}${issue?.message ?? '格式错误'}）`);
        }
        try {
          const answer = await ask(
            identity,
            { question, options: [], mode, fields: fields.data },
            ctx.signal,
          );
          return {
            ok: true,
            content: answer.startsWith('用户在问题卡上的回答') ? answer : `用户的回答：${answer}`,
          };
        } catch (error) {
          if (error instanceof AppError) return fail(String(error.code), error.message);
          return fail('INTERNAL', error instanceof Error ? error.message : String(error));
        }
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
      if (mode === 'multi' && options.length < 2) {
        return fail('INVALID_INPUT', '多选至少要 2 个候选答案');
      }
      // Each option is a button on the card and a line in every bot's context
      // (D75 审查 H1): short answers only — the background goes in the question.
      if (options.some((option) => option.length > ASK_USER_OPTION_MAX_CHARS)) {
        return fail(
          'INVALID_INPUT',
          `每个候选答案最多 ${ASK_USER_OPTION_MAX_CHARS} 字；背景说明写进 question`,
        );
      }
      try {
        const answer = await ask(identity, { question, options, mode }, ctx.signal);
        return {
          ok: true,
          content: answer.startsWith('用户在问题卡上的回答') ? answer : `用户的回答：${answer}`,
        };
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

/** D91: `start_task.capabilities` — a string array, trimmed + deduped, at most TASK_CAPABILITIES_MAX. */
function capabilityIds(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return 'capabilities 必须是能力 id 字符串数组（取 <capabilities> 里的 id）';
  }
  const ids = [...new Set((value as string[]).map((id) => id.trim()))];
  if (ids.length > TASK_CAPABILITIES_MAX) return `capabilities 最多 ${TASK_CAPABILITIES_MAX} 个`;
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
  // In-flight progress stays off the model (status overlay only). Incomplete
  // stops keep the last line so the Bot can see where the task stopped.
  if (
    summary.lastProgress &&
    (summary.state === 'cancelled' || summary.state === 'failed' || summary.state === 'interrupted')
  ) {
    parts.push(`停在：${summary.lastProgress}`);
  }
  if (summary.error) parts.push(`错误：${summary.error}`);
  if (summary.capabilities !== undefined && summary.capabilities.length > 0) {
    parts.push(`能力：${summary.capabilities.join('、')}`);
  }
  if (summary.state === 'submitted' || summary.state === 'running') {
    parts.push(`可注入：${summary.injectable ? '是' : '否'}`);
  }
  return parts.join('  ');
}

export function buildTaskTools(input: {
  identity: RunIdentity;
  tasks: TaskToolFacade;
  /** D90: this turn only read 「事项更新」 notices (see ResponseToolDeps.updateNotice). */
  updateNotice?:
    | {
        messageIds: readonly string[];
        startBlocked: () => string | null;
      }
    | undefined;
}): ToolDefinition[] {
  const { identity, tasks, updateNotice } = input;

  const startTask: ToolDefinition<{
    title: string;
    instruction: string;
    source_message_ids: string[];
    writes?: boolean | string[];
    cwd?: 'workspace' | 'workdir';
    continues_task_id?: string;
    capabilities?: string[];
  }> = {
    name: 'start_task',
    description:
      '把一件需要动手或耗时的事派成一个后台任务（文件、命令、浏览器、生成图片 / 语音 / 视频、长时间研究都在任务里做），立即返回 task_id，不等它完成。' +
      '对话轮只有只读查询工具（无 bash / 写入）；任务拥有完整工具面（bash、写文件、浏览器等），执行中会按需申请权限——本轮做不了的，就用 start_task 派任务去做。' +
      '任务完成后它的结果会交回给你，由你决定怎么告诉用户；过程中只有一条状态通知会更新给用户看（不堆消息）。' +
      'instruction 写清要做什么、要什么结果、约束；source_message_ids 填用户的原消息 id（任务会看到原文与附件）。' +
      'writes=true 表示要改文件（整目录串行，安全默认）；多个写任务各改一块时，可用 writes 传相对 cwd 的 glob 数组（如 ["apps/renderer/**","packages/core/**"]）声明互不相交的写域，互不相交的写任务可并行；域外写入会被拒绝。只读调研用 writes=false。' +
      '任务要用 <capabilities> 里的外部能力（连接应用 / 自定义 MCP）时，在 capabilities 里列出它们的 id（如 ["app:github"]）：任务只会挂上你列出的能力，其余能力任务里也能用，但要先查一步，更慢。' +
      '要接着一条已结束的任务重做，用 continues_task_id（先 cancel_task 进行中的那条）。派出后不必再复述「已派出」——任务卡会即时出现在对话里；有排队、能力不可用等用户需要知道的情况时才补一句。',
    parameters: Type.Object(
      {
        title: Type.String({
          description: `任务标题（≤ ${TASK_TITLE_MAX_CHARS} 字，用户在任务卡上看到）`,
        }),
        instruction: Type.String({ description: '交给任务的完整说明' }),
        source_message_ids: Type.Array(Type.String(), {
          description: '相关的用户原消息 id（msg_…），任务简报会带上原文',
        }),
        writes: Type.Optional(
          Type.Union([Type.Boolean(), Type.Array(Type.String({ description: '相对 cwd 的 glob，如 apps/renderer/**' }))], {
            description:
              'true = 整目录写任务（安全默认，写任务串行）；glob 数组 = 声明互不相交的写域（如 ["apps/renderer/**"]），域不相交的写任务可并行；false / 省略 = 只读。接续任务省略时继承来源任务',
          }),
        ),
        cwd: Type.Optional(
          Type.Union([Type.Literal('workspace'), Type.Literal('workdir')], {
            description: '工作目录：workdir（对话绑定的工作目录，缺省时有绑定即用）或 workspace',
          }),
        ),
        continues_task_id: Type.Optional(
          Type.String({ description: '接续的已结束任务 id：回放它的过程，避免重新踩坑' }),
        ),
        capabilities: Type.Optional(
          Type.Array(Type.String(), {
            description: `任务要挂的外部能力 id（取 <capabilities> 里的 id，如 app:github、mcp:fs-notes；最多 ${TASK_CAPABILITIES_MAX} 个）。任务只会挂上这里列出的能力；不列的能力任务里也能用，但要先 capability_search，更慢`,
          }),
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
        const blocked = updateNotice?.startBlocked() ?? null;
        if (blocked !== null) return fail('INVALID_INPUT', blocked);
        const ids = sourceIds(params.source_message_ids);
        if (typeof ids === 'string') return fail('INVALID_INPUT', ids);
        const writes = params.writes;
        if (
          writes !== undefined &&
          typeof writes !== 'boolean' &&
          !(Array.isArray(writes) && writes.every((pattern) => typeof pattern === 'string'))
        ) {
          return fail('INVALID_INPUT', 'writes 必须是布尔值或相对 cwd 的 glob 字符串数组');
        }
        if (params.cwd !== undefined && params.cwd !== 'workspace' && params.cwd !== 'workdir') {
          return fail('INVALID_INPUT', 'cwd 只能是 workspace 或 workdir');
        }
        const capabilities = capabilityIds(params.capabilities);
        if (typeof capabilities === 'string') return fail('INVALID_INPUT', capabilities);
        const started = tasks.start(identity, {
          title: nonEmpty(params.title, 'title', TASK_TITLE_MAX_CHARS),
          instruction: nonEmpty(params.instruction, 'instruction', TASK_INSTRUCTION_MAX_CHARS),
          sourceMessageIds: ids,
          ...(writes !== undefined ? { writes } : {}),
          ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
          ...(params.continues_task_id !== undefined && params.continues_task_id.trim() !== ''
            ? { continuesTaskId: params.continues_task_id.trim() }
            : {}),
          ...(capabilities.length > 0 ? { capabilities } : {}),
        });
        const line = started.alreadyStarted
          ? `任务 ${started.taskId} 在被重试的上一轮里已经派出过（${started.state}），没有重复派出。`
          : started.state === 'running'
            ? `已派出任务 ${started.taskId}，正在执行。`
            : started.state === 'submitted'
              ? `已派出任务 ${started.taskId}，排队中：${started.queueReason ?? '等待启动'}。`
              : `已派出任务 ${started.taskId}，但它已经结束（${started.state}），详见它的结算条目。`;
        const notReady =
          started.notReadyCapabilities !== undefined && started.notReadyCapabilities.length > 0
            ? `\n注意：能力 ${started.notReadyCapabilities.join('、')} 现在不是可用状态（见 <capabilities> 里的状态），任务里不会挂上它们；需要时先让用户（重新）连接。`
            : '';
        return {
          ok: true,
          content: `${line}${notReady}\n${JSON.stringify({ task_id: started.taskId, state: started.state, queue_reason: started.queueReason })}`,
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
        const given = sourceIds(params.source_message_ids);
        if (typeof given === 'string') return fail('INVALID_INPUT', given);
        // D90: relaying a 「事项更新」 — the notice itself travels with the injection (original text and
        // its <untrusted> marking), so the task never gets the executor's paraphrase alone.
        const ids = [...new Set([...given, ...(updateNotice?.messageIds ?? [])])].slice(
          0,
          TASK_SOURCE_MESSAGES_MAX,
        );
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

  return [startTask, injectTask, cancelTask, listTasks] as ToolDefinition[];
}

function describeWait(result: WaitForTaskResult): string {
  if (result.status === 'still_running') {
    const reason = result.queueReason !== null && result.queueReason !== undefined ? `（${result.queueReason}）` : '';
    return `对方仍未结束${reason}：这次没有等到终态，可以稍后再调 wait_for_task，或先做别的。\n${JSON.stringify(result)}`;
  }
  const head = result.status === 'completed' ? '对方已完成' : `对方已结束（${result.status}）`;
  const digest = result.resultDigest?.trim() ?? '';
  return `${head}。${digest.length > 0 ? `结果摘要：\n${digest}` : '没有结果摘要。'}\n${JSON.stringify(result)}`;
}

/**
 * D123: task-to-task coordination (docs/design/59 §4) — registered on the task
 * surface only. A task may message and wait for a sibling; it still cannot
 * start or cancel tasks (depth 1, §4.4).
 */
export function buildPeerTaskTools(input: {
  identity: RunIdentity;
  tasks: TaskToolFacade;
}): ToolDefinition[] {
  const { identity, tasks } = input;
  const send = tasks.send;
  const wait = tasks.wait;
  if (send === undefined || wait === undefined) return [];

  const sendToTask: ToolDefinition<{
    task_id: string;
    text: string;
    source_message_ids?: string[];
  }> = {
    name: 'send_to_task',
    description:
      '给同一对话里的另一个任务发一条消息（任务之间的协商，例如询问它的写域、约定先后）。' +
      `每次任务最多发 ${TASK_PEER_SEND_MAX_PER_RUN} 条、每条 ≤ ${TASK_PEER_MESSAGE_MAX_CHARS} 字；对方已结束会失败（TASK_PEER_FINISHED）。` +
      '这不等于派活或取消任务——需要改派请让对话轮处理。',
    parameters: Type.Object(
      {
        task_id: Type.String({ description: '目标任务的 id（见 <peer_tasks>）' }),
        text: Type.String({ description: '要发给对方的内容' }),
        source_message_ids: Type.Optional(
          Type.Array(Type.String(), { description: '相关用户原消息 id（对方会看到原文）' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        if (identity.loopType !== 'task') {
          return fail('NOT_SUPPORTED', '只有任务之间可以互发消息');
        }
        const ids = sourceIds(params.source_message_ids);
        if (typeof ids === 'string') return fail('INVALID_INPUT', ids);
        const result = send(identity, {
          taskId: nonEmpty(params.task_id, 'task_id', 200),
          text: nonEmpty(params.text, 'text', TASK_PEER_MESSAGE_MAX_CHARS),
          ...(ids.length > 0 ? { sourceMessageIds: ids } : {}),
        });
        return {
          ok: true,
          content: `${
            result.delivery === 'delivered'
              ? '已送达'
              : '已排队（对方收尾前可能收不到，与 inject_task 同语义）'
          }任务 ${params.task_id}。\n${JSON.stringify({ task_id: params.task_id, delivery: result.delivery })}`,
        };
      }),
  };

  const waitForTask: ToolDefinition<{
    task_id: string;
    timeout_minutes?: number;
  }> = {
    name: 'wait_for_task',
    description:
      '等待同一对话里的另一个任务结束（completed / failed / cancelled / interrupted），返回它的终态与结果摘要。' +
      `缺省最多等 ${TASK_PEER_WAIT_TTL_MS / 60_000} 分钟，可用 timeout_minutes 指定（上限 ${TASK_PEER_WAIT_TTL_MAX_MS / 60_000}）；` +
      '超时返回 still_running 与对方当前排队原因。等待期间让出并发名额、不计任务时长，本任务的写租约保留；' +
      '等待环（A 等 B、B 等 A）会报 TASK_WAIT_CYCLE。',
    parameters: Type.Object(
      {
        task_id: Type.String({ description: '要等待的任务 id（见 <peer_tasks>）' }),
        timeout_minutes: Type.Optional(
          Type.Number({
            description: `最多等多少分钟（缺省 ${TASK_PEER_WAIT_TTL_MS / 60_000}，上限 ${TASK_PEER_WAIT_TTL_MAX_MS / 60_000}）`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, ctx) => {
      if (identity.loopType !== 'task') {
        return fail('NOT_SUPPORTED', '只有任务可以等待其他任务');
      }
      try {
        const result = await wait(
          identity,
          {
            taskId: nonEmpty(params.task_id, 'task_id', 200),
            ...(params.timeout_minutes !== undefined
              ? { timeoutMinutes: params.timeout_minutes }
              : {}),
          },
          ctx.signal,
        );
        return { ok: true, content: describeWait(result) };
      } catch (error) {
        if (error instanceof AppError) return fail(String(error.code), error.message);
        return fail('INTERNAL', error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [sendToTask, waitForTask];
}

/**
 * D123 §5: runtime claims (task surface only). `claim` reserves paths inside
 * the task's own write domain; other tasks' writes there fail WRITE_CLAIMED
 * until `release` or the task ends.
 */
export function buildClaimTools(input: {
  identity: RunIdentity;
  tasks: TaskToolFacade;
}): ToolDefinition[] {
  const { identity, tasks } = input;
  const claim = tasks.claim;
  const release = tasks.release;
  if (claim === undefined || release === undefined) return [];

  const claimPaths: ToolDefinition<{ paths: string[]; reason: string }> = {
    name: 'claim',
    description:
      '认领本任务写域内的一小片路径（相对 cwd 的 glob），让其他任务写到这里时被拒绝（WRITE_CLAIMED）——只用于你们确实要碰同一块区域时，先认领再动手。' +
      `一次最多 ${TASK_CLAIM_PATHS_MAX} 条；必须在自己的写域内。完成或改道后 release；任务结束会自动释放。这是协调原语，不是永久锁。`,
    parameters: Type.Object(
      {
        paths: Type.Array(Type.String(), {
          description: `要认领的相对 cwd glob（最多 ${TASK_CLAIM_PATHS_MAX} 条）`,
        }),
        reason: Type.String({ description: '为什么认领（对方会在错误里看到）' }),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        if (identity.loopType !== 'task') return fail('NOT_SUPPORTED', '只有任务可以认领路径');
        if (!Array.isArray(params.paths) || params.paths.length === 0) {
          return fail('INVALID_INPUT', 'paths 不能为空');
        }
        const result = claim(identity, {
          paths: params.paths.filter((path): path is string => typeof path === 'string'),
          reason: nonEmpty(params.reason, 'reason', 200),
        });
        return {
          ok: true,
          content: `已认领：${result.paths.join('、')}（${result.reason}）。其他任务写到这里会被拒绝，完成或改道后记得 release。`,
        };
      }),
  };

  const releasePaths: ToolDefinition<{ paths?: string[] }> = {
    name: 'release',
    description: '释放本任务认领的路径；不带参数释放全部。任务结束会自动释放，无需在此调用。',
    parameters: Type.Object(
      {
        paths: Type.Optional(
          Type.Array(Type.String(), { description: '要释放的路径（缺省 = 全部）' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params) =>
      guarded(() => {
        if (identity.loopType !== 'task') return fail('NOT_SUPPORTED', '只有任务可以释放认领');
        const released = release(identity, {
          ...(Array.isArray(params.paths)
            ? { paths: params.paths.filter((path): path is string => typeof path === 'string') }
            : {}),
        });
        return {
          ok: true,
          content:
            released.length > 0 ? `已释放：${released.join('、')}` : '没有需要释放的认领。',
        };
      }),
  };

  return [claimPaths, releasePaths];
}
