import { describe, expect, it } from 'vitest';

import {
  WIDGET_CHECK_REPORT_MAX_CHARS,
  WIDGET_KNOWN_ISSUES_MAX,
  type WidgetCheckIssue,
  type WidgetCheckReport,
} from '@kepcup/shared';
import {
  buildCheckReport,
  formatCheckReport,
  issueSignature,
  knownIssuesForUser,
  ruleIssue,
} from '../../src/widgets/check/index.js';

/** D87 P3a 检查报告：去重、排序、计分、判定、文本截断、卡片已知问题。 */

const STAGES: WidgetCheckReport['stages'] = {
  S0: { status: 'ran', reason: '' },
  S1: { status: 'ran', reason: '' },
  S2: { status: 'skipped', reason: '预览宿主不可用（未经运行验证）' },
};

function report(
  issues: WidgetCheckIssue[],
  acceptance: WidgetCheckReport['acceptance'] = [],
): WidgetCheckReport {
  return buildCheckReport({
    issues,
    acceptance,
    stages: STAGES,
    htmlSha256: 'h',
    queriesSha256: '',
    now: 42,
  });
}

const storage = ruleIssue('sandbox.storage', { message: '使用了 localStorage', line: 9, col: 3 });
const alertWarn = ruleIssue('sandbox.alert', { message: '调用了 alert()', line: 2, col: 1 });
const consoleErr = ruleIssue('console.error', {
  message: 'boom',
  viewport: '360/light',
  trigger: 'button#add「添加」',
});
const queryBad = ruleIssue('query.invalid', { message: '查询「a」语法错误', file: 'queries.json' });
const syntax = ruleIssue('js.syntax', { message: '解析失败', line: 3, col: 7 });

describe('buildCheckReport', () => {
  it('dedupes identical issues and sorts blocking → error → warning, then file, line, col', () => {
    const r = report([alertWarn, consoleErr, queryBad, storage, syntax, { ...storage }]);
    expect(r.issues.map((issue) => issue.rule)).toEqual([
      'js.syntax',
      'sandbox.storage',
      'query.invalid',
      'console.error',
      'sandbox.alert',
    ]);
    expect(r).toMatchObject({
      blockers: 3,
      errors: 1,
      warnings: 1,
      createdAt: 42,
      htmlSha256: 'h',
    });
  });

  it('scores per design §11.6 (+ failed acceptance) and decides the verdict', () => {
    const r = report(
      [storage, consoleErr, alertWarn],
      [
        { id: 'add', must: true, passed: false, detail: '合计没变', viewport: '360/light' },
        { id: 'add', must: true, passed: false, detail: '合计没变', viewport: '720/dark' },
        { id: 'sort', must: false, passed: false, detail: '' },
        { id: 'ok', must: true, passed: true, detail: '' },
      ],
    );
    expect(r.score).toBe(100 + 10 + 1 + 50 + 5);
    expect(r.verdict).toBe('blocked');
  });

  it('verdicts: pass / issues / blocked by failed must acceptance alone', () => {
    expect(report([]).verdict).toBe('pass');
    expect(report([]).score).toBe(0);
    expect(report([alertWarn]).verdict).toBe('issues');
    expect(report([consoleErr]).verdict).toBe('issues');
    expect(report([], [{ id: 'x', must: false, passed: false, detail: '' }]).verdict).toBe(
      'issues',
    );
    expect(report([], [{ id: 'x', must: true, passed: false, detail: '' }]).verdict).toBe(
      'blocked',
    );
  });
});

