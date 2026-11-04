/**
 * 微应用 SDK 的生成物（设计 55 §6.1）：全部从 `spec.ts` 派生，**运行时按需计算**而非
 * 落盘生成——生成物与 spec 之间的漂移在构造上不可能（比「重新生成后无 diff」的守卫更强）。
 *
 * 产物与消费方：
 * - `buildMicroAppShim()`：注入垫片 JS（core `sdk-injection.ts` 在 open 时前置进 HTML）；
 * - `buildMicroAppSdkMd()`：制作 loop 系统提示的入口（≤4KB，信任边界第一段）；
 * - `buildMicroAppDts()`：`kepcup-micro-app.d.ts`（写 TS 的作者用，`micro_app_sdk_inspect` 同源）；
 * - `microAppPreviewMockSpec()`：S2 预览的能力 mock 清单（P0 骨架，P1/P3 扩充）；
 * - `microAppImplementedApiMethods()`：当前运行时实现的桥方法白名单（渲染端守卫与检查器共用）。
 *
 * 垫片纪律（同 v1，设计 32 §11.13）：单行注入、不写 `//` 注释、语句以分号结束——
 * 运行期与预览报错的行号就是作者原文的行号。关联凭据（resourceId）不进脚本。
 */

import {
  MICRO_APP_API_METHODS,
  MICRO_APP_BRIDGE_APP_SOURCE,
  MICRO_APP_BRIDGE_HOST_SOURCE,
  MICRO_APP_CAPABILITIES,
  MICRO_APP_ERROR_HINTS,
  MICRO_APP_EVENT_SUBSCRIPTIONS_MAX,
  MICRO_APP_IMPLEMENTED_CAPABILITIES,
  MICRO_APP_RUNTIME_PHASE,
  MICRO_APP_SDK_MARKER,
  MICRO_APP_SPEC_VERSION,
  microAppApiMethodOf,
  microAppCapabilityOf,
  type MicroAppCapabilityPhase,
} from './spec.js';
import {
  BOT_WIDGET_STORAGE_KEYS_MAX,
  BOT_WIDGET_STORAGE_QUOTA_BYTES,
  BOT_WIDGET_STORAGE_VALUE_MAX_BYTES,
} from '../domain/widgets-ui.js';
import {
  MICRO_APP_COLLECTION_QUOTA_BYTES,
  MICRO_APP_COLLECTIONS_MAX,
  MICRO_APP_CONTEXT_DATA_MAX_BYTES,
  MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS,
} from '../domain/micro-app.js';

const PHASE_ORDER: Record<MicroAppCapabilityPhase, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * 当前运行时接受的桥方法白名单：能力方法 = 能力已实现；平台方法 = `since` 不晚于
 * `MICRO_APP_RUNTIME_PHASE`。渲染端守卫（v2 方法白名单）与检查器共用这一份。
 */
export function microAppImplementedApiMethods(): ReadonlySet<string> {
  const cap = new Set<string>(MICRO_APP_IMPLEMENTED_CAPABILITIES);
  const methods = new Set<string>();
  for (const method of MICRO_APP_API_METHODS) {
    if (PHASE_ORDER[method.since] > PHASE_ORDER[MICRO_APP_RUNTIME_PHASE]) continue;
    if (method.capability === 'platform' || cap.has(method.capability)) methods.add(method.method);
  }
  return methods;
}

// --- 注入垫片 -------------------------------------------------------------------

/**
 * 微应用垫片脚本本体（桥 v2 客户端）。协议（55 §6.3，帧带 `k` 判别）：
 * - 微应用 → 宿主：`{k:'call', id, method, params}`、`{k:'cancel', target}`、`{k:'event-ack', subId, seq}`；
 * - 宿主 → 微应用：`{k:'ack', id, result}`、`{k:'error', id, code, message, hint?}`、
 *   `{k:'event', subId, name, data?, seq}`、`{k:'close', reason?}`。
 * 来源防线仍是 `event.source === window.parent`（opaque origin 的 `event.origin` 恒为 "null"）。
 * 流式：`call` 带 `stream:true` 时结果经 `subId = 's' + id` 的 `event` 帧（name 'delta' /
 * 'done'）投递；取消用 `{k:'cancel', target}`（call id 或 streamId）。事件通道 seq 连续，
 * 缺口即本地派发 `kepcup:bridge-reset` 并重新同步——应用应重读 `app.ready()` 状态。
 */
