import { parse as parseJs, tokenizer, type AnyNode, type Program } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';

/**
 * 检查器共用的源码模型（设计 32 §11.8）：index.html 只解析一次（parse5 带源码位置），
 * 抽出内联脚本、`on*` 属性、样式、id 与元素，再给 S0 / S1 规则共用的 JS 小工具
 * （通用遍历、标识符角色、成员路径、绑定收集）。
 *
 * 位置约定：一切位置都是 **index.html 原文的偏移**（UTF-16 码元，与 parse5 / acorn 一致；
 * parse5 的 offset 是原文偏移，CRLF 不折叠）。内联脚本的代码直接按偏移从原文切出来
 * （而不是用 parse5 的文本节点值——那份值把 CRLF 归一成了 LF），acorn 的 `pos` 加上
 * 脚本起点就是文件偏移，再经 {@link SourceText.position} 换成 1 起的行:列——「首行按起始列
 * 偏移、后续行从第 1 列起」自然成立。属性值有实体时（`&quot;`）解码后的文本与原文不等长，
 * 只能映射到值的起点（`exact=false`）。
 */

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;

/** 行首偏移表：offset → 1 起的行 / 列（`\r\n`、`\r`、`\n` 都算换行，同浏览器与 acorn）。 */
export class SourceText {
  readonly text: string;
  readonly #lineStarts: number[] = [0];

  constructor(text: string) {
    this.text = text;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      if (ch === 13 /* \r */) {
        if (text.charCodeAt(i + 1) === 10) i += 1;
        this.#lineStarts.push(i + 1);
      } else if (ch === 10 || ch === 0x2028 || ch === 0x2029) {
        this.#lineStarts.push(i + 1);
      }
    }
  }

  position(offset: number): { line: number; col: number } {
    const at = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.#lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#lineStarts[mid] ?? 0) <= at) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: at - (this.#lineStarts[lo] ?? 0) + 1 };
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }
}

export interface JsParseError {
  /** acorn 的报错（去掉末尾的 `(行:列)`）。 */
  message: string;
  /** 文件偏移。 */
  offset: number;
}

/** 一段可解析的 JS（内联脚本或 `on*` 属性体）。 */
export interface JsUnit {
  kind: 'classic' | 'module' | 'handler';
  /** 原文切片（handler 是解码后的属性值）。 */
  code: string;
  /** code[0] 在文件里的偏移。 */
  offset: number;
  /** false = code 与原文不等长（属性值含实体），位置只能落在值的起点。 */
  exact: boolean;
  program: Program | null;
  error: JsParseError | null;
  /** 文档序号（脚本与处理器各自计数）。 */
  index: number;
}

export interface InlineScript extends JsUnit {
  kind: 'classic' | 'module';
  /** `<script` 的偏移。 */
  tagOffset: number;
}

export interface InlineHandler extends JsUnit {
  kind: 'handler';
  /** 属性名（小写，如 `onclick`）。 */
  attr: string;
  tagName: string;
  /** 属性（名字处）的偏移。 */
  attrOffset: number;
  /** 元素在 `<form>` 里（处理器的作用域链上才有表单的 submit / reset / elements…）。 */
  inForm: boolean;
}

/** CSS 文本（`<style>` 内容或 `style` 属性值）。 */
export interface CssUnit {
  code: string;
  offset: number;
  exact: boolean;
}

export interface ElementInfo {
  tagName: string;
  /** 属性（小写名 → 解码后的值）。 */
  attrs: Map<string, string>;
  /** `<tag` 的偏移。 */
  offset: number;
  /** 祖先里有 `<form>`。 */
  inForm: boolean;
  /** 在 `<template>` 内容里（不渲染、脚本不执行）。 */
  inTemplate: boolean;
  /** 属性名处的偏移（找不到退到标签起点）。 */
  attrOffset(name: string): number;
  /** 属性值第一个字符的偏移与是否逐字对应（找不到退到属性名处）。 */
  attrValue(name: string): { offset: number; exact: boolean };
}

export interface WidgetHtmlModel {
  source: SourceText;
  /** parse5 的文档模式：缺 doctype 时为 `quirks`。 */
  mode: string;
  elements: ElementInfo[];
  scripts: InlineScript[];
  handlers: InlineHandler[];
  styles: CssUnit[];
  /** id → 出现处（id 属性值的偏移，文档序；含 template 内容）。 */
  ids: Map<string, Array<{ offset: number; inTemplate: boolean }>>;
}

