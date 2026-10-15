import { describeInstant, describeScheduleWhen } from '@kepcup/shared';
import type { TodoEntry } from '@kepcup/shared';

/** 人话时间的小工具（卡片、道头、抽屉共用）：全部复用 shared 的 `describeScheduleWhen` / `describeInstant`。 */

export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 一个时刻：「今天 09:00」「周五…」。 */
export function describeAt(at: number, now: number = Date.now()): string {
  return describeInstant(at, localTimeZone(), now);
}

/** 事项的排期人话：单次「明天 09:00」/ 周期「每个工作日 09:00」；没有排期返回 null。 */
export function describeTodoWhen(
  schedule: TodoEntry['schedule'],
  now: number = Date.now(),
): string | null {
  if (schedule === null) return null;
  return describeScheduleWhen(schedule, { localTimeZone: localTimeZone(), now });
}
