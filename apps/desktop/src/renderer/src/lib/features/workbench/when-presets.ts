/**
 * 事项时间选择器的纯函数（D90 §5.2）：界面上的「不定 / 立即 / 某时 / 重复」与
 * `todos.create|update` 的 `when` 字符串互转。
 *
 * 重复只做预设（每天 / 工作日 / 每周几 / 每月几号 + 时刻），转成 5 段 cron；
 * 现有 cron 回显时识别回预设，认不出的形态（自定义 cron，P1）返回 null，界面按「只读 cron」呈现。
 * 星期字段沿用 cron 习惯：0 = 周日，1–6 = 周一至周六，7 也算周日。
 */

export type WhenMode = 'none' | 'now' | 'once' | 'repeat';

export type RepeatPreset =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; day: number; time: string };

export type RepeatKind = RepeatPreset['kind'];

/** 时刻 `HH:mm`（24 小时制）。 */
export const DEFAULT_TIME = '09:00';

/** 周选择器的显示顺序：周一在前、周日在末（cron 值：1…6, 0）。 */
export const WEEK_DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `HH:mm` → [h, m]；非法返回 null。 */
export function parseTime(time: string): [number, number] | null {
  const match = TIME_RE.exec(time.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

function normalizeDays(days: readonly number[]): number[] {
  const set = new Set<number>();
  for (const day of days) {
    if (Number.isInteger(day) && day >= 0 && day <= 7) set.add(day % 7);
  }
  return [...set].sort((a, b) => a - b);
}

/** 预设是否填完整（时刻合法；每周至少选一天；每月日在 1–31）。 */
export function isPresetValid(preset: RepeatPreset): boolean {
  if (parseTime(preset.time) === null) return false;
  if (preset.kind === 'weekly') return normalizeDays(preset.days).length > 0;
  if (preset.kind === 'monthly') {
    return Number.isInteger(preset.day) && preset.day >= 1 && preset.day <= 31;
  }
  return true;
}

/** 预设 → 5 段 cron；预设不合法时返回 null。 */
export function presetToCron(preset: RepeatPreset): string | null {
  if (!isPresetValid(preset)) return null;
  const [hour, minute] = parseTime(preset.time) as [number, number];
  const head = `${minute} ${hour}`;
  switch (preset.kind) {
    case 'daily':
      return `${head} * * *`;
    case 'weekdays':
      return `${head} * * 1-5`;
    case 'weekly': {
      const days = normalizeDays(preset.days);
      return days.length === 7 ? `${head} * * *` : `${head} * * ${days.join(',')}`;
    }
    case 'monthly':
      return `${head} ${preset.day} * *`;
  }
}

/** 星期字段（`1-5` / `1,3,5` / `0` / `*`…）→ 排序去重的 0–6；认不出返回 null。 */
function parseDays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 7) return null;
      for (let day = from; day <= to; day += 1) days.add(day % 7);
      continue;
    }
    if (!/^\d$/.test(part) || Number(part) > 7) return null;
    days.add(Number(part) % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * cron → 预设；只认「单个分钟 + 单个小时」的形态：
 * - `m h * * *`、七天全选 → 每天；
 * - `m h * * 1-5`（含写成 `1,2,3,4,5`）→ 工作日；
 * - `m h * * <若干天>` → 每周几；
 * - `m h <日> * *` → 每月几号。
 * 多个时刻（`9,18`）、月份限定、每 n 分钟之类的步进写法等一律 null（自定义 cron，P1）。
 */
export function cronToPreset(cron: string): RepeatPreset | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField = '', hourField = '', dom = '', month = '', dow = ''] = fields;
  if (!/^\d{1,2}$/.test(minuteField) || !/^\d{1,2}$/.test(hourField)) return null;
  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (minute > 59 || hour > 23) return null;
  if (month !== '*') return null;
  const time = `${pad(hour)}:${pad(minute)}`;

  if (dom === '*') {
    if (dow === '*') return { kind: 'daily', time };
    const days = parseDays(dow);
    if (days === null || days.length === 0) return null;
    if (days.length === 7) return { kind: 'daily', time };
    if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) {
      return { kind: 'weekdays', time };
    }
    return { kind: 'weekly', days, time };
  }
  if (dow !== '*' || !/^\d{1,2}$/.test(dom)) return null;
  const day = Number(dom);
  if (day < 1 || day > 31) return null;
  return { kind: 'monthly', day, time };
}

/** 选择器的整体草稿。 */
export interface WhenDraft {
  mode: WhenMode;
  /** `<input type="datetime-local">` 的值：`YYYY-MM-DDTHH:mm`（本地时间）。 */
  onceLocal: string;
  /** 重复预设；`customCron` 非空时（认不出的 cron）预设仅作切回「重复」时的初值。 */
  preset: RepeatPreset;
  /** 事项上已有、但预设认不出的 cron：原样保留，界面只读显示。 */
  customCron: string | null;
}