describe('formatCheckReport', () => {
  it('header, grouped lines with rule / position / hint, skipped S2 line', () => {
    const text = formatCheckReport(report([storage, alertWarn, consoleErr, queryBad]));
    const lines = text.split('\n');
    expect(lines[0]).toContain('不合格');
    expect(lines[0]).toContain('阻断 2');
    expect(lines[0]).toContain('错误 1');
    expect(lines[0]).toContain('警告 1');
    expect(text).toContain('S2 运行预览：已跳过（预览宿主不可用（未经运行验证））');
    expect(text).toContain('[sandbox.storage] 第 9 行:3 列 — 使用了 localStorage — ');
    expect(text).toContain('kepcup.storage');
    expect(text).toContain('[query.invalid] queries.json — 查询「a」语法错误');
    expect(text).toContain('（视口 360/light，触发：button#add「添加」）');
    expect(text.indexOf('[sandbox.storage]')).toBeLessThan(text.indexOf('[console.error]'));
    expect(text.indexOf('[console.error]')).toBeLessThan(text.indexOf('[sandbox.alert]'));
  });

  it('repeats of a rule say "改法同上" instead of repeating the hint', () => {
    const second = ruleIssue('sandbox.storage', {
      message: '又用了 localStorage',
      line: 20,
      col: 1,
    });
    const text = formatCheckReport(report([storage, second]));
    expect(text).toContain('又用了 localStorage — 改法同上');
  });

  it('lists failed acceptance points', () => {
    const text = formatCheckReport(
      report(
        [],
        [
          {
            id: 'add-expense',
            must: true,
            passed: false,
            detail: '#total 文本是 0',
            viewport: '360/light',
          },
        ],
      ),
    );
    expect(text).toContain('[must] add-expense（视口 360/light） — #total 文本是 0');
    expect(text).toContain('验收未过 1（must 1）');
  });

  it('never exceeds maxChars, never cuts mid-line, and says how many were left out', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      ruleIssue('sandbox.storage', { message: `第 ${i} 处 localStorage`, line: i + 1, col: 1 }),
    );
    const r = report(many);
    const full = formatCheckReport(r, 1_000_000);
    const fullLines = new Set(full.split('\n'));
    for (const max of [200, 500, 1000, WIDGET_CHECK_REPORT_MAX_CHARS]) {
      const text = formatCheckReport(r, max);
      expect(text.length).toBeLessThanOrEqual(max);
      const lines = text.split('\n');
      const tail = lines[lines.length - 1] ?? '';
      expect(tail).toMatch(/^…另有 \d+ 条未列出$/);
      for (const line of lines.slice(0, -1)) expect(fullLines.has(line)).toBe(true);
      const listed = lines.filter((line) => line.startsWith('[sandbox.storage]')).length;
      expect(Number(/另有 (\d+) 条/.exec(tail)?.[1])).toBe(200 - listed);
    }
    expect(formatCheckReport(r).length).toBeLessThanOrEqual(WIDGET_CHECK_REPORT_MAX_CHARS);
  });

  it('a clean report says so', () => {
    const clean = buildCheckReport({
      issues: [],
      stages: { ...STAGES, S2: { status: 'ran', reason: '' } },
      htmlSha256: 'h',
      queriesSha256: '',
      now: 1,
    });
    expect(formatCheckReport(clean)).toContain('没有发现问题');
  });
});

describe('issueSignature / knownIssuesForUser', () => {
  it('signature = rule + file + line:col', () => {
    expect(issueSignature(storage)).toBe('sandbox.storage@index.html:9:3');
    expect(issueSignature(queryBad)).toBe('query.invalid@queries.json::');
  });

  it('user-facing lines: deduped, most severe first, capped, process-only rules omitted', () => {
    const acceptanceWarn = ruleIssue('acceptance.invalid', {
      message: 'x',
      file: 'acceptance.json',
    });
    const r = report(
      [alertWarn, storage, { ...storage, line: 30 }, consoleErr, acceptanceWarn],
      [
        { id: 'add', must: true, passed: false, detail: '' },
        { id: 'sort', must: false, passed: false, detail: '' },
      ],
    );
    const lines = knownIssuesForUser(r, WIDGET_KNOWN_ISSUES_MAX, [
      {
        id: 'add',
        desc: '添加一笔费用后合计更新',
        must: true,
        steps: [],
        expect: [{ noErrors: true }],
      },
    ]);
    expect(lines).toEqual([
      '数据保存功能无法使用',
      '未通过验收：添加一笔费用后合计更新',
      '运行中有错误输出',
      '未通过验收：sort',
      '部分提示信息不会显示',
    ]);
    expect(knownIssuesForUser(r, 2)).toHaveLength(2);
    expect(knownIssuesForUser(report([]))).toEqual([]);
  });
});
