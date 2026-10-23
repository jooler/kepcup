import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BOT_WIDGET_HTML_MAX_BYTES, type WidgetCheckIssue } from '@kepcup/shared';
import { staticCheck } from '../../src/widgets/check/index.js';

/**
 * D87 P3a 检查器 S0（设计 32 §11.8.1）：每条规则正 / 反例、关键位置（行:列）、
 * 注释与字符串里的 API 名字不误报、截断检测。
 */

const FIXTURES = path.join(__dirname, '../fixtures/widgets');

/** 包成完整文档：body 的第一行是文件第 5 行。 */
function doc(body: string, head = ''): string {
  return `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8">${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function check(html: string, queryNames: readonly string[] | null = []): WidgetCheckIssue[] {
  return staticCheck({ html, queryNames });
}

function only(issues: WidgetCheckIssue[], rule: string): WidgetCheckIssue[] {
  return issues.filter((issue) => issue.rule === rule);
}

function at(issue: WidgetCheckIssue | undefined): string {
  return `${issue?.line}:${issue?.col}`;
}

describe('S0 html.*', () => {
  it('a clean document has no structural issues', () => {
    expect(check(doc('<p>你好</p>'))).toEqual([]);
  });

  it('html.size flags documents over the byte cap', () => {
    const big = doc(`<p>${'x'.repeat(BOT_WIDGET_HTML_MAX_BYTES)}</p>`);
    const [issue] = only(check(big), 'html.size');
    expect(issue).toMatchObject({ level: 'error', blocking: true, stage: 'S0' });
    expect(only(check(doc('<p>x</p>')), 'html.size')).toEqual([]);
  });

  it('html.doctype warns (non-blocking) on quirks mode at 1:1', () => {
    const [issue] = only(check('<html><body><p>x</p></body></html>'), 'html.doctype');
    expect(issue).toMatchObject({ level: 'warning', blocking: false, line: 1, col: 1 });
    expect(only(check(doc('<p>x</p>')), 'html.doctype')).toEqual([]);
    // 大小写不敏感、前面有注释也算有 doctype。
    expect(only(check('<!doctype HTML><html><body></body></html>'), 'html.doctype')).toEqual([]);
  });

  it('html.truncated: cutting a valid widget anywhere after <html> is caught', () => {
    const good = readFileSync(path.join(FIXTURES, 'good/expense-splitter.html'), 'utf8');
    expect(only(check(good), 'html.truncated')).toEqual([]);
    for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
      const cut = good.slice(0, Math.floor(good.length * fraction));
      const issues = only(check(cut), 'html.truncated');
      expect(issues, `cut at ${fraction}`).toHaveLength(1);
      expect(issues[0]).toMatchObject({ level: 'error', blocking: true });
    }
  });

  it('html.truncated points at the unclosed <script> / <style> / comment / half tag', () => {
    const script = '<!DOCTYPE html>\n<html><body>\n  <script>\n    let a = 1;\n';
    expect(at(only(check(script), 'html.truncated')[0])).toBe('3:3');
    const style = '<!DOCTYPE html>\n<html><head><style>body { color: red;';
    expect(only(check(style), 'html.truncated')[0]?.message).toContain('<style>');
    const comment = '<!DOCTYPE html>\n<html><body><!-- todo';
    expect(only(check(comment), 'html.truncated')[0]?.message).toContain('注释');
    const halfTag = '<!DOCTYPE html>\n<html><body><div cla';
    expect(at(only(check(halfTag), 'html.truncated')[0])).toBe('2:13');
  });

  it('html.truncated: missing </body> / </html> reported at end of file', () => {
    const html = '<!DOCTYPE html>\n<html>\n<body>\n<p>x</p>\n';
    const [issue] = only(check(html), 'html.truncated');
    expect(issue?.message).toContain('</body>');
    expect(issue?.message).toContain('</html>');
    expect(at(issue)).toBe('5:1');
  });

  it('html.truncated: fragment widgets without <html>/<body> are not required to close them', () => {
    expect(
      only(
        check('<!DOCTYPE html>\n<div id="a">x</div>\n<script>let a = 1;</script>\n'),
        'html.truncated',
      ),
    ).toEqual([]);
  });

  it('html.truncated ignores "</script>"-like text inside comments and markup inside scripts', () => {
    const html = doc('<!-- <script> -->\n<script>const tpl = "<div><body>";</script>');
    expect(only(check(html), 'html.truncated')).toEqual([]);
  });
});

describe('S0 sandbox.external-resource', () => {
  it('flags relative script src with exact attribute-value position', () => {
    const html = doc('<script src="lib.js"></script>');
    const [issue] = only(check(html), 'sandbox.external-resource');
    expect(issue).toMatchObject({ level: 'error', blocking: true, stage: 'S0' });
    // `<script src="` 是 13 个字符，值从第 14 列开始。
    expect(at(issue)).toBe('5:14');
  });

  it('https resources are legal; protocol-relative //host resolves to kepcup-app:// and is broken', () => {
    const html = doc(
      '<script src="https://cdn.example.com/lib.js"></script>\n<img src="//img.example.com/a.png">',
      '<link rel="stylesheet" href="https://fonts.example/css">',
    );
    const issues = only(check(html), 'sandbox.external-resource');
    // 组件源是 kepcup-app://：协议相对 //host 解析回同一协议（不是 https），加载不到。
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', blocking: true, line: 6 });
    expect(issues[0]?.message).toContain('//img.example.com/a.png');
  });

  it('relative paths are broken too (there are no sibling files)', () => {
    const issues = only(
      check(
        doc(
          '<script src="app.js"></script>\n<img src="./logo.png">',
          '<link rel="stylesheet" href="style.css">',
        ),
      ),
      'sandbox.external-resource',
    );
    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.message).join('\n')).toContain('这个相对路径不存在');
  });

  it('relative assets are flagged; https / data: are fine (img / video / srcset / object)', () => {
    const html = doc(
      [
        '<img src="img/a.png">',
        '<iframe src="https://example.com"></iframe>',
        '<video src="movie.mp4" poster="data:image/png;base64,AAAA"></video>',
        '<picture><source srcset="https://x.example/b.png 1x, https://x.example/b@2x.png 2x"></picture>',
        '<object data="doc.pdf"></object>',
      ].join('\n'),
    );
    expect(only(check(html), 'sandbox.external-resource')).toHaveLength(3);
  });

  it('data: / blob: / fragment urls and non-loading link rels are fine', () => {
    const html = doc(
      [
        '<img src="data:image/svg+xml;utf8,<svg/>">',
        '<svg><use href="#icon"></use></svg>',
        '<div style="background: url(data:image/png;base64,AAAA)"></div>',
        '<svg><rect fill="url(#grad)"/></svg>',
      ].join('\n'),
      '<link rel="canonical" href="https://example.com/">',
    );
    expect(only(check(html), 'sandbox.external-resource')).toEqual([]);
  });

  it('CSS @import and url() with relative paths in <style> and style attributes', () => {
    const html = doc(
      '<div style="background-image: url(\'img/bg.jpg\')"></div>',
      '<style>\n@import url("style/defs.css");\n.a { background: url(assets/a.png); }\n</style>',
    );
    const issues = only(check(html), 'sandbox.external-resource');
    expect(issues).toHaveLength(3);
    // <style> 内容第 4 行就是 @import 那一行，第 1 列；url() 在第 5 行 `.a { background: `（17 字符）之后；
    // style 属性值从 `<div style="` 之后开始，url( 在值的第 19 个字符。
    expect(issues.map(at)).toEqual(['4:1', '5:18', '8:31']);
  });

  it('CSS comments do not count', () => {
    const html = doc(
      '<p>x</p>',
      '<style>/* background: url(assets/a.png) */ p { color: red }</style>',
    );
    expect(only(check(html), 'sandbox.external-resource')).toEqual([]);
  });

  it('JS: import from relative URLs, dynamic script.src injection', () => {
    const html = doc(
      [
        "<script type=\"module\">import confetti from './confetti.js';</script>",
        "<script>const s = document.createElement('script'); s.src = 'assets/x.js'; document.head.append(s);</script>",
      ].join('\n'),
    );
    expect(only(check(html), 'sandbox.external-resource')).toHaveLength(2);
  });
});

