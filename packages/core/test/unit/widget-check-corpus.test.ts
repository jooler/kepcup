import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { jsCheck, staticCheck } from '../../src/widgets/check/index.js';

/**
 * 检查器召回率的回归锁（执行文档 §5.1）：`bad/` 是典型的 LLM 坏组件（CDN 图表库、localStorage、
 * confirm 删除、表单提交、onclick 指向闭包函数、截断输出、fetch、window.open、prompt、module +
 * 内联 onclick、跨脚本重复 let、id 拼错、top.location、Google Fonts…），每份都必须被至少一条阻断项
 * 拦下；`good/` 是写对了的组件，不能有任何 error。草稿里没有 queries.json（声明的查询为空）。
 */

const ROOT = path.join(__dirname, '../fixtures/widgets');

function corpus(dir: 'good' | 'bad'): Array<[string, string]> {
  return readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith('.html'))
    .sort()
    .map((file) => [file, readFileSync(path.join(ROOT, dir, file), 'utf8')]);
}

function checkAll(html: string) {
  return [...staticCheck({ html, queryNames: [] }), ...jsCheck({ html })];
}

describe('widget checker corpus', () => {
  const bad = corpus('bad');
  const good = corpus('good');

  it('has a 12–20 file bad corpus and a good corpus', () => {
    expect(bad.length).toBeGreaterThanOrEqual(12);
    expect(bad.length).toBeLessThanOrEqual(20);
    expect(good.length).toBeGreaterThan(0);
  });

  it.each(bad)('bad/%s is blocked', (_file, html) => {
    const blocking = checkAll(html).filter((issue) => issue.blocking);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
  });

  it.each(good)('good/%s has no errors', (_file, html) => {
    const errors = checkAll(html).filter((issue) => issue.level === 'error');
    expect(errors).toEqual([]);
  });

  it('the realistic expense splitter is completely clean', () => {
    const html = good.find(([file]) => file === 'expense-splitter.html')?.[1] ?? '';
    expect(checkAll(html)).toEqual([]);
  });

  it('each bad fixture is caught by the rule it is about', () => {
    const expected: Record<string, string> = {
      'cdn-chart.html': 'sandbox.external-resource',
      'closure-onclick.html': 'js.handler-undefined',
      'confirm-delete.html': 'sandbox.modals',
      'css-background-url.html': 'sandbox.external-resource',
      'duplicate-let.html': 'js.redeclare',
      'fetch-api.html': 'sandbox.network',
      'form-onsubmit.html': 'sandbox.form-submit',
      'getelementbyid-typo.html': 'dom.id-missing',
      'google-fonts.html': 'sandbox.external-resource',
      'localstorage-todo.html': 'sandbox.storage',
      'markup-onclick-closure.html': 'js.handler-undefined',
      'module-inline-onclick.html': 'js.handler-undefined',
      'prompt-name.html': 'sandbox.modals',
      'query-undeclared.html': 'query.unknown-name',
      'submit-listener.html': 'sandbox.form-submit',
      'target-blank.html': 'sandbox.popup',
      'top-level-await.html': 'js.syntax',
      'top-location.html': 'sandbox.top-nav',
      'truncated-output.html': 'html.truncated',
      'window-open.html': 'sandbox.popup',
    };
    for (const [file, html] of bad) {
      expect(Object.keys(expected), `add ${file} to the expectation table`).toContain(file);
      const rules = checkAll(html).map((issue) => issue.rule);
      expect(rules, file).toContain(expected[file]);
    }
  });
});