const SHIM_TEMPLATE = `<script>/* ${MICRO_APP_SDK_MARKER} */
(function () {
  'use strict';
  if (window.kepcup) return;
  var seq = 0;
  var pending = new Map();
  var streams = new Map();
  var listeners = new Map();
  var channels = new Map();
  var lastSeq = new Map();
  var subscriptionCount = 0;
  var SUBSCRIPTIONS_MAX = ${MICRO_APP_EVENT_SUBSCRIPTIONS_MAX};
  var currentTheme = __KC_THEME__;
  function applyTheme(theme) {
    currentTheme = theme;
    try { document.documentElement.setAttribute('data-theme', theme); } catch (err) { /* 无 DOM（测试环境） */ }
  }
  applyTheme(currentTheme);
  function post(frame) {
    try { parent.postMessage(Object.assign({ v: 2, source: '${MICRO_APP_BRIDGE_APP_SOURCE}' }, frame), '*'); } catch (err) { /* 宿主不可达：promise 由 close/超时路径收口 */ }
  }
  function dispatchLocal(name, data) {
    var cbs = listeners.get(name);
    if (!cbs) return;
    cbs.slice().forEach(function (cb) { try { cb(data); } catch (err) { /* 应用回调出错不应打断其他订阅 */ } });
  }
  function failEntry(entry, code, message, hint) {
    var error = new Error(typeof message === 'string' && message ? message : '宿主调用失败');
    error.code = typeof code === 'string' ? code : 'MICRO_APP_CAPABILITY_DENIED';
    if (typeof hint === 'string' && hint) error.hint = hint;
    entry.reject(error);
  }
  function streamIterable(onDone) {
    var queue = [];
    var waiters = [];
    var finished = false;
    var failure = null;
    function streamError(code) {
      var error = new Error('模型流式调用失败');
      error.code = typeof code === 'string' && code ? code : 'MICRO_APP_AI_UNAVAILABLE';
      return error;
    }
    function wake() {
      while (waiters.length > 0 && (queue.length > 0 || finished)) {
        var waiter = waiters.shift();
        if (queue.length > 0) waiter.resolve({ value: queue.shift(), done: false });
        else if (failure !== null) waiter.reject(failure);
        else waiter.resolve({ value: undefined, done: true });
      }
    }
    var iterator = {
      next: function () {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (finished && failure !== null) return Promise.reject(failure);
        if (finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve, reject) { waiters.push({ resolve: resolve, reject: reject }); });
      },
      return: function () {
        finished = true;
        wake();
        if (onDone) onDone();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
    iterator[Symbol.asyncIterator] = function () { return iterator; };
    return {
      iterable: iterator,
      push: function (delta) { if (!finished) { queue.push({ delta: delta }); wake(); } },
      finish: function () { finished = true; wake(); },
      cancel: function () { finished = true; wake(); },
      fail: function (code) {
        if (finished) return;
        failure = streamError(code);
        finished = true;
        wake();
      }
    };
  }
  function call(method, params, options) {
    /*KC-MOCK-SEAM*/
    var mock = window.__kepcupMockBridge;
    if (mock && typeof mock.call === 'function') {
      /* S2 预览缝（55 §11）：流式调用仍走本垫片的迭代器管线——注册通道、把 mock 的事件帧经 handleEvent 喂进来（mock 用 options.subId 定向发帧）；非流式直接转发。 */
      if (options && options.stream) {
        return new Promise(function (resolve) {
          var subId = 'mock_stream_' + ++seq;
          var channel = streamIterable(function () { });
          streams.set(subId, channel);
          resolve(channel.iterable);
          Promise.resolve().then(function () {
            mock.call(method, params === undefined ? {} : params, { stream: true, subId: subId });
          });
        });
      }
      return mock.call(method, params === undefined ? {} : params, { stream: false });
    }
    /*KC-MOCK-SEAM-END*/
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var entry = { resolve: resolve, reject: reject, stream: !!(options && options.stream) };
      pending.set(id, entry);
      post({ k: 'call', id: id, method: method, params: params === undefined ? {} : params, stream: entry.stream });
    });
  }
  /* AbortSignal → 迭代器 return()（发出 cancel 帧并终止消费；§6.2 的取消面）。 */
  function wireAbort(promise, input, stream) {
    if (!stream || !input || !input.signal || typeof input.signal.aborted !== 'boolean') return promise;
    return promise.then(function (iterable) {
      var signal = input.signal;
      var stop = function () { try { if (iterable && typeof iterable.return === 'function') iterable.return(); } catch (err) { } };
      if (signal.aborted) stop();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', stop);
      return iterable;
    });
  }
  function bindStream(subId, entry) {
    var channel = streamIterable(function () { post({ k: 'cancel', target: subId }); });
    streams.set(subId, channel);
    entry.resolve(channel.iterable);
  }
  function handleEvent(frame) {
    var subId = typeof frame.subId === 'string' ? frame.subId : '';
    if (subId === '') return;
    var prev = lastSeq.get(subId);
    var frameSeq = typeof frame.seq === 'number' ? frame.seq : -1;
    if (frameSeq >= 0) {
      if (prev !== undefined && frameSeq !== prev + 1) dispatchLocal('bridge-reset', { subId: subId });
      lastSeq.set(subId, frameSeq);
      post({ k: 'event-ack', subId: subId, seq: frameSeq });
    }
    var channel = streams.get(subId);
    if (channel !== undefined && (frame.name === 'delta' || frame.name === 'done' || frame.name === 'error')) {
      if (frame.name === 'delta' && frame.data && typeof frame.data.delta === 'string') channel.push(frame.data.delta);
      if (frame.name === 'done') { streams.delete(subId); channel.finish(); }
      if (frame.name === 'error') { streams.delete(subId); channel.fail(frame.data && frame.data.code); }
      return;
    }
    var mediaCbs = channels.get(subId);
    if (mediaCbs !== undefined) {
      var cbs = mediaCbs[frame.name];
      if (cbs) cbs.slice().forEach(function (cb) { try { cb(frame.data); } catch (err) { } });
      if (frame.name === 'end') channels.delete(subId);
      return;
    }
    if (subId === 'app') {
      if (frame.name === 'theme' && (frame.data === 'light' || frame.data === 'dark')) {
        applyTheme(frame.data);
        try { window.dispatchEvent(new CustomEvent('kepcup:theme', { detail: { theme: frame.data } })); } catch (err) { /* 无 DOM */ }
        dispatchLocal('theme', frame.data);
        return;
      }
      dispatchLocal(frame.name, frame.data);
      return;
    }
    dispatchLocal(frame.name, frame.data);
  }
  function reportError(kind, error) {
    var code = 'Exception';
    var detail = '';
    try {
      if (error && typeof error.name === 'string' && error.name) code = error.name;
      if (error && typeof error.stack === 'string' && error.stack) {
        var lines = error.stack.split('\n');
        for (var i = 0; i < lines.length; i += 1) {
          if (lines[i].indexOf('kepcup') === -1 && /:\d+:\d+/.test(lines[i])) { detail = lines[i].trim().slice(0, 200); break; }
        }
      }
    } catch (err) { }
    try { post({ k: 'call', id: 0, method: 'app.reportError', params: { kind: kind, code: code, detail: detail }, stream: false }); } catch (err2) { }
  }
  window.addEventListener('error', function (event) { reportError('error', event.error || { name: 'Error', stack: '' }); });
  window.addEventListener('unhandledrejection', function (event) { reportError('rejection', event.reason); });
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== '${MICRO_APP_BRIDGE_HOST_SOURCE}') return;
    if (data.k === 'event') { handleEvent(data); return; }
    if (data.k === 'close') {
      pending.forEach(function (entry) { failEntry(entry, 'MICRO_APP_BRIDGE_CLOSED', typeof data.reason === 'string' ? data.reason : '宿主已断开能力桥'); });
      pending.clear();
      streams.forEach(function (channel) { channel.cancel(); });
      streams.clear();
      channels.clear();
      dispatchLocal('bridge-reset', { reason: data.reason });
      return;
    }
    if (data.k !== 'ack' && data.k !== 'error') return;
    var entry = pending.get(data.id);
    if (entry === undefined) return;
    pending.delete(data.id);
    if (data.k === 'ack') {
      if (entry.stream && data.result && typeof data.result.streamId === 'string') { bindStream(data.result.streamId, entry); return; }
      entry.resolve(data.result);
      return;
    }
    failEntry(entry, data.code, data.message, data.hint);
  });
  function requireKey(key) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('kepcup.storage 需要一个非空字符串 key');
    return key;
  }
  window.kepcup = {
    app: {
      ready: function () { return call('app.ready', {}); },
      on: function (name, cb) {
        if (typeof name !== 'string' || typeof cb !== 'function') throw new Error('app.on 需要 (事件名, 回调)');
        if (subscriptionCount >= SUBSCRIPTIONS_MAX) throw new Error('事件订阅超过上限（' + SUBSCRIPTIONS_MAX + '）：先取消不再使用的订阅');
        var cbs = listeners.get(name) || [];
        cbs.push(cb);
        subscriptionCount += 1;
        listeners.set(name, cbs);
        return function () {
          var rest = (listeners.get(name) || []).filter(function (item) { return item !== cb; });
          if (rest.length === 0) listeners.delete(name); else listeners.set(name, rest);
          subscriptionCount = Math.max(0, subscriptionCount - 1);
        };
      },
      setTitle: function (title) {
        if (typeof title !== 'string' || title.length === 0) return;
        post({ k: 'call', id: 0, method: 'app.setTitle', params: { title: title.slice(0, 120) }, stream: false });
      }
    },
    storage: {
      get: function (key) { return call('storage.get', { key: requireKey(key) }); },
      set: function (key, value) { return call('storage.set', { key: requireKey(key), value: value }); },
      delete: function (key) { return call('storage.delete', { key: requireKey(key) }); },
      list: function () { return call('storage.list', {}); }
    },
    query: function (name, params, opts) {
      if (typeof name !== 'string' || name.length === 0) return Promise.reject(new Error('kepcup.query 需要一个非空字符串查询名'));
      return call('query', { name: name, params: params === undefined ? {} : params, opts: opts === undefined ? {} : opts });
    },
    openLink: function (url) {
      if (typeof url !== 'string' || url.length === 0) return Promise.reject(new Error('kepcup.openLink 需要一个 https 网址'));
      return call('openLink', { url: url });
    },
    reply: function (text) {
      var activation = typeof navigator === 'undefined' ? null : navigator.userActivation;
      if (activation && !activation.isActive) return Promise.resolve(false);
      if (typeof text !== 'string' || text.trim().length === 0) return Promise.reject(new Error('kepcup.reply 需要一段非空文字'));
      return call('reply', { text: text });
    },
    ai: {
      chat: function (input) {
        var stream = !!(input && input.stream);
        /* call(..., {stream:true}) 的 Promise 解析为 AsyncIterable<{delta}>（bindStream）。 */
        var promise = call('ai.chat', { messages: input ? input.messages : [], stream: stream }, { stream: stream });
        return wireAbort(promise, input, stream);
      },
      session: function (input) {
        return call('ai.session.create', { id: input ? input.id : undefined, system: input ? input.system : undefined, maxTurns: input ? input.maxTurns : undefined }).then(function (out) {
          var sessionId = out && typeof out.sessionId === 'string' ? out.sessionId : '';
          function send(text, opts) {
            var stream = !!(opts && opts.stream);
            var promise = call('ai.session.send', { sessionId: sessionId, text: text, stream: stream }, { stream: stream });
            return wireAbort(promise, opts, stream);
          }
          return {
            send: send,
            history: function () { return call('ai.session.history', { sessionId: sessionId }); },
            reset: function () { return call('ai.session.reset', { sessionId: sessionId }); }
          };
        });
      }
    },
    media: {
      listen: function (input) {
        return call('media.listen', { lang: input ? input.lang : undefined, mode: input ? input.mode : undefined, silenceMs: input ? input.silenceMs : undefined }).then(function (out) {
          var channelId = out && typeof out.channelId === 'string' ? out.channelId : '';
          var cbs = {};
          channels.set(channelId, cbs);
          return {
            start: function () { return call('media.listen.start', { channelId: channelId }); },
            stop: function () {
              channels.delete(channelId);
              return call('media.listen.stop', { channelId: channelId });
            },
            on: function (name, cb) {
              if (typeof name !== 'string' || typeof cb !== 'function') throw new Error('listen().on 需要 (事件名, 回调)');
              var list = cbs[name] || (cbs[name] = []);
              list.push(cb);
              return function () {
                var rest = (cbs[name] || []).filter(function (item) { return item !== cb; });
                if (rest.length === 0) delete cbs[name]; else cbs[name] = rest;
              };
            }
          };
        });
      },
      speak: function (input) {
        if (!input || typeof input.text !== 'string' || input.text.length === 0) return Promise.reject(new Error('kepcup.media.speak 需要一段非空文字'));
        return call('media.speak', { text: input.text, voice: input.voice, rate: input.rate });
      },
      stopSpeaking: function () { return call('media.stopSpeaking', {}); }
    },
    collections: {
      put: function (name, doc) { return call('collections.put', { name: name, doc: doc }); },
      get: function (name, id) { return call('collections.get', { name: name, id: id }).then(function (out) { return out && typeof out === 'object' && 'doc' in out ? out.doc : out; }); },
      delete: function (name, id) { return call('collections.delete', { name: name, id: id }); },
      list: function (name) { return call('collections.list', { name: name }).then(function (out) { return out && typeof out === 'object' && Array.isArray(out.docs) ? out.docs : []; }); },
      query: function (name, filter) { return call('collections.query', { name: name, where: filter && filter.where ? filter.where : [], limit: filter && filter.limit ? filter.limit : 50 }).then(function (out) { return out && typeof out === 'object' && Array.isArray(out.docs) ? out.docs : []; }); }
    },
    context: {
      update: function (summary) { return call('context.update', { summary: summary, reason: 'gesture' }); },
      clear: function () { return call('context.clear', {}); }
    },
    ui: {
      theme: function () { return Promise.resolve(currentTheme); }
    }
  };
})();
</script>`;