describe('S0 sandbox.storage (cookie only in the full-webapp tier)', () => {
  it('localStorage / sessionStorage / indexedDB are legal; document.cookie is a warning', () => {
    const html = doc(
      [
        '<script>',
        "  const saved = localStorage.getItem('k');",
        "  window.sessionStorage.setItem('k', '1');",
        "  indexedDB.open('db');",
        "  document.cookie = 'a=1';",
        '  if (typeof localStorage !== "undefined") {}',
        '</script>',
      ].join('\n'),
    );
    const issues = only(check(html), 'sandbox.storage');
    expect(issues.map(at)).toEqual(['9:3']);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false });
  });

  it('comments, strings, property names and kepcup.storage do not trigger', () => {
    const html = doc(
      [
        '<script>',
        '  // 不要用 localStorage，也不要 confirm()',
        "  /* sessionStorage fetch('x') alert('x') */",
        "  const tip = 'localStorage 在沙箱里不可用；confirm() 也不行';",
        '  const obj = { localStorage: 1, fetch: 2 };',
        '  obj.localStorage = obj.fetch;',
        "  kepcup.storage.get('k').then(() => {});",
        '</script>',
      ].join('\n'),
    );
    expect(check(html)).toEqual([]);
  });

  it('network globals are legal in the full-webapp tier', () => {
    const html = doc(
      [
        '<script>',
        "  fetch('/api');",
        '  const x = new XMLHttpRequest();',
        "  new WebSocket('wss://x');",
        "  new EventSource('/s');",
        "  navigator.sendBeacon('/b', '');",
        '</script>',
      ].join('\n'),
    );
    expect(check(html)).toEqual([]);
  });

  it('falls back to the token stream when a script does not parse', () => {
    const broken = doc(
      '<script>\n// cookie in a comment\nconst v = document.cookie(\n</script>',
    );
    const issues = only(check(broken), 'sandbox.storage');
    expect(issues.map(at)).toEqual(['7:11']);
  });
});