/** 视为 JavaScript 的 `<script type>`（HTML 规范的 JS MIME 列表；空 / 缺省也是）。 */
const JS_MIME = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

export function scriptKindOf(typeAttr: string | undefined): 'classic' | 'module' | null {
  const type = (typeAttr ?? '').trim().toLowerCase();
  if (type === 'module') return 'module';
  return JS_MIME.has(type) ? 'classic' : null;
}

/** acorn 解析：经典脚本按 script、module 按 module、处理器按函数体（允许顶层 return）。 */
export function parseUnit(
  code: string,
  kind: JsUnit['kind'],
): { program: Program | null; error: { message: string; pos: number } | null } {
  try {
    const program = parseJs(code, {
      ecmaVersion: 'latest',
      sourceType: kind === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: kind === 'handler',
      allowHashBang: false,
    });
    return { program, error: null };
  } catch (error) {
    const err = error as { message?: string; pos?: number };
    const message = String(err.message ?? error).replace(/\s*\(\d+:\d+\)\s*$/, '');
    return { program: null, error: { message, pos: typeof err.pos === 'number' ? err.pos : 0 } };
  }
}

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node && typeof (node as P5Element).tagName === 'string';
}

function childrenOf(node: P5Node): P5Node[] {
  const kids: P5Node[] = 'childNodes' in node ? [...(node.childNodes as P5Node[])] : [];
  return kids;
}

/** 单条缓存：S0 与 S1 对同一份 HTML 各调一次，只解析一遍。 */
let cache: { html: string; model: WidgetHtmlModel } | null = null;

export function analyzeWidgetHtml(html: string): WidgetHtmlModel {
  if (cache !== null && cache.html === html) return cache.model;
  const model = buildModel(html);
  cache = { html, model };
  return model;
}

function buildModel(html: string): WidgetHtmlModel {
  const source = new SourceText(html);
  const doc = parseHtml(html, { sourceCodeLocationInfo: true });
  const model: WidgetHtmlModel = {
    source,
    mode: String(doc.mode),
    elements: [],
    scripts: [],
    handlers: [],
    styles: [],
    ids: new Map(),
  };

  const visit = (node: P5Node, inForm: boolean, inTemplate: boolean): void => {
    if (isElement(node)) {
      const info = elementInfo(html, node, inForm, inTemplate);
      if (info !== null) {
        model.elements.push(info);
        collectFromElement(html, node, info, model);
      }
      const nextInForm = inForm || node.tagName === 'form';
      if (node.tagName === 'template' && 'content' in node) {
        for (const kid of childrenOf((node as DefaultTreeAdapterTypes.Template).content)) {
          visit(kid, nextInForm, true);
        }
      }
      for (const kid of childrenOf(node)) visit(kid, nextInForm, inTemplate);
      return;
    }
    for (const kid of childrenOf(node)) visit(kid, inForm, inTemplate);
  };
  visit(doc, false, false);
  return model;
}

function elementInfo(
  html: string,
  node: P5Element,
  inForm: boolean,
  inTemplate: boolean,
): ElementInfo | null {
  const loc = node.sourceCodeLocation;
  // parse5 自己补出来的元素（隐式 html / head / body）没有位置：不算作者写的元素。
  if (loc === undefined || loc === null) return null;
  const attrs = new Map<string, string>();
  for (const attr of node.attrs) {
    if (!attrs.has(attr.name)) attrs.set(attr.name, attr.value);
  }
  const attrLocs = loc.attrs ?? {};
  const attrOffset = (name: string): number => attrLocs[name]?.startOffset ?? loc.startOffset;
  const attrValue = (name: string): { offset: number; exact: boolean } => {
    const attrLoc = attrLocs[name];
    if (attrLoc === undefined) return { offset: loc.startOffset, exact: false };
    const raw = html.slice(attrLoc.startOffset, attrLoc.endOffset);
    const eq = raw.indexOf('=');
    if (eq < 0) return { offset: attrLoc.startOffset, exact: false };
    let at = eq + 1;
    while (at < raw.length && /\s/.test(raw[at] ?? '')) at += 1;
    const quote = raw[at];
    const quoted = quote === '"' || quote === "'";
    if (quoted) at += 1;
    const rawValue = raw.slice(at, quoted ? raw.length - 1 : raw.length);
    return {
      offset: attrLoc.startOffset + at,
      exact: rawValue === (attrs.get(name) ?? ''),
    };
  };
  return {
    tagName: node.tagName,
    attrs,
    offset: loc.startOffset,
    inForm,
    inTemplate,
    attrOffset,
    attrValue,
  };
}

