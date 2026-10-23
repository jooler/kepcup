import { describe, expect, it } from 'vitest';

import type { WidgetCheckIssue } from '@kepcup/shared';
import { jsCheck } from '../../src/widgets/check/index.js';

/**
 * D87 P3a 检查器 S1（设计 32 §11.8.2）：语法、处理器作用域、未定义名字、跨脚本重复声明、
 * id 查找、kepcup 未 await。位置映射：内联脚本首行按起始列偏移、后续行从第 1 列起；
 * 属性处理器映射到属性值的列。
 */

/** 包成完整文档：body 的第一行是文件第 5 行。 */
function doc(body: string): string {
  return `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function only(html: string, rule: string): WidgetCheckIssue[] {
  return jsCheck({ html }).filter((issue) => issue.rule === rule);
}

function at(issue: WidgetCheckIssue | undefined): string {
  return `${issue?.line}:${issue?.col}`;
}

describe('S1 js.syntax / js.handler-syntax', () => {
  it('maps errors in a multi-line script to file line:col', () => {
    const [issue] = only(doc('<script>\n  const a = 1;\n  const b = ;\n</script>'), 'js.syntax');
    expect(issue).toMatchObject({ level: 'error', blocking: true, stage: 'S1', line: 7, col: 13 });
  });

  it('offsets the first line of an inline script by its start column', () => {
    // `<p>x</p><script>` 占 16 列，代码从第 17 列起；`let x = ;` 的 `;` 是代码第 9 个字符。
    expect(at(only(doc('<p>x</p><script>let x = ;</script>'), 'js.syntax')[0])).toBe('5:25');
  });

  it('parses type=module as a module and skips non-JS script types', () => {
    const html = doc(
      [
        '<script type="module">const v = await Promise.resolve(1); export {};</script>',
        '<script type="application/json">{ "not": js </script>',
        '<script type="text/template"><div>{{ x }}</div></script>',
      ].join('\n'),
    );
    expect(only(html, 'js.syntax')).toEqual([]);
  });

  it('top-level await in a classic script is a syntax error with an explanation', () => {
    const [issue] = only(
      doc("<script>\nconst v = await kepcup.storage.get('k');\n</script>"),
      'js.syntax',
    );
    expect(issue?.message).toContain('async 函数');
  });

  it('CRLF line endings keep line numbers right', () => {
    const html = doc('<script>\r\n  let a = 1;\r\n  let b = ;\r\n</script>')
      .replace(/\n/g, '\r\n')
      .replace(/\r\r/g, '\r');
    expect(at(only(html, 'js.syntax')[0])).toBe('7:11');
  });

  it('on* attribute bodies are parsed as function bodies', () => {
    const [issue] = only(doc('<button onclick="add(">x</button>'), 'js.handler-syntax');
    // `<button onclick="` 是 17 个字符；`add(` 在第 4 个字符之后出错。
    expect(issue).toMatchObject({ level: 'error', blocking: true, line: 5, col: 22 });
    expect(
      only(
        doc(
          '<button onclick="if (x) return false; go()">x</button><script>var x; function go() {}</script>',
        ),
        'js.handler-syntax',
      ),
    ).toEqual([]);
  });
});

