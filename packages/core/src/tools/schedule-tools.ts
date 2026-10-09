import { Type } from '@earendil-works/pi-ai';
import { scheduleDisplayTitle, type Schedule, type ScheduleOrigin } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import { untrustedBlock } from '../infra/data-boundary.js';

/**
 * The proactive-messaging tools (docs/dev/phases/P10-proactive.md 任务 1,
 * docs/dev/04-agent-runtime.md 工具目录 R 列) plus the offer card (D80,
 * todo/schedule-nudges.md §3.5). Creation targets the current conversation;
 * a bot can only list and cancel its own tasks.
 */
export interface ScheduleToolFacade {
  /** ISO 8601 → one-shot, anything else → cron (D80: shared with offers / routines). */
  createFromWhen(input: {
    botId: string;
    conversationId: string;
    when: string;
    timezone?: string | null | undefined;
    note: string;
    title?: string | undefined;
    origin: ScheduleOrigin;
  }): Schedule;
  /** Validates a `when` without creating (butler routines, D80); throws on invalid. */
  validateWhen(when: string, timezone?: string | null): unknown;
  /** 「每个工作日 09:00」 */
  describeWhen(row: Pick<Schedule, 'kind' | 'runAt' | 'cron' | 'timezone'>): string;
  /** Proactive switch off / first fire in quiet hours (D80). */
  fireabilityWarnings(row: Schedule): string[];
  listForBotInConversation(botId: string, conversationId: string): Schedule[];
  cancelOwn(botId: string, scheduleId: string): { ok: boolean; message: string };
  /** offer_schedule (D80): posts the offer card after the host checks. */
  createOffer(input: {
    botId: string;
    conversationId: string;
    when: string;
    timezone?: string | null | undefined;
    title: string;
    note: string;
    question: string;
  }): { ok: boolean; message: string };
  /** `<schedules>` context section (D80 §3.4); '' = nothing to say. */
  contextSection(botId: string, conversationId: string): string;
  /** Display title of a schedule (scheduled-turn reply tag). */
  displayTitle(scheduleId: string): string | null;
}

function describeSchedule(schedule: Schedule, facade: ScheduleToolFacade): string {
  const next =
    schedule.nextFireAt !== null
      ? `，下次 ${facade.describeWhen({ kind: 'once', runAt: schedule.nextFireAt, cron: null, timezone: schedule.timezone })}`
      : '';
  const raw = schedule.kind === 'cron' ? `（cron「${schedule.cron}」${schedule.timezone}）` : '';
  return `- [${schedule.id}] ${scheduleDisplayTitle(schedule)}：${facade.describeWhen(schedule)}${raw}${next}。到点要做：${schedule.note}`;
}

const WHEN_DESCRIPTION =
  'ISO 8601 时间（如 2026-10-09T09:00:00+08:00，一次性）或 cron 表达式（如 "0 9 * * 1-5"，周期，按 timezone 计，默认用户本地时区）。时间在过去会被拒绝。';
const TITLE_DESCRIPTION = '给用户看的短名（2~12 个字，如「工作日早报」「周报提醒」），显示在卡片和消息标签上';
const NOTE_DESCRIPTION = '到点时你会看到这段话：写清到时要做什么（如「提醒用户整理本周周报，问要不要帮忙起草」）';

