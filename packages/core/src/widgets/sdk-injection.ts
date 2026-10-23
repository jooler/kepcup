import {
  BOT_WIDGET_HEIGHT_MAX,
  BOT_WIDGET_HEIGHT_MIN,
  WIDGET_BRIDGE_HOST_SOURCE,
  WIDGET_BRIDGE_WIDGET_SOURCE,
  WIDGET_HOST_THEME_EVENT,
  htmlDefinesScrollbarStyle,
  IFRAME_SCROLLBAR_CSS,
  IFRAME_SCROLLBAR_STYLE_MARKER,
  type WidgetTheme,
} from '@kepcup/shared';

/**
 * widget 侧 SDK 垫片（D81 P1，设计 32 §6）：组件跑在 `sandbox="allow-scripts
 * allow-same-origin allow-forms allow-modals"` 的独占协议源 iframe 里（完整 WebApp 档：
 * fetch / localStorage 等按真实 WebApp 可用，与宿主的可靠通道仍是 postMessage——垫片以
 * `event.source === parent` 校验回执）。core 在 `widgets.ui.open` 登记 HTML 时把这段内联
 * `<script>` 前置进去，组件即可用 `window.kepcup.*`（storage / query / openLink / theme /
 * setHeight，全部 promise 化）。
 *
 * 垫片是静态文本：关联凭据（resourceId）由渲染端宿主桥附加，不进这里——因此
 * 不存在把不可信内容拼进脚本的注入面。插入点必须是 `<!DOCTYPE html>` **之后**
 * （doctype 前出现任何节点会触发 quirks mode，改变盒模型与 CSS 语义）：优先
 * `<head>` 开标签之后，找不到再退到 doctype 的 `>` 之后，两者都没有（本就不规范
 * 的 HTML）才前置到文档最开头。已知失效模式（垫片被注释 / 属性值吞掉，`window.kepcup`
 * 不存在）：Bot 把 `<head>` 字样写进注释或属性——自伤且无副作用，不做廉价探测。
 *
 * 暴露的 API（P1 storage/openLink/theme/setHeight，P2 query，D87 P4 reply）：全部 promise 化
 * （setHeight 是通知）；被拒时 reject 的 Error 带 `code`（机器可读错误码）。
 *
 * 宿主侧约束（给组件作者的契约，工具说明 widget-tools.ts 里同样写给 Bot）：
 * - storage 与 query 合计按卡片限流——令牌桶容量 `BOT_WIDGET_CALLS_BURST`（20，看板
 *   一次性并发拉取全部查询模板没问题）、每秒回填 `BOT_WIDGET_CALLS_PER_SECOND`（5）、
 *   同时在途至多 `BOT_WIDGET_CALLS_INFLIGHT_MAX`（20）；超出得 `WIDGET_RATE_LIMITED`。
 * - query 只能读作用域视图 `widget_kv` / `conversation_messages`，单次执行超过
 *   `BOT_WIDGET_QUERY_TIMEOUT_MS` 或内存超限得 `WIDGET_QUERY_TIMEOUT`。
 * - 卡片闲置后资源过期（`WIDGET_RESOURCE_EXPIRED`）由宿主卡片自动重开并重放调用，
 *   组件通常感知不到；只有组件已被删除 / 版本已修剪时才会真的收到这个错误。
 *
 * D87 P4 L3：`kepcup.reply(text)` 只在用户手势（`navigator.userActivation.isActive`）里有效；
 * 不在手势里直接得 `false`（不报错：S2 预览的合成点击没有手势，报错会被记成未处理的拒绝）。
 * 手势之外宿主卡片还会出确认条，并有每卡冷却。
 *
 * D87 P3b（设计 32 §11.13）：
 * - **单行注入**：注入的全部内容（主题变量、垫片、可选的 kit）不含换行——S2 预览与运行时
 *   报错的行号就是 Bot 原文的行号（只有注入所在那一行的列号偏移）。为此垫片源码里不写 `//`
 *   注释、语句都以分号结束，定义时折成一行。
 * - **主题**：总是注入一组 `--kc-*` CSS 变量（只定义变量，对存量组件无副作用），垫片在组件
 *   脚本之前设好 `<html data-theme>`（open 时的主题，缺省 light）；宿主推送
 *   `{source:'kepcup-host', event:'theme', theme}` 时更新属性并派发 `kepcup:theme` 事件。
 *   `kepcup.theme()` 直接返回当前主题。`color-scheme` 只在 kit 里设——存量组件可能写死了
 *   白底，跟着暗色把默认文字变成浅色会看不清。
 * - **kepcup-kit**（按需）：HTML 带 `<meta name="kepcup-kit" content="1">` 时另注入零优先级
 *   （`:where()`）的基础样式与 `kepcup.ui`（纯 SVG 柱 / 折 / 饼图 + 数字格式化）。是否带 kit
 *   由 core 在注入时按原文判定（静态），垫片本身不探测。
 */

