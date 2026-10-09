/**
 * Human wording of a schedule's timing (D80, todo/schedule-nudges.md §3.2):
 * the receipt / offer cards, the schedule panel, the schedule tool's result
 * and the <schedules> context all say 「每个工作日 09:00」 instead of the raw
 * cron. Common 5-field shapes only; anything else falls back to 「cron「…」」.
 * Pure (Intl only), shared by core and renderer.
 */

export interface ScheduleTiming {
  kind: 'once' | 'cron';
  runAt: number | null;
  cron: string | null;
  timezone: string;
}

export interface DescribeOptions {
  /** The user's zone: a schedule in another zone gets the zone appended. */
  localTimeZone?: string | undefined;
  /** Reference instant for 「今天 / 明天」 and the year of one-shot dates. */
  now?: number | undefined;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六', '日'];

const SHORTCUTS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const NUM = /^\d{1,2}$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "9,18" → [9, 18]; null when any part is not a plain number in range. */
function numberList(field: string, min: number, max: number): number[] | null {
  const parts = field.split(',');
  const out: number[] = [];
  for (const part of parts) {
    if (!NUM.test(part)) return null;
    const n = Number(part);
    if (n < min || n > max) return null;
    out.push(n);
  }
  return out;
}

/** Day-of-week field → 「每个工作日」「周末」「每周一、三」「周一至周三」; null = unsupported. */
function describeWeekdays(field: string): string | null {
  if (field === '1-5') return '每个工作日';
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 7) return null;
      for (let d = from; d <= to; d += 1) days.add(d % 7);
      continue;
    }
    if (!/^\d$/.test(part) || Number(part) > 7) return null;
    days.add(Number(part) % 7);
  }
  const sorted = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (sorted.length === 7) return '每天';
  if (sorted.length === 2 && days.has(0) && days.has(6)) return '每个周末';
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((d) => days.has(d))) return '每个工作日';
  return `每周${sorted.map((d) => WEEKDAYS[d]).join('、')}`;
}

/** The cron expression in words; null when the shape is not one we word. */
export function describeCron(expression: string): string | null {
  const expanded = SHORTCUTS[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;

  // 每 n 分钟 / 每 n 小时 / 每小时
  const everyMinutes = /^\*\/(\d{1,2})$/.exec(minute);
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `每 ${Number(everyMinutes[1])} 分钟`;
  }
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return '每分钟';
  }
  if (!NUM.test(minute) || Number(minute) > 59) return null;
  const mm = Number(minute);
  if (dom === '*' && month === '*' && dow === '*') {
    if (hour === '*') return mm === 0 ? '每小时整点' : `每小时第 ${mm} 分`;
    const everyHours = /^\*\/(\d{1,2})$/.exec(hour);
    if (everyHours) return `每 ${Number(everyHours[1])} 小时${mm === 0 ? '' : `（第 ${mm} 分）`}`;
  }

  const hours = numberList(hour, 0, 23);
  if (hours === null) return null;
  const times = hours.map((h) => `${pad(h)}:${pad(mm)}`).join('、');

  if (dom === '*' && month === '*') {
    if (dow === '*') return `每天 ${times}`;
    const days = describeWeekdays(dow);
    return days === null ? null : `${days} ${times}`;
  }
  if (dow !== '*') return null;
  const doms = numberList(dom, 1, 31);
  if (doms === null) return null;
  const domText = `${doms.join('、')} 日`;
  if (month === '*') return `每月 ${domText} ${times}`;
  const months = numberList(month, 1, 12);
  if (months === null || months.length !== 1) return null;
  return `每年 ${months[0]} 月 ${domText} ${times}`;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  ymd: string;
}

function localParts(at: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  return {
    year,
    month,
    day,
    weekday: weekday < 0 ? 0 : weekday,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    ymd: `${year}-${pad(month)}-${pad(day)}`,
  };
}

/** A one-shot instant: 「今天 / 明天 09:00」 or 「10月12日（周一）09:00」. */
export function describeInstant(at: number, timeZone: string, now?: number): string {
  const target = localParts(at, timeZone);
  const time = `${pad(target.hour)}:${pad(target.minute)}`;
  if (now !== undefined) {
    const today = localParts(now, timeZone);
    if (today.ymd === target.ymd) return `今天 ${time}`;
    const tomorrow = localParts(now + 24 * 60 * 60 * 1000, timeZone);
    if (tomorrow.ymd === target.ymd) return `明天 ${time}`;
  }
  const year = now !== undefined && localParts(now, timeZone).year !== target.year ? `${target.year}年` : '';
  return `${year}${target.month}月${target.day}日（周${WEEKDAYS[target.weekday]}）${time}`;
}

/** The schedule's timing in words, e.g. 「每个工作日 09:00」 / 「明天 09:00」. */
export function describeScheduleWhen(timing: ScheduleTiming, options: DescribeOptions = {}): string {
  const zoneSuffix =
    options.localTimeZone !== undefined && options.localTimeZone !== timing.timezone
      ? `（${timing.timezone}）`
      : '';
  if (timing.kind === 'once') {
    if (timing.runAt === null) return '时间待定';
    return `${describeInstant(timing.runAt, timing.timezone, options.now)}${zoneSuffix}`;
  }
  const cron = timing.cron ?? '';
  const words = describeCron(cron);
  return `${words ?? `cron「${cron}」`}${zoneSuffix}`;
}

/** Display name of a schedule: its title, else the note cut short. */
export function scheduleDisplayTitle(schedule: { title: string; note: string }): string {
  const title = schedule.title.trim();
  if (title.length > 0) return title;
  const note = schedule.note.trim().replace(/\s+/g, ' ');
  return note.length > 24 ? `${note.slice(0, 24)}…` : note;
}