describe('S1 js.handler-undefined', () => {
  it('function defined inside a DOMContentLoaded callback', () => {
    const html = doc(
      [
        '<button type="button" onclick="increment()">+1</button>',
        '<script>',
        "  document.addEventListener('DOMContentLoaded', () => {",
        '    function increment() {}',
        '  });',
        '</script>',
      ].join('\n'),
    );
    const [issue] = only(html, 'js.handler-undefined');
    expect(issue).toMatchObject({ level: 'error', blocking: true, line: 5, col: 32 });
    expect(issue?.message).toContain('函数内部');
  });

  it('function defined in a type=module script', () => {
    const html = doc(
      '<button onclick="calc()">=</button>\n<script type="module">function calc() {}</script>',
    );
    const [issue] = only(html, 'js.handler-undefined');
    expect(issue?.message).toContain('type="module"');
    expect(at(issue)).toBe('5:18');
  });

  it('a name that is not defined anywhere', () => {
    const [issue] = only(doc('<button onclick="nope()">x</button>'), 'js.handler-undefined');
    expect(issue?.message).toContain('没有定义');
  });

  it('globals: top-level function / var / let, window.x, Object.assign(window), implicit globals', () => {
    const html = doc(
      [
        '<button onclick="a()">a</button><button onclick="b.go()">b</button><button onclick="c()">c</button>',
        '<button onclick="d()">d</button><button onclick="e()">e</button><button onclick="f()">f</button>',
        '<script>',
        '  function a() {}',
        '  var b = { go() {} };',
        '  let c = () => {};',
        "  document.addEventListener('DOMContentLoaded', () => { f = function () {}; });",
        '</script>',
        '<script type="module">',
        '  function d() {}',
        '  window.d = d;',
        '  Object.assign(window, { e() {} });',
        '</script>',
      ].join('\n'),
    );
    expect(only(html, 'js.handler-undefined')).toEqual([]);
  });

  it('handler scope: event, element properties, element ids, browser globals', () => {
    const html = doc(
      '<input id="qty" oninput="update(value, event)"><button onclick="remove(); console.log(qty.value); kepcup.openLink(href)">x</button>\n<script>function update() {}</script>',
    );
    expect(only(html, 'js.handler-undefined')).toEqual([]);
  });

  it('form members only resolve inside a form', () => {
    expect(
      only(
        doc('<form><button type="button" onclick="reset()">x</button></form>'),
        'js.handler-undefined',
      ),
    ).toEqual([]);
    expect(
      only(doc('<button type="button" onclick="reset()">x</button>'), 'js.handler-undefined'),
    ).toHaveLength(1);
  });

  it('onclick inside script-generated markup only sees globals', () => {
    const html = doc(
      [
        '<ul id="list"></ul>',
        '<script>',
        '  (function () {',
        '    function removeItem(i) {}',
        "    document.getElementById('list').innerHTML = [1].map((x, i) => `<li onclick=\"removeItem(${i})\">x</li>`).join('');",
        '  })();',
        '</script>',
      ].join('\n'),
    );
    const [issue] = only(html, 'js.handler-undefined');
    expect(issue?.message).toContain('removeItem');
    // removeItem 在第 9 行：`    document.getElementById('list').innerHTML = [1].map((x, i) => \`<li onclick="` 之后。
    expect(at(issue)).toBe('9:81');
  });
});

