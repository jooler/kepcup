import type { AnyNode } from 'acorn';
import { BOT_WIDGET_HTML_MAX_BYTES, type WidgetCheckIssue } from '@kepcup/shared';
import { ruleIssue } from './rules.js';
import {
  analyzeWidgetHtml,
  blankCssComments,
  identifierRole,
  isCallee,
  memberPath,
  programFacts,
  propertyName,
  scanTokens,
  stringValue,
  stripGlobalAliases,
  unitOffset,
  walk,
  type CssUnit,
  type ElementInfo,
  type JsUnit,
  type WidgetHtmlModel,
} from './source.js';

/**
 * S0 静态检查（设计 32 §11.8.1）：HTML 结构（体积 / 截断 / doctype）、沙箱禁区、主题、
 * 查询名声明。
 *
 * 涉及 JS 的规则（存储 / 网络 / 弹窗 / 导航 / 下载 / 剪贴板 / 表单提交 / 查询名）只看**代码**：
 * 内联脚本与 `on*` 属性用 acorn 解析后按 AST 判断——注释里、字符串里提到 localStorage /
 * confirm 不算；解析不了的单元（S1 会报 js.syntax）退到 acorn 词法器的记号流上做同样的判断
 * （注释同样被跳过）。用户自己声明过的同名标识符（如自定义的 `function confirm()`）不算沙箱 API。
 *
 * 宿主拦截组件框架的一切子框架导航（§8.1 实测），所以除了 `location.hash = …`（同文档）以外，
 * 对 location 的任何改写与 `location.assign/replace/reload()` 都是 `sandbox.top-nav`。
 */
export function staticCheck(input: {
  html: string;
  /** queries.json 里声明的名字；queries.json 不合格时为 null（此时不报 query.unknown-name）。缺省文件 = []。 */
  queryNames: readonly string[] | null;
}): WidgetCheckIssue[] {
  const { html } = input;
  const issues: WidgetCheckIssue[] = [];
  const model = analyzeWidgetHtml(html);
  const push = (rule: string, offset: number, message: string): void => {
    const { line, col } = model.source.position(offset);
    issues.push(ruleIssue(rule, { message, line, col }));
  };

  const bytes = Buffer.byteLength(html);
  if (bytes > BOT_WIDGET_HTML_MAX_BYTES) {
    issues.push(
      ruleIssue('html.size', {
        message: `index.html 有 ${bytes} 字节，超过上限 ${BOT_WIDGET_HTML_MAX_BYTES} 字节`,
      }),
    );
  }
  checkTruncation(html, push);
  if (model.mode !== 'no-quirks') {
    issues.push(
      ruleIssue('html.doctype', {
        message: '文件开头没有 <!DOCTYPE html>，页面会以怪异模式（quirks mode）渲染',
        line: 1,
        col: 1,
      }),
    );
  }

  const ctx: ScanContext = {
    model,
    push,
    userDeclared: new Set(),
    userMembers: new Set(),
    queryNames: input.queryNames === null ? null : new Set(input.queryNames),
    hasSubmitHandler: false,
  };
  const units: JsUnit[] = [...model.scripts, ...model.handlers];
  for (const unit of units) {
    if (unit.program === null) continue;
    const facts = programFacts(unit.program, unit.kind);
    for (const binding of facts.bindings) ctx.userDeclared.add(binding.name);
    for (const name of facts.memberNames) ctx.userMembers.add(name);
  }

  for (const element of model.elements) checkElement(element, ctx);
  for (const handler of model.handlers) {
    if (handler.attr === 'onsubmit' && !isTrivialSubmitBody(handler.program?.body ?? null)) {
      ctx.hasSubmitHandler = true;
      push(
        'sandbox.form-submit',
        handler.attrOffset,
        `<${handler.tagName}> 上的 onsubmit 处理函数永远不会被调用（沙箱里 submit 事件不触发）`,
      );
    }
  }
  for (const unit of units) {
    if (unit.program !== null) scanUnitAst(unit, ctx);
    else scanUnitTokens(unit, ctx);
  }
  for (const css of model.styles) checkCss(css, push);
  // submit 按钮：只有在没有任何 submit 处理函数时才单独提示（有处理函数时 form-submit 已经报了）。
  if (!ctx.hasSubmitHandler) {
    for (const element of model.elements) checkSubmitButton(element, push);
  }
  return issues;
}

