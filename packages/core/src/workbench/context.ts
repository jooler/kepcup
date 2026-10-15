import type { Memo, TodoEntry } from '@kepcup/shared';
import { untrustedBlock } from '../infra/data-boundary.js';

/**
 * 管家的 `<workbench>` 上下文段与工作台时间的人话写法（D90 §6.3，docs/design/39-workbench.md）。
 * 纯函数：只放计数和要紧条目，不放全文；用户写的标题 / 备忘内容一律放进 `<untrusted>` 边界。
 */

/** 进行中的事项派发超过这么久仍没交付，算「逾期未交付」。 */
export const WORKBENCH_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** 待验收条目最多列几条。 */
export const WORKBENCH_DELIVERED_SHOWN_MAX = 3;
/** 备忘预览的字数（按字符，不是字节）。 */
export const WORKBENCH_MEMO_PREVIEW_CHARS = 40;
/** 事项标题在上下文里最多保留的字数（标题本身上限 120，段里不需要全文）。 */
const TITLE_SHOWN_CHARS = 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function dateKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function clockText(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/** 「今天 10:12」「昨天 18:00」「10-12 09:30」「2025-10-12 09:30」（用户时区）。 */
export function describeTime(ms: number, now: number, timeZone: string): string {
  const day = dateKey(ms, timeZone);
  const clock = clockText(ms, timeZone);
  if (day === dateKey(now, timeZone)) return `今天 ${clock}`;
  if (day === dateKey(now - DAY_MS, timeZone)) return `昨天 ${clock}`;
  if (day === dateKey(now + DAY_MS, timeZone)) return `明天 ${clock}`;
  return day.slice(0, 4) === dateKey(now, timeZone).slice(0, 4)
    ? `${day.slice(5)} ${clock}`
    : `${day} ${clock}`;
}

/** 「刚刚」「3 小时前」「3 天前」。 */
export function describeAgo(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  if (delta < HOUR_MS) return delta < 60_000 ? '刚刚' : `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} 小时前`;
  return `${Math.floor(delta / DAY_MS)} 天前`;
}

/** 单行预览：折叠空白，超过 `max` 个字符加省略号。 */
export function previewText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

export interface WorkbenchSectionInput {
  /** 未关闭的事项（草案 / 已排期 / 进行中 / 待验收）。 */
  todos: readonly TodoEntry[];
  /** 未删除的备忘。 */
  memos: readonly Memo[];
  now: number;
  timeZone: string;
}

/**
 * `<workbench>` 段正文；没有任何未关闭事项和备忘时返回 ''（段被省略）。
 * 标题和备忘内容是用户写的（可能来自网页摘录）：只出现在 `<untrusted>` 里。
 */
export function buildWorkbenchSection(input: WorkbenchSectionInput): string {
  const { todos, memos, now, timeZone } = input;
  const open = todos.filter((todo) => todo.status !== 'done' && todo.status !== 'cancelled');
  if (open.length === 0 && memos.length === 0) return '';

  const drafts = open.filter((todo) => todo.status === 'draft');
  const delivered = open.filter((todo) => todo.status === 'delivered');
  const inProgress = open.filter((todo) => todo.status === 'in_progress');
  const scheduled = open.filter((todo) => todo.status === 'scheduled');
  const today = dateKey(now, timeZone);
  const scheduledToday = scheduled.filter(
    (todo) =>
      todo.schedule?.nextFireAt != null && dateKey(todo.schedule.nextFireAt, timeZone) === today,
  );
  // 进行中太久没交付，或排期已过点却还没发出（等待补发）。
  const overdue =
    inProgress.filter(
      (todo) => todo.lastRun !== null && now - todo.lastRun.dispatchedAt > WORKBENCH_OVERDUE_MS,
    ).length +
    scheduled.filter((todo) => todo.schedule?.nextFireAt != null && todo.schedule.nextFireAt < now)
      .length;

  const counts: string[] = [];
  if (drafts.length > 0) {
    const earliest = Math.min(...drafts.map((todo) => todo.createdAt));
    counts.push(`草案 ${drafts.length} 条（最早 ${describeAgo(earliest, now)}）`);
  } else {
    counts.push('草案 0 条');
  }
  counts.push(`待验收 ${delivered.length} 条`);
  const countLines = [
    counts.join('；'),
    `进行中 ${inProgress.length} 条；今天排期 ${scheduledToday.length} 条；逾期未交付 ${overdue} 条`,
    `备忘 ${memos.length} 条`,
  ];

  // 用户写的内容：放进一个 <untrusted> 块。
  const data: string[] = [];
  if (delivered.length > 0) {
    const shown = [...delivered]
      .sort((a, b) => (b.lastRun?.settledAt ?? b.updatedAt) - (a.lastRun?.settledAt ?? a.updatedAt))
      .slice(0, WORKBENCH_DELIVERED_SHOWN_MAX);
    data.push('待验收：');
    for (const todo of shown) {
      const at = todo.lastRun?.settledAt ?? todo.updatedAt;
      const who = todo.assigneeName ?? '（无执行者）';
      data.push(
        `- [${todo.id}] 「${previewText(todo.title, TITLE_SHOWN_CHARS)}」· ${previewText(who, 20)} · ${describeTime(at, now, timeZone)} 交付`,
      );
    }
    if (delivered.length > shown.length)
      data.push(`（另有 ${delivered.length - shown.length} 条待验收）`);
  }
  if (memos.length > 0) {
    const latest = memos.reduce((best, memo) => (memo.updatedAt > best.updatedAt ? memo : best));
    data.push(
      `最近备忘（${describeTime(latest.updatedAt, now, timeZone)}）：${previewText(latest.body, WORKBENCH_MEMO_PREVIEW_CHARS)}`,
    );
  }

  return [
    ...countLines,
    ...(data.length > 0 ? [untrustedBlock(data.join('\n'))] : []),
    '需要细节用 list_todos / list_memos。',
  ].join('\n');
}
