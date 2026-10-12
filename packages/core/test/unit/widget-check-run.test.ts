import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { WidgetQueryDef } from '@kepcup/shared';
import {
  WIDGET_PREVIEW_UNAVAILABLE_REASON,
  runWidgetCheck,
  type WidgetPreviewRunner,
} from '../../src/widgets/check/index.js';
import { queriesSha256Of } from '../../src/widgets/service.js';

/** D87 P3a `runWidgetCheck`：草稿目录 → 报告（坏草稿不抛错、摘要与交付侧一致、S2 跳过原因）。 */

const GOOD_HTML =
  '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n<p id="n"></p>\n' +
  "<script>(async () => { const rows = await kepcup.query('count'); document.getElementById('n').textContent = rows.length; })();</script>\n" +
  '</body>\n</html>\n';

const dirs: string[] = [];
function draft(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'widget-draft-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const allowAll = (): string | null => null;

describe('runWidgetCheck', () => {
  it('missing or blank index.html → html.missing (blocking), S1 skipped, never throws', async () => {
    for (const files of [{}, { 'index.html': '  \n' }]) {
      const report = await runWidgetCheck({
        draftDir: draft(files),
        validateQueries: allowAll,
        now: 7,
      });
      expect(report.issues.map((issue) => issue.rule)).toEqual(['html.missing']);
      expect(report.verdict).toBe('blocked');
      expect(report.stages.S1.status).toBe('skipped');
      expect(report.createdAt).toBe(7);
    }
  });

  it('S2 is skipped with the documented reason when no preview runner is bound', async () => {
    const dir = draft({
      'index.html': GOOD_HTML,
      'queries.json': '[{"name":"count","sql":"select 1"}]',
    });
    const report = await runWidgetCheck({
      draftDir: dir,
      validateQueries: allowAll,
      preview: null,
      now: 1,
    });
    expect(report.stages).toEqual({
      S0: { status: 'ran', reason: '' },
      S1: { status: 'ran', reason: '' },
      S2: { status: 'skipped', reason: WIDGET_PREVIEW_UNAVAILABLE_REASON },
    });
    expect(report.verdict).toBe('pass');
  });

  it('sha256s match the delivery side (exact HTML text, canonical {name, sql} defs)', async () => {
    const defs = [{ name: 'count', sql: 'select 1', extra: 'dropped' }];
    const dir = draft({ 'index.html': GOOD_HTML, 'queries.json': JSON.stringify(defs) });
    const report = await runWidgetCheck({ draftDir: dir, validateQueries: allowAll, now: 1 });
    expect(report.htmlSha256).toBe(createHash('sha256').update(GOOD_HTML).digest('hex'));
    expect(report.queriesSha256).toBe(queriesSha256Of([{ name: 'count', sql: 'select 1' }]));
    expect(report.queriesSha256).not.toBe('');

    const noQueries = await runWidgetCheck({
      draftDir: draft({ 'index.html': '<!DOCTYPE html><p>x</p>' }),
      validateQueries: allowAll,
      now: 1,
    });
    expect(noQueries.queriesSha256).toBe('');
  });

  it('malformed queries.json → query.invalid on queries.json; unknown-name is then skipped', async () => {
    const dir = draft({ 'index.html': GOOD_HTML, 'queries.json': '[{"name": "count",' });
    const report = await runWidgetCheck({ draftDir: dir, validateQueries: allowAll, now: 1 });
    const rules = report.issues.map((issue) => issue.rule);
    expect(rules).toContain('query.invalid');
    expect(rules).not.toContain('query.unknown-name');
    expect(report.issues.find((issue) => issue.rule === 'query.invalid')).toMatchObject({
      file: 'queries.json',
      blocking: true,
    });
    expect(report.queriesSha256).toBe('');
  });

  it('a query rejected by the validator is reported verbatim', async () => {
    const seen: WidgetQueryDef[][] = [];
    const validate = (defs: WidgetQueryDef[]): string | null => {
      seen.push(defs);
      return '查询「count」只能读取 widget_kv / conversation_messages';
    };
    const dir = draft({
      'index.html': GOOD_HTML,
      'queries.json': '[{"name":"count","sql":"select * from secrets"}]',
    });
    const report = await runWidgetCheck({ draftDir: dir, validateQueries: validate, now: 1 });
    expect(seen).toEqual([[{ name: 'count', sql: 'select * from secrets' }]]);
    const issue = report.issues.find((item) => item.rule === 'query.invalid');
    expect(issue?.message).toBe('查询「count」只能读取 widget_kv / conversation_messages');
    expect(report.verdict).toBe('blocked');
  });

  it('a lenient validator never makes malformed queries.json throw', async () => {
    for (const content of ['{}', '[{"name": "bad name!", "sql": ""}]']) {
      const dir = draft({ 'index.html': GOOD_HTML, 'queries.json': content });
      const report = await runWidgetCheck({ draftDir: dir, validateQueries: allowAll, now: 1 });
      expect(report.issues.map((issue) => issue.rule)).toEqual(['query.invalid']);
    }
  });

  it('absent queries.json means no names are declared (kepcup.query literal → unknown-name)', async () => {
    const report = await runWidgetCheck({
      draftDir: draft({ 'index.html': GOOD_HTML }),
      validateQueries: allowAll,
      now: 1,
    });
    expect(report.issues.map((issue) => issue.rule)).toEqual(['query.unknown-name']);
  });

  it('invalid acceptance.json / fixtures.json are warnings; the preview gets null / empty fixtures', async () => {
    const calls: Array<Parameters<WidgetPreviewRunner['run']>[0]> = [];
    const preview: WidgetPreviewRunner = {
      async run(input) {
        calls.push(input);
        return { skipped: '测试：不运行' };
      },
    };
    const dir = draft({
      'index.html': '<!DOCTYPE html><p>x</p>',
      'acceptance.json': '[{"id": "bad id!", "desc": "x", "expect": []}]',
      'fixtures.json': '{"storage": [], "queries": 3}',
    });
    const report = await runWidgetCheck({
      draftDir: dir,
      validateQueries: allowAll,
      preview,
      now: 1,
    });
    const rules = report.issues.map((issue) => issue.rule).sort();
    expect(rules).toEqual(['acceptance.invalid', 'fixtures.invalid']);
    expect(report.issues.every((issue) => issue.level === 'warning' && !issue.blocking)).toBe(true);
    expect(calls[0]?.acceptance).toBeNull();
    expect(calls[0]?.fixtures).toEqual({ storage: {}, queries: {} });
    expect(report.stages.S2).toEqual({ status: 'skipped', reason: '测试：不运行' });
  });

  it('merges preview issues / acceptance / outline into the report', async () => {
    const preview: WidgetPreviewRunner = {
      async run(input) {
        expect(input.acceptance?.[0]?.id).toBe('shows');
        expect(input.fixtures.storage).toEqual({ k: 1 });
        return {
          issues: [
            {
              rule: 'runtime.error',
              level: 'error',
              stage: 'S2',
              blocking: true,
              file: 'index.html',
              line: 1,
              message: 'TypeError: x is null',
              hint: '',
              viewport: '360/light',
            },
          ],
          acceptance: [{ id: 'shows', must: true, passed: true, detail: '' }],
          outline: 'p "x"',
        };
      },
    };
    const dir = draft({
      'index.html': '<!DOCTYPE html><p>x</p>',
      'acceptance.json': JSON.stringify([
        { id: 'shows', desc: '显示 x', must: true, expect: [{ selector: 'p', textContains: 'x' }] },
      ]),
      'fixtures.json': '{"storage": {"k": 1}}',
    });
    const report = await runWidgetCheck({
      draftDir: dir,
      validateQueries: allowAll,
      preview,
      now: 1,
    });
    expect(report.stages.S2.status).toBe('ran');
    expect(report.outline).toBe('p "x"');
    expect(report.acceptance).toHaveLength(1);
    expect(report.verdict).toBe('blocked');
  });

  it('a throwing preview becomes a skipped S2 with the reason', async () => {
    const preview: WidgetPreviewRunner = {
      async run() {
        throw new Error('窗口崩了');
      },
    };
    const report = await runWidgetCheck({
      draftDir: draft({ 'index.html': '<!DOCTYPE html><p>x</p>' }),
      validateQueries: allowAll,
      preview,
      now: 1,
    });
    expect(report.stages.S2).toEqual({ status: 'skipped', reason: '预览失败：窗口崩了' });
  });
});