function oneLine(text: string): string {
  return text.replace(/\n\s*/g, ' ').trim();
}

/**
 * 某主题的单行微应用垫片（主题是经校验的枚举字面量替换，无拼注入面）。
 * `preview: true` 保留 `__kepcupMockBridge` 缝（S2 预览专用，55 §11）；生产版剥掉——
 * 组件运行期不能改道桥调用（P3 审查修复：正式打开路径永不触发 mock）。
 */
export function buildMicroAppShim(theme: 'light' | 'dark' = 'light', options: { preview?: boolean } = {}): string {
  const literal = theme === 'dark' ? "'dark'" : "'light'";
  if (SHIM_TEMPLATE.includes('//')) {
    throw new Error('micro-app shim source must not contain // comments');
  }
  let source = SHIM_TEMPLATE;
  if (options.preview !== true) {
    source = source.replace(/\/\*KC-MOCK-SEAM\*\/[\s\S]*?\/\*KC-MOCK-SEAM-END\*\//g, '');
  }
  return oneLine(source).replace('__KC_THEME__', literal);
}

/** 缺省（亮色）垫片——测试在 node 里执行协议路径用。 */
export const MICRO_APP_SDK_SHIM = /* @__PURE__ */ buildMicroAppShim('light');

// --- sdk.md 入口（制作 loop 系统提示；≤4KB，信任边界第一段）------------------------

/** references/ 分层索引（55 §6.1）：入口只引用当前阶段已存在的篇目。 */
export interface MicroAppSdkReference {
  readonly file: string;
  readonly topic: string;
  readonly since: MicroAppCapabilityPhase;
}

export const MICRO_APP_SDK_REFERENCES: readonly MicroAppSdkReference[] = [
  { file: 'references/manifest.md', topic: '清单字段 / 能力枚举 / net 档位', since: 'P0' },
  { file: 'references/storage.md', topic: 'storage / query / collections 配额与限流', since: 'P0' },
  { file: 'references/errors.md', topic: '错误码总表与修复步骤', since: 'P0' },
  { file: 'references/ai.md', topic: 'ai.chat / ai.session：隔离 / 流式 / 预算', since: 'P1' },
  { file: 'references/media.md', topic: '语音：半双工 / 打断 / 降级', since: 'P1' },
  { file: 'references/lifecycle.md', topic: '生命周期 / 会话恢复 / context.update', since: 'P2' },
];

const SDK_MD_MAX_BYTES = 4 * 1024;
/** 字节数（不是字符数）：CJK 内容按 UTF-8 计，与提示修剪阈值同口径。 */
const textEncoder = /* @__PURE__ */ new TextEncoder();

/** 入口 sdk.md：能力清单 + 每条 API 一行签名 + 最常见 3 个错误 + references 指针。 */
export function buildMicroAppSdkMd(phase: MicroAppCapabilityPhase = MICRO_APP_RUNTIME_PHASE): string {
  const lines: string[] = [];
  lines.push('# KepCup 微应用 SDK（入口）');
  lines.push('');
  lines.push(
    '**信任边界**：平台保证——沙箱 iframe（无 Node / 文件 / 宿主 API）、能力按版本校验、原始音频不出宿主。产品策略（非平台保证）：预算超限拒付、缺配置不可用、降级要自己写。别写「靠平台兜底」的代码。',
  );
  lines.push('');
  lines.push(`\`micro-app.json\` 的 spec 取 \`${MICRO_APP_SPEC_VERSION}\`；能力是闭合枚举，未声明的调用被拒（\`MICRO_APP_CAPABILITY_NOT_DECLARED\`）。调用任何能力前先 \`await kepcup.app.ready()\` 看 capabilities / grants，按返回值降级，别靠错误码试探。`);
  lines.push('');
  lines.push('## 能力与 API（一行签名）');
  for (const cap of MICRO_APP_CAPABILITIES) {
    if (!MICRO_APP_IMPLEMENTED_CAPABILITIES.includes(cap.id) && PHASE_ORDER[cap.phase] > PHASE_ORDER[phase]) continue;
    lines.push(`- \`${cap.id}\`（${cap.title}）`);
    for (const method of MICRO_APP_API_METHODS) {
      if (method.capability !== cap.id) continue;
      if (PHASE_ORDER[method.since] > PHASE_ORDER[phase]) continue;
      lines.push(`  - \`${method.signature}\``);
    }
  }
  lines.push('- 平台面（无需声明）');
  for (const method of MICRO_APP_API_METHODS) {
    if (method.capability !== 'platform' || PHASE_ORDER[method.since] > PHASE_ORDER[phase]) continue;
    lines.push(`  - \`${method.signature}\``);
  }
  lines.push('');
  lines.push('## 常见错误');
  lines.push('- `MICRO_APP_CAPABILITY_NOT_DECLARED`：能力没进 permissions——补清单或换能力。');
  lines.push('- `MICRO_APP_CAPABILITY_NOT_CONFIGURED`：宿主缺配置——引导设置并降级。');
  lines.push('- 忘 `await`：`kepcup.*` 全部异步。');
  lines.push('');
  lines.push('## 深入阅读（按需 `read`；签名详情可查 micro_app_sdk_inspect）');
  for (const ref of MICRO_APP_SDK_REFERENCES) {
    if (PHASE_ORDER[ref.since] > PHASE_ORDER[phase]) continue;
    lines.push(`- \`${ref.file}\`：${ref.topic}`);
  }
  const text = lines.join('\n');
  const bytes = textEncoder.encode(text).length;
  if (bytes > SDK_MD_MAX_BYTES) {
    throw new Error(`sdk.md entry exceeds ${SDK_MD_MAX_BYTES} bytes (was ${bytes})`);
  }
  return text;
}

// --- kepcup-micro-app.d.ts ---------------------------------------------------------

const TS_TYPE_OF = (method: string): string => {
  switch (method) {
    case 'app.ready':
      return 'ready(): Promise<AppReadyInfo>;';
    case 'app.on':
      return "on(event: 'theme' | 'pause' | 'resume' | 'capability.revoked' | 'display-mode' | 'bridge-reset', cb: (value?: unknown) => void): () => void;";
    case 'app.setTitle':
      return 'setTitle(title: string): void;';
    case 'app.requestDisplayMode':
      return "requestDisplayMode(mode: 'inline' | 'immersive'): Promise<{ mode: 'inline' | 'immersive' }>;";
    case 'app.close':
      return 'close(): void;';
    case 'storage.get':
      return 'get(key: string): Promise<unknown>;';
    case 'storage.set':
      return 'set(key: string, value: unknown): Promise<void>;';
    case 'storage.delete':
      return 'delete(key: string): Promise<void>;';
    case 'storage.list':
      return 'list(): Promise<string[]>;';
    case 'query':
      return 'query(name: string, params?: Record<string, unknown>, opts?: { cursor?: string; maxBytes?: number }): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; nextCursor?: string }>;';
    case 'openLink':
      return 'openLink(url: string): Promise<void>;';
    case 'reply':
      return 'reply(text: string): Promise<boolean>;';
    case 'ui.theme':
      return "theme(): Promise<'light' | 'dark'>;";
    default:
      return `${method}(input: unknown): Promise<unknown>;`;
  }
};

/** `kepcup-micro-app.d.ts`：从 API 索引生成（含 JSDoc：签名 / 参数 / 返回 / since）。 */
export function buildMicroAppDts(phase: MicroAppCapabilityPhase = MICRO_APP_RUNTIME_PHASE): string {
  const lines: string[] = [];
  lines.push(`/** KepCup 微应用 SDK 类型（由 micro-app-sdk/spec.ts 生成；spec ${MICRO_APP_SPEC_VERSION}）。 */`);
  lines.push('');
  lines.push('export interface AppReadyInfo {');
  lines.push('  capabilities: string[];');
  lines.push("  grants: { mic: 'granted' | 'denied' | 'unavailable'; net: { mode: 'open' | 'allowlist' | 'none'; domains: string[] } };");
  lines.push("  theme: 'light' | 'dark';");
  lines.push("  displayMode: 'inline' | 'immersive';");
  lines.push('  viewport: { width: number; height: number };');
  lines.push('  instanceId: string;');
  lines.push('}');
  lines.push('');
  lines.push('export interface KepcupMicroApp {');
  const emitted = new Set<string>();
  for (const method of MICRO_APP_API_METHODS) {
    if (PHASE_ORDER[method.since] > PHASE_ORDER[phase] || emitted.has(method.method)) continue;
    emitted.add(method.method);
    lines.push(`  /** ${method.signature} — 参数：${method.params}；返回：${method.returns}（${method.since} 起${method.deprecated ? '，已废弃' : ''}）。 */`);
    lines.push(`  ${TS_TYPE_OF(method.method)}`);
  }
  lines.push('}');
  return lines.join('\n');
}

// --- S2 预览的能力 mock 清单（P0 骨架）---------------------------------------------

export interface MicroAppPreviewMockSpec {
  readonly method: string;
  /** P0：预览宿主已 mock 的方法；未列出的方法在预览里按真实错误码拒绝。 */
  readonly behavior: 'in-memory-kv' | 'fixture-rows' | 'record-only' | 'scripted' | 'rejected';
  readonly note: string;
}

export function microAppPreviewMockSpec(): readonly MicroAppPreviewMockSpec[] {
  return [
    { method: 'app.ready', behavior: 'scripted', note: '返回清单声明的能力与 grants（mic=unavailable，net 按清单档位）' },
    { method: 'storage.get', behavior: 'in-memory-kv', note: '内存 KV（fixtures.storage 初值）' },
    { method: 'storage.set', behavior: 'in-memory-kv', note: '' },
    { method: 'storage.delete', behavior: 'in-memory-kv', note: '' },
    { method: 'storage.list', behavior: 'in-memory-kv', note: '' },
    { method: 'query', behavior: 'fixture-rows', note: '按名字返回 fixtures.queries[名]' },
    { method: 'openLink', behavior: 'record-only', note: '记录网址，回「用户取消」' },
    { method: 'reply', behavior: 'record-only', note: '校验后回 false，不发任何东西' },
    { method: 'app.setTitle', behavior: 'record-only', note: '' },
  ];
}

/** spec 便捷引用（守卫测试用）。 */
export const MICRO_APP_SDK_SPEC_METHOD_COUNT = /* @__PURE__ */ MICRO_APP_API_METHODS.length;
export const MICRO_APP_SDK_METHOD_OF = microAppApiMethodOf;

// --- S2 预览 mock（55 §11：宿主能力 mock——ai 脚本 / listen 转写 / speak 记录）---------

export interface MicroAppPreviewMockInput {
  theme: 'light' | 'dark';
  /** 清单声明的能力（app.ready 的 capabilities = 其中已实现的子集）。 */
  permissions: readonly string[];
  fixtures: {
    storage?: Record<string, unknown>;
    queries?: Record<string, Array<Record<string, unknown>>>;
    ai?: readonly string[];
    transcripts?: readonly string[];
  };
}

const MOCK_HOST_SOURCE = MICRO_APP_BRIDGE_HOST_SOURCE;

/**
 * S2 预览的微应用 mock 桥（单行 `<script>`，注入在垫片之前）：垫片的 `call` 缝检测到
 * `window.__kepcupMockBridge` 就改走这里——API 语义仍由同一份垫片实现，mock 只实现
 * 「宿主侧」的路由（fixtures 驱动）。流式调用以宿主帧的形式派发（MessageEvent、
 * source 指向 window.parent，与真实桥同一管线）。预览离线：这里没有网络面，
 * `net.fetch` 失败由外壳的离线归类承接。
 */
export function buildMicroAppPreviewMock(input: MicroAppPreviewMockInput): string {
  // 桥方法 → 能力（平台面为 null）：mock 与正式宿主同闸「只伺候声明过的能力」。
  const capOfMethod: Record<string, string | null> = {};
  for (const method of MICRO_APP_API_METHODS) {
    capOfMethod[method.method] = method.capability === 'platform' ? null : method.capability;
  }
  const caps = input.permissions.filter((id) => microAppCapabilityOf(id) !== undefined);
  const payload = {
    theme: input.theme,
    capabilities: caps,
    grants: {
      mic: caps.includes('media.listen') ? 'granted' : 'unavailable',
      net: { mode: 'none', domains: [] },
    },
    storage: input.fixtures.storage ?? {},
    queries: input.fixtures.queries ?? {},
    ai: input.fixtures.ai ?? [],
    transcripts: input.fixtures.transcripts ?? [],
  };
  // 审查修复 P1-3：嵌入 <script> 的 JSON 必须转义 `<`（fixtures 里的 `</script>` 会截断
  // mock 桥并注入标签）；U+2028/2029 同理（JS 字符串字面量外的行终止符）。
  const literal = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const hostSource = JSON.stringify(MOCK_HOST_SOURCE);
  const script = `<script>(function () {
  var cfg = ${literal};
  var kv = {};
  for (var k in cfg.storage) { if (Object.prototype.hasOwnProperty.call(cfg.storage, k)) kv[k] = cfg.storage[k]; }
  var docs = {};
  var sessions = {};
  var spoken = [];
  var seq = 0;
  var aiIndex = 0;
  function nextReply() {
    if (cfg.ai.length === 0) return '（预览 mock：没有写 fixtures.ai 脚本回复）';
    var text = cfg.ai[aiIndex % cfg.ai.length];
    aiIndex += 1;
    return text;
  }
  function emit(subId, name, data) {
    seq += 1;
    try {
      window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { v: 2, source: ${hostSource}, k: 'event', subId: subId, name: name, data: data, seq: seq } }));
    } catch (err) { }
  }
  function streamOut(subId, text) {
    var step = 24;
    var i = 0;
    var timer = setInterval(function () {
      if (i >= text.length) {
        clearInterval(timer);
        emit(subId, 'done', null);
        return;
      }
      emit(subId, 'delta', { delta: text.slice(i, Math.min(text.length, i + step)) });
      i += step;
    }, 4);
  }
  function reject(code, message) {
    var e = new Error(message);
    e.code = code;
    return Promise.reject(e);
  }
  var CAP_OF = ${JSON.stringify(capOfMethod)};
  var channels = 0;
  window.__kepcupSpoken = spoken;
  window.__kepcupMockBridge = {
    call: function (method, params, options) {
      var capOf = CAP_OF[method];
      if (capOf !== undefined && capOf !== null && cfg.capabilities.indexOf(capOf) === -1) {
        return reject('MICRO_APP_CAPABILITY_NOT_DECLARED', '这个微应用没有声明能力 ' + capOf + '（预览与正式宿主同闸）');
      }
      switch (method) {
        case 'app.ready':
          return Promise.resolve({ capabilities: cfg.capabilities, grants: cfg.grants, theme: cfg.theme, displayMode: 'inline', viewport: { width: 800, height: 600 }, instanceId: 'mai_preview_1' });
        case 'storage.get':
          return Promise.resolve(Object.prototype.hasOwnProperty.call(kv, params.key) ? kv[params.key] : undefined);
        case 'storage.set': {
          var size = JSON.stringify(params.value === undefined ? null : params.value).length;
          var keys = Object.prototype.hasOwnProperty.call(kv, params.key) ? Object.keys(kv).length : Object.keys(kv).length + 1;
          if (size > ${BOT_WIDGET_STORAGE_VALUE_MAX_BYTES} || keys > ${BOT_WIDGET_STORAGE_KEYS_MAX}) {
            return reject('WIDGET_STORAGE_QUOTA', '存储超出上限（预览与正式宿主同闸）');
          }
          kv[params.key] = params.value;
          return Promise.resolve(undefined);
        }
        case 'storage.delete':
          delete kv[params.key];
          return Promise.resolve(undefined);
        case 'storage.list':
          return Promise.resolve(Object.keys(kv));
        case 'query': {
          var rows = cfg.queries[params.name];
          if (rows === undefined) return reject('WIDGET_QUERY_UNKNOWN', '查询「' + params.name + '」没有在 fixtures.queries 里给数据');
          return Promise.resolve({ rows: rows, truncated: false });
        }
        case 'openLink':
        case 'reply':
          return Promise.resolve(true);
        case 'ai.chat': {
          var text = nextReply();
          if (options && options.stream) {
            var streamId = options.subId || 'mock_s' + (++seq);
            setTimeout(function () { streamOut(streamId, text); }, 0);
            return Promise.resolve({ streamId: streamId });
          }
          return Promise.resolve({ text: text });
        }
        case 'ai.session.create': {
          var id = 'mock_sess_' + (++seq);
          sessions[id] = [];
          return Promise.resolve({ sessionId: id });
        }
        case 'ai.session.send': {
          var text2 = nextReply();
          var list = sessions[params.sessionId];
          if (list) { list.push({ role: 'user', content: params.text }); list.push({ role: 'assistant', content: text2 }); }
          if (options && options.stream) {
            var sid = options.subId || 'mock_s' + (++seq);
            setTimeout(function () { streamOut(sid, text2); }, 0);
            return Promise.resolve({ streamId: sid });
          }
          return Promise.resolve({ text: text2 });
        }
        case 'ai.session.history':
          return Promise.resolve({ messages: sessions[params.sessionId] || [] });
        case 'ai.session.reset':
          if (sessions[params.sessionId]) sessions[params.sessionId] = [];
          return Promise.resolve({ ok: true });
        case 'ai.cancel':
        case 'ai.dispose':
          return Promise.resolve({ ok: true });
        case 'media.listen': {
          channels += 1;
          var channelId = 'mock_ch_' + channels;
          return Promise.resolve({ channelId: channelId });
        }
        case 'media.listen.start': {
          var ch = params.channelId;
          setTimeout(function () {
            emit(ch, 'level', 0.6);
            emit(ch, 'speech-start', null);
            for (var i = 0; i < cfg.transcripts.length; i += 1) {
              emit(ch, 'partial', { text: cfg.transcripts[i] });
              emit(ch, 'final', { text: cfg.transcripts[i] });
            }
            emit(ch, 'end', null);
          }, 0);
          return Promise.resolve(undefined);
        }
        case 'media.listen.stop':
          return Promise.resolve(undefined);
        case 'media.speak':
          spoken.push(String(params.text || ''));
          return Promise.resolve(undefined);
        case 'media.stopSpeaking':
          return Promise.resolve(undefined);
        case 'collections.put': {
          var bucket = docs[params.name] || (docs[params.name] = {});
          bucket[params.doc && params.doc.id] = params.doc;
          return Promise.resolve({ ok: true });
        }
        case 'collections.get': {
          var doc = (docs[params.name] || {})[params.id];
          return doc === undefined ? reject('NOT_FOUND', '文档不存在') : Promise.resolve({ doc: doc });
        }
        case 'collections.delete': {
          if (docs[params.name]) delete docs[params.name][params.id];
          return Promise.resolve({ ok: true });
        }
        case 'collections.list':
          return Promise.resolve({ docs: Object.values(docs[params.name] || {}) });
        case 'collections.query': {
          var all = Object.values(docs[params.name] || {});
          var where = Array.isArray(params.where) ? params.where : [];
          var hit = all.filter(function (doc) {
            return where.every(function (c) { return doc[c.field] === c.value; });
          });
          return Promise.resolve({ docs: hit.slice(0, params.limit || 50) });
        }
        case 'context.update': {
          var summary = params.summary;
          if (summary === null || typeof summary !== 'object' || typeof summary.headline !== 'string' || summary.headline.length === 0 || summary.headline.length > ${MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS}) {
            return reject('INVALID_INPUT', '摘要必须有 1–' + ${MICRO_APP_CONTEXT_HEADLINE_MAX_CHARS} + ' 字的 headline（预览与正式宿主同闸）');
          }
          if (summary.data !== undefined && JSON.stringify(summary.data).length > ${MICRO_APP_CONTEXT_DATA_MAX_BYTES}) {
            return reject('INVALID_INPUT', '摘要 data 超出上限（预览与正式宿主同闸）');
          }
          window.__kepcupContext = summary;
          return Promise.resolve({ ok: true });
        }
        case 'context.clear':
          window.__kepcupContext = undefined;
          return Promise.resolve({ ok: true });
        case 'app.setTitle':
        case 'app.reportError':
          return Promise.resolve(undefined);
        default:
          return reject('MICRO_APP_CAPABILITY_NOT_DECLARED', '预览 mock 没有实现这个方法：' + method);
      }
    }
  };
})();
</script>`;
  if (script.includes('//')) throw new Error('micro-app preview mock must not contain // comments');
  return script.replace(/\n\s*/g, ' ').trim();
}

// --- micro_app_sdk_inspect（55 §6.1 按需自省；制作 loop 工具的数据源）----------------

const INSPECT_MAX_BYTES = 2 * 1024;

/** 单条 API 契约（inspect 工具回执；≤2KB，未知名返回可用方法列表）。 */
export function buildMicroAppApiInspect(method: string): string {
  if (method.trim() === '') {
    return microAppImplementedApiMethods().size === 0
      ? '没有已实现的 API 方法。'
      : [...microAppImplementedApiMethods()].join('\n');
  }
  const entry = microAppApiMethodOf(method.trim());
  if (entry === undefined) {
    return [
      `没有 API「${method.trim()}」。可用的方法：`,
      [...microAppImplementedApiMethods()].join('\n'),
    ].join('\n');
  }
  const cap = entry.capability === 'platform' ? '（平台面，无需声明）' : `（能力 ${entry.capability}）`;
  const lines = [entry.signature, cap];
  if (entry.params !== '') lines.push(`参数：${entry.params}`);
  if (entry.returns !== '') lines.push(`返回：${entry.returns}`);
  if (entry.deprecated === true) lines.push('状态：已废弃（看报告里的替代写法）');
  const text = lines.join('\n');
  return text.length <= INSPECT_MAX_BYTES ? text : `${text.slice(0, INSPECT_MAX_BYTES - 1)}…`;
}

// --- references/ 分层（55 §6.1：每篇 1–3KB，制作 loop 的 read 工具按需读）--------------

/** 每篇 references 的正文（与 spec 同源组装：限额常量、错误 hint 直接引用）。 */
export function buildMicroAppSdkReferenceBodies(): Readonly<Record<string, string>> {
  const caps = MICRO_APP_CAPABILITIES.map((cap) => `- \`${cap.id}\`（${cap.title}）：${cap.limits}`).join('\n');
  const bodies: Record<string, string> = {
    'references/manifest.md': [
      '# micro-app.json 清单',
      '',
      `- \`spec\`：固定 \`${MICRO_APP_SPEC_VERSION}\`；`,
      '- `slug` / `name` / `description`：包标识与展示名；',
      '- `entry`：入口 HTML，当前只接受 `index.html`；',
      '- `permissions`：能力闭合枚举的子集（未声明的能力调用会被拒）：',
      caps,
      '- `net`：`{ mode: open | allowlist | none, allowlist?: [] }`，缺省 open。保留 open 要在 spec.md 写联网用途与失败降级；',
      '- `display`：`{ mode: inline | immersive }`（inline 卡片内 / immersive 覆盖层全屏）——字段名是 display.mode，不是 displayMode（schema strict，写错整个清单被拒）。',
      '',
      '清单变化（permissions / net / display）= 能力面变化 = 新版本 + 用户重新确认；只改代码沿用上次确认。',
    ].join('\n'),
    'references/storage.md': [
      '# storage.kv 与查询模板',
      '',
      `- \`kepcup.storage.get/set/delete/list\`：每微应用独立命名空间，单值 ≤${kbOf(BOT_WIDGET_STORAGE_VALUE_MAX_BYTES)}，总量 ≤${kbOf(BOT_WIDGET_STORAGE_QUOTA_BYTES)} / ${BOT_WIDGET_STORAGE_KEYS_MAX} 键；超限得 \`WIDGET_STORAGE_QUOTA\`。`,
      '- `kepcup.query(name, params, opts?)`：只读命名查询模板（queries.json 里声明，随版本审查）；返回 `{ rows, truncated, nextCursor? }`。',
      '- 分页：`opts.maxBytes`（1024B–256KB）按字节切页，`opts.cursor` 接上一页返回的 `nextCursor`（形如 `off:N`），翻到底 `nextCursor` 缺省。',
      '- `kepcup.collections.put/get/list/delete/query`（能力 storage.collection）：JSON 文档集合，`put` 的文档必须有字符串 `id`；总量 ≤${(MICRO_APP_COLLECTION_QUOTA_BYTES / 1024 / 1024).toFixed(0)}MB、至多 ${MICRO_APP_COLLECTIONS_MAX} 个集合。',
      '- 调用与存储共享限流：突发 20 / 每秒 5 / 在途 20——保存要防抖，别高频轮询。',
    ].join('\n'),
    'references/errors.md': [
      '# 错误码与修复步骤',
      '',
      ...MICRO_APP_ERROR_HINTS.map((hint) => `- \`${hint.code}\`：${hint.hint}`),
      '',
      '每个 await 都要 try/catch：`error.code` 程序化分支，`error.message` 可直接展示。',
    ].join('\n'),
    'references/ai.md': [
      '# ai.chat / ai.session（能力 ai.chat）',
      '',
      '- `kepcup.ai.chat({ messages, stream?, signal? })`：一次性对话；返回 `{ text }`，`stream: true` 返回 AsyncIterable<{delta}>。',
      '- `kepcup.ai.session({ id?, system?, maxTurns? })`：多轮会话 → `{ send, history, reset }`；上下文不进主对话。',
      '- 并发 1：同一实例已有调用在途得 `MICRO_APP_AI_BUSY`；预算（会话 / 每微应用每日 / 每 Bot 每日）超限得 `MICRO_APP_AI_QUOTA`。',
      '- 你不能指定模型厂商或型号；用量计入编写本微应用的 Bot。失败时显示可读错误并保留进度（`MICRO_APP_AI_UNAVAILABLE`）。',
    ].join('\n'),
    'references/media.md': [
      '# media.listen / media.speak（语音）',
      '',
      '- `kepcup.media.listen({ lang?, mode?, silenceMs? })` → `{ start, stop, on }`：宿主代理采集（原始音频不出宿主），事件 `level / speech-start / partial / final / error / end`。',
      '- 麦克风是**会话授权**：外壳的麦克风开关决定可用性；拒绝或撤销得 `MICRO_APP_CAPABILITY_DENIED`，必须提供键盘输入降级（app.fallback-missing 检查器会查）。',
      '- `kepcup.media.speak({ text, voice?, rate? })` 播报；`kepcup.media.stopSpeaking()` 停止。用户插话时宿主会自动打断——`speak` 的 Promise 仍会 settle。',
      '- 半双工：播报时采集自动让路；不要在 speak 未返回前立刻 listen。',
    ].join('\n'),
    'references/lifecycle.md': [
      '# 生命周期',
      '',
      '- `kepcup.app.on(\'pause\' | \'resume\' | \'capability.revoked\' | \'theme\' | \'display-mode\' | \'bridge-reset\', cb)`：窗口隐藏 / 恢复 / 能力撤销。',
      '- 会话恢复：pause 时把进度写到 `kepcup.storage`（键名建议 `session:` 前缀），重开时读回——宿主不代存 DOM。',
      '- 升级不热替换：运行中的实例钉住当前版本，`next_version` 下次打开生效。',
      '- 心跳无响应（`MICRO_APP_UNRESPONSIVE`）由宿主判定：不要写死循环阻塞主线程。',
      '- `kepcup.context.update({ headline, data? })`（能力 context.update）：把结构化进度同步进主对话的模型上下文（headline ≤80 字、data ≤1KB、自由文本字段会被拒）。',
    ].join('\n'),
  };
  return bodies;
}

function kbOf(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}
