import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

import { WIDGET_PROBE_HOST_SOURCE, WIDGET_PROBE_SOURCE } from '@kepcup/shared';
import {
  WIDGET_PREVIEW_PROBE,
  WIDGET_PREVIEW_PROBE_MARKER,
  injectPreviewProbe,
} from '../../src/widgets/preview-probe.js';
import { WIDGET_SDK_MARKER, injectWidgetSdk } from '../../src/widgets/sdk-injection.js';

/**
 * D87 P3b 预览探针（设计 32 §11.8.3 / §11.9）：注入物必须是不含换行的一行（报告里的行号 = 草稿
 * index.html 的行号），紧跟在垫片之后，且脚本本体能被解析（折叠换行不能改坏语义）。
 * 行为（错误捕获、验收、乱点）在真实 Chromium 里验证：apps/desktop/test/electron/widget-preview.harness.ts。
 */

function scriptBody(tag: string): string {
  const match = /^<script>([\s\S]*)<\/script>$/.exec(tag);
  if (match === null) throw new Error('not a single <script> element');
  return match[1]!;
}

const DRAFT = [
  '<!DOCTYPE html>',
  '<html>',
  '<head><meta charset="utf-8"><title>t</title></head>',
  '<body>',
  '<p id="x">hi</p>',
  '<script>throw new Error("line 6");</script>',
  '</body>',
  '</html>',
].join('\n');

describe('WIDGET_PREVIEW_PROBE', () => {
  it('is a single line that parses as a classic script', () => {
    expect(WIDGET_PREVIEW_PROBE).not.toMatch(/[\n\r\u2028\u2029]/);
    const body = scriptBody(WIDGET_PREVIEW_PROBE);
    expect(() => parse(body, { ecmaVersion: 2022, sourceType: 'script' })).not.toThrow();
    // 内联脚本里不能出现会提前结束 / 改变脚本数据状态的序列。
    expect(body.toLowerCase()).not.toContain('</script');
    expect(body).not.toContain('<!--');
    expect(body).toContain(WIDGET_PREVIEW_PROBE_MARKER);
    expect(body).toContain(JSON.stringify(WIDGET_PROBE_SOURCE));
    expect(body).toContain(JSON.stringify(WIDGET_PROBE_HOST_SOURCE));
  });

  it('does not depend on window.kepcup', () => {
    expect(scriptBody(WIDGET_PREVIEW_PROBE)).not.toMatch(
      /\bkepcup\.(storage|query|theme|openLink)/,
    );
  });
});

describe('injectPreviewProbe', () => {
  it('goes right after the SDK shim, before any widget script', () => {
    const withShim = injectWidgetSdk(DRAFT);
    const out = injectPreviewProbe(withShim);
    const shimAt = out.indexOf(WIDGET_SDK_MARKER);
    const shimEnd = out.indexOf('</script>', shimAt) + '</script>'.length;
    expect(out.slice(shimEnd, shimEnd + WIDGET_PREVIEW_PROBE.length)).toBe(WIDGET_PREVIEW_PROBE);
    expect(out.indexOf(WIDGET_PREVIEW_PROBE)).toBeLessThan(out.indexOf('line 6'));
    expect(out.replace(WIDGET_PREVIEW_PROBE, '')).toBe(withShim);
  });

  it('without a shim goes where the shim would go (after <head>, else doctype, else start)', () => {
    const head = injectPreviewProbe(DRAFT);
    expect(head.startsWith(`<!DOCTYPE html>\n<html>\n<head>${WIDGET_PREVIEW_PROBE}<meta`)).toBe(
      true,
    );
    const noHead = injectPreviewProbe('<!doctype html>\n<p>x</p>');
    expect(noHead).toBe(`<!doctype html>${WIDGET_PREVIEW_PROBE}\n<p>x</p>`);
    expect(injectPreviewProbe('<p>x</p>')).toBe(`${WIDGET_PREVIEW_PROBE}<p>x</p>`);
  });

  it('keeps the line numbers of the original HTML', () => {
    const original = DRAFT.split('\n');
    for (const html of [injectPreviewProbe(injectWidgetSdk(DRAFT)), injectPreviewProbe(DRAFT)]) {
      const lines = html.split('\n');
      expect(lines).toHaveLength(original.length);
      // Only the injection line changes; every other line is byte-identical.
      lines.forEach((line, index) => {
        if (index !== 2) expect(line).toBe(original[index]);
      });
      expect(lines[5]).toBe('<script>throw new Error("line 6");</script>');
    }
  });

  it('is idempotent', () => {
    const once = injectPreviewProbe(injectWidgetSdk(DRAFT));
    expect(injectPreviewProbe(once)).toBe(once);
    expect(once.split(WIDGET_PREVIEW_PROBE_MARKER)).toHaveLength(2);
  });
});
