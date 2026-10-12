import { describe, expect, test } from 'vitest';

import { zhCN } from '../../i18n/locales/zh-CN';
import { checkBadge } from './check-status';

/** 自检徽标（D87 P3c）：legacy 不显示；其余三态各有文案（存在于词条表）与配色。 */
describe('checkBadge', () => {
  test('legacy cards show no badge', () => {
    expect(checkBadge('legacy')).toBeNull();
  });

  test('passed / issues / unverified map to existing labels', () => {
    for (const status of ['passed', 'issues', 'unverified'] as const) {
      const badge = checkBadge(status);
      expect(badge).not.toBeNull();
      expect(zhCN[badge!.label]).toBeTruthy();
    }
    expect(zhCN[checkBadge('passed')!.label]).toBe('已通过自检');
    expect(zhCN['botWidget.check.note']).toContain('不代表安全');
  });
});
