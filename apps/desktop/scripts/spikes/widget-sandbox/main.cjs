// D87 P3-0 spike (todo/bot-widgets-authoring.md §4 / §8): how a Bot widget behaves inside the
// production sandbox (iframe sandbox="allow-scripts" + the widget CSP served over the privileged
// kepcup-app scheme), and whether a hidden preview window can observe it.
//
// Run:  xvfb-run -a node_modules/electron/dist/electron [--no-sandbox in Docker] apps/desktop/scripts/spikes/widget-sandbox/main.cjs
// Prints one JSON line per finding and writes captures to $SPIKE_OUT (default: os.tmpdir()).
'use strict';
const { app, BrowserWindow, protocol, session, ipcMain, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEME = 'kepcup-app';
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  },
]);

// Same as buildAppCspHeader({connectDomains:[], resourceDomains:[]}) + appUiResponseHeaders.
const CSP = [
  "default-src 'none'",
  'sandbox allow-scripts',
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors file: http://localhost:*',
].join('; ');
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(), display-capture=()',
};

const PROBE = `<script>(function(){
  var send=function(type,data){try{parent.postMessage({source:'kepcup-probe',type:type,data:data},'*');}catch(e){}};
  addEventListener('error',function(e){
    var t=e.target&&e.target!==window?(e.target.tagName+' '+(e.target.src||e.target.href||'')):null;
    send('error',{message:e.message,line:e.lineno,col:e.colno,resource:t});
  },true);
  addEventListener('unhandledrejection',function(e){send('rejection',{reason:String(e.reason&&e.reason.message||e.reason)});});
  addEventListener('securitypolicyviolation',function(e){send('csp',{directive:e.effectiveDirective,blocked:e.blockedURI,line:e.lineNumber,sample:e.sample});});
  ['error','warn'].forEach(function(k){var o=console[k];console[k]=function(){send('console-'+k,Array.prototype.map.call(arguments,String).join(' '));return o.apply(this,arguments);};});
  addEventListener('load',function(){send('loaded',{});});
})();</script>`;

const page = (body, head = '') =>
  `<!DOCTYPE html><html><head><meta charset="utf-8">${PROBE}${head}</head><body>${body}</body></html>`;

const WIDGETS = {
  behaviors: page(`
<form id="f" onsubmit="window.__inlineSubmit=(window.__inlineSubmit||0)+1"><input name="a" value="1"><button id="sb" type="submit" onclick="window.__submitBtnClick=(window.__submitBtnClick||0)+1">Submit</button><button id="typeless" onclick="window.__typelessClick=(window.__typelessClick||0)+1">typeless</button></form>
<input id="copySrc" value="copied-by-widget">
<form id="f2"><input id="enterInput" name="b" value="2"></form>
<a id="blank" href="https://example.com/" target="_blank">blank</a>
<a id="dl" href="data:text/plain,hello" download="x.txt">dl</a>
<a id="hash" href="#sec">hash</a>
<div id="sec">sec</div>
<script>
  document.getElementById('f').addEventListener('submit', function(){ window.__listenerSubmit=(window.__listenerSubmit||0)+1; });
  document.getElementById('f2').addEventListener('submit', function(){ window.__enterSubmit=(window.__enterSubmit||0)+1; });
</script>`),

  errors: page(
    `<p>errors</p>
<script src="https://cdn.example.com/lib.js"></script>
<img src="https://example.com/x.png">
<script>this is a syntax error (</script>
<script>notDefinedFn();</script>
<script>Promise.reject(new Error('rejected!')); console.error('console err'); console.warn('console warn');</script>
<script>setTimeout(function(){ null.boom; }, 50);</script>
<script>let dup = 1;</script>
<script>let dup = 2;</script>`,
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto"><style>@import url(https://example.com/a.css); body{background:url(https://example.com/bg.png)}</style>',
  ),

  visual: page(`
<div style="background:rgb(255,0,0);width:200px;height:120px">red</div>
<div style="background:rgb(0,0,255);width:200px;height:120px;color:#fff">blue</div>
<svg width="100" height="60"><rect width="100" height="60" fill="rgb(0,200,0)"/></svg>`),

  loopAfterLoad: page(
    `<p>about to spin</p><script>setTimeout(function(){ for(;;){} }, 300);</script>`,
  ),
  loopAtLoad: page(`<p>spin now</p><script>for(;;){}</script>`),
  normal: page(
    `<p id="ok">ok</p><script>document.getElementById('ok').textContent='still ok';</script>`,
  ),
};

