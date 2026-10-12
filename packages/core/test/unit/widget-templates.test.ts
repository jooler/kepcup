import { describe, expect, it } from 'vitest';

import { jsCheck, staticCheck } from '../../src/widgets/check/index.js';
import { WidgetQueryGate } from '../../src/widgets/query-gate.js';
import { cleanWidgetQueries } from '../../src/widgets/query-validate.js';
import { injectWidgetSdk, wantsKepcupKit } from '../../src/widgets/sdk-injection.js';
import { WIDGET_TEMPLATES } from '../../src/widgets/templates/index.js';

/**
 * 骨架模板（D87 P3b，设计 32 §11.13）：每个模板本身必须过 S0 / S1 全部规则（零错误、零警告），
 * 都启用 kit，配套的查询示例能过交付侧校验。S2 由桌面预览宿主的真实 Electron 用例覆盖。
 */

describe('widget templates', () => {
  it('四个模板齐全', () => {
    expect(WIDGET_TEMPLATES.map((t) => t.name)).toEqual([
      'blank',
      'form-calculator',
      'list-tracker',
      'dashboard',
    ]);
  });

  for (const template of WIDGET_TEMPLATES) {
    it(`${template.name}：S0 / S1 零问题、启用 kit`, () => {
      const queryNames = (template.queries ?? []).map((q) => q.name);
      const issues = [
        ...staticCheck({ html: template.html, queryNames }),
        ...jsCheck({ html: template.html }),
      ];
      expect(issues).toEqual([]);
      expect(wantsKepcupKit(template.html)).toBe(true);
      expect(injectWidgetSdk(template.html)).toContain('kepcup.ui');
    });
  }

  it('dashboard 的查询示例能过交付侧校验', () => {
    const gate = new WidgetQueryGate();
    try {
      const dashboard = WIDGET_TEMPLATES.find((t) => t.name === 'dashboard')!;
      expect(cleanWidgetQueries([...(dashboard.queries ?? [])], gate)).toHaveLength(1);
    } finally {
      gate.dispose();
    }
  });
});
