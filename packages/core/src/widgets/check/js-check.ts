import type { AnyNode } from 'acorn';
import globals from 'globals';
import type { WidgetCheckIssue } from '@kepcup/shared';
import { ruleIssue } from './rules.js';
import {
  analyzeWidgetHtml,
  escapeRegExp,
  identifierRole,
  isCallee,
  isTypeofOperand,
  memberPath,
  programFacts,
  propertyName,
  stringValue,
  stripGlobalAliases,
  unitOffset,
  walk,
  type BindingInfo,
  type InlineHandler,
  type JsUnit,
  type ProgramFacts,
  type WidgetHtmlModel,
} from './source.js';

/**
 * S1 JavaScript 检查（设计 32 §11.8.2）：acorn 解析 + 轻量作用域分析，不引 ESLint。
 *
 * 作用域只做到「够用且少误报」：
 * - **全局**：经典脚本的顶层 function / var / let / const / class（含函数外的 var 与顶层块里的
 *   函数声明）、任何脚本里挂到 `window.x` / `globalThis.x` / `self.x` / `Object.assign(window, …)`
 *   上的名字、非严格脚本里给未声明名字赋值造成的隐式全局、浏览器全局（`globals` 包）与 `kepcup`。
 *   元素 id 也算（浏览器把它们挂在 window 上）。
 * - **未定义名字**：只要在任何脚本的任何作用域里声明过就算声明过——宁可漏报也不误报；
 *   被调用（`x()` / `new x()`）是 error，只读是 warning。
 * - **内联处理器**（`onclick="fn()"`）只看得见全局（加上元素 / 表单 / document 的属性），
 *   写在 DOMContentLoaded 回调或 module 脚本里的函数是这里最常见的失败。
 */
export function jsCheck(input: { html: string }): WidgetCheckIssue[] {
  const model = analyzeWidgetHtml(input.html);
  const issues: WidgetCheckIssue[] = [];
  const push = (
    rule: string,
    offset: number,
    message: string,
    level?: 'error' | 'warning',
  ): void => {
    const { line, col } = model.source.position(offset);
    issues.push(ruleIssue(rule, { message, line, col, ...(level ? { level } : {}) }));
  };

  checkSyntax(model, push);
  const analysis = analyze(model);
  checkHandlers(analysis, push);
  checkUndefinedNames(analysis, push);
  checkRedeclare(model, analysis, push);
  checkIds(model, analysis, push);
  checkNotAwaited(analysis, push);
  return issues;
}

type Push = (rule: string, offset: number, message: string, level?: 'error' | 'warning') => void;

/** 浏览器全局 + ES 内建 + kepcup（`globals` 包；不在表里的名字才可能是未定义）。 */
const KNOWN_GLOBALS: ReadonlySet<string> = new Set([
  ...Object.keys(globals.browser),
  ...Object.keys(globals.builtin),
  'kepcup',
  'arguments',
]);

/**
 * 内联处理器的作用域链上还有元素自身、所属表单与 document：`onclick="remove()"`、
 * `oninput="update(value)"` 能解析到元素属性，不是未定义（虽然常常不是作者本意）。
 */
