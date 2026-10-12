import {
  BOT_WIDGET_CALLS_BURST,
  BOT_WIDGET_CALLS_PER_SECOND,
  BOT_WIDGET_STORAGE_KEYS_MAX,
  BOT_WIDGET_STORAGE_QUOTA_BYTES,
  BOT_WIDGET_STORAGE_VALUE_MAX_BYTES,
  BOT_WIDGET_HEIGHT_MAX,
  BOT_WIDGET_HEIGHT_MIN,
  BOT_WIDGET_QUERY_NAME_MAX_CHARS,
  BOT_WIDGET_STORAGE_KEY_MAX_CHARS,
  MCP_APP_SCHEME,
  WIDGET_BRIDGE_HOST_SOURCE,
  WIDGET_BRIDGE_WIDGET_SOURCE,
  WIDGET_PROBE_HOST_SOURCE,
  WIDGET_PROBE_SOURCE,
  WIDGET_REPLY_MAX_CHARS,
} from '@kepcup/shared';

/**
 * S2 预览外壳页（D87 P3b，设计 32 §11.9）：主进程隐藏窗口加载的 `file://` 页面（组件 CSP 的
 * `frame-ancestors file: http://localhost:*` 要求嵌入方是应用自己的页面）。它做三件事：
 *
 * 1. 按 `BotWidgetCard` **完全相同**的属性挂 iframe（`sandbox="allow-scripts" allow=""
 *    referrerpolicy="no-referrer"`、`color-scheme: normal`），宽度 = 视口宽度；
 * 2. 扮演模拟能力桥宿主（{@link PREVIEW_SHELL_BRIDGE_JS}）：只信 `event.source === iframe.contentWindow`，
 *    回执形状与正式宿主（renderer `widget-bridge-host.ts` + `widget-bridge-guard.ts`）逐字段一致；
 * 3. 与探针对话：等 `ready`（或 iframe `load` 之后一段宽限仍没等到就照样下发），下发 `inspect`，
 *    把探针的 `result` 连同记录的外链、iframe 矩形交还主进程。
 *
 * 主进程不经 preload，直接 `executeJavaScript('window.__kcPreview.run(cfg)')` 驱动（返回 Promise）；
 * `drop()` 移除 iframe、以 null 结束还挂着的 run（不留悬空 Promise），并返回当时的进度（超时诊断
 * 「卡在哪一步」）；`ping()` 判外壳本身是否还活着。
 */

/**
 * 模拟能力桥（纯函数源码，外壳页内联执行；单测里用 `new Function` 取出来跑协议用例）。
 * `kcBridgeHandle(state, msg)` → `{ reply, height }`：`reply` 是要回给组件的消息（null = 不回执），
 * `height` 是夹取后的 setHeight（外壳拿来调 iframe 高度，截图与真实卡片一致）。
 * state：`{ kv: 无原型对象（fixtures.storage 的 JSON 深拷贝）, queries, theme, links: [], tokens?, refillAt? }`。
 * 与正式宿主同样的限额（审查修复）：单值 / 总量 / 键数（`WIDGET_STORAGE_QUOTA`）与 storage + query
 * 合计的令牌桶限流（`WIDGET_RATE_LIMITED`）——预览要暴露真实卡片会拒绝的写法，而不是更宽松。
 * 在途上限不模拟（这里同步回执，没有在途）。
 * 与正式宿主一致的语义：每个带可解析 id 的请求恰好一条回执；`storage.get` 未命中不带 value；
 * `query` → `{rows, truncated:false}`（按名字取 fixtures，缺省空数组）；`openLink` 只记录（https 才
 * 记）并回 `value:false`（相当于用户没有同意打开，组件不会因此收到异常）；`theme.get` → 视口主题。
 * 写法：只用 ES5 语法、不依赖外层变量（源码被原样内联）。
 */
