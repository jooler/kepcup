import { describe, expect, it } from 'vitest';

import {
  WIDGET_CHECK_RULES,
  ruleIssue,
  sandboxPitfallsPrompt,
  widgetCheckRule,
} from '../../src/widgets/check/index.js';

/** D87 P3a 规则注册表：覆盖设计 32 §11.8 的规则、级别与阻断口径、提示词不漂移。 */

describe('widget check rule registry', () => {
  it('registers every rule in design §11.8.1 / §11.8.2 plus the P3a/P3b extras, once', () => {
    const ids = WIDGET_CHECK_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'html.missing',
        'html.truncated',
        'html.size',
        'html.doctype',
        'sandbox.external-resource',
        'sandbox.storage',
        'sandbox.network',
        'sandbox.modals',
        'sandbox.alert',
        'sandbox.form-submit',
        'sandbox.submit-button',
        'sandbox.popup',
        'sandbox.top-nav',
        'sandbox.link-navigation',
        'sandbox.download',
        'sandbox.clipboard',
        'theme.media-query',
        'query.invalid',
        'query.unknown-name',
        'acceptance.invalid',
        'fixtures.invalid',
        'js.syntax',
        'js.handler-syntax',
        'js.handler-undefined',
        'js.undefined-name',
        'js.redeclare',
        'dom.id-missing',
        'dom.duplicate-id',
        'kepcup.not-awaited',
        'runtime.error',
        'runtime.rejection',
        'console.error',
        'console.warn',
        'csp.violation',
        'render.blank',
        'render.overflow-x',
        'render.bad-text',
        'preview.timeout',
      ]),
    );
  });

  it('levels follow the spike-revised design (alert / submit-button are warnings)', () => {
    const level = (id: string): string => widgetCheckRule(id).level;
    expect(level('sandbox.alert')).toBe('warning');
    expect(level('sandbox.submit-button')).toBe('warning');
    expect(level('sandbox.modals')).toBe('error');
    expect(level('sandbox.form-submit')).toBe('error');
    expect(level('sandbox.link-navigation')).toBe('warning');
    expect(level('acceptance.invalid')).toBe('warning');
  });

  it('every S0/S1 error is blocking; S2 blocking set matches §11.6', () => {
    for (const rule of WIDGET_CHECK_RULES) {
      if (rule.stage !== 'S2') expect(rule.blocking, rule.id).toBe(rule.level === 'error');
      if (rule.level === 'warning') expect(rule.blocking, rule.id).toBe(false);
    }
    const s2Blocking = WIDGET_CHECK_RULES.filter((rule) => rule.stage === 'S2' && rule.blocking)
      .map((rule) => rule.id)
      .sort();
    expect(s2Blocking).toEqual([
      'preview.timeout',
      'render.blank',
      'runtime.error',
      'runtime.rejection',
    ]);
    expect(widgetCheckRule('console.error')).toMatchObject({ level: 'error', blocking: false });
    expect(widgetCheckRule('csp.violation')).toMatchObject({ level: 'error', blocking: false });
  });

  it('every rule has a Chinese title and hint; widgetCheckRule throws on unknown ids', () => {
    for (const rule of WIDGET_CHECK_RULES) {
      expect(rule.title, rule.id).toMatch(/[一-鿿]/);
      expect(rule.hint, rule.id).toMatch(/[一-鿿]/);
    }
    expect(() => widgetCheckRule('no.such-rule')).toThrow(/unknown/);
  });

  it('sandbox hints point at the kepcup.* replacements', () => {
    expect(widgetCheckRule('sandbox.storage').hint).toContain('kepcup.storage');
    expect(widgetCheckRule('sandbox.popup').hint).toContain('kepcup.openLink');
    expect(widgetCheckRule('sandbox.network').hint).toContain('kepcup.query');
  });

  it('ruleIssue: downgraded level is never blocking; messages are clipped', () => {
    const warn = ruleIssue('js.undefined-name', {
      message: 'x',
      level: 'warning',
      line: 1,
      col: 2,
    });
    expect(warn).toMatchObject({
      level: 'warning',
      blocking: false,
      stage: 'S1',
      file: 'index.html',
    });
    const long = ruleIssue('query.invalid', { message: 'y'.repeat(1000), file: 'queries.json' });
    expect(long.blocking).toBe(true);
    expect(long.message.length).toBeLessThanOrEqual(300);
  });

  it('sandboxPitfallsPrompt mentions every rule id (prompt and checker cannot drift)', () => {
    const prompt = sandboxPitfallsPrompt();
    for (const rule of WIDGET_CHECK_RULES) expect(prompt, rule.id).toContain(`[${rule.id}]`);
    expect(prompt).toContain('沙箱雷区清单');
    expect(prompt).toContain('阻断');
  });
});