type Push = (rule: string, offset: number, message: string) => void;

interface ScanContext {
  model: WidgetHtmlModel;
  push: Push;
  /** 所有单元里声明过的名字（自定义的 confirm / open 等不算沙箱 API）。 */
  userDeclared: Set<string>;
  /** 自定义的方法 / 属性名（自定义 `submit()` 方法不算 form.submit()）。 */
  userMembers: Set<string>;
  queryNames: Set<string> | null;
  hasSubmitHandler: boolean;
}

// --- html.truncated -----------------------------------------------------------

/** 内容是原始文本、要找对应结束标签的元素（里面的 `<` 不是标签）。 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * 对原文单独数标签（parse5 会自动补全缺失的结束标签，看解析树发现不了截断）：未闭合的
 * 注释 / 原始文本元素（script、style…）、写到一半的标签、有 `<body>` / `<html>` 开标签却没有
 * 对应的结束标签。没写 `<html>` / `<body>` 的片段式组件不要求结束标签。
 */
function checkTruncation(html: string, push: Push): void {
  const lower = html.toLowerCase();
  const end = html.length;
  let at = 0;
  let htmlOpen = false;
  let htmlClose = false;
  let bodyOpen = false;
  let bodyClose = false;
  while (at < end) {
    const lt = html.indexOf('<', at);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close < 0) {
        push('html.truncated', lt, '注释 <!-- 一直到文件末尾都没有闭合（-->），疑似输出被截断');
        return;
      }
      at = close + 3;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (tag === null) {
      at = lt + 1;
      continue;
    }
    const closing = tag[1] === '/';
    const name = (tag[2] ?? '').toLowerCase();
    const gt = tagEnd(html, lt + tag[0].length);
    if (gt < 0) {
      push(
        'html.truncated',
        lt,
        `标签 <${closing ? '/' : ''}${name} 没有写完，文件就结束了（疑似输出被截断）`,
      );
      return;
    }
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      if (close < 0) {
        push('html.truncated', lt, `<${name}> 没有闭合（找不到 </${name}>），疑似输出被截断`);
        return;
      }
      at = close;
      continue;
    }
    if (name === 'html') {
      if (closing) htmlClose = true;
      else htmlOpen = true;
    } else if (name === 'body') {
      if (closing) bodyClose = true;
      else bodyOpen = true;
    }
    at = gt + 1;
  }
  const missing: string[] = [];
  if (bodyOpen && !bodyClose) missing.push('</body>');
  if (htmlOpen && !htmlClose) missing.push('</html>');
  if (missing.length > 0) {
    push('html.truncated', end, `文件末尾缺少 ${missing.join(' 和 ')}，疑似输出被截断`);
  }
}

/** 从标签名之后找 `>`（跳过 `=` 之后的引号值）；没有返回 -1。 */
function tagEnd(html: string, from: number): number {
  let prev = '';
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i] ?? '';
    if (ch === '>') return i;
    if ((ch === '"' || ch === "'") && prev === '=') {
      const close = html.indexOf(ch, i + 1);
      if (close < 0) return -1;
      i = close;
      prev = ch;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return -1;
}

// --- 元素与属性 ---------------------------------------------------------------

/** 会去加载资源的属性（链接与导航另算）。 */
const RESOURCE_ATTRS: Record<string, readonly string[]> = {
  script: ['src'],
  img: ['src', 'srcset'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  video: ['src', 'poster'],
  audio: ['src'],
  source: ['src', 'srcset'],
  track: ['src'],
  image: ['href'],
  use: ['href'],
  feimage: ['href'],
};

/** 不加载资源的 `<link rel>`（其余 rel 一律视为要加载：stylesheet / icon / preload / preconnect…）。 */
const NON_LOADING_LINK_RELS = new Set([
  'canonical',
  'alternate',
  'author',
  'help',
  'license',
  'next',
  'prev',
  'search',
  'bookmark',
  'me',
]);

/** 指向沙箱外（或不存在的同目录文件）的 URL：除 data: / blob: / 页内锚点外都加载不到。 */
function isBrokenUrl(raw: string): boolean {
  const url = raw.trim();
  if (url === '') return false;
  return !/^(data:|blob:|#|javascript:|about:)/i.test(url);
}

function describeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:)?\/\//i.test(trimmed)) return `外链 ${trimmed}（被 CSP 拦截）`;
  return `「${trimmed}」（组件只有 index.html 一个文件，这个路径不存在）`;
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '');
}