/** 垫片的唯一指纹：幂等判定与「确认注入成功」都认它，不用协议里组件也会写的字段值。 */
export const WIDGET_SDK_MARKER = 'kepcup-widget-sdk-v2';
/** 旧版（P1–P3a，多行）垫片的指纹：含它的 HTML 同样视为已注入。 */
const LEGACY_SDK_MARKER = 'kepcup-widget-sdk-v1';

/** 把多行脚本 / 样式折成一行（源码里不写 `//` 注释、语句以分号结束，折行安全）。 */
function oneLine(text: string): string {
  return text.replace(/\n\s*/g, ' ').trim();
}

/** 主题变量（亮 / 暗两组；只定义变量）。 */
const THEME_VARS = {
  light: {
    '--kc-bg': '#ffffff',
    '--kc-surface': '#f6f7f9',
    '--kc-fg': '#1f2328',
    '--kc-muted': '#6b7280',
    '--kc-border': '#d0d7de',
    '--kc-accent': '#2563eb',
    '--kc-danger': '#dc2626',
  },
  dark: {
    '--kc-bg': '#18181b',
    '--kc-surface': '#232327',
    '--kc-fg': '#e4e4e7',
    '--kc-muted': '#a1a1aa',
    '--kc-border': '#3f3f46',
    '--kc-accent': '#60a5fa',
    '--kc-danger': '#f87171',
  },
} as const;

const varsCss = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([name, value]) => `${name}:${value};`)
    .join('');

/** 主题变量样式：`:root` 亮色、`[data-theme=dark]` 暗色，外加字体与圆角。 */
export const WIDGET_THEME_STYLE = `<style data-kepcup="theme">:root{${varsCss(THEME_VARS.light)}--kc-radius:8px;--kc-font:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}:root[data-theme=dark]{${varsCss(THEME_VARS.dark)}}</style>`;

/**
 * 垫片脚本本体（IIFE，不污染全局 except `window.kepcup`）。协议：
 * - widget → 宿主：`{ source: 'kepcup-widget', id, type, payload }`（宿主 origin 打包态是
 *   `file://`、开发态是 localhost，垫片不知道也不猜，`postMessage` 用 `targetOrigin '*'`，
 *   宿主侧必须以 `event.source` 校验来源）；
 * - 宿主 → widget：`{ source: 'kepcup-host', id, ok, value?/code?, error? }`——拒绝时
 *   `error` 是人话、`code` 是机器可读错误码（widget 据此区分限速 / 配额 / 过期等）；
 *   主题推送 `{ source: 'kepcup-host', event: 'theme', theme }`（没有 id）。
 * 不设超时：宿主对每个带 id 的请求保证恰好一条回执（含格式拒收），iframe 销毁时
 * 挂起的 promise 随上下文消亡。`__KC_THEME__` 在注入时替换为经校验的主题字面量。
 */