const BEHAVIOR_TESTS = `(async () => {
  const r = {};
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const t = async (name, fn) => {
    try { r[name] = await fn(); } catch (e) { r[name] = 'THROW ' + (e && e.name) + ': ' + (e && e.message); }
  };
  await t('origin', () => self.origin);
  await t('userActivation', () => navigator.userActivation && navigator.userActivation.isActive);
  await t('confirm', () => { const t0 = performance.now(); const v = confirm('ok?'); return { v, ms: Math.round(performance.now() - t0) }; });
  await t('alert', () => { const t0 = performance.now(); const v = alert('hi'); return { v: String(v), ms: Math.round(performance.now() - t0) }; });
  await t('prompt', () => { const t0 = performance.now(); const v = prompt('name?', 'def'); return { v, ms: Math.round(performance.now() - t0) }; });
  await t('localStorage', () => typeof localStorage);
  await t('localStorageGet', () => localStorage.getItem('x'));
  await t('sessionStorage', () => sessionStorage.getItem('x'));
  await t('indexedDB', () => new Promise((res) => { const q = indexedDB.open('x'); q.onsuccess = () => res('opened'); q.onerror = () => res('error ' + q.error); }));
  await t('cookie', () => { document.cookie = 'a=1'; return JSON.stringify(document.cookie); });
  await t('submitButtonClick', async () => { document.getElementById('sb').click(); await sleep(300); return { inline: window.__inlineSubmit || 0, listener: window.__listenerSubmit || 0, href: location.href }; });
  await t('submitButtonOnclick', () => window.__submitBtnClick || 0);
  await t('typelessButtonInForm', async () => { document.getElementById('typeless').click(); await sleep(200); return { onclick: window.__typelessClick || 0, submit: window.__listenerSubmit || 0, href: location.href }; });
  await t('requestSubmit', async () => { document.getElementById('f').requestSubmit(); await sleep(300); return { inline: window.__inlineSubmit || 0, listener: window.__listenerSubmit || 0 }; });
  await t('dispatchSubmitEvent', async () => { document.getElementById('f').dispatchEvent(new Event('submit', { cancelable: true })); await sleep(50); return { inline: window.__inlineSubmit || 0, listener: window.__listenerSubmit || 0 }; });
  await t('formSubmitMethod', async () => { document.getElementById('f').submit(); await sleep(300); return { href: location.href }; });
  await t('windowOpen', () => String(window.open('https://example.com/')));
  await t('blankLinkClick', async () => { document.getElementById('blank').click(); await sleep(300); return 'clicked'; });
  await t('downloadClick', async () => { document.getElementById('dl').click(); await sleep(500); return 'clicked'; });
  await t('hashLinkClick', async () => { document.getElementById('hash').click(); await sleep(100); return location.hash; });
  await t('clipboardWrite', () => navigator.clipboard.writeText('hi').then(() => 'ok'));
  await t('clipboardRead', () => navigator.clipboard.readText().then((x) => 'ok ' + x));
  await t('execCommandCopy', () => { const el = document.getElementById('copySrc'); el.select(); return document.execCommand('copy'); });
  await t('fetch', () => fetch('https://example.com/').then(() => 'ok'));
  await t('topLocation', () => { top.location.href = 'https://example.com/'; return 'no throw'; });
  return r;
})()`;

