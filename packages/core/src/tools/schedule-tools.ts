import { Type } from '@earendil-works/pi-ai';
import type { Schedule } from '@kepcup/shared';
import type { RunIdentity, ToolDefinition } from '../agent/types.js';
import { untrustedBlock } from '../infra/data-boundary.js';

/**
 * The three proactive-messaging tools (docs/dev/phases/P10-proactive.md 任务 1,
 * docs/dev/04-agent-runtime.md 工具目录 R 列). Creation targets the current
 * conversation; a bot can only list and cancel its own tasks.
 */
export interface ScheduleToolFacade {
  createOnce(input: {
    botId: string;
    conversationId: string;
    runAt: number;
    note: string;
  }): Schedule;
  createCron(input: {
    botId: string;
    conversationId: string;
    expression: string;
    timezone?: string;
    note: string;
  }): Schedule;
  listForBotInConversation(botId: string, conversationId: string): Schedule[];
  cancelOwn(botId: string, scheduleId: string): { ok: boolean; message: string };
}

/**
 * Strict ISO 8601 shape: `YYYY-MM-DD` with an optional time part. Date.parse
 * must only see ISO-shaped strings — V8 happily parses `0 3 * * *` as
 * February 3rd 2000 (BR-P10-001), so the cron branch is the default and a
 * cron expression can never be mistaken for a past instant.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** ISO-shaped strings parse as instants (NaN throws); everything else is cron. */
function parseIsoOrThrow(when: string): number | null {
  const trimmed = when.trim();
  if (!ISO_DATETIME.test(trimmed)) return null;
  const parsed = Date.parse(trimmed.replace(' ', 'T'));
  if (Number.isNaN(parsed)) {
    throw new Error(`无法识别的时间格式：${when}（应为 ISO 8601 时间或 cron 表达式）`);
  }
  return parsed;
}

function describeSchedule(schedule: Schedule): string {
  const when =
    schedule.kind === 'cron'
      ? `cron「${schedule.cron}」（${schedule.timezone}）`
      : new Date(schedule.runAt ?? 0).toISOString();
  const next =
    schedule.nextFireAt !== null ? new Date(schedule.nextFireAt).toISOString() : '待重算';
  return `- [${schedule.id}] ${when}，下次触发 ${next}：${schedule.note}`;
}

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
    timezone?: string;
  }> = {
    name: 'schedule',
    description:
      '为当前对话创建定时任务，到时间你会被唤醒并可以主动发消息。when 填 ISO 8601 时间（如 2026-10-09T09:00:00+08:00，一次性任务）或 cron 表达式（如 "0 9 * * 1-5"，周期任务，需配 timezone，默认用户本地时区）。时间在过去会被拒绝。',
    parameters: Type.Object({
      when: Type.String({ description: 'ISO 8601 时间或 cron 表达式' }),
      note: Type.String({ description: '任务说明（触发时你会看到这段话）' }),
      timezone: Type.Optional(
        Type.String({ description: 'cron 表达式使用的 IANA 时区，如 Asia/Shanghai；一次性任务无需填写' }),
      ),
    }),
    execute: async (params) => {
      const ctx = requireContext();
      if (ctx === null) return noContext();
      try {
        const iso = parseIsoOrThrow(params.when);
        if (iso !== null) {
          const created = schedule.createOnce({
            botId: ctx.botId,
            conversationId: ctx.conversationId,
            runAt: iso,
            note: params.note,
          });
          return {
            ok: true,
            content: `已创建一次性定时任务（id：${created.id}），触发时间 ${new Date(created.runAt ?? 0).toISOString()}。`,
          };
        }
        const created = schedule.createCron({
          botId: ctx.botId,
          conversationId: ctx.conversationId,
          expression: params.when,
          ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
          note: params.note,
        });
        return {
          ok: true,
          content: `已创建周期定时任务（id：${created.id}），cron「${created.cron}」（${created.timezone}），下次触发 ${new Date(created.nextFireAt ?? 0).toISOString()}。`,
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
      return { ok: true, content: untrustedBlock(rows.map(describeSchedule).join('\n')) };
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
