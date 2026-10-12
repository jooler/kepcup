import {
  WIDGET_PREVIEW_OUTLINE_MAX_CHARS,
  WIDGET_PREVIEW_SETTLE_MAX_MS,
  WIDGET_PREVIEW_SETTLE_MS,
  WIDGET_PROBE_HOST_SOURCE,
  WIDGET_PROBE_SOURCE,
} from '@kepcup/shared';
import { WIDGET_SDK_MARKER } from './sdk-injection.js';

/**
 * S2 预览探针（D87 P3b，设计 32 §11.8.3 / §11.9）：只进**预览版** HTML（主进程隐藏窗口里跑），
 * 正式卡片永远不带它。紧跟在 SDK 垫片之后、组件任何脚本之前执行，所以它的监听器最先挂上：
 *
 * - 加载期：捕获阶段 `error`（未捕获异常 → `runtime.error`，带事件给的行列；元素上的资源加载
 *   失败先记下，结算时被 CSP 事件覆盖的并入 `csp.violation`，其余记 `console.error`「资源加载
 *   失败」）、`unhandledrejection` → `runtime.rejection`、`securitypolicyviolation` →
 *   `csp.violation`（指令 + 被拦 URI + 行号）、包装 `console.error/warn`（行号取自调用栈）。
 * - `load` 后等 DOM 静默（MutationObserver，静默 `WIDGET_PREVIEW_SETTLE_MS`、上限
 *   `WIDGET_PREVIEW_SETTLE_MAX_MS`）再向外壳报 `ready`；`load` 不来（加载期死循环）由外壳 / 主进程的
 *   时限处理。
 * - 外壳下发 `inspect`（只认 `event.source === parent`，且对组件自己的 message 监听器隐藏）后依次：
 *   大纲（取初始状态，供不看图的模型「看见」页面）→ 渲染体检 → 验收点 → 乱点冒烟，最后回报
 *   `{source:'kepcup-probe', type:'result', findings, acceptance, outline}`。执行每个验收点 / 乱点动作
 *   之前发一条 `{type:'step', trigger}`，外壳据此在超时时说出「卡在哪一步」。
 *
 * 协议（与 `apps/desktop/src/main/widget-preview-shell.ts` 的外壳页对应）：
 * - 外壳 → 探针：`{source:'kepcup-probe-host', cmd:'inspect', width, monkeyMax, acceptance, budgetMs, nonce}`（结果原样带回 nonce，外壳只认它）；
 *   `budgetMs` 是留给探针的剩余时间——验收与乱点到点即停（剩余验收点记「未执行到」），保证在
 *   主进程硬时限之前回报。
 * - `step` 发出后先让出一次事件循环再动手：同步死循环会把还没真正发出的 postMessage 一起卡住
 *   （harness 实测），外壳就说不出卡在哪一步。
 * - `ready` 还要等组件框架拿到非零视口（跨进程 iframe 的尺寸是异步同步过来的，宿主那边会推帧），
 *   上限同 DOM 静默；结果里带 `viewport: [innerWidth, innerHeight]`，宿主据此判 0×0 的运行不可信。
 * - finding：`{rule, message, line?, col?, trigger?}`；trigger 的格式是乱点元素「短选择器「文字」」
 *   （如 `button#add「添加」`）或 `验收点 <id>`；加载期的没有 trigger。
 *
 * 写法约束：整段脚本**不含换行**（行号保持与草稿 `index.html` 一致，见 {@link injectPreviewProbe}）——
 * 源码按普通多行 JS 写，模块加载时把换行与缩进折叠成单个空格，所以脚本里**不写 `//` 注释、每条语句
 * 都以 `;` 结束**（单测用 acorn 解析折叠后的结果兜底）。探针与组件同一个 realm，组件理论上能干扰
 * 它（覆盖全局、改原型）：这里只在开头抓住要用的全局引用、处处 try/catch，求的是「组件写坏了也尽量
 * 报得出」，不是安全边界（设计 32 §8 第 8 条）；防篡改对照是主进程的 `console-message`。
 * 探针不依赖 `window.kepcup`。
 */

/** 探针的唯一指纹（幂等判定）。 */
export const WIDGET_PREVIEW_PROBE_MARKER = 'kepcup-widget-probe-v1';