describe('S1 js.undefined-name', () => {
  it('called undefined names are errors; plain reads are warnings', () => {
    const html = doc('<script>\n  doSomething();\n  const t = total + 1;\n</script>');
    const issues = only(html, 'js.undefined-name');
    expect(
      issues.map((issue) => [issue.message.includes('doSomething'), issue.level, at(issue)]),
    ).toEqual([
      [true, 'error', '6:3'],
      [false, 'warning', '7:13'],
    ]);
    expect(issues[0]?.blocking).toBe(true);
    expect(issues[1]?.blocking).toBe(false);
  });

  it('third-party library globals are called out', () => {
    const [issue] = only(
      doc('<script>new Chart(ctx, {});\nvar ctx;</script>'),
      'js.undefined-name',
    );
    expect(issue?.message).toContain('第三方库');
  });

  it('with an https external script, called library globals downgrade to warning', () => {
    const base = '<script>new Chart(ctx, {});\nvar ctx;</script>';
    // 无外链脚本：调用未定义的库全局是 error（阻断）。
    const [without] = only(doc(base), 'js.undefined-name');
    expect(without).toMatchObject({ level: 'error', blocking: true });
    // 双引号 / 单引号 / 属性序 / 大小写 / 不带引号的属性值都算「引了 https 外链脚本」。
    for (const script of [
      '<script src="https://cdn.example.com/chart.js"></script>',
      "<script src='https://cdn.example.com/chart.js'></script>",
      '<script defer src="https://cdn.example.com/chart.js"></script>',
      '<SCRIPT SRC="HTTPS://cdn.example.com/chart.js"></SCRIPT>',
      '<script src=https://cdn.example.com/chart.js></script>',
    ]) {
      const [issue] = only(doc(`${script}\n${base}`), 'js.undefined-name');
      expect(issue).toMatchObject({ level: 'warning', blocking: false });
      expect(issue?.message).toContain('CDN');
    }
    // 协议相对 // 不算外链（解析回 kepcup-app 协议，加载不到），保持 error。
    const [protocolRelative] = only(
      doc('<script src="//cdn.example.com/chart.js"></script>\n' + base),
      'js.undefined-name',
    );
    expect(protocolRelative).toMatchObject({ level: 'error', blocking: true });
    // 未声明的非库全局不因外链脚本降级（CDN 提供不了任意名字）。
    const [plain] = only(
      doc('<script src="https://cdn.example.com/chart.js"></script>\n<script>nope();</script>'),
      'js.undefined-name',
    );
    expect(plain).toMatchObject({ level: 'error', blocking: true });
  });

  it('typeof, property keys, members, labels, declarations anywhere, element ids are fine', () => {
    const html = doc(
      [
        '<span id="total"></span>',
        '<script>',
        "  if (typeof maybe === 'undefined') {}",
        '  const o = { unknownKey: 1 };',
        '  o.unknownProp = 2;',
        '  outer: for (;;) { break outer; }',
        '  total.textContent = laterFn();',
        '  kepcup.storage.list();',
        '  window.addEventListener("load", () => { shared(); });',
        '</script>',
        '<script>function laterFn() { return 1; } function shared() {}</script>',
      ].join('\n'),
    );
    expect(only(html, 'js.undefined-name')).toEqual([]);
  });

  it('one issue per name (first call site preferred)', () => {
    const html = doc('<script>\nconst a = helper;\nhelper();\nhelper();\n</script>');
    const issues = only(html, 'js.undefined-name');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', line: 7, col: 1 });
    expect(issues[0]?.message).toContain('共 3 处');
  });
});

describe('S1 js.redeclare', () => {
  it('let / const across classic scripts', () => {
    const html = doc(
      '<script>\nlet state = {};\n</script>\n<script>\nconst state = [];\n</script>',
    );
    const [issue] = only(html, 'js.redeclare');
    expect(issue).toMatchObject({ level: 'error', blocking: true, line: 9, col: 7 });
    expect(issue?.message).toContain('第 1 个');
  });

  it('let in one script vs var / function in another', () => {
    expect(
      only(doc('<script>var x = 1;</script><script>let x = 2;</script>'), 'js.redeclare'),
    ).toHaveLength(1);
    expect(
      only(doc('<script>let y = 1;</script><script>function y() {}</script>'), 'js.redeclare'),
    ).toHaveLength(1);
  });

  it('var / function redeclarations, module scripts and nested scopes are fine', () => {
    const html = doc(
      [
        '<script>var a = 1; function f() {} let c = 1;</script>',
        '<script>var a = 2; function f() {} function g() { let c = 2; }</script>',
        '<script type="module">let c = 3;</script>',
      ].join('\n'),
    );
    expect(only(html, 'js.redeclare')).toEqual([]);
  });

  it('top-level let named like an unforgeable global', () => {
    expect(only(doc('<script>const location = "x";</script>'), 'js.redeclare')).toHaveLength(1);
    expect(
      only(doc('<script>function f() { const location = "x"; }</script>'), 'js.redeclare'),
    ).toEqual([]);
  });

  it('duplicates inside one script are a syntax error, not a redeclare', () => {
    const html = doc('<script>let z = 1; let z = 2;</script>');
    expect(only(html, 'js.redeclare')).toEqual([]);
    expect(only(html, 'js.syntax')).toHaveLength(1);
  });
});