const out = process.env.SPIKE_OUT || os.tmpdir();
const results = [];
const log = (key, value) => {
  const line = JSON.stringify({ key, value });
  results.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let reports = [];
let heartbeats = [];
ipcMain.on('spike:report', (_e, msg) => {
  if (msg.type === 'heartbeat') heartbeats.push(Date.now());
  else reports.push(msg);
});

function waitFor(pred, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = pred();
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const ses = session.fromPartition('widget-preview'); // in-memory (no persist:)
  log('partition.persistent', ses.isPersistent());
  let seq = 0;
  const served = new Map();
  ses.protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const html = served.get(url.pathname.slice(1));
    if (html === undefined) return new Response('not found', { status: 404 });
    return new Response(html, { status: 200, headers: HEADERS });
  });
  const denied = [];
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    denied.push(`request:${permission}`);
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    denied.push(`check:${permission}`);
    return false;
  });
  const downloads = [];
  ses.on('will-download', (event, item) => {
    downloads.push(item.getURL());
    event.preventDefault();
  });

  const shellPath = path.join(__dirname, 'shell.html');
  let win;
  const navigations = [];
  const popups = [];
  const consoleMessages = [];
  let gone = [];
  const createWindow = async () => {
    win = new BrowserWindow({
      show: false,
      width: 760,
      height: 700,
      webPreferences: {
        partition: 'widget-preview',
        preload: path.join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler((d) => {
      popups.push(d.url);
      return { action: 'deny' };
    });
    wc.on('will-frame-navigate', (e) => {
      navigations.push({ main: e.isMainFrame, url: e.url.slice(0, 80) });
      if (!e.isMainFrame && e.frame && e.frame.url.startsWith(`${SCHEME}:`)) e.preventDefault();
      if (e.isMainFrame && !e.url.startsWith('file:')) e.preventDefault();
    });
    wc.on('console-message', (e) => {
      consoleMessages.push({
        level: e.level,
        message: String(e.message).slice(0, 120),
        frame: e.frame ? e.frame.url.slice(0, 40) : null,
      });
    });
    wc.on('render-process-gone', (_e, d) => gone.push(d.reason));
    reports = [];
    await win.loadFile(shellPath);
    await waitFor(() => reports.find((r) => r.type === 'shell-ready'), 5000);
  };

  const load = async (name, width = 360) => {
    const id = `r${++seq}`;
    served.set(id, WIDGETS[name]);
    reports = [];
    const url = `${SCHEME}://widget-${String(seq).padStart(24, 'a')}/${id}`;
    win.webContents.send('spike:command', { op: 'load', url, width });
    return url;
  };
  const widgetFrame = () =>
    win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(`${SCHEME}:`)) ?? null;

  await createWindow();
  log('electron', { electron: process.versions.electron, chrome: process.versions.chrome });

  // --- A. sandbox behaviours, with and without a user gesture -----------------------------------
  for (const gesture of [true, false]) {
    await load('behaviors');
    await waitFor(() => reports.find((r) => r.type === 'frame-load'), 5000);
    const frame = widgetFrame();
    log(
      `frame.process.isolated`,
      frame && frame.osProcessId !== win.webContents.mainFrame.osProcessId,
    );
    navigations.length = 0;
    popups.length = 0;
    downloads.length = 0;
    denied.length = 0;
    clipboard.writeText('before');
    const res = await frame.executeJavaScript(BEHAVIOR_TESTS, gesture);
    res.systemClipboardAfter = clipboard.readText();
    await sleep(300);
    log(`behaviors.gesture=${gesture}`, res);
    log(`behaviors.gesture=${gesture}.main`, {
      navigations: [...navigations],
      popups: [...popups],
      downloads: [...downloads],
      denied: [...new Set(denied)],
    });
    log(
      `behaviors.gesture=${gesture}.probe`,
      reports.filter((r) => r.type === 'probe').map((r) => r.data),
    );
  }

  // Enter key in a lone text input (implicit submission) through a real input event.
  {
    await load('behaviors');
    await waitFor(() => reports.find((r) => r.type === 'frame-load'), 5000);
    const frame = widgetFrame();
    await frame.executeJavaScript(`document.getElementById('enterInput').focus()`, true);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await sleep(300);
    log(
      'implicitSubmit.enter',
      await frame.executeJavaScript(
        `({enter: window.__enterSubmit||0, href: location.href, active: document.activeElement && document.activeElement.id})`,
      ),
    );
  }

  // --- B. error capture: probe vs webContents console-message ------------------------------------
  consoleMessages.length = 0;
  await load('errors');
  await waitFor(() => reports.find((r) => r.type === 'frame-load'), 5000);
  await sleep(500);
  log(
    'errors.probe',
    reports.filter((r) => r.type === 'probe').map((r) => r.data),
  );
  log(
    'errors.consoleMessage',
    consoleMessages.filter((m) => m.frame === null || m.frame.startsWith(SCHEME)),
  );

  // --- C. capturePage of the hidden window, including the (out-of-process) iframe -------------------
  const countColors = (img) => {
    const bmp = img.toBitmap(); // BGRA
    let red = 0;
    let blue = 0;
    let green = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      if (r > 240 && g < 20 && b < 20) red++;
      if (b > 240 && r < 20 && g < 20) blue++;
      if (g > 180 && r < 20 && b < 20) green++;
    }
    return { red, blue, green };
  };
  for (const [attempt, width] of [
    [1, 360],
    [2, 720],
    [3, 360],
  ]) {
    await load('visual', width);
    const t0 = Date.now();
    await waitFor(() => reports.find((r) => r.type === 'frame-load'), 5000);
    const tLoad = Date.now() - t0;
    let first = null;
    let captures = 0;
    let last = null;
    while (Date.now() - t0 < 5000) {
      const img = await win.webContents.capturePage();
      captures++;
      last = img;
      const c = countColors(img);
      if (c.red > 0 && c.blue > 0 && c.green > 0) {
        first = { ms: Date.now() - t0, ...c };
        break;
      }
      await sleep(50);
    }
    fs.writeFileSync(path.join(out, `widget-capture-${attempt}.png`), last.toPNG());
    log(`capture.${attempt}`, {
      width,
      frameLoadMs: tLoad,
      firstColoredCapture: first,
      captures,
      size: last.getSize(),
    });
  }

  // --- D. infinite loops ----------------------------------------------------------------------------
  // Each widget gets a fresh host (production previews would too) so we can see process reuse.
  const safeFrame = () => {
    try {
      return widgetFrame();
    } catch {
      return null;
    }
  };
  const spin = async (name) => {
    gone = [];
    await load(name);
    const loaded = await waitFor(() => reports.find((r) => r.type === 'frame-load'), 3000);
    await sleep(600);
    const frame = safeFrame();
    const framePid = frame ? frame.osProcessId : null;
    heartbeats = [];
    await sleep(1500);
    const answer = frame
      ? await Promise.race([
          frame.executeJavaScript('1+1').then(
            (v) => `answered ${v}`,
            (e) => `rejected ${e.message}`,
          ),
          sleep(1000).then(() => 'no answer in 1s'),
        ])
      : 'no frame';
    return { loaded: !!loaded, framePid, hb: heartbeats.length, answer };
  };
  const next = async () => {
    await load('normal');
    const ok = await waitFor(() => reports.find((r) => r.type === 'frame-load'), 5000);
    const f = safeFrame();
    const text = f
      ? await Promise.race([
          f.executeJavaScript(`document.getElementById('ok').textContent`),
          sleep(1500).then(() => 'TIMEOUT'),
        ])
      : null;
    return { loaded: !!ok, pid: f ? f.osProcessId : null, text };
  };

  for (const name of ['loopAfterLoad', 'loopAtLoad']) {
    const s = await spin(name);
    log(`${name}.state`, { ...s, shellPid: win.webContents.mainFrame.osProcessId });

    // A: shell removes the iframe; does Chromium reap the hung process? Where does the next widget go?
    win.webContents.send('spike:command', { op: 'unload' });
    await sleep(3000);
    const aliveAfterUnload = s.framePid ? pidAlive(s.framePid) : null;
    const n = await next();
    log(`${name}.recover.unloadIframe`, {
      loopProcessAliveAfter3s: aliveAfterUnload,
      next: n,
      nextInHungProcess: n.pid === s.framePid,
    });
    if (s.framePid && pidAlive(s.framePid)) process.kill(s.framePid, 'SIGKILL');
    await sleep(300);
  }

  // B: kill only the widget frame's process.
  {
    const s = await spin('loopAfterLoad');
    process.kill(s.framePid, 'SIGKILL');
    await sleep(500);
    heartbeats = [];
    await sleep(500);
    const n = await next();
    log('recover.killFrameProcess', {
      gone: [...gone],
      shellHeartbeatsAfterKill: heartbeats.length,
      next: n,
    });
  }

  // D: destroy the window and build a new one.
  {
    const s = await spin('loopAtLoad');
    const t0 = Date.now();
    win.destroy();
    for (let i = 1; i <= 3; i++) {
      try {
        await createWindow();
        log('D.createWindow', { attempt: i, ok: true });
        break;
      } catch (e) {
        log('D.createWindow', { attempt: i, error: String(e) });
        await sleep(500);
      }
    }
    await sleep(2500);
    const n = await next();
    log('recover.destroyWindow', {
      loopAliveAfter3s: s.framePid ? pidAlive(s.framePid) : null,
      next: n,
      ms: Date.now() - t0,
    });
    if (s.framePid && pidAlive(s.framePid)) process.kill(s.framePid, 'SIGKILL');
  }

  // C: crash the shell renderer, then load the shell again.
  {
    const s = await spin('loopAfterLoad');
    const t0 = Date.now();
    win.webContents.forcefullyCrashRenderer();
    await sleep(500);
    const alive500 = pidAlive(s.framePid);
    reports = [];
    await win.loadFile(shellPath).catch((e) => log('C.loadFile', String(e)));
    await waitFor(() => reports.find((r) => r.type === 'shell-ready'), 5000);
    await sleep(2000);
    const n = await next();
    log('recover.crashShellRenderer', {
      gone: [...gone],
      loopAliveAfter500ms: alive500,
      loopAliveLater: pidAlive(s.framePid),
      next: n,
      ms: Date.now() - t0,
    });
    if (pidAlive(s.framePid)) process.kill(s.framePid, 'SIGKILL');
  }

  log('partition.storagePath', ses.storagePath ?? null);
  fs.writeFileSync(path.join(out, 'widget-sandbox-spike.jsonl'), results.join('\n') + '\n');
}

// The real app always has its main window; don't quit when the preview window is destroyed.
app.on('window-all-closed', () => {});
app.whenReady().then(() =>
  main()
    .catch((e) => console.log(JSON.stringify({ key: 'FATAL', value: String(e && e.stack) })))
    .finally(() => app.exit(0)),
);