export const PREVIEW_SHELL_BRIDGE_JS = String.raw`function kcBridgeHandle(state, msg) {
  var METHODS = { 'storage.get': 1, 'storage.set': 1, 'storage.delete': 1, 'storage.list': 1, query: 1, openLink: 1, reply: 1, 'theme.get': 1, setHeight: 1 };
  var KEY_MAX = ${BOT_WIDGET_STORAGE_KEY_MAX_CHARS};
  var NAME_MAX = ${BOT_WIDGET_QUERY_NAME_MAX_CHARS};
  var REPLY_MAX = ${WIDGET_REPLY_MAX_CHARS};
  var H_MIN = ${BOT_WIDGET_HEIGHT_MIN};
  var H_MAX = ${BOT_WIDGET_HEIGHT_MAX};
  var MSG_MAX = 1048576;
  var VALUE_MAX = ${BOT_WIDGET_STORAGE_VALUE_MAX_BYTES};
  var QUOTA = ${BOT_WIDGET_STORAGE_QUOTA_BYTES};
  var KEYS_MAX = ${BOT_WIDGET_STORAGE_KEYS_MAX};
  var BURST = ${BOT_WIDGET_CALLS_BURST};
  var PER_SECOND = ${BOT_WIDGET_CALLS_PER_SECOND};
  var bytes = function (text) { try { return new TextEncoder().encode(text).length; } catch (e) { return text.length * 3; } };
  var isObj = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
  var clone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  var ok = function (id, value) {
    var r = { source: ${JSON.stringify(WIDGET_BRIDGE_HOST_SOURCE)}, id: id, ok: true };
    if (value !== undefined) r.value = value;
    return { reply: r, height: null };
  };
  var fail = function (id, error, code) {
    return { reply: { source: ${JSON.stringify(WIDGET_BRIDGE_HOST_SOURCE)}, id: id, ok: false, error: error, code: code }, height: null };
  };
  if (!isObj(msg)) return { reply: null, height: null };
  var id = typeof msg.id === 'number' && Math.floor(msg.id) === msg.id && msg.id >= 0 ? msg.id : null;
  if (msg.source !== ${JSON.stringify(WIDGET_BRIDGE_WIDGET_SOURCE)} || id === null) return { reply: null, height: null };
  var size = 0;
  try { size = JSON.stringify(msg).length; } catch (e) { size = -1; }
  var method = msg.type;
  var payload = msg.payload;
  if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(METHODS, method) || !isObj(payload) || size < 0 || size > MSG_MAX) {
    return fail(id, '不支持的消息格式', 'INVALID_INPUT');
  }
  if (method === 'setHeight') {
    var h = payload.height;
    if (typeof h !== 'number' || !isFinite(h)) return { reply: null, height: null };
    return { reply: null, height: Math.min(H_MAX, Math.max(H_MIN, Math.ceil(h))) };
  }
  if (method.indexOf('storage.') === 0 || method === 'query') {
    var nowMs = typeof state.now === 'function' ? state.now() : Date.now();
    if (typeof state.tokens !== 'number') { state.tokens = BURST; state.refillAt = nowMs; }
    state.tokens = Math.min(BURST, state.tokens + ((nowMs - state.refillAt) / 1000) * PER_SECOND);
    state.refillAt = nowMs;
    if (state.tokens < 1) return fail(id, '组件调用宿主能力过于频繁，请稍后再试', 'WIDGET_RATE_LIMITED');
    state.tokens -= 1;
  }
  if (method.indexOf('storage.') === 0 && method !== 'storage.list') {
    var key = payload.key;
    if (typeof key !== 'string' || key.length === 0) return fail(id, 'kepcup.storage 需要一个非空字符串 key', 'INVALID_INPUT');
    if (key.length > KEY_MAX) return fail(id, 'key 过长（最多 ' + KEY_MAX + ' 字）', 'INVALID_INPUT');
    if (method === 'storage.get') return ok(id, Object.prototype.hasOwnProperty.call(state.kv, key) ? clone(state.kv[key]) : undefined);
    if (method === 'storage.delete') { delete state.kv[key]; return ok(id, undefined); }
    var json;
    try { json = JSON.stringify(payload.value); } catch (e) { json = undefined; }
    if (json === undefined) return fail(id, '值必须能 JSON 序列化', 'INVALID_INPUT');
    var size = bytes(json);
    if (size > VALUE_MAX) return fail(id, '单个值过大（上限 ' + VALUE_MAX + ' 字节）', 'WIDGET_STORAGE_QUOTA');
    var used = 0;
    var keys = 0;
    for (var k in state.kv) {
      if (!Object.prototype.hasOwnProperty.call(state.kv, k) || k === key) continue;
      keys++;
      used += bytes(JSON.stringify(state.kv[k]));
    }
    if (used + size > QUOTA) return fail(id, '这个组件的存储空间已用完（上限 ' + QUOTA + ' 字节），先删除一些键再试', 'WIDGET_STORAGE_QUOTA');
    if (!Object.prototype.hasOwnProperty.call(state.kv, key) && keys >= KEYS_MAX) return fail(id, '这个组件的键数量已达上限（' + KEYS_MAX + ' 个），先删除一些键再试', 'WIDGET_STORAGE_QUOTA');
    state.kv[key] = JSON.parse(json);
    return ok(id, undefined);
  }
  if (method === 'storage.list') return ok(id, Object.keys(state.kv).sort());
  if (method === 'query') {
    var name = payload.name;
    if (typeof name !== 'string' || name.length === 0) return fail(id, 'kepcup.query 需要一个非空字符串查询名', 'INVALID_INPUT');
    if (name.length > NAME_MAX) return fail(id, '查询名过长（最多 ' + NAME_MAX + ' 字）', 'INVALID_INPUT');
    var params = payload.params === undefined ? {} : payload.params;
    if (!isObj(params)) return fail(id, 'query 的 params 必须是一个对象', 'INVALID_INPUT');
    var rows = Object.prototype.hasOwnProperty.call(state.queries, name) ? state.queries[name] : [];
    return ok(id, { rows: clone(rows), truncated: false });
  }
  if (method === 'openLink') {
    var raw = payload.url;
    var url = null;
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 2048) {
      try {
        var u = new URL(raw);
        if (u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === '') url = u.toString();
      } catch (e) { url = null; }
    }
    if (url === null) return fail(id, '只支持打开 https 链接', 'INVALID_INPUT');
    if (state.links.length < 50) state.links.push(url);
    return ok(id, false);
  }
  if (method === 'reply') {
    var text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (text.length === 0) return fail(id, 'kepcup.reply 需要一段非空文字', 'INVALID_INPUT');
    if (text.length > REPLY_MAX) return fail(id, '回传的内容过长（最多 ' + REPLY_MAX + ' 字）', 'INVALID_INPUT');
    return ok(id, false);
  }
  return ok(id, state.theme);
}`;

