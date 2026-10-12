/**
 * D87 P3b S2 预览宿主的真机 harness（设计 32 §11.9）：在真实 Electron / Chromium 里跑
 * `WidgetPreviewHost`，覆盖单测碰不到的部分——沙箱 iframe、探针的错误捕获与行号、乱点与验收、
 * 死循环回收、崩溃识别、截图。由 `apps/desktop/scripts/run-widget-preview-harness.mjs` 用 esbuild
 * 打成 CJS 主进程脚本后运行；每个用例一行 JSON，最后一行是汇总，有失败则退出码非零。
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, nativeImage, webContents } from 'electron';
import {
  widgetPreviewRunInputSchema,
  widgetPreviewRunOutputSchema,
  type WidgetPreviewRunOutput,
  type WidgetPreviewViewportResult,
  type WidgetTheme,
} from '@kepcup/shared';
import { injectPreviewProbe } from '../../../../packages/core/src/widgets/preview-probe';
import { injectWidgetSdk } from '../../../../packages/core/src/widgets/sdk-injection';
import { WIDGET_TEMPLATES } from '../../../../packages/core/src/widgets/templates/index';
import { registerAppsUiScheme } from '../../src/main/apps-ui';
import { WidgetPreviewHost } from '../../src/main/widget-preview';
import {
  PREVIEW_URL_PREFIX,
  isUniformBitmap,
  pidAlive,
} from '../../src/main/widget-preview-policy';

registerAppsUiScheme();
/** 每条结果一行 JSON（stdout，便于外层脚本 / CI 解析）。 */
const emit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const scratch = mkdtempSync(path.join(os.tmpdir(), 'kepcup-wp-harness-data-'));
app.setPath('userData', path.join(scratch, 'userData'));
// The real app is tray-resident; destroying the preview window must not quit the harness either.
app.on('window-all-closed', () => {});

const host = new WidgetPreviewHost({
  tempRoot: scratch,
  log: (message, error) =>
    emit({
      key: 'host-log',
      message,
      error: error instanceof Error ? error.message : undefined,
    }),
});

/** 草稿原文 → 某视口的预览 HTML（与 core 的 S2 适配同一条注入路径）。 */
function previewHtml(src: string, theme: WidgetTheme): string {
  return injectPreviewProbe(injectWidgetSdk(src, { theme }));
}