describe('S0 confirm / prompt / alert (legal in the full-webapp tier)', () => {
  it('confirm() in an on* attribute, prompt and alert are not flagged', () => {
    const html = doc(
      '<button type="button" onclick="if (confirm(\'删除？\')) del()">删除</button>\n<script>\nfunction del() {}\nconst n = prompt(\'名字\');\nif (window.confirm(\'ok?\')) {}\nalert(\'完成\');\n</script>',
    );
    expect(check(html)).toEqual([]);
  });

  it('member calls named confirm and user-defined confirm are fine', () => {
    const html = doc(
      '<script>\nconst dialog = { confirm() { return true; } };\ndialog.confirm();\nfunction prompt2() {}\nprompt2();\n</script>',
    );
    expect(check(html)).toEqual([]);
    const shadow = doc(
      '<script>\nfunction confirm(msg) { return true; }\nif (confirm("x")) {}\n</script>',
    );
    expect(check(shadow)).toEqual([]);
  });
});

describe('S0 sandbox.form-submit / submit-button', () => {
  it('submit handlers (onsubmit / addEventListener) are legal and suppress the button warning', () => {
    const html = doc(
      '<form onsubmit="save(event)"><input><button>保存</button></form>\n<script>function save(e) {}</script>',
    );
    expect(only(check(html), 'sandbox.form-submit')).toEqual([]);
    expect(only(check(html), 'sandbox.submit-button')).toEqual([]);
  });

  it('addEventListener("submit") is fine; requestSubmit() / form.submit() are warnings', () => {
    const html = doc(
      [
        '<form id="f"><input></form>',
        '<script>',
        "  const f = document.getElementById('f');",
        "  f.addEventListener('submit', (e) => { e.preventDefault(); save(); });",
        '  f.onsubmit = () => save();',
        '  f.requestSubmit();',
        '  f.submit();',
        '  function save() {}',
        '</script>',
      ].join('\n'),
    );
    expect(only(check(html), 'sandbox.form-submit').map(at)).toEqual(['10:3', '11:3']);
    expect(only(check(html), 'sandbox.form-submit')[0]).toMatchObject({
      level: 'warning',
      blocking: false,
    });
  });

  it('handlers that only prevent default are harmless', () => {
    const html = doc(
      [
        '<form id="f" onsubmit="return false"><input><button type="button">x</button></form>',
        "<script>document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());</script>",
      ].join('\n'),
    );
    expect(only(check(html), 'sandbox.form-submit')).toEqual([]);
  });

  it('custom submit() methods with arguments are not form.submit()', () => {
    const html = doc(
      '<script>\nconst quiz = { submit(answer) { return answer; } };\nquiz.submit(1);\nquiz.submit();\n</script>',
    );
    expect(only(check(html), 'sandbox.form-submit')).toEqual([]);
  });

  it('submit buttons without a submit handler are a warning', () => {
    const html = doc(
      '<form>\n<input>\n<button onclick="go()">保存</button>\n<button type="button">取消</button>\n</form>\n<button type="submit">外面</button>\n<script>function go() {}</script>',
    );
    const issues = only(check(html), 'sandbox.submit-button');
    expect(issues.map(at)).toEqual(['7:1', '10:9']);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false });
  });
});