/** 外壳页底色（截图「整幅与底色一致」的判定依据；暗色取卡片暗色底）。 */
export const PREVIEW_SHELL_BACKGROUND = { light: '#ffffff', dark: '#18181b' } as const;

/** 卡片未上报高度时的缺省高度（同 BotWidgetCard）。 */
export const PREVIEW_FRAME_DEFAULT_HEIGHT = 380;

/** 外壳页 HTML（写进临时文件，`loadFile` 加载）。 */
export function buildPreviewShellHtml(): string {
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `frame-src ${MCP_APP_SCHEME}:`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>widget preview</title>
<style>html,body{margin:0;padding:0;background:${PREVIEW_SHELL_BACKGROUND.light};}#host{padding:0;}</style>
</head>
<body>
<div id="host"></div>
<script>
(function () {
  'use strict';
  ${PREVIEW_SHELL_BRIDGE_JS}
  var BG = ${JSON.stringify(PREVIEW_SHELL_BACKGROUND)};
  var frame = null;
  var cur = null;
  function drop() {
    var status = cur ? { stage: cur.stage, lastTrigger: cur.lastTrigger, probeReady: cur.probeReady } : { stage: 'idle', lastTrigger: null, probeReady: false };
    if (cur) {
      cur.closed = true;
      if (!cur.done) { cur.done = true; cur.finish(null); }
    }
    if (frame) { try { frame.remove(); } catch (e) {} }
    frame = null;
    cur = null;
    return status;
  }
  window.addEventListener('message', function (event) {
    if (cur === null || frame === null || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (data === null || typeof data !== 'object') return;
    if (data.source === ${JSON.stringify(WIDGET_BRIDGE_WIDGET_SOURCE)}) {
      var out = kcBridgeHandle(cur.state, data);
      if (out.height !== null) frame.style.height = out.height + 'px';
      if (out.reply !== null) { try { frame.contentWindow.postMessage(out.reply, '*'); } catch (e) {} }
      return;
    }
    if (data.source !== ${JSON.stringify(WIDGET_PROBE_SOURCE)}) return;
    if (data.type === 'ready') cur.onReady();
    else if (data.type === 'step') cur.lastTrigger = typeof data.trigger === 'string' ? data.trigger.slice(0, 300) : null;
    else if (data.type === 'result') cur.onResult(data);
  });
  window.__kcPreview = {
    ping: function () { return 'pong'; },
    drop: drop,
    /* 截图握手（审查修复）：holdForCapture 时 ready 之后先停住，主进程截图后调 go() 再下发 inspect——
       截图是加载完成的页面，不是验收与乱点（清空 / 删除）之后的页面。 */
    whenReady: function () {
      var run = cur;
      if (run === null) return Promise.resolve(null);
      return new Promise(function (resolve) {
        if (run.held) { resolve(run.rectNow()); return; }
        run.onHeld = function () { resolve(run.rectNow()); };
      });
    },
    go: function () { if (cur !== null && cur.held) { cur.held = false; cur.inspectNow(); } return true; },
    run: function (cfg) {
      drop();
      return new Promise(function (resolve) {
        var started = Date.now();
        var kv = Object.create(null);
        var seed = cfg.fixtures && cfg.fixtures.storage ? cfg.fixtures.storage : {};
        Object.keys(seed).forEach(function (k) { kv[k] = JSON.parse(JSON.stringify(seed[k] === undefined ? null : seed[k])); });
        var run = {
          stage: 'loading', lastTrigger: null, probeReady: false, closed: false, done: false, held: false, onHeld: null,
          nonce: (function () { var a = new Uint32Array(4); crypto.getRandomValues(a); return Array.prototype.join.call(a, '-'); })(),
          state: { kv: kv, queries: (cfg.fixtures && cfg.fixtures.queries) || {}, theme: cfg.theme, links: [] }
        };
        run.finish = resolve;
        cur = run;
        document.body.style.background = BG[cfg.theme] || BG.light;
        var f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.setAttribute('allow', '');
        f.setAttribute('referrerpolicy', 'no-referrer');
        f.setAttribute('title', 'widget preview');
        f.style.cssText = 'display:block;border:0;background:transparent;color-scheme:normal;width:' + cfg.width + 'px;height:' + cfg.height + 'px;';
        var inspected = false;
        run.rectNow = function () { var r = f.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
        function inspect() {
          if (inspected || run.closed || run.held) return;
          if (cfg.holdForCapture && !run.captured) {
            run.captured = true;
            run.held = true;
            run.stage = 'capture';
            if (run.onHeld) run.onHeld();
            return;
          }
          run.inspectNow();
        }
        run.inspectNow = function () {
          if (inspected || run.closed) return;
          inspected = true;
          run.stage = 'inspecting';
          var budget = Math.max(500, cfg.budgetMs - (Date.now() - started));
          try {
            f.contentWindow.postMessage({ source: ${JSON.stringify(WIDGET_PROBE_HOST_SOURCE)}, cmd: 'inspect', width: cfg.width, monkeyMax: cfg.monkeyMax, acceptance: cfg.acceptance, budgetMs: budget, nonce: run.nonce }, '*');
          } catch (e) {}
        };
        run.onReady = function () { run.probeReady = true; inspect(); };
        run.onResult = function (data) {
          /* 只认带本次 nonce 的第一条结果：组件自己伪造的 result 不算数。 */
          if (run.closed || run.done || data.nonce !== run.nonce) return;
          run.done = true;
          run.stage = 'done';
          var r = f.getBoundingClientRect();
          resolve({
            probe: data,
            openedLinks: run.state.links.slice(),
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
            probeReady: run.probeReady
          });
        };
        f.addEventListener('load', function () {
          if (run.stage === 'loading') run.stage = 'loaded';
          setTimeout(function () { if (!run.closed) inspect(); }, cfg.readyGraceMs);
        });
        f.src = cfg.url;
        document.getElementById('host').appendChild(f);
        frame = f;
      });
    }
  };
})();
</script>
</body>
</html>
`;
}