export function buildScheduleTools(input: {
  identity: RunIdentity;
  schedule: ScheduleToolFacade;
}): ToolDefinition[] {
  const { identity, schedule } = input;
  const requireContext = (): { botId: string; conversationId: string } | null => {
    if (identity.conversationId === null || identity.botId === null) return null;
    return { botId: identity.botId, conversationId: identity.conversationId };
  };
  const noContext = (): { ok: false; content: string; errorCode: string } => ({
    ok: false,
    content: '当前执行没有对话上下文，无法使用定时任务工具',
    errorCode: 'INVALID_INPUT',
  });

  const scheduleTool: ToolDefinition<{
    when: string;
    note: string;
    title?: string;
    timezone?: string;
  }> = {
    name: 'schedule',
    description:
      '为当前对话创建定时任务，到时间你会被唤醒并可以主动发消息。用户明确要求提醒 / 定时时用；只是你觉得可能有用时改用 offer_schedule 先问用户。创建后对话里会出现一张用户可见的回执卡。',
    parameters: Type.Object({
      when: Type.String({ description: WHEN_DESCRIPTION }),
      note: Type.String({ description: NOTE_DESCRIPTION }),
      title: Type.Optional(Type.String({ description: TITLE_DESCRIPTION })),
      timezone: Type.Optional(
        Type.String({ description: 'cron 表达式使用的 IANA 时区，如 Asia/Shanghai；一次性任务无需填写' }),
      ),
    }),
    execute: async (params) => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      try {
        const created = schedule.createFromWhen({
          botId: ctx.botId,
          conversationId: ctx.conversationId,
          when: params.when,
          ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
          note: params.note,
          ...(params.title !== undefined ? { title: params.title } : {}),
          origin: 'tool',
        });
        const kind = created.kind === 'cron' ? '周期' : '一次性';
        const warnings = schedule.fireabilityWarnings(created);
        return {
          ok: true,
          content: [
            `已创建${kind}定时任务「${scheduleDisplayTitle(created)}」（id：${created.id}）：${schedule.describeWhen(created)}。对话里已显示回执卡，回复里用一句话确认时间即可。`,
            ...warnings.map((warning) => `注意：${warning}请告诉用户。`),
          ].join('\n'),
        };
      } catch (error) {
        return {
          ok: false,
          content: `创建定时任务失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INVALID_INPUT',
        };
      }
    },
  };

  const listSchedules: ToolDefinition<Record<string, never>> = {
    name: 'list_schedules',
    description: '列出你当前对话中的有效定时任务。',
    parameters: Type.Object({}),
    execute: async () => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      const rows = schedule.listForBotInConversation(ctx.botId, ctx.conversationId);
      if (rows.length === 0) return { ok: true, content: '当前对话没有有效的定时任务。' };
      // Task notes can originate from user/web material — the literal closing
      // tag inside a note must not close the boundary (BR-P10-007, BR-P09-004).
      return {
        ok: true,
        content: untrustedBlock(rows.map((row) => describeSchedule(row, schedule)).join('\n')),
      };
    },
  };

  const cancelSchedule: ToolDefinition<{ schedule_id: string }> = {
    name: 'cancel_schedule',
    description: '取消一个定时任务。只能取消你自己创建的任务。',
    parameters: Type.Object({
      schedule_id: Type.String({ description: '定时任务 id（形如 sch_...）' }),
    }),
    execute: async (params) => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      const outcome = schedule.cancelOwn(ctx.botId, params.schedule_id);
      return outcome.ok
        ? { ok: true, content: outcome.message }
        : { ok: false, content: outcome.message, errorCode: 'NOT_FOUND' };
    },
  };

  return [scheduleTool, listSchedules, cancelSchedule];
}

/**
 * offer_schedule (D80 §3.5): the turn's proposal card — a concrete time the
 * user accepts or declines with one click. Turn surface only (D75: cards
 * facing the user are the turn's).
 */
export function buildOfferScheduleTool(input: {
  identity: RunIdentity;
  schedule: ScheduleToolFacade;
}): ToolDefinition<{ when: string; title: string; note: string; question: string; timezone?: string }> {
  const { identity, schedule } = input;
  return {
    name: 'offer_schedule',
    description:
      '向用户出一张定时提议卡：用户一键「设置」或「不用了」。用于用户没明确要求、但对话里出现了延后、重复或截止时间等信号的时候；用户明确要求提醒时直接用 schedule。一件事只提一次；被拒绝多次后宿主会拒绝再次提议。',
    parameters: Type.Object({
      when: Type.String({ description: WHEN_DESCRIPTION }),
      title: Type.String({ description: TITLE_DESCRIPTION }),
      note: Type.String({ description: NOTE_DESCRIPTION }),
      question: Type.String({
        description: '卡片上的一句自然的问话，带上具体时间，如「要我明早 9 点提醒你整理周报吗？」',
      }),
      timezone: Type.Optional(Type.String({ description: 'cron 表达式使用的 IANA 时区；一次性无需填写' })),
    }),
    execute: async (params) => {
      if (identity.conversationId === null || identity.botId === null) {
        return { ok: false, content: '当前执行没有对话上下文，无法提议定时任务', errorCode: 'INVALID_INPUT' };
      }
      try {
        const outcome = schedule.createOffer({
          botId: identity.botId,
          conversationId: identity.conversationId,
          when: params.when,
          ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
          title: params.title,
          note: params.note,
          question: params.question,
        });
        return outcome.ok
          ? { ok: true, content: outcome.message }
          : { ok: false, content: outcome.message, errorCode: 'INVALID_INPUT' };
      } catch (error) {
        return {
          ok: false,
          content: `提议失败：${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'INVALID_INPUT',
        };
      }
    },
  };
}