const HANDLER_SCOPE_NAMES: ReadonlySet<string> = new Set([
  'event',
  'value',
  'checked',
  'disabled',
  'id',
  'name',
  'type',
  'form',
  'style',
  'dataset',
  'className',
  'classList',
  'textContent',
  'innerText',
  'innerHTML',
  'outerHTML',
  'parentNode',
  'parentElement',
  'children',
  'firstChild',
  'lastChild',
  'firstElementChild',
  'lastElementChild',
  'nextSibling',
  'previousSibling',
  'nextElementSibling',
  'previousElementSibling',
  'tagName',
  'nodeName',
  'title',
  'hidden',
  'tabIndex',
  'click',
  'focus',
  'blur',
  'remove',
  'append',
  'prepend',
  'before',
  'after',
  'replaceWith',
  'closest',
  'matches',
  'querySelector',
  'querySelectorAll',
  'getAttribute',
  'setAttribute',
  'removeAttribute',
  'toggleAttribute',
  'hasAttribute',
  'getBoundingClientRect',
  'scrollIntoView',
  'select',
  'setSelectionRange',
  'selectedIndex',
  'selectedOptions',
  'options',
  'files',
  'min',
  'max',
  'step',
  'placeholder',
  'href',
  'src',
  'alt',
  'label',
  'open',
  'show',
  'showModal',
  'close',
  'length',
  'checkValidity',
  'reportValidity',
  'contains',
  'insertAdjacentHTML',
  'cloneNode',
  'appendChild',
  'removeChild',
  'replaceChildren',
  'offsetWidth',
  'offsetHeight',
  'scrollTop',
  'scrollLeft',
  'valueAsNumber',
  'valueAsDate',
  'defaultValue',
  'readOnly',
  'required',
  'multiple',
  'selected',
  'text',
  'play',
  'pause',
  'currentTime',
  'duration',
  'paused',
  'volume',
  'muted',
  'getContext',
  'width',
  'height',
  'body',
  'head',
  'documentElement',
  'createElement',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'activeElement',
]);

/** 只有表单里的元素（或表单自身）的处理器才解析得到的表单成员。 */
const FORM_SCOPE_NAMES: ReadonlySet<string> = new Set([
  'submit',
  'reset',
  'elements',
  'action',
  'method',
  'requestSubmit',
  'encoding',
  'enctype',
]);

/** 常被 LLM 当成「已经引入」的第三方库全局名（报错里点明是 CDN 库）。 */
const LIBRARY_NAMES = new Set([
  'Chart',
  '$',
  'jQuery',
  '_',
  'd3',
  'moment',
  'dayjs',
  'axios',
  'Vue',
  'React',
  'ReactDOM',
  'echarts',
  'Swal',
  'confetti',
  'marked',
  'Papa',
  'XLSX',
  'luxon',
  'anime',
  'gsap',
  'THREE',
]);

/** 全局对象上不可配置的属性：经典脚本顶层 let / const / class 用这些名字直接 SyntaxError。 */
const RESTRICTED_GLOBALS = new Set([
  'window',
  'document',
  'location',
  'top',
  'undefined',
  'NaN',
  'Infinity',
]);

interface UnitAnalysis {
  unit: JsUnit;
  facts: ProgramFacts;
}

interface Analysis {
  units: UnitAnalysis[];
  /** 每个名字的全部声明（跨所有单元）。 */
  bindings: Map<string, Array<BindingInfo & { unitKind: JsUnit['kind'] }>>;
  /** 内联处理器看得见的名字（全局声明 + window 挂载 + 隐式全局 + 已知全局 + 元素 id）。 */
  globalNames: Set<string>;
  /** 任何地方声明 / 挂载过的名字（未定义名字检查用）。 */
  declaredAnywhere: Set<string>;
}

function analyze(model: WidgetHtmlModel): Analysis {
  const units: UnitAnalysis[] = [];
  for (const unit of [...model.scripts, ...model.handlers]) {
    if (unit.program !== null) units.push({ unit, facts: programFacts(unit.program, unit.kind) });
  }
  const bindings: Analysis['bindings'] = new Map();
  const globalNames = new Set<string>([...KNOWN_GLOBALS, ...model.ids.keys()]);
  const declaredAnywhere = new Set<string>([...KNOWN_GLOBALS, ...model.ids.keys()]);
  for (const { unit, facts } of units) {
    for (const binding of facts.bindings) {
      const list = bindings.get(binding.name) ?? [];
      list.push({ ...binding, unitKind: unit.kind });
      bindings.set(binding.name, list);
      declaredAnywhere.add(binding.name);
      if (binding.global) globalNames.add(binding.name);
    }
    for (const name of facts.windowNames) {
      globalNames.add(name);
      declaredAnywhere.add(name);
    }
  }
  // 隐式全局：非 module 代码里给从未声明过的名字赋值（sloppy mode 会在 window 上建属性）。
  for (const { unit, facts } of units) {
    for (const name of facts.assignedNames.keys()) {
      declaredAnywhere.add(name);
      if (unit.kind !== 'module' && !bindings.has(name)) globalNames.add(name);
    }
  }
  return { units, bindings, globalNames, declaredAnywhere };
}