const SHIM_SOURCE = `<script>/* ${WIDGET_SDK_MARKER} */
(function () {
  'use strict';
  if (window.kepcup) return;
  var seq = 0;
  var pending = new Map();
  var HEIGHT_MIN = ${BOT_WIDGET_HEIGHT_MIN};
  var HEIGHT_MAX = ${BOT_WIDGET_HEIGHT_MAX};
  var currentTheme = __KC_THEME__;
  function applyTheme(theme) {
    currentTheme = theme;
    try { document.documentElement.setAttribute('data-theme', theme); } catch (err) { /* 无 DOM（测试环境） */ }
  }
  applyTheme(currentTheme);
  function send(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        parent.postMessage({ source: '${WIDGET_BRIDGE_WIDGET_SOURCE}', id: id, type: type, payload: payload }, '*');
      } catch (err) {
        pending.delete(id);
        reject(new Error('无法连接宿主：' + err));
      }
    });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== '${WIDGET_BRIDGE_HOST_SOURCE}') return;
    if (data.event === '${WIDGET_HOST_THEME_EVENT}') {
      if (data.theme !== 'light' && data.theme !== 'dark') return;
      applyTheme(data.theme);
      try { window.dispatchEvent(new CustomEvent('kepcup:theme', { detail: { theme: data.theme } })); } catch (err) { /* 无 DOM */ }
      return;
    }
    var call = pending.get(data.id);
    if (call === undefined) return;
    pending.delete(data.id);
    if (data.ok) { call.resolve(data.value); return; }
    var error = new Error(typeof data.error === 'string' ? data.error : '宿主调用失败');
    if (typeof data.code === 'string') error.code = data.code;
    call.reject(error);
  });
  function clampHeight(value) {
    var height = Math.ceil(Number(value));
    if (!isFinite(height)) return null;
    return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, height));
  }
  function requireKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('kepcup.storage 需要一个非空字符串 key');
    }
    return key;
  }
  window.kepcup = {
    storage: {
      get: function (key) { return send('storage.get', { key: requireKey(key) }); },
      set: function (key, value) { return send('storage.set', { key: requireKey(key), value: value }); },
      delete: function (key) { return send('storage.delete', { key: requireKey(key) }); },
      list: function () { return send('storage.list', {}); }
    },
    query: function (name, params) {
      if (typeof name !== 'string' || name.length === 0) {
        return Promise.reject(new Error('kepcup.query 需要一个非空字符串查询名'));
      }
      return send('query', { name: name, params: params === undefined ? {} : params });
    },
    openLink: function (url) {
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('kepcup.openLink 需要一个 https 网址'));
      }
      return send('openLink', { url: url });
    },
    reply: function (text) {
      var activation = typeof navigator === 'undefined' ? null : navigator.userActivation;
      if (activation && !activation.isActive) {
        return Promise.resolve(false);
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        return Promise.reject(new Error('kepcup.reply 需要一段非空文字'));
      }
      return send('reply', { text: text });
    },
    theme: function () { return Promise.resolve(currentTheme); },
    setHeight: function (height) {
      var clamped = clampHeight(height);
      if (clamped === null) return;
      try {
        parent.postMessage({ source: '${WIDGET_BRIDGE_WIDGET_SOURCE}', id: 0, type: 'setHeight', payload: { height: clamped } }, '*');
      } catch (err) { /* 宿主不可达时静默 */ }
    }
  };
})();
</script>`;

/** 某主题的单行垫片（主题是经校验的枚举，替换成字符串字面量，没有拼注入面）。 */
export function widgetSdkShim(theme: WidgetTheme = 'light'): string {
  const literal = theme === 'dark' ? "'dark'" : "'light'";
  return oneLine(SHIM_SOURCE).replace('__KC_THEME__', literal);
}

/** 缺省（亮色）垫片——测试按它在 node 里执行协议路径。 */
export const WIDGET_SDK_SHIM = widgetSdkShim('light');