function collectFromElement(
  html: string,
  node: P5Element,
  info: ElementInfo,
  model: WidgetHtmlModel,
): void {
  const id = info.attrs.get('id');
  if (id !== undefined && id !== '') {
    const list = model.ids.get(id) ?? [];
    list.push({ offset: info.attrValue('id').offset, inTemplate: info.inTemplate });
    model.ids.set(id, list);
  }
  if (info.inTemplate) return;

  for (const [name, value] of info.attrs) {
    if (name.startsWith('on') && name.length > 2 && value.trim() !== '') {
      const { offset, exact } = info.attrValue(name);
      const parsed = parseUnit(value, 'handler');
      model.handlers.push({
        kind: 'handler',
        attr: name,
        tagName: info.tagName,
        attrOffset: info.attrOffset(name),
        inForm: info.inForm || info.tagName === 'form',
        code: value,
        offset,
        exact,
        program: parsed.program,
        error:
          parsed.error === null
            ? null
            : {
                message: parsed.error.message,
                offset: exact ? offset + parsed.error.pos : offset,
              },
        index: model.handlers.length,
      });
    }
    if (name === 'style' && value.trim() !== '') {
      const { offset, exact } = info.attrValue(name);
      model.styles.push({ code: value, offset, exact });
    }
  }

  if (info.tagName === 'script' || info.tagName === 'style') {
    const text = childrenOf(node).find((kid) => kid.nodeName === '#text');
    const textLoc = text?.sourceCodeLocation;
    if (text === undefined || textLoc === undefined || textLoc === null) return;
    const code = html.slice(textLoc.startOffset, textLoc.endOffset);
    if (info.tagName === 'style') {
      model.styles.push({ code, offset: textLoc.startOffset, exact: true });
      return;
    }
    // 带 src 的脚本：内联内容被浏览器忽略（外链本身由 S0 报）。
    if (info.attrs.has('src')) return;
    const kind = scriptKindOf(info.attrs.get('type'));
    if (kind === null || code.trim() === '') return;
    const parsed = parseUnit(code, kind);
    model.scripts.push({
      kind,
      code,
      offset: textLoc.startOffset,
      exact: true,
      tagOffset: info.offset,
      program: parsed.program,
      error:
        parsed.error === null
          ? null
          : { message: parsed.error.message, offset: textLoc.startOffset + parsed.error.pos },
      index: model.scripts.length,
    });
  }
}

/** JS 单元里某个位置（单元内偏移）对应的文件偏移。 */
export function unitOffset(unit: Pick<JsUnit, 'offset' | 'exact'>, pos: number): number {
  return unit.exact ? unit.offset + pos : unit.offset;
}

// --- JS 小工具 -------------------------------------------------------------------

type Visitor = (node: AnyNode, ancestors: readonly AnyNode[], key: string | null) => void;

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

function isNode(value: unknown): value is AnyNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** 通用前序遍历（没有 acorn-walk）：visitor 拿到节点、祖先链（近的在后）与父节点里的字段名。 */
export function walk(root: AnyNode, visitor: Visitor): void {
  const ancestors: AnyNode[] = [];
  const go = (node: AnyNode, key: string | null): void => {
    visitor(node, ancestors, key);
    ancestors.push(node);
    const record = node as unknown as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (SKIP_KEYS.has(field)) continue;
      const value = record[field];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) go(item, field);
      } else if (isNode(value)) {
        go(value, field);
      }
    }
    ancestors.pop();
  };
  go(root, null);
}

export function isFunctionNode(node: AnyNode): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'StaticBlock'
  );
}

/** 绑定模式里的标识符（不含默认值表达式与计算键）。 */
export function patternIdentifiers(
  pattern: AnyNode | null | undefined,
  out: AnyNode[] = [],
): AnyNode[] {
  if (pattern === null || pattern === undefined) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') patternIdentifiers(prop.argument, out);
        else patternIdentifiers(prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) patternIdentifiers(element, out);
      break;
    case 'RestElement':
      patternIdentifiers(pattern.argument, out);
      break;
    case 'AssignmentPattern':
      patternIdentifiers(pattern.left, out);
      break;
    default:
      break;
  }
  return out;
}

