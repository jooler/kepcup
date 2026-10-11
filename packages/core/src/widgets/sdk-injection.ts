/**
 * widget 侧 SDK 垫片（D81 P1，设计 32 §6）：组件跑在 `sandbox="allow-scripts"` 的
 * opaque origin iframe 里——没有 localStorage / fetch / window.kepcup，与宿主的唯一
 * 通道是 postMessage。core 在 `widgets.ui.open` 登记 HTML 时把这段内联 `<script>`
 * 前置进去（响应头 CSP 的 `script-src 'unsafe-inline'` 允许内联），组件即可用
 * `window.kepcup.*`（storage / openLink / theme / setHeight，全部 promise 化）。
 *
 * 垫片是静态文本：关联凭据（resourceId）由渲染端宿主桥附加，不进这里——因此
 * 不存在把不可信内容拼进脚本的注入面。插入点必须是 `<!DOCTYPE html>` **之后**
 * （doctype 前出现任何节点会触发 quirks mode，改变盒模型与 CSS 语义）：优先
 * `<head>` 开标签之后，找不到再退到 doctype 的 `>` 之后，两者都没有（本就不规范
 * 的 HTML）才前置到文档最开头。
 */

/**
 * 垫片脚本本体（IIFE，不污染全局 except `window.kepcup`）。协议：
 * - widget → 宿主：`{ source: 'kepcup-widget', id, type, payload }`（opaque origin
 *   下 `postMessage` 只能 `targetOrigin '*'`，宿主侧必须以 `event.source` 校验来源）；
 * - 宿主 → widget：`{ source: 'kepcup-host', id, ok, value? , error? }`。
 */
export const WIDGET_SDK_SHIM = `<script>
(function () {
  'use strict';
  if (window.kepcup) return;
  var seq = 0;
  var pending = new Map();
  var HEIGHT_MIN = 100;
  var HEIGHT_MAX = 800;
  function send(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        parent.postMessage({ source: 'kepcup-widget', id: id, type: type, payload: payload }, '*');
      } catch (err) {
        pending.delete(id);
        reject(new Error('无法连接宿主：' + err));
      }
    });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== 'kepcup-host') return;
    var call = pending.get(data.id);
    if (call === undefined) return;
    pending.delete(data.id);
    if (data.ok) call.resolve(data.value);
    else call.reject(new Error(typeof data.error === 'string' ? data.error : '宿主调用失败'));
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
    openLink: function (url) {
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('kepcup.openLink 需要一个 https 网址'));
      }
      return send('openLink', { url: url });
    },
    theme: function () { return send('theme.get', {}); },
    setHeight: function (height) {
      var clamped = clampHeight(height);
      if (clamped === null) return;
      try {
        parent.postMessage({ source: 'kepcup-widget', id: 0, type: 'setHeight', payload: { height: clamped } }, '*');
      } catch (err) { /* 宿主不可达时静默 */ }
    }
  };
})();
</script>`;

/**
 * 把垫片插进 HTML（quirks-mode 安全，见模块注释）。返回新 HTML；已含垫片标记
 * `kepcup-widget` 的输入原样返回（幂等，防重复注入）。
 */
export function injectWidgetSdk(html: string): string {
  if (html.includes("source: 'kepcup-widget'")) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${WIDGET_SDK_SHIM}${html.slice(at)}`;
  }
  const doctype = /<!doctype\s[^>]*>/i.exec(html);
  if (doctype !== null) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}${WIDGET_SDK_SHIM}${html.slice(at)}`;
  }
  return `${WIDGET_SDK_SHIM}${html}`;
}