/** 处理器里阻止了默认动作（`return false` / preventDefault），链接自身不导航。 */
function preventsDefault(element: ElementInfo): boolean {
  const onclick = element.attrs.get('onclick') ?? '';
  return /preventDefault|return\s+false/.test(onclick);
}

function checkElement(element: ElementInfo, ctx: ScanContext): void {
  const { push } = ctx;
  const tag = element.tagName.toLowerCase();

  const resourceAttrs = [...(RESOURCE_ATTRS[tag] ?? [])];
  if (tag === 'input' && (element.attrs.get('type') ?? '').toLowerCase() === 'image') {
    resourceAttrs.push('src');
  }
  for (const attr of resourceAttrs) {
    const value = element.attrs.get(attr);
    if (value === undefined) continue;
    const urls = attr === 'srcset' ? srcsetUrls(value) : [value];
    const broken = urls.find(isBrokenUrl);
    if (broken !== undefined) {
      push(
        'sandbox.external-resource',
        element.attrValue(attr).offset,
        `<${element.tagName} ${attr}> 引用了${describeUrl(broken)}`,
      );
    }
  }
  if (tag === 'link') {
    const href = element.attrs.get('href');
    const rels = (element.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const loads = rels.length === 0 || rels.some((rel) => !NON_LOADING_LINK_RELS.has(rel));
    if (href !== undefined && loads && isBrokenUrl(href)) {
      push(
        'sandbox.external-resource',
        element.attrValue('href').offset,
        `<link rel="${rels.join(' ')}"> 引用了${describeUrl(href)}`,
      );
    }
  }

  if (tag === 'meta' && (element.attrs.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
    push('sandbox.top-nav', element.offset, '<meta http-equiv="refresh"> 会让页面导航，宿主会拦下');
  }

  const target = element.attrs.get('target');
  const targetName = (target ?? '').trim().toLowerCase();
  if (
    (tag === 'a' || tag === 'area' || tag === 'form') &&
    target !== undefined &&
    !preventsDefault(element)
  ) {
    if (targetName === '_top' || targetName === '_parent') {
      push(
        'sandbox.top-nav',
        element.attrOffset('target'),
        `<${tag} target="${target}"> 会尝试导航外层页面，宿主会拦下`,
      );
    } else if (targetName !== '' && targetName !== '_self') {
      push(
        'sandbox.popup',
        element.attrOffset('target'),
        `<${tag} target="${target}"> 要打开新窗口，沙箱里点了没反应`,
      );
    }
  }
  if ((tag === 'a' || tag === 'area') && !preventsDefault(element)) {
    const href = element.attrs.get('href');
    const sameFrame = target === undefined || targetName === '' || targetName === '_self';
    if (
      href !== undefined &&
      sameFrame &&
      isBrokenUrl(href) &&
      !/^mailto:|^tel:/i.test(href.trim())
    ) {
      push(
        'sandbox.link-navigation',
        element.attrValue('href').offset,
        `链接 <a href="${href.trim()}"> 点击后会被宿主拦下，什么也不发生`,
      );
    } else if (href !== undefined && sameFrame && /^(mailto|tel):/i.test(href.trim())) {
      push(
        'sandbox.link-navigation',
        element.attrValue('href').offset,
        `链接 <a href="${href.trim()}"> 在沙箱里无法打开`,
      );
    }
  }
  if (tag === 'a' && element.attrs.has('download')) {
    push(
      'sandbox.download',
      element.attrOffset('download'),
      '<a download> 在沙箱里点击没有任何效果',
    );
  }
}

/** 提交按钮：显式 type=submit / image，或表单里没写 type（缺省就是 submit）的 `<button>`。 */
function checkSubmitButton(element: ElementInfo, push: Push): void {
  const tag = element.tagName.toLowerCase();
  const type = element.attrs.get('type');
  const typeName = (type ?? '').trim().toLowerCase();
  if (tag === 'button') {
    const isSubmit =
      typeName === 'submit' || (element.inForm && typeName !== 'button' && typeName !== 'reset');
    if (!isSubmit) return;
    push(
      'sandbox.submit-button',
      type === undefined ? element.offset : element.attrOffset('type'),
      type === undefined
        ? '表单里的 <button> 没写 type（缺省是 submit）：回车提交与默认提交在沙箱里无效'
        : '<button type="submit">：回车提交与默认提交在沙箱里无效',
    );
  } else if (tag === 'input' && (typeName === 'submit' || typeName === 'image')) {
    push(
      'sandbox.submit-button',
      element.attrOffset('type'),
      `<input type="${typeName}">：提交在沙箱里无效`,
    );
  }
}

// --- CSS ------------------------------------------------------------------------

function checkCss(css: CssUnit, push: Push): void {
  const code = blankCssComments(css.code);
  const at = (index: number): number => (css.exact ? css.offset + index : css.offset);
  const importRe = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gi;
  for (const match of code.matchAll(importRe)) {
    const url = match[2] ?? '';
    if (isBrokenUrl(url)) {
      push('sandbox.external-resource', at(match.index), `CSS @import 引用了${describeUrl(url)}`);
    }
  }
  const urlRe = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
  for (const match of code.matchAll(urlRe)) {
    const url = match[2] ?? '';
    // @import url(...) 已经报过一次。
    if (/@import\s+$/i.test(code.slice(Math.max(0, match.index - 12), match.index))) continue;
    if (isBrokenUrl(url)) {
      push(
        'sandbox.external-resource',
        at(match.index),
        `CSS url() 引用了${describeUrl(url)}——被拦时没有任何报错，只是显示不出来`,
      );
    }
  }
  for (const match of code.matchAll(/prefers-color-scheme/gi)) {
    push(
      'theme.media-query',
      at(match.index),
      '用 prefers-color-scheme 跟随系统深浅色，而不是应用主题',
    );
  }
}

// --- JS（AST） ------------------------------------------------------------------

/**
 * 只做「阻止默认提交」的 submit 处理（`onsubmit="return false"`、`e => e.preventDefault()`）：
 * 沙箱里本来就不会提交，它不触发也不丢任何逻辑——不算依赖表单提交。
 */
function isTrivialSubmitBody(body: readonly AnyNode[] | null): boolean {
  if (body === null) return false;
  return body.every((statement) => {
    if (statement.type === 'EmptyStatement') return true;
    if (statement.type === 'ReturnStatement') {
      return statement.argument?.type === 'Literal' && statement.argument.value === false;
    }
    if (statement.type !== 'ExpressionStatement') return false;
    const expr = statement.expression;
    return expr.type === 'CallExpression' && propertyName(expr.callee) === 'preventDefault';
  });
}

function isTrivialSubmitListener(listener: AnyNode | undefined): boolean {
  if (listener?.type !== 'ArrowFunctionExpression' && listener?.type !== 'FunctionExpression') {
    return false;
  }
  if (listener.body.type === 'BlockStatement') return isTrivialSubmitBody(listener.body.body);
  return isTrivialSubmitBody([
    { type: 'ExpressionStatement', expression: listener.body } as AnyNode,
  ]);
}

const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const NETWORK_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
/** location 前面可以出现的「窗口」前缀：window.location / top.location / document.location… */
const LOCATION_OWNERS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'document']);
const LOCATION_NAV_METHODS = new Set(['assign', 'replace', 'reload']);
const MARKUP_POPUP_RE = /<a\b[^>]*?\btarget\s*=\s*\\?["']?_blank/i;

function locationPath(path: readonly string[]): string[] {
  let at = 0;
  while (at < path.length - 1 && LOCATION_OWNERS.has(path[at] ?? '')) at += 1;
  return path.slice(at);
}

/** 沙箱 API 的全局使用（裸名字或 window.x）。 */
function globalUse(name: string, offset: number, called: boolean, ctx: ScanContext): void {
  const { push } = ctx;
  if (STORAGE_GLOBALS.has(name)) {
    push('sandbox.storage', offset, `使用了 ${name}（沙箱里一访问就抛 SecurityError）`);
  } else if (NETWORK_GLOBALS.has(name)) {
    push('sandbox.network', offset, `使用了 ${name}（组件禁网，请求必然失败）`);
  } else if (called && (name === 'confirm' || name === 'prompt')) {
    push(
      'sandbox.modals',
      offset,
      name === 'confirm'
        ? '调用了 confirm()：不弹窗、立即返回 false，依赖它的分支永远不执行'
        : '调用了 prompt()：不弹窗、立即返回 null',
    );
  } else if (called && name === 'alert') {
    push('sandbox.alert', offset, '调用了 alert()：不弹窗，用户看不到这条提示');
  } else if (called && name === 'open') {
    push('sandbox.popup', offset, '调用了 window.open()：沙箱里返回 null，不会打开任何窗口');
  }
}

function checkQueryName(nameNode: AnyNode | undefined, unit: JsUnit, ctx: ScanContext): void {
  if (ctx.queryNames === null) return;
  const name = stringValue(nameNode);
  if (name === null || nameNode === undefined || ctx.queryNames.has(name)) return;
  ctx.push(
    'query.unknown-name',
    unitOffset(unit, nameNode.start),
    ctx.queryNames.size === 0
      ? `kepcup.query('${name}') 调用的查询没有声明（草稿里没有 queries.json）`
      : `kepcup.query('${name}') 调用的查询不在 queries.json 里（已声明：${[...ctx.queryNames].join('、')}）`,
  );
}

function checkStringText(raw: string, start: number, unit: JsUnit, ctx: ScanContext): void {
  const theme = /prefers-color-scheme/i.exec(raw);
  if (theme !== null) {
    ctx.push(
      'theme.media-query',
      unitOffset(unit, start + theme.index),
      '用 prefers-color-scheme 跟随系统深浅色，而不是应用主题',
    );
  }
  const popup = MARKUP_POPUP_RE.exec(raw);
  if (popup !== null) {
    ctx.push(
      'sandbox.popup',
      unitOffset(unit, start + popup.index),
      '脚本生成的链接带 target="_blank"：沙箱里点了没反应',
    );
  }
}

function scanUnitAst(unit: JsUnit, ctx: ScanContext): void {
  const program = unit.program;
  if (program === null) return;
  const facts = programFacts(program, unit.kind);
  const { push } = ctx;
  const at = (node: AnyNode): number => unitOffset(unit, node.start);

  walk(program, (node, ancestors, key) => {
    const parent = ancestors[ancestors.length - 1];
    switch (node.type) {
      case 'Identifier': {
        if (identifierRole(node, parent, key, facts.bindingNodes) !== 'ref') break;
        if (ctx.userDeclared.has(node.name)) break;
        globalUse(node.name, at(node), isCallee(node, parent, key), ctx);
        break;
      }
      case 'MemberExpression': {
        const path = memberPath(node);
        if (path === null) break;
        const stripped = stripGlobalAliases(path);
        if (stripped.length === 1 && path.length > 1) {
          globalUse(stripped[0] ?? '', at(node), isCallee(node, parent, key), ctx);
        }
        const joined = stripped.join('.');
        if (joined === 'document.cookie') {
          push('sandbox.storage', at(node), '使用了 document.cookie（沙箱里抛 SecurityError）');
        } else if (joined === 'navigator.sendBeacon') {
          push('sandbox.network', at(node), '使用了 navigator.sendBeacon（组件禁网）');
        } else if (joined === 'navigator.clipboard') {
          push(
            'sandbox.clipboard',
            at(node),
            '使用了 navigator.clipboard（沙箱里被拒，NotAllowedError）',
          );
        }
        break;
      }
      case 'AssignmentExpression': {
        const left = memberPath(node.left);
        if (left !== null) {
          const loc = locationPath(left);
          const bareShadowed = left.length === 1 && ctx.userDeclared.has('location');
          // 只改片段（`location.href = '#x'`）是同文档跳转，与改 location.hash 等价，不报。
          const fragmentOnly = (stringValue(node.right) ?? '').startsWith('#');
          if (
            loc[0] === 'location' &&
            !bareShadowed &&
            !fragmentOnly &&
            (loc.length === 1 || (loc.length === 2 && loc[1] !== 'hash'))
          ) {
            push(
              'sandbox.top-nav',
              at(node),
              `改写了 ${left.join('.')}：宿主拦截组件框架的导航，跳转不会发生`,
            );
          }
        }
        const prop = propertyName(node.left);
        const value = stringValue(node.right);
        if (prop === 'onsubmit') {
          ctx.hasSubmitHandler = true;
          push(
            'sandbox.form-submit',
            at(node),
            '设置了 onsubmit 处理函数：沙箱里 submit 事件永远不触发',
          );
        } else if (prop === 'download') {
          push('sandbox.download', at(node), '设置了链接的 download 属性：沙箱里下载静默无效');
        } else if (prop === 'target' && value?.trim().toLowerCase() === '_blank') {
          push('sandbox.popup', at(node), '把链接的 target 设成 _blank：沙箱里点了没反应');
        } else if (prop === 'src' && value !== null && isBrokenUrl(value)) {
          push('sandbox.external-resource', at(node), `脚本把 src 设成了${describeUrl(value)}`);
        }
        break;
      }
      case 'CallExpression': {
        const callee = memberPath(node.callee);
        const method = propertyName(
          node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee,
        );
        const firstArg = node.arguments[0];
        if (callee !== null) {
          const loc = locationPath(callee);
          if (loc.length === 2 && loc[0] === 'location' && LOCATION_NAV_METHODS.has(loc[1] ?? '')) {
            push(
              'sandbox.top-nav',
              at(node),
              `调用了 ${callee.join('.')}()：宿主拦截组件框架的导航`,
            );
          }
          if (stripGlobalAliases(callee).join('.') === 'kepcup.query') {
            checkQueryName(firstArg, unit, ctx);
          }
        }
        const calleeName = method ?? (node.callee.type === 'Identifier' ? node.callee.name : null);
        if (method === 'requestSubmit') {
          push(
            'sandbox.form-submit',
            at(node),
            '调用了 requestSubmit()：沙箱里不会触发 submit 事件',
          );
        } else if (
          method === 'submit' &&
          node.arguments.length === 0 &&
          !ctx.userMembers.has('submit')
        ) {
          push('sandbox.form-submit', at(node), '调用了 form.submit()：沙箱里静默无效');
        } else if (
          calleeName === 'addEventListener' &&
          stringValue(firstArg) === 'submit' &&
          !isTrivialSubmitListener(node.arguments[1])
        ) {
          ctx.hasSubmitHandler = true;
          push(
            'sandbox.form-submit',
            at(node),
            "addEventListener('submit', …) 注册的处理函数永远不会被调用",
          );
        } else if (method === 'setAttribute') {
          const attr = stringValue(firstArg)?.toLowerCase();
          const attrValue = stringValue(node.arguments[1]);
          if (attr === 'download') {
            push('sandbox.download', at(node), "setAttribute('download', …)：沙箱里下载静默无效");
          } else if (attr === 'target' && attrValue?.trim().toLowerCase() === '_blank') {
            push('sandbox.popup', at(node), "setAttribute('target', '_blank')：沙箱里点了没反应");
          } else if (attr === 'src' && attrValue !== null && isBrokenUrl(attrValue)) {
            push(
              'sandbox.external-resource',
              at(node),
              `setAttribute('src', …) 引用了${describeUrl(attrValue)}`,
            );
          }
        }
        break;
      }
      case 'ImportDeclaration':
      case 'ImportExpression': {
        const spec = stringValue(node.source);
        if (spec === null || isBrokenUrl(spec)) {
          push(
            'sandbox.external-resource',
            at(node),
            spec === null ? '动态 import() 加载不到任何模块' : `import 引用了${describeUrl(spec)}`,
          );
        }
        break;
      }
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source !== null && node.source !== undefined) {
          push(
            'sandbox.external-resource',
            at(node),
            `export … from 引用了${describeUrl(String(node.source.value))}`,
          );
        }
        break;
      case 'Literal':
        if (typeof node.value === 'string' && node.raw !== undefined) {
          checkStringText(node.raw, node.start, unit, ctx);
        }
        break;
      case 'TemplateLiteral':
        // 整个模板串（含 `${…}` 原文）一起看：`<a href="${u}" target="_blank">` 被插值切成了两段。
        checkStringText(unit.code.slice(node.start, node.end), node.start, unit, ctx);
        break;
      default:
        break;
    }
  });
}