describe('S1 dom.id-missing / dom.duplicate-id', () => {
  it('typo in getElementById is an error at the string literal', () => {
    const html = doc(
      '<span id="total"></span>\n<script>\n  document.getElementById(\'totl\').textContent = "1";\n</script>',
    );
    const [issue] = only(html, 'dom.id-missing');
    expect(issue).toMatchObject({ level: 'error', blocking: true, line: 7, col: 27 });
  });

  it('querySelector("#id …") forms, attribute selectors ignored', () => {
    const html = doc(
      "<script>\ndocument.querySelector('#missing .row');\ndocument.querySelectorAll('[href=\"#nothere\"]');\ndocument.querySelector('#ok');\n</script>\n<p id=\"ok\"></p>",
    );
    const issues = only(html, 'dom.id-missing');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('missing');
  });

  it('ids generated dynamically (string appears elsewhere) are not reported', () => {
    const html = doc(
      [
        '<div id="root"></div>',
        '<script>',
        "  const row = document.createElement('div');",
        "  row.id = 'dyn';",
        '  document.getElementById(\'root\').innerHTML = `<p id="later"></p>`;',
        "  document.getElementById('dyn').remove();",
        "  document.getElementById('later').remove();",
        '</script>',
      ].join('\n'),
    );
    expect(only(html, 'dom.id-missing')).toEqual([]);
  });

  it('large documents: thousands of same-name identifiers stay linear (review #10)', () => {
    const uses = Array.from({ length: 20_000 }, (_, i) => `count += ${i};`).join('\n');
    const html = doc(
      `<script>\nlet count = 0;\n${uses}\ndocument.getElementById('count').textContent = count;\n</script>`,
    );
    const started = performance.now();
    const issues = only(html, 'dom.id-missing');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(issues).toHaveLength(1);
  });

  it('the id inside a compound selector literal is not "elsewhere"', () => {
    const html = doc("<script>\ndocument.querySelector('.list #gone').remove();\n</script>");
    expect(only(html, 'dom.id-missing')).toHaveLength(1);
  });

  it('a variable with the same name does not count as the id existing', () => {
    const html = doc(
      "<script>\nconst total = 1;\ndocument.getElementById('total').textContent = total;\n</script>",
    );
    expect(only(html, 'dom.id-missing')).toHaveLength(1);
  });

  it('every lookup of a missing id is reported', () => {
    const html = doc(
      "<script>\ndocument.getElementById('gone');\ndocument.getElementById('gone');\n</script>",
    );
    expect(only(html, 'dom.id-missing')).toHaveLength(2);
  });

  it('duplicate ids warn at the later occurrence; template content is ignored', () => {
    const html = doc('<p id="x"></p>\n<p id="x"></p>\n<template><p id="x"></p></template>');
    const issues = only(html, 'dom.duplicate-id');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false, line: 6, col: 8 });
  });
});

describe('S1 kepcup.not-awaited', () => {
  it('flags results used without await', () => {
    const html = doc(
      [
        '<script>',
        "  const saved = kepcup.storage.get('k');",
        "  const n = kepcup.storage.get('k').length;",
        "  render(kepcup.query('rows'));",
        '  let v; v = kepcup.storage.list();',
        "  const label = '共 ' + kepcup.query('n');",
        '  function render() {}',
        '</script>',
      ].join('\n'),
    );
    const issues = only(html, 'kepcup.not-awaited');
    expect(issues.map(at)).toEqual(['6:17', '7:13', '8:10', '9:14', '10:24']);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false });
  });

  it('await / then / return / arrow body / Promise.all / bare statement are fine', () => {
    const html = doc(
      [
        '<button onclick="kepcup.storage.set(\'k\', 1)">x</button>',
        '<script>',
        '  async function load() {',
        "    const a = await kepcup.storage.get('a');",
        "    const [b, c] = await Promise.all([kepcup.query('b'), kepcup.storage.get('c')]);",
        "    kepcup.storage.set('a', 1);",
        "    kepcup.storage.get('a').then((v) => v).catch(() => null);",
        "    const p = kepcup.query('later');",
        '    await p;',
        '    return kepcup.storage.list();',
        '  }',
        '  const get = (k) => kepcup.storage.get(k);',
        '  load(); get;',
        '</script>',
      ].join('\n'),
    );
    expect(only(html, 'kepcup.not-awaited')).toEqual([]);
  });
});