function doc(body: string, head = ''): string {
  return `<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8">${head}</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

interface RunOptions {
  viewports?: Array<{ width: number; theme: WidgetTheme }>;
  acceptance?: unknown;
  fixtures?: unknown;
  monkeyMax?: number;
  screenshots?: boolean;
  budgetMs?: number;
}

async function preview(src: string, options: RunOptions = {}): Promise<WidgetPreviewRunOutput> {
  const viewports = options.viewports ?? [{ width: 360, theme: 'light' }];
  const input = widgetPreviewRunInputSchema.parse({
    viewports: viewports.map((v) => ({ ...v, html: previewHtml(src, v.theme) })),
    acceptance: options.acceptance ?? null,
    fixtures: options.fixtures ?? {},
    monkeyMax: options.monkeyMax ?? 30,
    screenshots: options.screenshots ?? false,
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  });
  return widgetPreviewRunOutputSchema.parse(await host.run(input));
}

class Expectation extends Error {}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Expectation(message);
}
const brief = (v: WidgetPreviewViewportResult): unknown => ({
  status: v.status,
  detail: v.detail,
  findings: v.findings,
  acceptance: v.acceptance,
  outline: v.outline.slice(0, 300),
  openedLinks: v.openedLinks,
});

interface CaseResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  data?: unknown;
}
const results: CaseResult[] = [];

/** `KEPCUP_HARNESS_ONLY=<子串>` 只跑名字含该子串的用例（调试用）。 */
const ONLY = process.env['KEPCUP_HARNESS_ONLY'] ?? '';

async function test(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (ONLY !== '' && !name.includes(ONLY)) return;
  const t0 = Date.now();
  let result: CaseResult;
  try {
    const data = await fn();
    result = { name, ok: true, ms: Date.now() - t0, data };
  } catch (error) {
    result = {
      name,
      ok: false,
      ms: Date.now() - t0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  results.push(result);
  emit({ key: 'case', ...result });
}

const COUNTER = doc(`<h2>计数器</h2>
<p>当前计数：<span id="count">…</span></p>
<p id="theme"></p>
<button id="inc" type="button">加一</button>
<button id="reset" type="button">清空</button>
<label>备注 <input id="note" type="text" placeholder="写点什么"></label>
<ul id="list"></ul>
<script>
  var count = 0;
  function render() { document.getElementById('count').textContent = String(count); }
  async function load() {
    var v = await kepcup.storage.get('count');
    count = typeof v === 'number' ? v : 0;
    render();
    var res = await kepcup.query('recent', {});
    var ul = document.getElementById('list');
    ul.innerHTML = '';
    res.rows.forEach(function (r) { var li = document.createElement('li'); li.className = 'row'; li.textContent = r.text; ul.appendChild(li); });
    document.getElementById('theme').textContent = '主题 ' + (await kepcup.theme());
  }
  document.getElementById('inc').addEventListener('click', async function () { count += 1; render(); await kepcup.storage.set('count', count); });
  document.getElementById('reset').addEventListener('click', async function () { count = 0; render(); await kepcup.storage.delete('count'); });
  load();
</script>`);

const COUNTER_FIXTURES = {
  storage: { count: 2 },
  queries: { recent: [{ text: '第一条' }, { text: '第二条' }] },
};
const COUNTER_ACCEPTANCE = [
  {
    id: 'inc',
    desc: '加一后计数为 3',
    must: true,
    steps: [{ click: '#inc' }],
    expect: [{ selector: '#count', textEquals: '3' }, { noErrors: true }],
  },
  {
    id: 'rows',
    desc: '列表来自查询',
    expect: [
      { selector: '.row', count: 2 },
      { selector: '#list', textContains: '第二条' },
      { noBadText: true },
    ],
  },
  {
    id: 'note',
    desc: '备注可填写',
    steps: [{ fill: '#note', value: '你好' }, { press: 'Enter' }],
    expect: [{ selector: '#note', valueEquals: '你好' }],
  },
];

async function main(): Promise<void> {
  // 骨架模板（P3b）：S2 也必须零问题——同时是 kit（基础样式 + kepcup.ui 图表）在真实 Chromium 里的运行验证。
  for (const template of WIDGET_TEMPLATES) {
    await test(`template ${template.name}: no findings in both viewports (kit runtime)`, async () => {
      const out = await preview(template.html, {
        viewports: [
          { width: 360, theme: 'light' },
          { width: 720, theme: 'dark' },
        ],
        fixtures: {
          storage: {},
          queries: {
            summary: [
              { label: '一月', value: 12 },
              { label: '二月', value: 30 },
            ],
          },
        },
      });
      for (const v of out.viewports) {
        expect(v.status === 'ok', `status ${v.status} ${v.detail}`);
        expect(v.findings.length === 0, `findings: ${JSON.stringify(v.findings)}`);
      }
      if (template.name === 'dashboard') {
        // fixtures 两行：合计 42、SVG 图表画出来了、表格 2 行数据 + 表头。
        const outline = out.viewports[0]!.outline;
        expect(
          outline.includes('42') && outline.includes('[svg') && outline.includes('[表格 3行'),
          `chart/table not rendered: ${outline}`,
        );
      }
      return out.viewports.map(brief);
    });
  }

  await test('correct widget: no findings, acceptance passes with fixtures, both viewports', async () => {
    const out = await preview(COUNTER, {
      viewports: [
        { width: 360, theme: 'light' },
        { width: 720, theme: 'dark' },
      ],
      fixtures: COUNTER_FIXTURES,
      acceptance: COUNTER_ACCEPTANCE,
    });
    for (const v of out.viewports) {
      expect(v.status === 'ok', `status ${v.status} ${v.detail}`);
      expect(v.findings.length === 0, `findings: ${JSON.stringify(v.findings)}`);
      expect(
        v.acceptance.length === 3 && v.acceptance.every((a) => a.passed),
        `acceptance: ${JSON.stringify(v.acceptance)}`,
      );
      expect(
        v.outline.includes('计数器') && v.outline.includes('[按钮] 加一'),
        `outline: ${v.outline}`,
      );
      expect(v.outline.includes(`主题 ${v.theme}`), `theme not in outline: ${v.outline}`);
    }
    return out.viewports.map(brief);
  });

  await test('uncaught exception at load, line numbers match the draft', async () => {
    const src = doc(`<p>hello</p>
<script>
  var a = 1;
  notDefinedFn();
</script>`);
    // doc(): body starts on line 5 → `notDefinedFn();` is line 8.
    expect(src.split('\n')[7] === '  notDefinedFn();', 'fixture line drifted');
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    const hit = v!.findings.find((f) => f.rule === 'runtime.error');
    expect(hit !== undefined, `no runtime.error: ${JSON.stringify(v!.findings)}`);
    expect(hit.line === 8 && hit.col === 3, `position ${hit.line}:${hit.col}`);
    expect(hit.trigger === undefined, 'load-time error must have no trigger');
    expect(v!.findings.filter((f) => f.rule === 'runtime.error').length === 1, 'not deduped');
    return brief(v!);
  });

  await test('async rejection', async () => {
    const src = doc(`<p>x</p>
<script>
  Promise.reject(new Error('rejected!'));
</script>`);
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    const hit = v!.findings.find((f) => f.rule === 'runtime.rejection');
    expect(hit?.message.includes('rejected!'), JSON.stringify(v!.findings));
    expect(v!.findings.filter((f) => f.rule === 'runtime.rejection').length === 1, 'not deduped');
    return brief(v!);
  });

  await test('CSP violation (external script) + console output', async () => {
    const src = doc(`<p>x</p>
<script src="https://cdn.example.com/lib.js"></script>
<script>
  console.error('bad thing', { a: 1 });
  console.warn('careful');
</script>`);
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    const csp = v!.findings.filter((f) => f.rule === 'csp.violation');
    expect(
      csp.length === 1 && csp[0]!.message.includes('https://cdn.example.com/lib.js'),
      JSON.stringify(v!.findings),
    );
    // Element-initiated loads carry no source position in the CSP event (lineNumber 0): no line.
    expect(
      !v!.findings.some((f) => f.message.includes('资源加载失败')),
      'resource failure not merged into CSP',
    );
    const err = v!.findings.find((f) => f.rule === 'console.error');
    expect(err?.message === 'bad thing {"a":1}' && err.line === 8, JSON.stringify(err));
    expect(
      v!.findings.some((f) => f.rule === 'console.warn' && f.message === 'careful' && f.line === 9),
      'warn',
    );
    return brief(v!);
  });

  await test('tampered probe: console-message still yields the uncaught exception', async () => {
    // Breaking Array.prototype.push makes the probe drop every finding it records.
    const src = doc(`<p>x</p>
<script>
  Array.prototype.push = function () { return 0; };
  setTimeout(function () { var o = null; o.boom(); }, 0);
</script>`);
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    const hit = v!.findings.find((f) => f.rule === 'runtime.error');
    expect(hit?.message.includes("reading 'boom'") && hit.line === 8, JSON.stringify(brief(v!)));
    return brief(v!);
  });

  await test('blank page', async () => {
    const [v] = (await preview(doc('<div></div>'), { monkeyMax: 0 })).viewports;
    expect(
      v!.findings.some((f) => f.rule === 'render.blank'),
      JSON.stringify(v!.findings),
    );
    return brief(v!);
  });

  await test('bad text (NaN) and horizontal overflow', async () => {
    const src = doc(`<p id="t"></p>
<div style="width:600px;background:#eee">wide</div>
<script>
  document.getElementById('t').textContent = '合计：' + (undefined * 2) + ' 元';
</script>`);
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    expect(
      v!.findings.some((f) => f.rule === 'render.bad-text' && f.message.includes('NaN')),
      JSON.stringify(v!.findings),
    );
    expect(
      v!.findings.some((f) => f.rule === 'render.overflow-x'),
      'overflow',
    );
    return brief(v!);
  });

  await test('monkey-triggered error records the trigger', async () => {
    const src = doc(`<p>点按钮</p>
<button id="ok" type="button" onclick="document.getElementById('out').textContent = '好'">好的</button>
<button id="boom" type="button" onclick="explode()">爆炸</button>
<p id="out"></p>
<script>
  function explode() { var o = null; return o.x; }
</script>`);
    const [v] = (await preview(src)).viewports;
    const hit = v!.findings.find((f) => f.rule === 'runtime.error');
    expect(hit?.trigger === 'button#boom「爆炸」', JSON.stringify(v!.findings));
    expect(hit.line === 10, `line ${hit.line}`);
    return brief(v!);
  });

  await test('acceptance failure reports the actual value', async () => {
    const src = doc(`<input id="amount" type="number">
<button id="add" type="button">添加</button>
<p id="total">合计 0</p>
<script>
  var sum = 0;
  document.getElementById('add').addEventListener('click', function () {
    sum += Number(document.getElementById('amount').value);
    document.getElementById('total').textContent = '合计 ' + sum;
  });
</script>`);
    const [v] = (
      await preview(src, {
        monkeyMax: 0,
        acceptance: [
          {
            id: 'wrong',
            desc: '故意写错的期望',
            must: true,
            steps: [{ fill: '#amount', value: '12' }, { click: '#add' }],
            expect: [{ selector: '#total', textEquals: '合计 99' }],
          },
          {
            id: 'missing',
            desc: '不存在的元素',
            steps: [{ click: '#nope' }],
            expect: [{ noErrors: true }],
          },
          { id: 'right', desc: '累加', expect: [{ selector: '#total', textContains: '12' }] },
        ],
      })
    ).viewports;
    const [wrong, missing, right] = v!.acceptance;
    expect(
      wrong?.passed === false && wrong.must && wrong.detail.includes('合计 12'),
      JSON.stringify(wrong),
    );
    expect(missing?.passed === false && missing.detail.includes('#nope'), JSON.stringify(missing));
    expect(right?.passed === true, JSON.stringify(right));
    return brief(v!);
  });

  await test('openLink is recorded, never opened', async () => {
    const src = doc(`<button id="go" type="button">打开文档</button>
<p id="r"></p>
<script>
  document.getElementById('go').addEventListener('click', async function () {
    var opened = await kepcup.openLink('https://example.com/docs');
    document.getElementById('r').textContent = opened ? '已打开' : '未打开';
  });
</script>`);
    const [v] = (await preview(src)).viewports;
    expect(
      v!.openedLinks.length === 1 && v!.openedLinks[0] === 'https://example.com/docs',
      JSON.stringify(brief(v!)),
    );
    expect(v!.findings.length === 0, JSON.stringify(v!.findings));
    return brief(v!);
  });

  await test('reply without a real user gesture resolves false, never sends, no findings', async () => {
    const src = doc(`<button id="go" type="button">发给 Bot</button>
<p id="r"></p>
<script>
  document.getElementById('go').addEventListener('click', async function () {
    var sent = await kepcup.reply('清单：牛奶');
    document.getElementById('r').textContent = sent ? '已发送' : '未发送';
  });
</script>`);
    const [v] = (await preview(src)).viewports;
    expect(v!.status === 'ok', `status ${v!.status} ${v!.detail}`);
    expect(v!.findings.length === 0, JSON.stringify(v!.findings));
    return brief(v!);
  });

  await test('infinite loop at load → timeout, then the next preview works', async () => {
    const t0 = Date.now();
    const [v] = (await preview(doc('<p>spin</p>\n<script>for(;;){}</script>'))).viewports;
    const tLoop = Date.now() - t0;
    expect(v!.status === 'timeout', `status ${v!.status} ${v!.detail}`);
    expect(v!.findings[0]?.rule === 'preview.timeout', JSON.stringify(v!.findings));
    const t1 = Date.now();
    const [next] = (
      await preview(COUNTER, { fixtures: COUNTER_FIXTURES, acceptance: COUNTER_ACCEPTANCE })
    ).viewports;
    expect(next!.status === 'ok' && next!.findings.length === 0, JSON.stringify(brief(next!)));
    return { loop: brief(v!), loopMs: tLoop, nextMs: Date.now() - t1 };
  });

  await test('monkey-triggered infinite loop → timeout naming the element; hung process reaped', async () => {
    const t0 = Date.now();
    const src = doc(`<p>别点</p>
<button id="spin" type="button" onclick="for(;;){}">转圈</button>`);
    let pid: number | null = null;
    const watcher = setInterval(() => {
      pid = previewFramePid() ?? pid;
    }, 100);
    const [v] = (await preview(src)).viewports;
    clearInterval(watcher);
    expect(v!.status === 'timeout', `status ${v!.status} ${JSON.stringify(brief(v!))}`);
    const timeout = v!.findings.find((f) => f.rule === 'preview.timeout');
    expect(timeout?.trigger === 'button#spin「转圈」', JSON.stringify(v!.findings));
    const ms = Date.now() - t0;
    // Removal of the iframe lets Chromium reap the process; the host kills it after 3s otherwise.
    await sleep(3_500);
    expect(pid !== null && !pidAlive(pid), `hung process ${pid} still alive`);
    const [next] = (await preview(doc('<p>ok</p>'))).viewports;
    expect(next!.status === 'ok', `next ${next!.status}`);
    return { ms, timeout };
  });

  await test('widget process killed mid-run → crashed', async () => {
    // Keeps mutating the DOM so the probe's settle phase lasts its full cap.
    const src = doc(`<p id="t">tick</p>
<script>setInterval(function () { document.getElementById('t').dataset.n = String(Date.now()); }, 20);</script>`);
    const running = preview(src);
    let killed: number | null = null;
    for (let i = 0; i < 40 && killed === null; i++) {
      await sleep(100);
      const pid = previewFramePid();
      if (pid !== null) {
        process.kill(pid, 'SIGKILL');
        killed = pid;
      }
    }
    expect(killed !== null, 'never saw the widget frame');
    const [v] = (await running).viewports;
    expect(v!.status === 'crashed', `status ${v!.status} ${v!.detail}`);
    const [next] = (await preview(doc('<p>ok</p>'))).viewports;
    expect(next!.status === 'ok', `next ${next!.status}`);
    return brief(v!);
  });

  await test('screenshot is a non-empty, non-uniform PNG of the iframe', async () => {
    const src = doc(`<div style="background:rgb(255,0,0);height:120px">red</div>
<svg width="100" height="60"><rect width="100" height="60" fill="rgb(0,200,0)"/></svg>`);
    const [v] = (await preview(src, { screenshots: true, monkeyMax: 0 })).viewports;
    expect(v!.screenshot !== undefined, 'no screenshot');
    const image = nativeImage.createFromBuffer(Buffer.from(v!.screenshot, 'base64'));
    const size = image.getSize();
    expect(!image.isEmpty() && size.width === 360, `size ${JSON.stringify(size)}`);
    expect(!isUniformBitmap(image.toBitmap()), 'uniform screenshot');
    return { size, bytes: v!.screenshot.length };
  });
  // --- 审查修复回归（P3b review） ---------------------------------------------------------

  await test('busy widget that starves the probe → blocking timeout (not a host failure), console findings kept', async () => {
    // 每 30ms 来一段 290ms 的同步计算：页面能应答，但探针始终等不到 DOM 静默 / 完不成检查。
    const src = doc(`<p id="t">busy</p>
<script>
  console.error('before the storm');
  setInterval(function () { var end = Date.now() + 290; while (Date.now() < end) {} document.getElementById('t').dataset.n = String(Date.now()); }, 30);
</script>`);
    const out = await preview(src, {
      viewports: [
        { width: 360, theme: 'light' },
        { width: 720, theme: 'dark' },
      ],
    });
    // 探针够健壮时能慢慢跑完（ok）；跑不完就是阻断的 timeout——无论哪种都不能是宿主 failed（会把组件放行）。
    for (const v of out.viewports) {
      expect(v.status === 'ok' || v.status === 'timeout', `status ${v.status} ${v.detail}`);
      if (v.status === 'timeout') {
        expect(
          v.findings.some((f) => f.rule === 'preview.timeout'),
          JSON.stringify(v.findings),
        );
      }
    }
    // 一个视口超时就不再跑第二个。
    if (out.viewports[0]!.status === 'timeout') {
      expect(out.viewports.length === 1, `viewports ${out.viewports.length}`);
    }
    return out.viewports.map(brief);
  });

  await test('forged probe result from the widget is ignored', async () => {
    const src = doc(`<p>forge</p>
<script>
  parent.postMessage({ source: 'kepcup-probe', type: 'result', findings: [], acceptance: [{ id: 'x', must: true, passed: true, detail: '' }], outline: 'fake', viewport: [360, 380] }, '*');
  setTimeout(function () { null.boom; }, 0);
</script>`);
    const [v] = (await preview(src)).viewports;
    expect(v!.status === 'ok', `status ${v!.status} ${v!.detail}`);
    expect(v!.outline !== 'fake', 'forged outline accepted');
    expect(
      v!.findings.some((f) => f.rule === 'runtime.error'),
      JSON.stringify(v!.findings),
    );
    return brief(v!);
  });

  await test('no network egress: fetch / WebSocket / img / WebRTC / navigation / popups all fail, server sees 0 hits', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end('hi');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const src = doc(`<p id="r">probing</p>
<img src="${base}/img.png">
<script>
  try { fetch('${base}/fetch').catch(function () {}); } catch (e) {}
  try { new WebSocket('ws://127.0.0.1:${port}/ws'); } catch (e) {}
  try { navigator.sendBeacon('${base}/beacon', 'x'); } catch (e) {}
  try {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] });
    pc.createDataChannel('x');
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () {});
  } catch (e) {}
  try { window.open('${base}/popup'); } catch (e) {}
  try { top.location.href = '${base}/top'; } catch (e) {}
  setTimeout(function () { try { location.href = '${base}/self'; } catch (e) {} }, 50);