describe('S0 sandbox.popup / top-nav / link-navigation / download / clipboard', () => {
  it('target=_blank and window.open are popup errors', () => {
    const html = doc(
      '<a href="https://x.example" target="_blank">x</a>\n<script>window.open("https://x.example");\nconst a = document.createElement("a"); a.target = "_blank";\nlist.innerHTML = `<a href="${u}" target="_blank">链接</a>`;</script>',
    );
    const issues = only(check(html), 'sandbox.popup');
    expect(issues.map(at)).toEqual(['5:29', '6:9', '7:40', '8:19']);
    expect(issues[0]).toMatchObject({ level: 'error', blocking: true });
    expect(only(check(html), 'sandbox.link-navigation')).toEqual([]);
  });

  it('links whose onclick prevents default (kepcup.openLink) are fine', () => {
    const html = doc(
      '<a href="https://x.example" target="_blank" onclick="kepcup.openLink(this.href); return false">x</a>',
    );
    expect(check(html)).toEqual([]);
  });

  it('location writes / navigation calls / target=_top / meta refresh are top-nav errors', () => {
    const html = doc(
      [
        '<a href="#a" target="_top">x</a>',
        '<script>',
        "  location.href = '/next';",
        "  window.location = 'https://x.example';",
        "  top.location.href = 'https://x.example';",
        "  location.assign('/a');",
        '  location.reload();',
        "  document.location.search = '?q=1';",
        '</script>',
      ].join('\n'),
      '<meta http-equiv="refresh" content="5; url=https://x.example">',
    );
    const issues = only(check(html), 'sandbox.top-nav');
    // meta 在 head 行 `<head><meta charset="utf-8">` 之后；target 在 `<a href="#a" ` 之后。
    expect(issues.map(at)).toEqual(['3:29', '5:14', '7:3', '8:3', '9:3', '10:3', '11:3', '12:3']);
  });

  it('location.hash writes and location reads are fine', () => {
    const html = doc(
      "<script>\nlocation.hash = 'list';\nconst here = location.href;\nconst link = document.createElement('a');\nlink.href = '#x';\n</script>",
    );
    expect(only(check(html), 'sandbox.top-nav')).toEqual([]);
  });

  it('relative and https links are link-navigation warnings (nav guard blocks both); anchors are fine', () => {
    const html = doc(
      '<a href="https://x.example/docs">文档</a>\n<a href="page2.html">下一页</a>\n<a href="#top">顶部</a>',
    );
    const issues = only(check(html), 'sandbox.link-navigation');
    expect(issues.map(at)).toEqual(['5:10', '6:10']);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false });
    // https 外链的条目指向 kepcup.openLink 替代写法。
    expect(issues[0]?.message).toContain('kepcup.openLink');
  });

  it('a[download] and navigator.clipboard are warnings', () => {
    const html = doc(
      '<a href="#" download="x.csv">导出</a>\n<script>navigator.clipboard.writeText("x");\nconst a = document.createElement("a"); a.download = "y.csv";</script>',
    );
    expect(only(check(html), 'sandbox.download').map(at)).toEqual(['5:13', '7:40']);
    const [clip] = only(check(html), 'sandbox.clipboard');
    expect(clip).toMatchObject({ level: 'warning', blocking: false, line: 6, col: 9 });
    expect(
      only(check(doc('<script>const t = "navigator.clipboard";</script>')), 'sandbox.clipboard'),
    ).toEqual([]);
  });
});

