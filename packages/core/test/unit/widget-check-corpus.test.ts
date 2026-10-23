import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { jsCheck, staticCheck } from '../../src/widgets/check/index.js';

/**
 * 检查器召回率的回归锁（执行文档 §5.1；完整 WebApp 档修订）。`bad/` 是典型的 LLM 坏组件
 * （相对路径资源、onclick 指向闭包函数、截断输出、window.open、module + 内联 onclick、
 * 跨脚本重复 let、id 拼错、top.location…），每份都必须被至少一条阻断项拦下；`good/` 是
 * 写对了的组件，不能有任何 error——其中联网 / 浏览器存储 / confirm / 表单 preventDefault /
 * CDN 外链（fetch、localStorage、Google Fonts、CDN 图表库…）在完整 WebApp 档下都是合法用法。
 * 草稿里没有 queries.json（声明的查询为空）。
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
      'closure-onclick.html': 'js.handler-undefined',
      'duplicate-let.html': 'js.redeclare',
      'getelementbyid-typo.html': 'dom.id-missing',
      'markup-onclick-closure.html': 'js.handler-undefined',
      'module-inline-onclick.html': 'js.handler-undefined',
      'query-undeclared.html': 'query.unknown-name',
      'relative-assets.html': 'sandbox.external-resource',
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