</script>`);
      const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
      await sleep(1_500);
      expect(hits === 0, `loopback server saw ${hits} hits`);
      return { status: v!.status, findings: v!.findings.map((f) => f.rule) };
    } finally {
      server.close();
    }
  });

  await test('kit charts with edge values render without bad text', async () => {
    const src = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="kepcup-kit" content="1"></head>
<body>
<div id="bar"></div><div id="line"></div><div id="one"></div><div id="pie"></div>
<p id="f"></p>
<script>
  kepcup.ui.bar('#bar', [{ label: null, value: -3 }, { label: '二', value: 'x' }, { label: '三', value: 5 }]);
  kepcup.ui.line('#line', { labels: ['a'], series: [{ name: 's', values: [1, 2, 3] }] });
  kepcup.ui.line('#one', [{ label: '唯一', value: 7 }]);
  kepcup.ui.pie('#pie', [{ value: 1 }, { label: '二', value: 1 }]);
  document.getElementById('f').textContent = [kepcup.ui.format(null), kepcup.ui.format(NaN), kepcup.ui.format(1234.5)].join(' ');
</script>
</body>
</html>`;
    const [v] = (await preview(src, { monkeyMax: 0 })).viewports;
    expect(v!.status === 'ok', `status ${v!.status}`);
    expect(v!.findings.length === 0, JSON.stringify(v!.findings));
    expect(v!.outline.includes('— — 1,234.5'), `format: ${v!.outline}`);
    return brief(v!);
  });

  await test('two concurrent runs queue; an exhausted budget is reported as host busy, not as a widget timeout', async () => {
    const spin = preview(doc('<p>spin</p>\n<script>for(;;){}</script>'));
    const queued = preview(doc('<p>ok</p>'), { budgetMs: 3_000 });
    const later = preview(doc('<p>ok</p>'));
    const [spun, busy, ok] = await Promise.all([spin, queued, later]);
    expect(spun.viewports[0]!.status === 'timeout', `spin ${spun.viewports[0]!.status}`);
    expect(
      busy.viewports[0]!.status === 'failed' && busy.viewports[0]!.detail.includes('繁忙'),
      JSON.stringify(brief(busy.viewports[0]!)),
    );
    expect(ok.viewports[0]!.status === 'ok', `later ${ok.viewports[0]!.status}`);
    return { busy: brief(busy.viewports[0]!) };
  });

  await test('shell renderer crashed between runs → next run recovers on a fresh window', async () => {
    await preview(doc('<p>warm</p>'));
    const shell = webContents
      .getAllWebContents()
      .find(
        (wc) => wc.getURL().startsWith('file:') && wc.getURL().includes('kepcup-widget-preview-'),
      );
    expect(shell !== undefined, 'no preview shell webContents');
    shell!.forcefullyCrashRenderer();
    await sleep(500);
    const [v] = (
      await preview(COUNTER, { fixtures: COUNTER_FIXTURES, acceptance: COUNTER_ACCEPTANCE })
    ).viewports;
    expect(v!.status === 'ok' && v!.findings.length === 0, JSON.stringify(brief(v!)));
    return brief(v!);
  });

  await test('dispose mid-run rejects later runs and settles the in-flight one', async () => {
    const running = preview(doc('<p>spin</p>\n<script>for(;;){}</script>'));
    await sleep(500);
    host.dispose();
    const settled = await Promise.race([
      running.then(
        () => 'settled',
        () => 'settled',
      ),
      sleep(15_000).then(() => 'hung'),
    ]);
    expect(settled === 'settled', 'in-flight run never settled after dispose');
    let rejected = false;
    try {
      await preview(doc('<p>x</p>'));
    } catch {
      rejected = true;
    }
    expect(rejected, 'run after dispose was not rejected');
    return { settled };
  });
}

function previewFramePid(): number | null {
  for (const wc of webContents.getAllWebContents()) {
    try {
      const frame = wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(PREVIEW_URL_PREFIX));
      if (
        frame !== undefined &&
        frame.osProcessId > 0 &&
        frame.osProcessId !== wc.mainFrame.osProcessId
      ) {
        return frame.osProcessId;
      }
    } catch {
      // Destroyed webContents / frame.
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void app.whenReady().then(async () => {
  const t0 = Date.now();
  try {
    await main();
  } catch (error) {
    results.push({
      name: 'FATAL',
      ok: false,
      ms: 0,
      error: error instanceof Error ? error.stack : String(error),
    });
  }
  host.dispose();
  const failedCases = results.filter((r) => !r.ok).map((r) => r.name);
  emit({
    key: 'summary',
    ok: failedCases.length === 0,
    passed: results.length - failedCases.length,
    failed: failedCases,
    ms: Date.now() - t0,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  });
  app.exit(failedCases.length === 0 ? 0 : 1);
});