const PROBE_SOURCE = String.raw`
(function () {
  'use strict';
  var W = window;
  var DOC = W.document;
  var PARENT = W.parent;
  var SRC = ${JSON.stringify(WIDGET_PROBE_SOURCE)};
  var HOST_SRC = ${JSON.stringify(WIDGET_PROBE_HOST_SOURCE)};
  var SETTLE = ${WIDGET_PREVIEW_SETTLE_MS};
  var SETTLE_MAX = ${WIDGET_PREVIEW_SETTLE_MAX_MS};
  var OUTLINE_MAX = ${WIDGET_PREVIEW_OUTLINE_MAX_CHARS};
  var MAX_FINDINGS = 150;
  var Prom = W.Promise;
  var D = W.Date;
  var now = function () { return D.now(); };
  var later = W.setTimeout.bind(W);
  var raf = typeof W.requestAnimationFrame === 'function' ? W.requestAnimationFrame.bind(W) : null;
  var MO = W.MutationObserver;
  var CON = W.console;
  var HREF = String(W.location.href);
  var Ev = W.Event;
  var MEv = W.MouseEvent || W.Event;
  var PEv = W.PointerEvent || MEv;
  var KEv = W.KeyboardEvent || W.Event;
  var IEv = W.InputEvent || W.Event;
  var IN = W.HTMLInputElement;
  var TA = W.HTMLTextAreaElement;
  var SE = W.HTMLSelectElement;
  var setterOf = function (C) {
    try { var d = Object.getOwnPropertyDescriptor(C.prototype, 'value'); return d && d.set ? d.set : null; } catch (x) { return null; }
  };
  var SET_IN = setterOf(IN);
  var SET_TA = setterOf(TA);
  var SET_SE = setterOf(SE);
  var findings = [];
  var seen = Object.create(null);
  var badSeen = Object.create(null);
  var errSeq = 0;
  var errLog = [];
  var resFails = [];
  var cspUris = [];
  var trigger = null;

  function post(msg) { try { PARENT.postMessage(msg, '*'); } catch (x) {} }
  function str(v, n) {
    var s;
    try { s = typeof v === 'string' ? v : String(v); } catch (x) { s = '[无法显示的值]'; }
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function squash(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function add(rule, message, line, col, trig) {
    var msg = str(message, 500);
    var t = trig === undefined ? trigger : trig;
    var key = rule + '|' + msg + '|' + (line || 0);
    if (seen[key]) return;
    seen[key] = 1;
    if (findings.length >= MAX_FINDINGS) return;
    var f = { rule: rule, message: msg };
    if (typeof line === 'number' && line >= 1) f.line = Math.floor(line);
    if (typeof col === 'number' && col >= 1) f.col = Math.floor(col);
    if (t) f.trigger = str(t, 300);
    findings.push(f);
  }
  function noteError(msg) {
    errSeq++;
    if (errLog.length < 200) errLog.push(str(msg, 200));
  }
  function describe(v) {
    try {
      if (typeof v === 'string') return v;
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return String(v);
      if (typeof v.message === 'string' && typeof v.stack === 'string') return (v.name ? v.name + ': ' : '') + v.message;
      var j = JSON.stringify(v);
      return j === undefined ? String(v) : j;
    } catch (x) { return '[对象]'; }
  }
  /*
   * 栈里第一帧「组件自己的代码」：垫片、kit 与探针都在注入的那一行（SELF_LINE），落在这一行的帧
   * 不算——kit 里抛的错、经垫片 reject 的桥调用都定位到组件的调用处；找不到就不给位置。
   */
  function stackLoc(stack) {
    if (typeof stack !== 'string') return null;
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(HREF) < 0) continue;
      var m = /:(\d+):(\d+)\)?\s*$/.exec(lines[i]);
      if (!m) continue;
      if (+m[1] === SELF_LINE) continue;
      return { line: +m[1], col: +m[2] };
    }
    return null;
  }
  var SELF_LINE = (function () {
    try {
      var lines = String(new Error().stack).split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(HREF) < 0) continue;
        var m = /:(\d+):(\d+)\)?\s*$/.exec(lines[i]);
        if (m) return +m[1];
      }
    } catch (x) {}
    return 0;
  })();

  W.addEventListener('error', function (e) {
    try {
      var t = e ? e.target : null;
      if (t && t !== W && t.nodeType === 1) {
        resFails.push({ tag: String(t.tagName).toLowerCase(), url: str(t.src || t.href || t.currentSrc || '', 300), trigger: trigger });
        return;
      }
      var msg = e && e.message ? e.message : (e && e.error ? describe(e.error) : 'Uncaught error');
      noteError(msg);
      var line = e && e.lineno;
      var col = e && e.colno;
      if (line === SELF_LINE) {
        var loc0 = null;
        try { loc0 = e.error && typeof e.error === 'object' ? stackLoc(e.error.stack) : null; } catch (x) {}
        line = loc0 ? loc0.line : 0;
        col = loc0 ? loc0.col : 0;
      }
      add('runtime.error', msg, line, col);
    } catch (x) {}
  }, true);
  W.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e ? e.reason : undefined;
      var loc = null;
      try { loc = r && typeof r === 'object' ? stackLoc(r.stack) : null; } catch (x) {}
      var msg = describe(r);
      noteError(msg);
      add('runtime.rejection', msg, loc ? loc.line : 0, loc ? loc.col : 0);
    } catch (x) {}
  }, true);
  W.addEventListener('securitypolicyviolation', function (e) {
    try {
      var dir = e.effectiveDirective || e.violatedDirective || '';
      var blocked = String(e.blockedURI || '');
      cspUris.push(blocked);
      add('csp.violation', '内容安全策略拦截（' + dir + '）：' + (blocked || '内联代码'), e.lineNumber, e.columnNumber);
    } catch (x) {}
  }, true);
  (function () {
    var kinds = ['error', 'warn'];
    for (var i = 0; i < kinds.length; i++) {
      (function (k) {
        var orig = CON ? CON[k] : null;
        if (typeof orig !== 'function') return;
        CON[k] = function () {
          try {
            var parts = [];
            for (var a = 0; a < arguments.length && a < 8; a++) parts.push(str(describe(arguments[a]), 300));
            var loc = stackLoc(new Error().stack);
            add('console.' + k, parts.join(' ') || '(空)', loc ? loc.line : 0, loc ? loc.col : 0);
          } catch (x) {}
          return orig.apply(CON, arguments);
        };
      })(kinds[i]);
    }
  })();

  function flushResources() {
    for (var i = 0; i < resFails.length; i++) {
      var r = resFails[i];
      var covered = false;
      for (var j = 0; j < cspUris.length; j++) {
        var b = cspUris[j];
        if (b && r.url && (r.url === b || r.url.indexOf(b) === 0)) { covered = true; break; }
      }
      if (!covered) add('console.error', '资源加载失败：<' + r.tag + '> ' + (r.url || '(无地址)'), 0, 0, r.trigger);
    }
    resFails = [];
  }

  function quiet(ms, max, cb) {
    var start = now();
    var last = start;
    var mo = null;
    try {
      mo = new MO(function () { last = now(); });
      mo.observe(DOC, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (x) { mo = null; }
    var tick = function () {
      var t = now();
      if (t - last >= ms || t - start >= max) {
        try { if (mo) mo.disconnect(); } catch (x) {}
        cb();
        return;
      }
      later(tick, Math.min(50, ms));
    };
    later(tick, Math.min(50, ms));
  }
  function quietP(ms, max) { return new Prom(function (res) { quiet(ms, max, res); }); }
  function sleep(ms) { return new Prom(function (res) { later(res, ms); }); }
  async function announce(trig) {
    post({ source: SRC, type: 'step', trigger: trig });
    await sleep(5);
  }
  function shortSettle() {
    return new Prom(function (res) {
      var done = false;
      var fin = function () { if (!done) { done = true; res(); } };
      later(function () {
        try { if (raf) raf(function () { raf(fin); }); } catch (x) {}
        later(fin, 100);
      }, 50);
    });
  }

  function visible(el) {
    try {
      if (!el || !el.isConnected) return false;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (x) { return false; }
  }
  function textOf(el) {
    try {
      var t = el.innerText;
      return typeof t === 'string' ? t : String(el.textContent || '');
    } catch (x) { return ''; }
  }
  function tagOf(el) { try { return String(el.tagName || '').toUpperCase(); } catch (x) { return ''; } }
  function typeOf(el) { try { return String(el.type || '').toLowerCase(); } catch (x) { return ''; } }
  function cssIdent(s) { return typeof s === 'string' && /^[A-Za-z_][\w-]*$/.test(s); }
  function part(el) {
    var tag = tagOf(el).toLowerCase();
    if (cssIdent(el.id)) return tag + '#' + el.id;
    var cls = '';
    try {
      var cl = el.classList;
      for (var i = 0, n = 0; i < cl.length && n < 2; i++) { if (cssIdent(cl[i])) { cls += '.' + cl[i]; n++; } }
    } catch (x) {}
    var p = el.parentElement;
    if (p && !cls) {
      var same = 0;
      var idx = 0;
      for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName === el.tagName) { same++; if (c === el) idx = same; }
      }
      if (same > 1) cls = ':nth-of-type(' + idx + ')';
    }
    return tag + cls;
  }
  function selectorOf(el) {
    try {
      var s = part(el);
      var p = el.parentElement;
      var depth = 0;
      while (s.indexOf('#') < 0 && p && p !== DOC.body && p !== DOC.documentElement && depth < 2) {
        s = part(p) + ' > ' + s;
        p = p.parentElement;
        depth++;
      }
      return s.slice(0, 160);
    } catch (x) { return '?'; }
  }
  function labelOf(el) {
    var t = '';
    try {
      t = squash(textOf(el));
      if (!t && typeof el.value === 'string' && tagOf(el) === 'INPUT') t = el.value;
      if (!t) t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    } catch (x) {}
    return squash(t).slice(0, 40);
  }
  function triggerOf(el) {
    var l = labelOf(el);
    return selectorOf(el) + (l ? '「' + l + '」' : '');
  }

  var BAD = /\bNaN\b|\bundefined\b|\[object Object\]|\bnull\b/;
  function badTexts() {
    var out = [];
    try {
      var body = DOC.body;
      if (!body) return out;
      var lines = textOf(body).split('\n');
      for (var i = 0; i < lines.length && out.length < 10; i++) {
        var l = squash(lines[i]);
        if (l && BAD.test(l)) out.push(l.slice(0, 120));
      }
      var fields = body.querySelectorAll('input:not([type]),input[type=text],input[type=search],textarea');
      for (var j = 0; j < fields.length && out.length < 10; j++) {
        var v = String(fields[j].value || '');
        if (BAD.test(v) && visible(fields[j])) out.push(selectorOf(fields[j]) + ' 的值：' + v.slice(0, 80));
      }
    } catch (x) {}
    return out;
  }
  function reportBad(trig) {
    var b = badTexts();
    for (var i = 0; i < b.length; i++) {
      if (badSeen[b[i]]) continue;
      badSeen[b[i]] = 1;
      add('render.bad-text', '页面出现可疑文本：「' + b[i] + '」', 0, 0, trig);
    }
  }
  function widest(cw) {
    var best = null;
    var right = cw + 1;
    try {
      var all = DOC.body.querySelectorAll('*');
      for (var i = 0; i < all.length && i < 3000; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.right > right) { right = r.right; best = all[i]; }
      }
    } catch (x) {}
    return best ? selectorOf(best) + '，右缘 ' + Math.round(right) + 'px' : '';
  }
  function renderCheck() {
    var body = DOC.body;
    var hasText = !!body && squash(textOf(body)).length > 0;
    var hasMedia = false;
    if (!hasText && body) {
      var media = body.querySelectorAll('canvas,svg,img,video,picture,input,select,textarea,button');
      for (var i = 0; i < media.length; i++) { if (visible(media[i])) { hasMedia = true; break; } }
    }
    if (!hasText && !hasMedia) add('render.blank', '页面空白：body 里没有可见文字，也没有尺寸非零的 canvas / svg / img', 0, 0, null);
    var de = DOC.documentElement;
    var sw = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
    var cw = de.clientWidth;
    if (sw > cw + 1) {
      var who = widest(cw);
      add('render.overflow-x', '横向溢出：内容宽 ' + sw + 'px，超出视口 ' + cw + 'px' + (who ? '（最靠右的元素 ' + who + '）' : ''), 0, 0, null);
    }
    reportBad(null);
  }

  function fire(el, type, init, C) {
    try {
      var o = { bubbles: true, cancelable: true, composed: true };
      if (init) { for (var k in init) { if (Object.prototype.hasOwnProperty.call(init, k)) o[k] = init[k]; } }
      return el.dispatchEvent(new (C || Ev)(type, o));
    } catch (x) { return true; }
  }
  function doClick(el) {
    try { if (typeof el.focus === 'function') el.focus(); } catch (x) {}
    fire(el, 'pointerdown', null, PEv);
    fire(el, 'mousedown', null, MEv);
    fire(el, 'pointerup', null, PEv);
    fire(el, 'mouseup', null, MEv);
    try { if (typeof el.click === 'function') el.click(); else fire(el, 'click', null, MEv); } catch (x) {}
  }
  function setValue(el, v) {
    var set = null;
    try { set = el instanceof TA ? SET_TA : el instanceof SE ? SET_SE : el instanceof IN ? SET_IN : null; } catch (x) {}
    try { if (set) set.call(el, v); else el.value = v; } catch (x) { try { el.value = v; } catch (y) {} }
  }
  function fill(el, v) {
    try { if (typeof el.focus === 'function') el.focus(); } catch (x) {}
    var editable = false;
    try { editable = !!el.isContentEditable && tagOf(el) !== 'INPUT' && tagOf(el) !== 'TEXTAREA'; } catch (x) {}
    if (editable) { try { el.textContent = v; } catch (x) {} } else setValue(el, v);
    fire(el, 'input', { inputType: 'insertText', data: v }, IEv);
    fire(el, 'change', null, Ev);
  }
  function pick(el, value) {
    var opts;
    try { opts = el.options; } catch (x) { opts = null; }
    if (!opts) return false;
    var hit = -1;
    for (var i = 0; i < opts.length; i++) { if (opts[i].value === value) { hit = i; break; } }
    if (hit < 0) { for (var j = 0; j < opts.length; j++) { if (squash(opts[j].text) === squash(value)) { hit = j; break; } } }
    if (hit < 0) return false;
    try { if (typeof el.focus === 'function') el.focus(); } catch (x) {}
    try { el.selectedIndex = hit; } catch (x) {}
    fire(el, 'input', null, Ev);
    fire(el, 'change', null, Ev);
    return true;
  }
  function optionList(el) {
    var out = [];
    try { for (var i = 0; i < el.options.length && i < 10; i++) out.push(el.options[i].value || squash(el.options[i].text)); } catch (x) {}
    return out.join(', ');
  }
  function buttonLike(el) {
    var tag = tagOf(el);
    var type = typeOf(el);
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    if (tag === 'A') { try { return el.hasAttribute('href'); } catch (x) { return false; } }
    if (tag === 'INPUT') return type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'checkbox' || type === 'radio';
    try { return el.getAttribute('role') === 'button'; } catch (x) { return false; }
  }
  var KEYS = { Enter: 'Enter', Return: 'Enter', Escape: 'Escape', Esc: 'Escape', Tab: 'Tab', Space: ' ', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  var KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, ' ': 32, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  function press(name, el) {
    var k = Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : name;
    var code = k === ' ' ? 'Space' : k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /[0-9]/.test(k) ? 'Digit' + k : '') : k;
    var kc = Object.prototype.hasOwnProperty.call(KEY_CODES, k) ? KEY_CODES[k] : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
    var init = { key: k, code: code, keyCode: kc, which: kc };
    var ok = fire(el, 'keydown', init, KEv);
    if (k.length === 1 || k === 'Enter') fire(el, 'keypress', { key: k, code: code, keyCode: kc, which: kc, charCode: k === 'Enter' ? 13 : k.charCodeAt(0) }, KEv);
    if (ok && (k === 'Enter' || k === ' ') && buttonLike(el)) { try { if (typeof el.click === 'function') el.click(); } catch (x) {} }
    fire(el, 'keyup', init, KEv);
  }
  function find(sel) {
    var el;
    try { el = DOC.querySelector(String(sel)); } catch (x) { return { el: null, err: '选择器无效：' + str(sel, 200) }; }
    return el ? { el: el, err: '' } : { el: null, err: '找不到元素 ' + str(sel, 200) };
  }
  function fieldText(el) {
    var t = squash(textOf(el));
    try {
      var tag = tagOf(el);
      if (!t && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) t = squash(el.value);
    } catch (x) {}
    return t;
  }
  function describeStep(s) {
    try { return str(JSON.stringify(s), 120); } catch (x) { return ''; }
  }

  async function runStep(s) {
    if (!s || typeof s !== 'object') return '步骤格式不对';
    if ('wait' in s) { await sleep(Math.min(1000, Math.max(0, Number(s.wait) || 0))); return ''; }
    if ('press' in s) {
      var target = null;
      if (s.selector) { var fp = find(s.selector); if (!fp.el) return fp.err; target = fp.el; }
      else target = DOC.activeElement || DOC.body;
      press(String(s.press), target);
      return '';
    }
    var sel = 'click' in s ? s.click : 'fill' in s ? s.fill : 'select' in s ? s.select : 'check' in s ? s.check : null;
    if (sel === null) return '不认识的步骤';
    var f = find(sel);
    if (!f.el) return f.err;
    var el = f.el;
    try { if (el.disabled) return str(sel, 200) + ' 处于禁用状态（disabled）'; } catch (x) {}
    if ('click' in s) { doClick(el); return ''; }
    if ('fill' in s) { fill(el, String(s.value)); return ''; }
    if ('select' in s) {
      return pick(el, String(s.value)) ? '' : str(sel, 200) + ' 没有值或文字为「' + str(s.value, 100) + '」的选项（现有：' + optionList(el) + '）';
    }
    var want = s.value !== false;
    var checked = false;
    try { checked = !!el.checked; } catch (x) {}
    if (checked !== want) {
      if (want || typeOf(el) !== 'radio') doClick(el);
      else { try { el.checked = false; } catch (x) {} fire(el, 'change', null, Ev); }
    }
    return '';
  }
  function checkExpect(e, startSeq) {
    if (!e || typeof e !== 'object') return '断言格式不对';
    if (e.noBadText) { var b = badTexts(); return b.length ? '页面有可疑文本：「' + b[0] + '」' : ''; }
    if (e.noErrors) { return errSeq > startSeq ? '出现了运行错误：' + (errLog[startSeq] || '（超出记录上限）') : ''; }
    var sel = String(e.selector);
    if ('count' in e) {
      var n;
      try { n = DOC.querySelectorAll(sel).length; } catch (x) { return '选择器无效：' + str(sel, 200); }
      return n === e.count ? '' : sel + ' 的数量：期望 ' + e.count + '，实际 ' + n;
    }
    var f = find(sel);
    if ('exists' in e) {
      if (!f.el && f.err.indexOf('选择器无效') === 0) return f.err;
      return !!f.el === !!e.exists ? '' : sel + (e.exists ? ' 不存在' : ' 不应存在，实际存在');
    }
    if (!f.el) return f.err;
    var t;
    if ('textContains' in e) {
      t = fieldText(f.el);
      return t.indexOf(squash(e.textContains)) >= 0 ? '' : sel + ' 的文字不含「' + str(e.textContains, 100) + '」，实际「' + str(t, 200) + '」';
    }
    if ('textEquals' in e) {
      t = fieldText(f.el);
      return t === squash(e.textEquals) ? '' : sel + ' 的文字应为「' + str(e.textEquals, 100) + '」，实际「' + str(t, 200) + '」';
    }
    if ('valueEquals' in e) {
      var v;
      try { v = f.el.value === undefined || f.el.value === null ? '' : String(f.el.value); } catch (x) { v = ''; }
      return v === String(e.valueEquals) ? '' : sel + ' 的值应为「' + str(e.valueEquals, 100) + '」，实际「' + str(v, 200) + '」';
    }
    return '不认识的断言';
  }
  async function runItem(item, deadline) {
    var id = str(item && item.id, 64);
    var res = { id: id, must: !!(item && item.must), passed: false, detail: '' };
    var startSeq = errSeq;
    trigger = '验收点 ' + id;
    await announce(trigger);
    try {
      var steps = item && Array.isArray(item.steps) ? item.steps : [];
      for (var i = 0; i < steps.length && !res.detail; i++) {
        if (now() > deadline - 200) { res.detail = '第 ' + (i + 1) + ' 步时预览时限已到'; break; }
        var err = await runStep(steps[i]);
        if (err) { res.detail = '第 ' + (i + 1) + ' 步 ' + describeStep(steps[i]) + '：' + err; break; }
        await shortSettle();
      }
      if (!res.detail) {
        await quietP(150, Math.max(0, Math.min(1000, deadline - now() - 200)));
        var expects = item && Array.isArray(item.expect) ? item.expect : [];
        for (var j = 0; j < expects.length; j++) {
          var fail = checkExpect(expects[j], startSeq);
          if (fail) { res.detail = fail; break; }
        }
        if (!res.detail) res.passed = true;
      }
    } catch (x) {
      res.detail = '执行出错：' + str(x && x.message ? x.message : x, 200);
    }
    reportBad(trigger);
    trigger = null;
    res.detail = str(res.detail, 500);
    return res;
  }

  var ACTION_SEL = 'button,[onclick],input,select,textarea,[role=button],a[href^="#"]';
  var DANGER = /删除|清空|重置|delete|clear|reset/i;
  var NO_FILL = { hidden: 1, file: 1, button: 1, submit: 1, reset: 1, image: 1 };
  function isFillable(el) {
    var tag = tagOf(el);
    if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
    return tag === 'INPUT' && !NO_FILL[typeOf(el) || 'text'];
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function sampleFor(type) {
    var d = new D();
    var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    switch (type) {
      case 'number': case 'range': return '12';
      case 'date': return day;
      case 'datetime-local': return day + 'T09:30';
      case 'time': return '09:30';
      case 'month': return day.slice(0, 7);
      case 'week': return d.getFullYear() + '-W01';
      case 'color': return '#3366cc';
      case 'email': return 'test@example.com';
      case 'url': return 'https://example.com/';
      case 'tel': return '13800000000';
      default: return '测试';
    }
  }
  function autoFill(el) {
    var tag = tagOf(el);
    if (tag === 'SELECT') {
      var n = 0;
      try { n = el.options.length; } catch (x) {}
      if (n > 0) {
        try { el.selectedIndex = n > 1 ? 1 : 0; } catch (x) {}
        fire(el, 'input', null, Ev);
        fire(el, 'change', null, Ev);
      }
      return;
    }
    var type = typeOf(el);
    if (type === 'checkbox' || type === 'radio') { doClick(el); return; }
    try { if (el.readOnly) return; } catch (x) {}
    fill(el, sampleFor(tag === 'TEXTAREA' ? 'textarea' : type));
  }
  async function monkey(max, deadline) {
    var all;
    try { all = DOC.querySelectorAll(ACTION_SEL); } catch (x) { return; }
    var fills = [];
    var clicks = [];
    var danger = [];
    var picked = 0;
    for (var i = 0; i < all.length && picked < max; i++) {
      var el = all[i];
      var type = typeOf(el);
      if (tagOf(el) === 'INPUT' && (type === 'hidden' || type === 'file')) continue;
      try { if (el.disabled) continue; } catch (x) {}
      if (!visible(el)) continue;
      picked++;
      if (isFillable(el)) fills.push(el);
      else if (DANGER.test(labelOf(el))) danger.push(el);
      else clicks.push(el);
    }
    var queue = fills.concat(clicks, danger);
    for (var q = 0; q < queue.length; q++) {
      if (now() > deadline - 300) break;
      var target = queue[q];
      if (!target.isConnected) continue;
      trigger = triggerOf(target);
      await announce(trigger);
      try { if (isFillable(target)) autoFill(target); else doClick(target); } catch (x) {}
      await shortSettle();
      reportBad(trigger);
    }
    trigger = null;
  }

  var STRUCT = 'h1,h2,h3,h4,h5,h6,button,input,select,textarea,table,ul,ol,dl,canvas,svg,img,[role=button],div,p,section,article,header,footer,main,nav,aside,form,fieldset,li,label,details,summary';
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };
  function labelForField(el) {
    try {
      var l = el.getAttribute('aria-label');
      if (!l && el.id && cssIdent(el.id)) { var lab = DOC.querySelector('label[for="' + el.id + '"]'); if (lab) l = textOf(lab); }
      if (!l && typeof el.closest === 'function') { var wrap = el.closest('label'); if (wrap) l = textOf(wrap); }
      if (!l) l = el.getAttribute('name') || '';
      return squash(l).slice(0, 40);
    } catch (x) { return ''; }
  }
  function fieldLine(el) {
    var tag = tagOf(el);
    var type = tag === 'INPUT' ? typeOf(el) || 'text' : tag.toLowerCase();
    var lab = labelForField(el);
    var head = lab ? ' ' + lab : '';
    try {
      if (tag === 'SELECT') {
        var cur = el.selectedIndex >= 0 ? squash(el.options[el.selectedIndex].text) : '';
        return '[下拉' + head + '] 当前「' + cur.slice(0, 30) + '」，共 ' + el.options.length + ' 项';
      }
      if (type === 'checkbox' || type === 'radio') return '[' + (type === 'radio' ? '单选' : '勾选') + head + '] ' + (el.checked ? '已选' : '未选');
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return '[按钮] ' + squash(el.value || lab || type).slice(0, 40);
      var v = squash(el.value || '');
      var ph = squash(el.getAttribute('placeholder') || '');
      return '[输入 ' + type + head + ']' + (v ? ' 值「' + v.slice(0, 40) + '」' : '') + (ph ? ' 提示「' + ph.slice(0, 40) + '」' : '');
    } catch (x) { return '[输入 ' + type + head + ']'; }
  }
  function buildOutline() {
    var out = [];
    var size = 0;
    var full = false;
    var push = function (line) {
      if (full || !line) return;
      line = line.slice(0, 160);
      if (size + line.length + 1 > OUTLINE_MAX - 2) { out.push('…'); full = true; return; }
      out.push(line);
      size += line.length + 1;
    };
    var walk = function (node, depth) {
      for (var c = node.firstChild; c && !full; c = c.nextSibling) {
        if (c.nodeType === 3) {
          var tx = squash(c.nodeValue || '');
          if (tx && c.parentElement && visible(c.parentElement)) push(tx.slice(0, 120));
          continue;
        }
        if (c.nodeType !== 1) continue;
        var tag = tagOf(c);
        if (SKIP_TAGS[tag] || !visible(c)) continue;
        try {
          if (/^H[1-6]$/.test(tag)) { push(tag + ' ' + squash(textOf(c)).slice(0, 80)); continue; }
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { push(fieldLine(c)); continue; }
          if (buttonLike(c) && tag !== 'A') { push('[按钮] ' + labelOf(c)); continue; }
          if (tag === 'TABLE') {
            var rows = c.rows ? c.rows.length : 0;
            var cols = 0;
            for (var r = 0; r < rows && r < 5; r++) cols = Math.max(cols, c.rows[r].cells.length);
            var headCells = [];
            if (rows > 0) { for (var k = 0; k < c.rows[0].cells.length && k < 8; k++) headCells.push(squash(textOf(c.rows[0].cells[k])).slice(0, 20)); }
            push('[表格 ' + rows + '行×' + cols + '列] ' + headCells.join(' | '));
            continue;
          }
          if (tag === 'UL' || tag === 'OL') {
            var items = [];
            var n = 0;
            for (var li = c.firstElementChild; li; li = li.nextElementSibling) {
              if (tagOf(li) !== 'LI') continue;
              n++;
              if (items.length < 3) items.push(squash(textOf(li)).slice(0, 30));
            }
            push('[列表 ' + n + ' 项] ' + items.join(' / ') + (n > 3 ? ' …' : ''));
            continue;
          }
          if (tag === 'CANVAS' || tag === 'SVG' || tag === 'IMG' || tag === 'VIDEO') {
            var rc = c.getBoundingClientRect();
            var alt = tag === 'IMG' ? squash(c.getAttribute('alt') || '') : '';
            push('[' + tag.toLowerCase() + ' ' + Math.round(rc.width) + '×' + Math.round(rc.height) + (alt ? ' ' + alt.slice(0, 30) : '') + ']');
            continue;
          }
          if (tag === 'A') { push('[链接] ' + labelOf(c)); continue; }
          if (!c.querySelector(STRUCT)) { push(squash(textOf(c)).slice(0, 120)); continue; }
        } catch (x) { continue; }
        if (depth < 40) walk(c, depth + 1);
      }
    };
    try { if (DOC.body) walk(DOC.body, 0); } catch (x) {}
    return out.join('\n');
  }

  async function inspect(cmd) {
    var budget = typeof cmd.budgetMs === 'number' && cmd.budgetMs > 0 ? cmd.budgetMs : 5000;
    var deadline = now() + budget;
    var outline = '';
    try { outline = buildOutline(); } catch (x) {}
    try { renderCheck(); } catch (x) {}
    var acc = [];
    var items = Array.isArray(cmd.acceptance) ? cmd.acceptance : [];
    for (var i = 0; i < items.length; i++) {
      if (now() > deadline - 300) {
        acc.push({ id: str(items[i] && items[i].id, 64), must: !!(items[i] && items[i].must), passed: false, detail: '预览时限内未执行到' });
        continue;
      }
      acc.push(await runItem(items[i], deadline));
    }
    var max = typeof cmd.monkeyMax === 'number' ? Math.max(0, Math.min(100, cmd.monkeyMax)) : 0;
    if (max > 0) { try { await monkey(max, deadline); } catch (x) {} }
    trigger = null;
    flushResources();
    var vw = 0;
    var vh = 0;
    try { vw = W.innerWidth; vh = W.innerHeight; } catch (x) {}
    return { source: SRC, type: 'result', nonce: cmd.nonce, findings: findings, acceptance: acc, outline: outline, viewport: [vw, vh] };
  }

  var inspecting = false;
  W.addEventListener('message', function (e) {
    try {
      if (e.source !== PARENT) return;
      var d = e.data;
      if (!d || typeof d !== 'object' || d.source !== HOST_SRC) return;
      e.stopImmediatePropagation();
      if (d.cmd !== 'inspect' || inspecting) return;
      inspecting = true;
      inspect(d).then(post, function (err) {
        flushResources();
        post({ source: SRC, type: 'result', nonce: d.nonce, findings: findings, acceptance: [], outline: '', error: str(err && err.message ? err.message : err, 300) });
      });
    } catch (x) {}
  }, true);
  function whenSized(max, cb) {
    var start = now();
    var tick = function () {
      var w = 0;
      try { w = W.innerWidth; } catch (x) {}
      if (w > 0 || now() - start >= max) { cb(); return; }
      later(tick, 25);
    };
    tick();
  }
  W.addEventListener('load', function () {
    quiet(SETTLE, SETTLE_MAX, function () {
      whenSized(SETTLE_MAX, function () { post({ source: SRC, type: 'ready' }); });
    });
  });
})();
`;

