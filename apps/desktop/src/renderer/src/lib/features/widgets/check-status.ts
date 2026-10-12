import type { WidgetCheckStatus } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * 组件版本的自检状态（D87 P3c，设计 32 §11.12）→ 徽标文案与配色。`legacy`（D87 之前的存量
 * 版本）不显示徽标。自检只说明它能运行、不代表安全——卡片徽标下固定配一行说明，按版本人工
 * 确认照旧。
 */
export interface CheckBadge {
  label: MessageKey;
  /** Tailwind 配色（亮 / 暗）。 */
  tone: string;
}

const BADGES: Readonly<Record<Exclude<WidgetCheckStatus, 'legacy'>, CheckBadge>> = {
  passed: {
    label: 'botWidget.check.passed',
    tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  issues: {
    label: 'botWidget.check.issues',
    tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  unverified: {
    label: 'botWidget.check.unverified',
    tone: 'bg-muted text-muted-foreground',
  },
};

export function checkBadge(status: WidgetCheckStatus): CheckBadge | null {
  return status === 'legacy' ? null : BADGES[status];
}