/** kit 的开关：组件原文里的 `<meta name="kepcup-kit" content="1">`。 */
const KIT_META =
  /<meta\s[^>]*name\s*=\s*["']?kepcup-kit["']?[^>]*content\s*=\s*["']?1["']?[^>]*>|<meta\s[^>]*content\s*=\s*["']?1["']?[^>]*name\s*=\s*["']?kepcup-kit["']?[^>]*>/i;

export function wantsKepcupKit(html: string): boolean {
  return KIT_META.test(html);
}

/**
 * kit 基础样式：全部包在 `:where()` 里（优先级 0，组件自己的任何样式都能盖过），只在
 * `<html data-kc-kit>` 下生效；`color-scheme` 跟随 data-theme。
 */
export const WIDGET_KIT_STYLE = oneLine(`<style data-kepcup="kit">
:where(html[data-kc-kit]){color-scheme:light;}
:where(html[data-kc-kit][data-theme=dark]){color-scheme:dark;}
:where(html[data-kc-kit] body){margin:0;padding:12px;font:14px/1.5 var(--kc-font);color:var(--kc-fg);background:var(--kc-bg);}
:where(html[data-kc-kit] *, html[data-kc-kit] *::before, html[data-kc-kit] *::after){box-sizing:border-box;}
:where(html[data-kc-kit] button){font:inherit;padding:6px 12px;border:1px solid var(--kc-border);border-radius:var(--kc-radius);background:var(--kc-surface);color:var(--kc-fg);cursor:pointer;}
:where(html[data-kc-kit] button.primary){background:var(--kc-accent);border-color:var(--kc-accent);color:#fff;}
:where(html[data-kc-kit] button.danger){color:var(--kc-danger);}
:where(html[data-kc-kit] button:disabled){opacity:.5;cursor:default;}
:where(html[data-kc-kit] input, html[data-kc-kit] select, html[data-kc-kit] textarea){font:inherit;padding:6px 8px;border:1px solid var(--kc-border);border-radius:var(--kc-radius);background:var(--kc-bg);color:var(--kc-fg);min-width:0;max-width:100%;}
:where(html[data-kc-kit] table){border-collapse:collapse;width:100%;}
:where(html[data-kc-kit] th, html[data-kc-kit] td){padding:6px 8px;border-bottom:1px solid var(--kc-border);text-align:left;}
:where(html[data-kc-kit] .kc-row){display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0;}
:where(html[data-kc-kit] .kc-card){padding:12px;border:1px solid var(--kc-border);border-radius:var(--kc-radius);background:var(--kc-surface);}
:where(html[data-kc-kit] .kc-muted){color:var(--kc-muted);}
:where(html[data-kc-kit] .kc-error){color:var(--kc-danger);}
</style>`);

/**
 * `kepcup.ui`（kit 才有）：纯 SVG 图表与数字格式化——S2 预览离线、CDN 图表库在预览里
 * 加载不到，徒手画 canvas 是 bug 的主要来源之一。图表写进容器（元素或 #id 选择器），
 * 文字一律经 textContent（不拼 HTML）。数据：`[{label, value}]`；line 也接受多组
 * `{series: [{name, values}], labels}`。
 */
const KIT_SOURCE = `<script>/* kepcup-kit */
(function () {
  'use strict';
  if (!window.kepcup || window.kepcup.ui) return;
  try { document.documentElement.setAttribute('data-kc-kit', ''); } catch (err) { /* 无 DOM */ }
  var NS = 'http://www.w3.org/2000/svg';
  var PALETTE = ['var(--kc-accent)', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
  function host(target) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('kepcup.ui：找不到图表容器 ' + target);
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  function node(tag, attrs, text) {
    var el = document.createElementNS(NS, tag);
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      var v = String(attrs[key]);
      /* 颜色经 style 设置：SVG 呈现属性里的 var() 不一定被解析。 */
      if ((key === 'fill' || key === 'stroke') && v.indexOf('var(') === 0) el.style.setProperty(key, v);
      else el.setAttribute(key, v);
    }
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function num(value) { var n = Number(value); return isFinite(n) ? n : 0; }
  function label(value) { return value === null || value === undefined ? '' : String(value); }
  function format(value, options) {
    var opts = options || {};
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!isFinite(n)) return '—';
    var style = opts.percent ? 'percent' : (opts.currency ? 'currency' : 'decimal');
    var config = { style: style, maximumFractionDigits: opts.decimals === undefined ? 2 : opts.decimals };
    if (opts.decimals !== undefined) config.minimumFractionDigits = opts.decimals;
    if (opts.currency) config.currency = opts.currency;
    try { return new Intl.NumberFormat('zh-CN', config).format(n); } catch (err) { return String(n); }
  }
  function svg(el, height) {
    var width = Math.max(240, el.clientWidth || 320);
    var root = node('svg', { viewBox: '0 0 ' + width + ' ' + height, width: '100%', height: height, role: 'img' });
    root.style.display = 'block';
    el.appendChild(root);
    return { root: root, width: width };
  }
  function bar(target, data, options) {
    var opts = options || {};
    var el = host(target);
    var rows = Array.isArray(data) ? data : [];
    var height = opts.height || 200;
    var s = svg(el, height);
    if (rows.length === 0) { s.root.appendChild(node('text', { x: 8, y: 20, fill: 'var(--kc-muted)' }, opts.empty || '暂无数据')); return; }
    var max = Math.max.apply(null, rows.map(function (r) { return num(r.value); }).concat([0]));
    var pad = 24;
    var slot = (s.width - pad * 2) / rows.length;
    rows.forEach(function (r, i) {
      /* 负值按 0 高度画（数值标签照常显示），不画出负高度的矩形。 */
      var h = max > 0 ? (Math.max(0, num(r.value)) / max) * (height - pad * 2) : 0;
      var x = pad + i * slot + slot * 0.15;
      s.root.appendChild(node('rect', { x: x, y: height - pad - h, width: slot * 0.7, height: h, rx: 3, fill: PALETTE[0] }));
      s.root.appendChild(node('text', { x: x + slot * 0.35, y: height - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--kc-muted)' }, label(r.label)));
      s.root.appendChild(node('text', { x: x + slot * 0.35, y: height - pad - h - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--kc-fg)' }, format(r.value, opts.format)));
    });
  }
  function line(target, data, options) {
    var opts = options || {};
    var el = host(target);
    var series = Array.isArray(data) ? [{ name: '', values: data.map(function (r) { return num(r.value); }) }] : ((data && data.series) || []);
    var labels = Array.isArray(data) ? data.map(function (r) { return r.label; }) : ((data && data.labels) || []);
    var height = opts.height || 200;
    var s = svg(el, height);
    var all = [];
    series.forEach(function (sr) { all = all.concat((sr.values || []).map(num)); });
    if (all.length === 0) { s.root.appendChild(node('text', { x: 8, y: 20, fill: 'var(--kc-muted)' }, opts.empty || '暂无数据')); return; }
    var max = Math.max.apply(null, all.concat([0]));
    var min = Math.min.apply(null, all.concat([0]));
    var pad = 24;
    var longest = 0;
    series.forEach(function (sr) { longest = Math.max(longest, (sr.values || []).length); });
    var count = Math.max(1, labels.length, longest);
    var stepX = count > 1 ? (s.width - pad * 2) / (count - 1) : 0;
    var span = max - min || 1;
    series.forEach(function (sr, k) {
      var color = PALETTE[k % PALETTE.length];
      var points = (sr.values || []).map(function (v, i) { return [count > 1 ? pad + i * stepX : s.width / 2, height - pad - ((num(v) - min) / span) * (height - pad * 2)]; });
      s.root.appendChild(node('polyline', { points: points.map(function (p) { return p[0] + ',' + p[1]; }).join(' '), fill: 'none', stroke: color, 'stroke-width': 2 }));
      /* 每个点画一个圆点：只有一个点时折线不可见，圆点仍可见。 */
      points.forEach(function (p) { s.root.appendChild(node('circle', { cx: p[0], cy: p[1], r: 3, fill: color })); });
    });
    labels.forEach(function (text, i) {
      s.root.appendChild(node('text', { x: count > 1 ? pad + i * stepX : s.width / 2, y: height - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--kc-muted)' }, label(text)));
    });
  }
  function pie(target, data, options) {
    var opts = options || {};
    var el = host(target);
    var rows = (Array.isArray(data) ? data : []).filter(function (r) { return num(r.value) > 0; });
    var height = opts.height || 200;
    var s = svg(el, height);
    var total = rows.reduce(function (sum, r) { return sum + num(r.value); }, 0);
    if (total <= 0) { s.root.appendChild(node('text', { x: 8, y: 20, fill: 'var(--kc-muted)' }, opts.empty || '暂无数据')); return; }
    var r0 = height / 2 - 8;
    var cx = r0 + 8;
    var cy = height / 2;
    var angle = -Math.PI / 2;
    rows.forEach(function (r, i) {
      var slice = (num(r.value) / total) * Math.PI * 2;
      var color = PALETTE[i % PALETTE.length];
      if (rows.length === 1) {
        s.root.appendChild(node('circle', { cx: cx, cy: cy, r: r0, fill: color }));
      } else {
        var x1 = cx + r0 * Math.cos(angle);
        var y1 = cy + r0 * Math.sin(angle);
        var x2 = cx + r0 * Math.cos(angle + slice);
        var y2 = cy + r0 * Math.sin(angle + slice);
        var large = slice > Math.PI ? 1 : 0;
        s.root.appendChild(node('path', { d: 'M' + cx + ',' + cy + ' L' + x1 + ',' + y1 + ' A' + r0 + ',' + r0 + ' 0 ' + large + ' 1 ' + x2 + ',' + y2 + ' Z', fill: color }));
      }
      angle += slice;
      s.root.appendChild(node('rect', { x: cx * 2 + 8, y: 12 + i * 18, width: 10, height: 10, fill: color }));
      s.root.appendChild(node('text', { x: cx * 2 + 24, y: 21 + i * 18, 'font-size': 12, fill: 'var(--kc-fg)' }, (label(r.label) + ' ' + format(num(r.value) / total, { percent: true, decimals: 0 })).trim()));
    });
  }
  window.kepcup.ui = { bar: bar, line: line, pie: pie, format: format };
})();
</script>`;

export const WIDGET_KIT_SCRIPT = oneLine(KIT_SOURCE);

/**
 * 把垫片插进 HTML（quirks-mode 安全，见模块注释）：主题变量 + 垫片（按 `theme`）+ 可选 kit，
 * 整段单行。已含垫片标记（v1 / v2）的输入原样返回（幂等，防重复注入）。
 */
export function injectWidgetSdk(html: string, options: { theme?: WidgetTheme } = {}): string {
  if (html.includes(WIDGET_SDK_MARKER) || html.includes(LEGACY_SDK_MARKER)) return html;
  const injection = [
    // 默认滚动条（应用同款）：页面自己定义了滚动条样式就不注入（见 iframe-defaults.ts）。
    ...(htmlDefinesScrollbarStyle(html)
      ? []
      : [`<style ${IFRAME_SCROLLBAR_STYLE_MARKER}>${IFRAME_SCROLLBAR_CSS}</style>`]),
    WIDGET_THEME_STYLE,
    widgetSdkShim(options.theme ?? 'light'),
    ...(wantsKepcupKit(html) ? [WIDGET_KIT_STYLE, WIDGET_KIT_SCRIPT] : []),
  ].join('');
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${injection}${html.slice(at)}`;
  }
  const doctype = /<!doctype\s[^>]*>/i.exec(html);
  if (doctype !== null) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}${injection}${html.slice(at)}`;
  }
  return `${injection}${html}`;
}