export interface BindingInfo {
  name: string;
  node: AnyNode;
  kind: 'var' | 'let' | 'const' | 'function' | 'class' | 'param' | 'catch' | 'import' | 'local';
  /** 经典脚本里落在全局（var / 顶层函数 / 顶层 let·const·class）；module 与处理器恒为 false。 */
  global: boolean;
  /** 顶层词法声明（let / const / class 直接在 Program 下）。 */
  topLexical: boolean;
}

export interface ProgramFacts {
  bindings: BindingInfo[];
  /** 声明位置的标识符节点（遍历时据此区分「声明」与「引用」）。 */
  bindingNodes: Set<AnyNode>;
  /** 赋值目标里的裸名字（`x = …`、`[a, b] = …`、`for (x of …)`）。 */
  assignedNames: Map<string, AnyNode>;
  /** 挂到全局对象上的名字：`window.x =` / `globalThis.x =` / `self.x =` / `Object.assign(window, {x})`。 */
  windowNames: Set<string>;
  /** 自定义的方法 / 属性名（对象字面量键、类方法），用来排除 `.submit()` 之类的同名误报。 */
  memberNames: Set<string>;
}

export const GLOBAL_ALIASES = new Set(['window', 'self', 'globalThis']);

function functionAncestor(ancestors: readonly AnyNode[]): boolean {
  return ancestors.some(isFunctionNode);
}

/** 收集一段程序的声明与全局化事实（轻量：不建作用域树，只看声明落点）。 */
export function programFacts(program: Program, kind: JsUnit['kind']): ProgramFacts {
  const facts: ProgramFacts = {
    bindings: [],
    bindingNodes: new Set(),
    assignedNames: new Map(),
    windowNames: new Set(),
    memberNames: new Set(),
  };
  const classic = kind === 'classic';
  const add = (
    ids: AnyNode[],
    bindingKind: BindingInfo['kind'],
    global: boolean,
    topLexical = false,
  ): void => {
    for (const id of ids) {
      if (id.type !== 'Identifier') continue;
      facts.bindingNodes.add(id);
      facts.bindings.push({ name: id.name, node: id, kind: bindingKind, global, topLexical });
    }
  };
  const addAssignTargets = (target: AnyNode): void => {
    if (target.type === 'MemberExpression') {
      const object = target.object;
      const prop = propertyName(target);
      if (object.type === 'Identifier' && GLOBAL_ALIASES.has(object.name) && prop !== null) {
        facts.windowNames.add(prop);
      }
      return;
    }
    for (const id of patternIdentifiers(target)) {
      if (id.type === 'Identifier' && !facts.assignedNames.has(id.name)) {
        facts.assignedNames.set(id.name, id);
      }
    }
    // 解构赋值里的成员目标（`[window.a] = …`）忽略。
  };

  walk(program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    switch (node.type) {
      case 'VariableDeclaration': {
        const inFunction = functionAncestor(ancestors);
        const top = parent?.type === 'Program';
        // for (let x of …) 的 let 也走这里（不是顶层，global=false）。
        for (const decl of node.declarations) {
          const ids = patternIdentifiers(decl.id);
          if (node.kind === 'var') add(ids, 'var', classic && !inFunction);
          else add(ids, node.kind === 'let' ? 'let' : 'const', classic && top, classic && top);
        }
        break;
      }
      case 'FunctionDeclaration':
        if (node.id) add([node.id], 'function', classic && !functionAncestor(ancestors));
        for (const param of node.params) add(patternIdentifiers(param), 'param', false);
        break;
      case 'FunctionExpression':
        if (node.id) add([node.id], 'local', false);
        for (const param of node.params) add(patternIdentifiers(param), 'param', false);
        break;
      case 'ArrowFunctionExpression':
        for (const param of node.params) add(patternIdentifiers(param), 'param', false);
        break;
      case 'ClassDeclaration': {
        const top = parent?.type === 'Program';
        if (node.id) add([node.id], 'class', classic && top, classic && top);
        break;
      }
      case 'ClassExpression':
        if (node.id) add([node.id], 'local', false);
        break;
      case 'CatchClause':
        if (node.param) add(patternIdentifiers(node.param), 'catch', false);
        break;
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        add([node.local], 'import', false);
        break;
      case 'AssignmentExpression':
        addAssignTargets(node.left);
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.left.type !== 'VariableDeclaration') addAssignTargets(node.left);
        break;
      case 'CallExpression': {
        // Object.assign(window, { a, b }) —— 常见的「导出给 onclick」写法。
        const callee = memberPath(node.callee);
        const target = node.arguments[0];
        if (
          callee !== null &&
          callee.join('.') === 'Object.assign' &&
          target?.type === 'Identifier' &&
          GLOBAL_ALIASES.has(target.name)
        ) {
          for (const source of node.arguments.slice(1)) {
            if (source.type !== 'ObjectExpression') continue;
            for (const prop of source.properties) {
              if (prop.type !== 'Property') continue;
              const name = keyName(prop.key, prop.computed);
              if (name !== null) facts.windowNames.add(name);
            }
          }
        }
        break;
      }
      case 'Property': {
        const name = keyName(node.key, node.computed);
        if (name !== null && parent?.type === 'ObjectExpression') facts.memberNames.add(name);
        break;
      }
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        const name = keyName(node.key, node.computed);
        if (name !== null) facts.memberNames.add(name);
        break;
      }
      default:
        break;
    }
  });
  return facts;
}