// --- js.syntax / js.handler-syntax ---------------------------------------------------

function checkSyntax(model: WidgetHtmlModel, push: Push): void {
  model.scripts.forEach((script, index) => {
    if (script.error === null) return;
    const local = script.error.offset - script.offset;
    const awaitAtTop =
      script.kind === 'classic' && /\bawait\s*$/.test(script.code.slice(0, Math.max(0, local)));
    const label = `第 ${index + 1} 个 <script>${script.kind === 'module' ? '（type="module"）' : ''}`;
    push(
      'js.syntax',
      script.error.offset,
      `${label}解析失败：${script.error.message}` +
        (awaitAtTop ? '（经典脚本里 await 只能写在 async 函数内）' : '') +
        '——整段脚本都不会执行',
    );
  });
  for (const handler of model.handlers) {
    if (handler.error === null) continue;
    push(
      'js.handler-syntax',
      handler.error.offset,
      `<${handler.tagName} ${handler.attr}="${clip(handler.code)}"> 解析失败：${handler.error.message}`,
    );
  }
}

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// --- js.handler-undefined -----------------------------------------------------------

function whereDefined(name: string, analysis: Analysis): string {
  const list = analysis.bindings.get(name) ?? [];
  if (list.some((binding) => binding.unitKind === 'module')) {
    return `${name} 定义在 type="module" 脚本里（模块作用域），内联处理器看不到`;
  }
  if (list.length > 0) {
    return `${name} 定义在函数内部（如 DOMContentLoaded / load 回调里），不是全局函数，内联处理器看不到`;
  }
  return `${name} 没有定义`;
}

function visibleToHandler(name: string, analysis: Analysis, inForm = false): boolean {
  return (
    analysis.globalNames.has(name) ||
    HANDLER_SCOPE_NAMES.has(name) ||
    (inForm && FORM_SCOPE_NAMES.has(name))
  );
}

