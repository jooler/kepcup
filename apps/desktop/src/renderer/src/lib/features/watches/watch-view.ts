import type { WatchCondition, WatchEntry } from '@kepcup/shared';

/**
 * 监看卡 / 监看列表的纯展示逻辑（W7）：条件文案键、间隔分钟、可执行的动作。
 * 返回 i18n 键与参数，由组件 `t` 翻译，便于单测。
 */

export type ConditionLabelKey =
  | 'watches.condition.changed'
  | 'watches.condition.contains'
  | 'watches.condition.not_contains'
  | 'watches.condition.number_below'
  | 'watches.condition.number_above';

/** The i18n key + parameters describing a condition (`t(label.key, label.params)`). */
export function conditionLabel(condition: WatchCondition): {
  key: ConditionLabelKey;
  params: Record<string, string | number>;
} {
  switch (condition.kind) {
    case 'contains':
    case 'not_contains':
      return { key: `watches.condition.${condition.kind}`, params: { text: condition.text } };
    case 'number_below':
    case 'number_above':
      return { key: `watches.condition.${condition.kind}`, params: { value: condition.value } };
    default:
      return { key: 'watches.condition.changed', params: {} };
  }
}

export function intervalMinutes(watch: Pick<WatchEntry, 'intervalSec'>): number {
  return Math.round(watch.intervalSec / 60);
}

/** Which buttons a watch offers: 暂停 (active), 恢复 (paused), 停止 (not stopped). */
export function watchActions(watch: Pick<WatchEntry, 'status'>): {
  pause: boolean;
  resume: boolean;
  stop: boolean;
} {
  return {
    pause: watch.status === 'active',
    resume: watch.status === 'paused',
    stop: watch.status !== 'stopped',
  };
}
