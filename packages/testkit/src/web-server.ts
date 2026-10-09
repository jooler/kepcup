import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local test web server for the P11 browser tools (docs/dev/phases/
 * P11-browser.md 测试要求): fixture pages with forms, links, downloadable
 * files, cookie set/read and reflection — everything runs on 127.0.0.1 so
 * tests never touch the real internet.
 */
export interface TestWebServer {
  url: string;
  port: number;
  requestsServed(): number;
  stop(): Promise<void>;
}

export const WEB_FORM_USER = 'e2e-user';

function page(body: string): string {
  // The fixture strings carry their own <title>; hoist it into <head> so the
  // placeholder resolves and no stray title text node lands in the body.
  const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '';
  const rest = body.replace(/<title>[\s\S]*?<\/title>/, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${rest}</body></html>`;
}

const INDEX_PAGE = page(`
<title>P11 夹具首页</title>
<h1>fixture-home-marker</h1>
<div style="width:120px;height:80px;background:rgb(200,60,60)"></div>
<div style="width:120px;height:80px;background:rgb(60,160,80);margin-top:8px"></div>
<div style="width:120px;height:80px;background:rgb(60,80,200);margin-top:8px"></div>
<ul>
  <li><a id="form-link" href="/form">打开表单</a></li>
  <li><a id="download-link" href="/files/report.txt" download>下载报告</a></li>
  <li><a id="cookie-link" href="/cookie-set">设置 Cookie</a></li>
  <li><a id="reader-link" href="/cookie-read">读取 Cookie</a></li>
  <li><a id="large-link" href="/large">打开大页面</a></li>
</ul>
`);

const FORM_PAGE = page(`
<title>P11 表单页</title>
<h1>fixture-form-marker</h1>
<form id="f" action="/submit" method="get">
  <input id="username" name="username" type="text" value=""/>
  <select id="plan" name="plan"><option value="free">free</option><option value="pro">pro</option></select>
  <button id="submit-btn" type="submit">提交表单</button>
</form>
`);

const COOKIE_SET_PAGE = page(`
<title>P11 已设置 Cookie</title>
<h1>cookie-set-page</h1>
<script>document.cookie = 'fixture_sid=SID1234; path=/';</script>
`);

const COOKIE_READ_PAGE = page(`
<title>P11 Cookie 状态</title>
<h1>cookie-read-page</h1>
<p id="jar"></p>
<script>
  // One text node (textContent) so the AX tree exposes the whole line as a
  // single string — document.write would split it into separate AX nodes.
  document.getElementById('jar').textContent = 'COOKIE_JAR=[' + document.cookie + ']';
</script>
`);

/**
 * Popup scheme traps (BR-P11-002): page-controlled `window.open` targets with
 * non-http(s) schemes must never reach the page via the host's window-open
 * handler; the http(s) button is the positive control (same-page open).
 */
const POPUP_TRAP_PAGE = page(`
<title>P11 弹窗陷阱</title>
<h1>popup-trap-marker</h1>
<button id="file-trap" type="button" onclick="window.open('file:///etc/passwd')">打开文件陷阱</button>
<button id="js-trap" type="button" onclick="window.open('javascript:void(document.title)')">打开脚本陷阱</button>
<button id="http-open" type="button" onclick="window.open('/form')">打开表单页</button>
`);

/**
 * W1 stale-ref fixture: the button keeps its DOM node (same backendNodeId) but
 * is re-rendered with another name shortly after load — a click on the old ref
 * must be refused (BROWSER_REF_STALE) without running the handler. The
 * password field drives the forced-sensitive browser_type path.
 */
const SPA_PAGE = page(`
<title>P11 SPA 重渲染</title>
<h1>fixture-spa-marker</h1>
<p id="status">SPA_STATUS=idle</p>
<button id="target" type="button" onclick="document.getElementById('status').textContent = 'SPA_STATUS=clicked'">删除 张三</button>
<label>登录密码 <input id="pw" name="pw" type="password"/></label>
<script>
  setTimeout(function () { document.getElementById('target').textContent = '删除 李四'; }, 1500);
</script>
`);

function submitPage(query: string): string {
  return page(`<title>P11 提交完成</title><h1>fixture-submitted-marker</h1><p>SUBMITTED_QUERY=${query}</p>`);
}

/**
 * Complex-page fixture (docs 任务 3 技术点：AXTree 输出规模定标)：interactive
 * elements and text both far beyond the snapshot caps (150 / 4000), plus deep
 * nesting so the raw AX tree is large. Deterministic content.
 */
function largePage(): string {
  const buttons = Array.from(
    { length: 400 },
    (_, i) => `<div><button id="lb-${i}" type="button">大页面按钮 ${i + 1}</button></div>`,
  ).join('\n');
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) =>
      `<p>大页面段落 ${i + 1}：${'内容样本'.repeat(50)}</p>`,
  ).join('\n');
  return page(`<title>P11 大页面</title><h1>fixture-large-marker</h1>${buttons}${paragraphs}`);
}

export async function startTestWebServer(): Promise<TestWebServer> {
  let served = 0;
  const server: Server = createServer((req, res) => {
    handle(req, res, () => {
      served += 1;
    });
  });
  const handle = (req: IncomingMessage, res: ServerResponse, mark: () => void) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (body: string, contentType = 'text/html; charset=utf-8') => {
      mark();
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    };
    switch (url.pathname) {
      case '/':
        send(INDEX_PAGE);
        return;
      case '/form':
        send(FORM_PAGE);
        return;
      case '/submit':
        send(submitPage(url.search.startsWith('?') ? url.search.slice(1) : url.search));
        return;
      case '/cookie-set':
        send(COOKIE_SET_PAGE);
        return;
      case '/cookie-read':
        send(COOKIE_READ_PAGE);
        return;
      case '/popup-trap':
        send(POPUP_TRAP_PAGE);
        return;
      case '/redirect':
        // Real 302: the tool's reported page lands on /redirected — the final
        // URL is page-controlled (BR-P11-001 regression fixture).
        mark();
        res.writeHead(302, { location: '/redirected?from=fixture-redirect' });
        res.end();
        return;
      case '/redirected':
        send(
          page(
            `<title>P11 重定向落点</title><h1>fixture-redirected-marker</h1><p>REDIRECT_QUERY=${url.search}</p>`,
          ),
        );
        return;
      case '/large':
        send(largePage());
        return;
      case '/spa':
        send(SPA_PAGE);
        return;
      case '/files/report.txt':
        send('fixture download payload — P11\n', 'text/plain; charset=utf-8');
        return;
      default:
        mark();
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
  };
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requestsServed: () => served,
        stop: () => new Promise<void>((stop) => server.close(() => stop())),
      });
    });
  });
}