/** 脚本生成的标记里的内联处理器：`` `<button onclick="del(${i})">` ``。 */
const MARKUP_HANDLER_RE = /\bon[a-z]+\s*=\s*\\?["']\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(/g;

function checkHandlers(analysis: Analysis, push: Push): void {
  for (const { unit, facts } of analysis.units) {
    if (unit.kind !== 'handler' || unit.program === null) continue;
    const handler = unit as InlineHandler;
    const local = new Set(facts.bindings.map((binding) => binding.name));
    const seen = new Set<string>();
    walk(unit.program, (node, ancestors, key) => {
      if (node.type !== 'Identifier') return;
      const parent = ancestors[ancestors.length - 1];
      if (identifierRole(node, parent, key, facts.bindingNodes) !== 'ref') return;
      if (isTypeofOperand(parent)) return;
      // 赋值目标（`oninput="price = +value"`）在 sloppy 模式下建隐式全局，不报错。
      if (parent?.type === 'AssignmentExpression' && key === 'left') return;
      const name = node.name;
      if (local.has(name) || visibleToHandler(name, analysis, handler.inForm) || seen.has(name)) {
        return;
      }
      seen.add(name);
      push(
        'js.handler-undefined',
        unitOffset(unit, node.start),
        `<${handler.tagName} ${handler.attr}="${clip(handler.code)}">：${whereDefined(name, analysis)}`,
      );
    });
  }
  // 脚本拼出来的 HTML 里的 onclick（innerHTML / 模板字符串）同样只看得见全局。
  for (const { unit } of analysis.units) {
    if (unit.kind === 'handler' || unit.program === null) continue;
    walk(unit.program, (node) => {
      let raw: string | null = null;
      if (node.type === 'Literal' && typeof node.value === 'string') raw = node.raw ?? null;
      else if (node.type === 'TemplateLiteral') raw = unit.code.slice(node.start, node.end);
      if (raw === null || !raw.includes('on')) return;
      for (const match of raw.matchAll(MARKUP_HANDLER_RE)) {
        const name = match[1] ?? '';
        if (visibleToHandler(name, analysis)) continue;
        const nameAt = match.index + match[0].lastIndexOf(name);
        push(
          'js.handler-undefined',
          unitOffset(unit, node.start + nameAt),
          `脚本生成的标记里 ${clip(match[0], 40)}…：${whereDefined(name, analysis)}`,
        );
      }
    });
  }
}

// --- js.undefined-name -------------------------------------------------------------

function checkUndefinedNames(analysis: Analysis, push: Push): void {
  // 每个名字只报一处：被调用的那处优先（error），否则第一次出现（warning）。
  const found = new Map<string, { offset: number; called: boolean; count: number }>();
  for (const { unit, facts } of analysis.units) {
    if (unit.kind === 'handler' || unit.program === null) continue;
    walk(unit.program, (node, ancestors, key) => {
      if (node.type !== 'Identifier') return;
      const parent = ancestors[ancestors.length - 1];
      if (identifierRole(node, parent, key, facts.bindingNodes) !== 'ref') return;
      if (isTypeofOperand(parent) || analysis.declaredAnywhere.has(node.name)) return;
      const called = isCallee(node, parent, key);
      const offset = unitOffset(unit, node.start);
      const prev = found.get(node.name);
      if (prev === undefined) found.set(node.name, { offset, called, count: 1 });
      else {
        prev.count += 1;
        if (called && !prev.called) {
          prev.called = true;
          prev.offset = offset;
        }
      }
    });
  }
  for (const [name, hit] of found) {
    const library = LIBRARY_NAMES.has(name)
      ? `（${name} 是第三方库的全局名：沙箱加载不了 CDN，这个库不存在）`
      : '';
    const more = hit.count > 1 ? `（共 ${hit.count} 处）` : '';
    push(
      'js.undefined-name',
      hit.offset,
      hit.called
        ? `调用了未定义的 ${name}${library}${more}，运行到这里会抛 ReferenceError`
        : `使用了未定义的 ${name}${library}${more}`,
      hit.called ? 'error' : 'warning',
    );
  }
}

// --- js.redeclare ----------------------------------------------------------------

function checkRedeclare(model: WidgetHtmlModel, analysis: Analysis, push: Push): void {
  // 只有能解析的经典脚本会执行；按文档序累积全局声明。
  const seen = new Map<string, { lexical: boolean; script: number }>();
  for (const { unit, facts } of analysis.units) {
    if (unit.kind !== 'classic') continue;
    const scriptNo = model.scripts.indexOf(unit as (typeof model.scripts)[number]) + 1;
    const mine: Array<{ name: string; lexical: boolean; node: AnyNode }> = [];
    for (const binding of facts.bindings) {
      if (binding.topLexical) mine.push({ name: binding.name, lexical: true, node: binding.node });
      else if (binding.global)
        mine.push({ name: binding.name, lexical: false, node: binding.node });
    }
    for (const decl of mine) {
      const at = unitOffset(unit, decl.node.start);
      if (decl.lexical && RESTRICTED_GLOBALS.has(decl.name)) {
        push(
          'js.redeclare',
          at,
          `顶层 let / const / class 用了 ${decl.name}：与浏览器内置全局冲突，第 ${scriptNo} 个 <script> 整段抛 SyntaxError`,
        );
        continue;
      }
      const prev = seen.get(decl.name);
      if (prev === undefined || prev.script === scriptNo) continue;
      if (decl.lexical || prev.lexical) {
        push(
          'js.redeclare',
          at,
          `${decl.name} 已在第 ${prev.script} 个 <script> 里声明过：第 ${scriptNo} 个 <script> 整段抛 SyntaxError（Identifier '${decl.name}' has already been declared），一行都不执行`,
        );
      }
    }
    for (const decl of mine) {
      const prev = seen.get(decl.name);
      if (prev === undefined || decl.lexical)
        seen.set(decl.name, { lexical: decl.lexical, script: scriptNo });
    }
  }
}

// --- dom.id-missing / dom.duplicate-id ------------------------------------------------

/** 选择器里的 `#id`（去掉引号串与属性选择器，免得 `[href="#a"]` 被当成 id）。 */
function selectorIds(selector: string): string[] {
  const stripped = selector.replace(/"[^"]*"|'[^']*'/g, '').replace(/\[[^\]]*\]/g, '');
  return [...stripped.matchAll(/#(-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*)/g)].map(
    (match) => match[1] ?? '',
  );
}

function checkIds(model: WidgetHtmlModel, analysis: Analysis, push: Push): void {
  const html = model.source.text;
  const lookups: Array<{ id: string; offset: number; via: string }> = [];
  /**
   * 不算「别处出现」的位置：查找调用的字面量本身与所有标识符。名字的命中位置总是落在这些节点
   * 的起点（标识符）或起点 +1（字符串字面量的引号之后），按起点集合 O(1) 判定——2MB 的 HTML
   * 里成千上万个同名标识符也不会退化成「查找 × 命中 × 标识符」的三重扫描。
   */
  const excluded = new Set<number>();
  for (const { unit } of analysis.units) {
    if (unit.program === null) continue;
    walk(unit.program, (node) => {
      if (node.type === 'Identifier' && unit.exact) {
        excluded.add(unit.offset + node.start);
        return;
      }
      if (node.type !== 'CallExpression') return;
      const method = propertyName(node.callee);
      if (
        method !== 'getElementById' &&
        method !== 'querySelector' &&
        method !== 'querySelectorAll'
      )
        return;
      const arg = node.arguments[0];
      const text = stringValue(arg);
      if (text === null || arg === undefined) return;
      const ids = method === 'getElementById' ? [text.trim()] : selectorIds(text);
      for (const id of ids) {
        if (unit.exact && id !== '') {
          // 字面量本身里这个名字的每一处出现都不算「别处」。
          const start = unit.offset + arg.start;
          const end = unit.offset + arg.end;
          for (
            let at = html.indexOf(id, start);
            at >= 0 && at < end;
            at = html.indexOf(id, at + 1)
          ) {
            excluded.add(at);
          }
        }
        if (id !== '')
          lookups.push({ id, offset: unitOffset(unit, arg.start), via: `${method}('${text}')` });
      }
    });
  }
  const isExcluded = (index: number): boolean => excluded.has(index);
  const reported = new Set<string>();
  for (const lookup of lookups) {
    if (model.ids.has(lookup.id) || reported.has(`${lookup.id}@${lookup.offset}`)) continue;
    // 源码别处（字符串、模板、标记、样式、注释）出现过这个名字 → 多半是动态生成的元素，不报。
    const re = new RegExp(`(?<![\\w-])${escapeRegExp(lookup.id)}(?![\\w-])`, 'g');
    const elsewhere = [...html.matchAll(re)].some((match) => !isExcluded(match.index));
    if (elsewhere) continue;
    reported.add(`${lookup.id}@${lookup.offset}`);
    push(
      'dom.id-missing',
      lookup.offset,
      `${lookup.via}：页面里没有 id="${lookup.id}" 的元素，拿到 null 后再访问属性会抛 TypeError`,
    );
  }

  for (const [id, places] of model.ids) {
    const live = places.filter((place) => !place.inTemplate);
    if (live.length < 2) continue;
    const first = model.source.position(live[0]?.offset ?? 0);
    for (const place of live.slice(1)) {
      push('dom.duplicate-id', place.offset, `id="${id}" 重复（第一次出现在第 ${first.line} 行）`);
    }
  }
}

// --- kepcup.not-awaited -------------------------------------------------------------

const KEPCUP_ASYNC = new Set([
  'kepcup.query',
  'kepcup.storage.get',
  'kepcup.storage.set',
  'kepcup.storage.delete',
  'kepcup.storage.list',
]);

/** 之后被 await / .then / Promise.* 消费过的变量名（`const p = kepcup.query(…); await p` 不报）。 */
function awaitedNames(program: AnyNode): Set<string> {
  const names = new Set<string>();
  const addIdentifiers = (node: AnyNode | null | undefined): void => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'ArrayExpression')
      for (const el of node.elements) if (el) addIdentifiers(el);
  };
  walk(program, (node) => {
    if (node.type === 'AwaitExpression') addIdentifiers(node.argument);
    else if (node.type === 'MemberExpression') {
      const prop = propertyName(node);
      if (prop === 'then' || prop === 'catch' || prop === 'finally') addIdentifiers(node.object);
    } else if (node.type === 'CallExpression') {
      const callee = memberPath(node.callee);
      if (callee?.[0] === 'Promise') for (const arg of node.arguments) addIdentifiers(arg);
    }
  });
  return names;
}

