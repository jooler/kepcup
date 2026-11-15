import type {
  PluginRuntimeCallRecord,
  PluginRuntimePluginState,
  PluginRuntimeStatus,
} from '@kepcup/shared';
import { errorText, type MessageKey } from '$lib/i18n';

/**
 * 插件运行时状态的展示逻辑（D125 P3，61 §6）：状态徽标 + 活动抽屉的纯函数，
 * 组件只做渲染（renderer 测试没有 DOM，展示口径在这里单测）。
 */

/** 徽标视觉口径：点 / 文字的 tailwind 类与是否脉冲。 */
export interface RuntimeBadgeView {
  status: PluginRuntimeStatus;
  labelKey: MessageKey;
  dotClass: string;
  textClass: string;
  pulse: boolean;
  /** hover 提示：error 用最近错误，其余用状态说明；无 = 空串。 */
  tooltip: string;
}

const STATUS_KEYS: Record<PluginRuntimeStatus, MessageKey> = {
  stopped: 'plugins.runtime.status.stopped',
  starting: 'plugins.runtime.status.starting',
  ready: 'plugins.runtime.status.ready',
  busy: 'plugins.runtime.status.busy',
  error: 'plugins.runtime.status.error',
};

const STATUS_CLASSES: Record<PluginRuntimeStatus, { dot: string; text: string; pulse: boolean }> = {
  stopped: { dot: 'bg-muted-foreground/60', text: 'text-muted-foreground', pulse: false },
  starting: { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400', pulse: true },
  ready: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', pulse: false },
  busy: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', pulse: false },
  error: { dot: 'bg-destructive', text: 'text-destructive', pulse: false },
};

/**
 * 状态 → 徽标视图。`null`（非执行型插件 / 运行时快照未到）返回 null——调用方
 * 不渲染任何东西，数据型插件卡与今日逐字节一致。
 */
export function runtimeBadge(state: PluginRuntimePluginState | null): RuntimeBadgeView | null {
  if (state === null) return null;
  const classes = STATUS_CLASSES[state.status];
  const tooltip =
    state.status === 'error' ? (state.lastError ?? state.detail ?? '') : (state.detail ?? '');
  return {
    status: state.status,
    labelKey: STATUS_KEYS[state.status],
    dotClass: classes.dot,
    textClass: classes.text,
    pulse: classes.pulse,
    tooltip,
  };
}

/** 一次调用的结果三态：成功 / 失败 / 已取消（取消不是厂商错误，单列）。 */
export type CallOutcome = 'ok' | 'failed' | 'cancelled';

export interface ActivityRowView {
  /** 行 key（列表按 index 使用；记录本身没有 id）。 */
  key: string;
  at: number;
  /** 本地时间 HH:mm:ss。 */
  time: string;
  /** 契约.方法。 */
  call: string;
  duration: string;
  outcome: CallOutcome;
  outcomeKey: MessageKey;
  /** 错误列人话（成功 / 取消为空）。 */
  error: string;
  /** 插件 error.message 的次级说明（截断 200 字；与人话相同则为空）。 */
  detail: string;
  /** hover 提示（完整消息，未截断）。 */
  tooltip: string;
}

const OUTCOME_KEYS: Record<CallOutcome, MessageKey> = {
  ok: 'plugins.runtime.result.ok',
  failed: 'plugins.runtime.result.failed',
  cancelled: 'plugins.runtime.result.cancelled',
};

/** 取消记录的 errorCode（core PluginHost 在 AbortSignal 取消时写入）。 */
export const RUNTIME_CANCELLED_CODE = 'CANCELLED';

/** 插件 error.message 作为次级说明时的截断长度（61 §6 人话呈现）。 */
export const RUNTIME_MESSAGE_MAX_CHARS = 200;

/** 活动抽屉的表格行（最新在前，顺序 = core 环形历史）。 */
export function activityRows(
  state: PluginRuntimePluginState | null,
  locale: string,
): ActivityRowView[] {
  if (state === null) return [];
  return state.recent.map((record, index) => callRow(record, index, locale));
}

function callRow(record: PluginRuntimeCallRecord, index: number, locale: string): ActivityRowView {
  const outcome: CallOutcome = record.ok
    ? 'ok'
    : record.errorCode === RUNTIME_CANCELLED_CODE
      ? 'cancelled'
      : 'failed';
  const raw = record.message ?? '';
  // 错误人话：既有 errorText 表（PROVIDER_* 与 PLUGIN_* 四码），认不出回原始消息。
  const human = outcome === 'failed' ? errorText(record.errorCode ?? undefined, raw).trim() : '';
  const detail =
    outcome === 'failed' && raw.length > 0 && raw !== human
      ? truncateMessage(raw, RUNTIME_MESSAGE_MAX_CHARS)
      : '';
  return {
    key: `${record.at}-${index}`,
    at: record.at,
    time: formatClock(record.at, locale),
    call: `${record.contract}.${record.method}`,
    duration: formatDuration(record.durationMs),
    outcome,
    outcomeKey: OUTCOME_KEYS[outcome],
    error: human,
    detail,
    tooltip: raw,
  };
}

/** HH:mm:ss（本地时区；locale 只影响 12/24 小时制）。 */
export function formatClock(at: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleTimeString();
  }
}

/** 时长：<1s 毫秒，<1min 秒（一位小数），其余「分 秒」。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/** 插件消息截断（次级说明；完整文本留给 tooltip）。 */
export function truncateMessage(text: string, max: number = RUNTIME_MESSAGE_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 空态判定：执行型插件但尚无调用（抽屉显示「尚未被调用」）。 */
export function activityEmpty(state: PluginRuntimePluginState | null): boolean {
  return state !== null && state.recent.length === 0;
}