function keyName(key: AnyNode, computed: boolean): string | null {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** 成员表达式的属性名（非计算属性，或计算属性里的字符串字面量）。 */
export function propertyName(node: AnyNode): string | null {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

/** `a.b['c'].d` → `['a','b','c','d']`；根不是标识符或中间有动态属性时为 null。 */
export function memberPath(node: AnyNode): string[] | null {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ChainExpression') return memberPath(node.expression);
  if (node.type === 'ParenthesizedExpression') return memberPath(node.expression);
  if (node.type !== 'MemberExpression') return null;
  const head = memberPath(node.object);
  const prop = propertyName(node);
  if (head === null || prop === null) return null;
  return [...head, prop];
}

/** 去掉开头的全局对象别名：`window.self.localStorage` → `['localStorage']`。 */
export function stripGlobalAliases(path: readonly string[]): string[] {
  let at = 0;
  while (at < path.length - 1 && GLOBAL_ALIASES.has(path[at] ?? '')) at += 1;
  return path.slice(at);
}

export type IdentifierRole = 'ref' | 'binding' | 'property' | 'key' | 'label' | 'meta';

/** 标识符在父节点里的角色：只有 `ref` 是对某个名字的引用。 */
export function identifierRole(
  node: AnyNode,
  parent: AnyNode | undefined,
  key: string | null,
  bindingNodes: ReadonlySet<AnyNode>,
): IdentifierRole {
  if (bindingNodes.has(node)) return 'binding';
  if (parent === undefined) return 'ref';
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'property' && !parent.computed ? 'property' : 'ref';
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key === 'key' && !parent.computed ? 'key' : 'ref';
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return 'label';
    case 'MetaProperty':
      return 'meta';
    case 'ImportSpecifier':
      return key === 'imported' ? 'key' : 'binding';
    case 'ExportSpecifier':
      return key === 'exported' ? 'key' : 'ref';
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return 'binding';
    default:
      return 'ref';
  }
}

/** 是 `typeof x` 的操作数（未声明也不抛错）。 */
export function isTypeofOperand(parent: AnyNode | undefined): boolean {
  return parent?.type === 'UnaryExpression' && parent.operator === 'typeof';
}

/** 标识符是否作为被调用者（`x()` / `new x()`）。 */
export function isCallee(node: AnyNode, parent: AnyNode | undefined, key: string | null): boolean {
  return (
    (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') &&
    key === 'callee' &&
    parent.callee === node
  );
}

/** 字符串值：普通字符串字面量，或没有插值的模板字符串。 */
export function stringValue(node: AnyNode | undefined | null): string | null {
  if (node === undefined || node === null) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** 解析不了的脚本的降级扫描：acorn 词法器读到出错处为止（注释被跳过、字符串是独立记号）。 */
export interface JsToken {
  type: string;
  value: string;
  start: number;
  end: number;
}

export function scanTokens(code: string, kind: JsUnit['kind']): JsToken[] {
  const tokens: JsToken[] = [];
  try {
    for (const token of tokenizer(code, {
      ecmaVersion: 'latest',
      sourceType: kind === 'module' ? 'module' : 'script',
      allowReturnOutsideFunction: true,
    })) {
      tokens.push({
        type: token.type.label,
        value: tokenValue((token as unknown as { value?: unknown }).value),
        start: token.start,
        end: token.end,
      });
    }
  } catch {
    // 读到词法错误为止（截断的字符串 / 模板）：前面的记号照样可用。
  }
  return tokens;
}

function tokenValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : String(value);
}

/** 正则转义。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉 CSS 注释（保留长度与换行，位置不变）。 */
export function blankCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, (match) => match.replace(/[^\r\n]/g, ' '));
}