describe('S0 theme.media-query', () => {
  it('prefers-color-scheme in CSS and in matchMedia', () => {
    const html = doc(
      '<script>const dark = matchMedia("(prefers-color-scheme: dark)").matches;</script>',
      '<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>',
    );
    const issues = only(check(html), 'theme.media-query');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ level: 'warning', blocking: false });
    expect(
      only(
        check(doc('<p>x</p>', '<style>[data-theme="dark"] body { background: #000 }</style>')),
        'theme.media-query',
      ),
    ).toEqual([]);
  });
});

describe('S0 query.unknown-name', () => {
  const html = doc(
    [
      '<script>',
      '  (async () => {',
      "    const a = await kepcup.query('monthly', { m: 1 });",
      "    const b = await window.kepcup.query('weekly');",
      '    const c = await kepcup.query(name);',
      '  })();',
      '</script>',
    ].join('\n'),
  );

  it('literal names missing from queries.json are errors at the literal', () => {
    const issues = only(check(html, ['monthly']), 'query.unknown-name');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'error', blocking: true, line: 8, col: 41 });
    expect(issues[0]?.message).toContain('weekly');
  });

  it('absent queries.json (no names declared) flags every literal name', () => {
    expect(only(check(html, []), 'query.unknown-name')).toHaveLength(2);
  });

  it('invalid queries.json (null) skips the name check', () => {
    expect(only(check(html, null), 'query.unknown-name')).toEqual([]);
  });

  it('all names declared → nothing', () => {
    expect(only(check(html, ['monthly', 'weekly']), 'query.unknown-name')).toEqual([]);
  });
});

describe('review fixes (D87 P3a)', () => {
  it('fragment-only location.href / window.location are same-document, not top-nav (#11)', () => {
    const issues = check(
      doc(
        "<script>\nlocation.href = '#top';\nwindow.location = '#list';\nlocation.href = 'https://example.com/';\n</script>",
      ),
    );
    const nav = only(issues, 'sandbox.top-nav');
    expect(nav).toHaveLength(1);
    expect(nav[0]?.line).toBe(8);
  });

  it('SVG xlink:href with a relative path is an external resource (#12)', () => {
    const issues = check(
      doc('<svg><image xlink:href="img/a.png" width="10" height="10"/></svg>'),
    );
    expect(only(issues, 'sandbox.external-resource')).toHaveLength(1);
  });
});