/** 折叠成一行：换行连同两侧缩进换成单个空格（脚本不含 `//` 注释与跨行字符串，见模块注释）。 */
function collapse(js: string): string {
  return js.replace(/\s*\n\s*/g, ' ').trim();
}

/** 预览探针脚本（单行 `<script>`，不含 `\n`）。 */
export const WIDGET_PREVIEW_PROBE = `<script>/* ${WIDGET_PREVIEW_PROBE_MARKER} */${collapse(PROBE_SOURCE)}</script>`;

/**
 * 把探针插进预览 HTML：紧跟在 SDK 垫片的 `</script>` 之后（垫片之后、组件脚本之前）；没有垫片时
 * 插在垫片本该在的位置（`<head…>` 之后，否则 doctype 之后，否则文首——同 `injectWidgetSdk` 的
 * quirks-mode 安全规则）。探针本身不含换行，原文后续各行的行号不变。幂等：已含探针指纹原样返回。
 */
export function injectPreviewProbe(html: string): string {
  if (html.includes(WIDGET_PREVIEW_PROBE_MARKER)) return html;
  const insertAt = (at: number): string =>
    `${html.slice(0, at)}${WIDGET_PREVIEW_PROBE}${html.slice(at)}`;
  const shim = html.indexOf(WIDGET_SDK_MARKER);
  if (shim >= 0) {
    const end = html.indexOf('</script>', shim);
    if (end >= 0) return insertAt(end + '</script>'.length);
  }
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) return insertAt(head.index + head[0].length);
  const doctype = /<!doctype\s[^>]*>/i.exec(html);
  if (doctype !== null) return insertAt(doctype.index + doctype[0].length);
  return insertAt(0);
}