function notAwaitedUse(
  call: AnyNode,
  ancestors: readonly AnyNode[],
  awaited: ReadonlySet<string>,
): string | null {
  let child: AnyNode = call;
  let index = ancestors.length - 1;
  // 透明的包装：可选链、条件 / 逻辑表达式的分支、逗号表达式的最后一项。
  while (index >= 0) {
    const parent = ancestors[index];
    if (parent === undefined) break;
    const transparent =
      parent.type === 'ChainExpression' ||
      parent.type === 'ParenthesizedExpression' ||
      parent.type === 'LogicalExpression' ||
      (parent.type === 'ConditionalExpression' && parent.test !== child) ||
      (parent.type === 'SequenceExpression' &&
        parent.expressions[parent.expressions.length - 1] === child);
    if (!transparent) break;
    child = parent;
    index -= 1;
  }
  const parent = ancestors[index];
  if (parent === undefined) return null;
  switch (parent.type) {
    case 'MemberExpression': {
      if (parent.object !== child) return null;
      const prop = propertyName(parent);
      return prop === 'then' || prop === 'catch' || prop === 'finally'
        ? null
        : `直接访问了 .${prop ?? '[…]'}`;
    }
    case 'VariableDeclarator':
      if (parent.init !== child) return null;
      return parent.id.type === 'Identifier' && awaited.has(parent.id.name)
        ? null
        : '直接赋给了变量';
    case 'AssignmentExpression':
      if (parent.right !== child) return null;
      return parent.left.type === 'Identifier' && awaited.has(parent.left.name)
        ? null
        : '直接赋了值';
    case 'CallExpression':
    case 'NewExpression': {
      if (parent.callee === child) return null;
      const callee = memberPath(parent.callee);
      return callee?.[0] === 'Promise' ? null : '直接当作参数传了出去';
    }
    case 'BinaryExpression':
    case 'TemplateLiteral':
      return '直接参与了运算 / 拼接';
    case 'UnaryExpression':
      return parent.operator === 'void' ? null : '直接参与了运算';
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return parent.test === child ? '直接当作条件（Promise 恒为真）' : null;
    case 'ConditionalExpression':
      return parent.test === child ? '直接当作条件（Promise 恒为真）' : null;
    case 'SpreadElement':
      return '直接被展开';
    case 'Property':
      return parent.value === child ? '直接放进了对象' : null;
    default:
      return null;
  }
}

function checkNotAwaited(analysis: Analysis, push: Push): void {
  for (const { unit } of analysis.units) {
    if (unit.program === null) continue;
    const awaited = awaitedNames(unit.program);
    walk(unit.program, (node, ancestors) => {
      if (node.type !== 'CallExpression') return;
      const callee = memberPath(node.callee);
      if (callee === null) return;
      const name = stripGlobalAliases(callee).join('.');
      if (!KEPCUP_ASYNC.has(name)) return;
      const use = notAwaitedUse(node, ancestors, awaited);
      if (use === null) return;
      push(
        'kepcup.not-awaited',
        unitOffset(unit, node.start),
        `${name}(…) 返回的是 Promise，没有 await 就${use}`,
      );
    });
  }
}