export function defaultPreset(): RepeatPreset {
  return { kind: 'daily', time: DEFAULT_TIME };
}

export function emptyWhenDraft(): WhenDraft {
  return { mode: 'none', onceLocal: '', preset: defaultPreset(), customCron: null };
}

/** 毫秒时间戳 → `datetime-local` 值（本机时区）。 */
export function toLocalInput(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `datetime-local` 值 → 毫秒时间戳（本机时区）；空 / 非法返回 null。 */
export function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(value).getTime();
  return Number.isNaN(at) ? null : at;
}

/** 事项现有排期（`TodoEntry.schedule`）的最小形状。 */
export interface ScheduleLike {
  kind: 'once' | 'cron';
  runAt: number | null;
  cron: string | null;
  timezone: string;
}

/**
 * 从事项现有排期还原选择器草稿；没有排期 = 不定。cron 在别的时区下算（与 `localZone`
 * 不同）时不识别成预设——预设按本机时区解读，认成预设会改写含义——按只读 cron 回显。
 */
export function draftFromSchedule(
  schedule: ScheduleLike | null,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): WhenDraft {
  const draft = emptyWhenDraft();
  if (schedule === null) return draft;
  if (schedule.kind === 'once') {
    if (schedule.runAt !== null) {
      draft.mode = 'once';
      draft.onceLocal = toLocalInput(schedule.runAt);
    }
    return draft;
  }
  draft.mode = 'repeat';
  const cron = schedule.cron ?? '';
  const preset = schedule.timezone === localZone ? cronToPreset(cron) : null;
  if (preset !== null) draft.preset = preset;
  else draft.customCron = cron.trim() === '' ? null : cron.trim();
  return draft;
}

/**
 * 草稿 → `when` 入参：`'now'` / ISO 8601（UTC）/ cron / `null`（不定）。
 * 草稿还没填完整（某时没选日期、预设不合法）返回 `undefined`，由调用方拦住保存。
 */
export function whenFromDraft(draft: WhenDraft): string | null | undefined {
  switch (draft.mode) {
    case 'none':
      return null;
    case 'now':
      return 'now';
    case 'once': {
      const at = fromLocalInput(draft.onceLocal);
      return at === null ? undefined : new Date(at).toISOString();
    }
    case 'repeat':
      if (draft.customCron !== null) return draft.customCron;
      return presetToCron(draft.preset) ?? undefined;
  }
}

/** 两份草稿提交出去的 `when` 是否相同（用于「没改时间就不重发 when」）。 */
export function sameWhen(a: WhenDraft, b: WhenDraft): boolean {
  return whenFromDraft(a) === whenFromDraft(b);
}

/**
 * 预设的下一次触发时刻（本机时区，严格晚于 `now`），供抽屉实时显示「下次：…」；
 * 预设不合法返回 null。每月 29–31 号遇到没有该日的月份会跳过（与 cron 语义一致）。
 */
export function nextFireOfPreset(preset: RepeatPreset, now: number): number | null {
  if (!isPresetValid(preset)) return null;
  const [hour, minute] = parseTime(preset.time) as [number, number];
  const days = preset.kind === 'weekly' ? normalizeDays(preset.days) : [];
  const start = new Date(now);
  // 向后逐日扫描；每月最多相隔 ~2 个月（31 号），366 天内必有结果。
  for (let offset = 0; offset <= 400; offset += 1) {
    const candidate = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      hour,
      minute,
      0,
      0,
    );
    if (candidate.getTime() <= now) continue;
    const weekday = candidate.getDay();
    switch (preset.kind) {
      case 'daily':
        return candidate.getTime();
      case 'weekdays':
        if (weekday >= 1 && weekday <= 5) return candidate.getTime();
        break;
      case 'weekly':
        if (days.includes(weekday)) return candidate.getTime();
        break;
      case 'monthly':
        if (candidate.getDate() === preset.day) return candidate.getTime();
        break;
    }
  }
  return null;
}

/** 「某时」是否已过（草稿填完整但不晚于 `now`）；没填完整不算。 */
export function isPastOnce(draft: WhenDraft, now: number): boolean {
  if (draft.mode !== 'once') return false;
  const at = fromLocalInput(draft.onceLocal);
  return at !== null && at <= now;
}

/** 每月 29–31 号：没有该日的月份不会执行（界面据此给一行提示）。 */
export function skipsShortMonths(draft: WhenDraft): boolean {
  return (
    draft.mode === 'repeat' &&
    draft.customCron === null &&
    draft.preset.kind === 'monthly' &&
    draft.preset.day >= 29
  );
}