// --- JS（解析失败时的记号流降级） -----------------------------------------------

function scanUnitTokens(unit: JsUnit, ctx: ScanContext): void {
  const tokens = scanTokens(unit.code, unit.kind);
  const { push } = ctx;
  const at = (index: number): number => unitOffset(unit, tokens[index]?.start ?? 0);
  const type = (index: number): string => tokens[index]?.type ?? '';
  const value = (index: number): string => tokens[index]?.value ?? '';
  const isName = (index: number, name?: string): boolean =>
    type(index) === 'name' && (name === undefined || value(index) === name);

  for (let i = 0; i < tokens.length; i += 1) {
    const kind = type(i);
    if (kind === 'string' || kind === 'template') {
      const raw = unit.code.slice(tokens[i]?.start ?? 0, tokens[i]?.end ?? 0);
      checkStringText(raw, tokens[i]?.start ?? 0, unit, ctx);
      continue;
    }
    if (kind !== 'name') continue;
    const name = value(i);
    const afterDot = type(i - 1) === '.';
    // `window.x`（前面恰好是 window./self./globalThis.）与裸名字同等对待。
    const viaAlias =
      afterDot &&
      isName(i - 2) &&
      ['window', 'self', 'globalThis'].includes(value(i - 2)) &&
      type(i - 3) !== '.';
    const bare = (!afterDot || viaAlias) && !ctx.userDeclared.has(name);
    const called = type(i + 1) === '(';
    const start = viaAlias ? i - 2 : i;
    if (bare) globalUse(name, at(start), called, ctx);

    if (afterDot && isName(i - 2, 'document') && name === 'cookie') {
      push('sandbox.storage', at(i - 2), '使用了 document.cookie（沙箱里抛 SecurityError）');
    }
    if (afterDot && isName(i - 2, 'navigator') && name === 'sendBeacon') {
      push('sandbox.network', at(i - 2), '使用了 navigator.sendBeacon（组件禁网）');
    }
    if (afterDot && isName(i - 2, 'navigator') && name === 'clipboard') {
      push(
        'sandbox.clipboard',
        at(i - 2),
        '使用了 navigator.clipboard（沙箱里被拒，NotAllowedError）',
      );
    }
    if (name === 'location' && (!afterDot || LOCATION_OWNERS.has(value(i - 2)))) {
      const nav =
        type(i + 1) === '=' ||
        (type(i + 1) === '.' && type(i + 3) === '=' && value(i + 2) !== 'hash') ||
        (type(i + 1) === '.' && LOCATION_NAV_METHODS.has(value(i + 2)) && type(i + 3) === '(');
      if (nav)
        push(
          'sandbox.top-nav',
          at(i),
          '改写 location / 调用 location 导航：宿主拦截组件框架的导航',
        );
    }
    if (afterDot && name === 'requestSubmit' && called) {
      push('sandbox.form-submit', at(i), '调用了 requestSubmit()：沙箱里不会触发 submit 事件');
    }
    if (
      afterDot &&
      name === 'submit' &&
      called &&
      type(i + 2) === ')' &&
      !ctx.userMembers.has('submit')
    ) {
      push('sandbox.form-submit', at(i), '调用了 form.submit()：沙箱里静默无效');
    }
    if (afterDot && name === 'onsubmit' && type(i + 1) === '=') {
      ctx.hasSubmitHandler = true;
      push('sandbox.form-submit', at(i), '设置了 onsubmit 处理函数：沙箱里 submit 事件永远不触发');
    }
    if (
      name === 'addEventListener' &&
      called &&
      type(i + 2) === 'string' &&
      value(i + 2) === 'submit'
    ) {
      ctx.hasSubmitHandler = true;
      push(
        'sandbox.form-submit',
        at(i),
        "addEventListener('submit', …) 注册的处理函数永远不会被调用",
      );
    }
    if (
      name === 'kepcup' &&
      type(i + 1) === '.' &&
      isName(i + 2, 'query') &&
      type(i + 3) === '(' &&
      type(i + 4) === 'string' &&
      ctx.queryNames !== null &&
      !ctx.queryNames.has(value(i + 4))
    ) {
      push(
        'query.unknown-name',
        at(i + 4),
        `kepcup.query('${value(i + 4)}') 调用的查询没有在 queries.json 里声明`,
      );
    }
  }
}
