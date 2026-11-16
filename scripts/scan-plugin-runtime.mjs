#!/usr/bin/env node
// Runtime package static scan (D125 P4, docs/design/61-plugin-runtime-platform.md §7 / §10).
//
//   node scripts/scan-plugin-runtime.mjs --dir <plugin-dir> [--json]
//   node scripts/scan-plugin-runtime.mjs --package <file.kepcup> [--json]
//
// Every marketplace build runs this over packages whose manifest carries a `runtime`
// section (scripts/sign-plugin-index.mjs): a failing package is never signed/published.
// Data-only plugins are out of scope (the marketplace pipeline keeps its D104 checks).
//
// Checks (fail):
//   - native / binary payloads: .node / .wasm / .dll / .so / .dylib / .exe
//   - any symlink (a single-file bundle has no reason for one; install pipeline rejects too)
//   - the executable bit on POSIX archives
//   - code: eval / Function( / require / createRequire / process.binding-like escapes /
//     Worker( / globalThis[...] (the whole identifier, so `(0,eval)` and aliases fail too)
//   - static or dynamic import of a denied Node builtin (fs / net / http / child_process /
//     vm / worker_threads / module / …), of a remote / data: / file: specifier, of an
//     absolute path, or of a computed specifier (`import('node:' + x)`)
// Warn:
//   - an http(s) host inside bundled JS that `runtime.network.allow` does not cover
//     (manual review; wildcard matching is the runtime's own isHostAllowed semantics)
//
// Exports are pure over a file list so tests can build hostile fixtures in memory; the
// CLI is a thin wrapper around the directory / .kepcup readers.

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export class RuntimeScanError extends Error {}

/** Extensions that mean "native code / executable payload" (fail closed). */
export const RUNTIME_SCAN_FORBIDDEN_EXTENSIONS = [
  '.node',
  '.wasm',
  '.dll',
  '.so',
  '.dylib',
  '.exe',
];

/** JS-ish files whose text is scanned for dangerous constructs. */
const CODE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];

const CODE_RULES = [
  // The identifier (not just `eval(`) so indirect forms like `(0, eval)(...)`,
  // `const e = eval` and `globalThis.eval` all fail. Strings / comments are masked out.
  { pattern: /\beval\b/g, message: 'eval' },
  { pattern: /\bFunction\s*\(/g, message: 'Function(' },
  // A single-file ESM bundle has no business loading CommonJS modules; `require` is also
  // the shortest path to child_process / fs.
  { pattern: /\brequire\b/g, message: 'require（ESM 单文件插件不应使用 CommonJS 加载）' },
  { pattern: /\bcreateRequire\b/g, message: 'createRequire' },
  {
    pattern: /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen|getBuiltinModule|mainModule)\b/g,
    message: 'process.binding / 内置模块动态加载',
  },
  // Destructuring / aliasing the same methods (`const { getBuiltinModule } = process`)
  // must not slip past the member-access rule above.
  { pattern: /\bgetBuiltinModule\b/g, message: 'getBuiltinModule' },
  { pattern: /\b_linkedBinding\b/g, message: '_linkedBinding' },
  { pattern: /\bmainModule\b/g, message: 'mainModule' },
  { pattern: /\bWorker\s*\(/g, message: 'Worker(' },
  // Obfuscated code gets the global object through computed access (`globalThis["ev"+"al"]`);
  // a single-file bundle has no legitimate reason for it.
  { pattern: /\bglobalThis\s*\[/g, message: 'globalThis[...] 动态成员访问' },
  { pattern: /\bprocess\s*\[/g, message: 'process[...] 动态成员访问' },
  // Reflection routes to the same primitives (`Reflect.get(globalThis, 'eval')`,
  // `Object.getOwnPropertyDescriptor(globalThis, 'eval').value`, `…constructor.constructor`).
  {
    pattern: /\bReflect\s*\.\s*get\s*\(\s*globalThis\b/g,
    message: 'Reflect.get(globalThis, …)',
  },
  {
    pattern: /\bgetOwnPropertyDescriptor\s*\(\s*globalThis\b/g,
    message: 'getOwnPropertyDescriptor(globalThis, …)',
  },
  { pattern: /\bconstructor\s*\.\s*constructor\b/g, message: 'constructor.constructor' },
];

const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;

/** Builtins a plugin may never load itself (Host API is the only capability surface). */
const FORBIDDEN_MODULE_TARGETS = new Set([
  'child_process',
  'node:child_process',
  'cluster',
  'node:cluster',
  'dgram',
  'node:dgram',
  'dns',
  'node:dns',
  'dns/promises',
  'node:dns/promises',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'http',
  'node:http',
  'http2',
  'node:http2',
  'https',
  'node:https',
  'inspector',
  'node:inspector',
  'module',
  'node:module',
  'net',
  'node:net',
  'repl',
  'node:repl',
  'sqlite',
  'node:sqlite',
  'tls',
  'node:tls',
  'vm',
  'node:vm',
  'wasi',
  'node:wasi',
  'worker_threads',
  'node:worker_threads',
]);

/** Specifiers that can load code from outside the bundle. */
const REMOTE_SPECIFIER_PATTERN = /^(?:https?|data|file|ftp):/i;

/** Static `import 'x'` / `import … from 'x'` / `export … from 'x'`. */
const STATIC_IMPORT_PATTERN = /(?:\bimport|\bfrom)\s*(['"])([^'"]+)\1/g;

/** Identifier start/part (ASCII; enough to find identifiers in bundled JS). */
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

/** Keywords after which a `/` starts a regex literal, not a division. */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'delete',
  'void',
  'throw',
  'new',
  'yield',
  'await',
  'else',
  'do',
]);

/** Hosts extracted from bundled text: `http(s)://host[:port][/…]`. */
const URL_HOST_PATTERN = /\bhttps?:\/\/([^/'"`\s\\]+)/gi;

/**
 * Identifier namespaces that look like URLs in bundled libraries but are never request
 * targets (JSON Schema `$schema`, XML namespaces). Exempting them keeps the allowlist
 * warning signal about actual network intent.
 */
const NON_NETWORK_HOSTS = new Set([
  'json-schema.org',
  'www.w3.org',
  'w3.org',
  'schemas.xmlsoap.org',
  'www.w3.org/2000/svg',
]);

/**
 * Finds the end of a regex literal starting at `start` (`/`), or -1 when the slash is a
 * division operator / an unterminated line. Handles escapes, character classes and flags.
 */
function regexLiteralEnd(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') return -1; // regex literals cannot span lines
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      let end = i + 1;
      while (end < text.length && /[a-z]/i.test(text[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * Masks comments, string literals, regex literals and template TEXT with spaces
 * (newlines preserved) so code rules match real code, not documentation strings or
 * comments. Template `${…}` expressions are NOT masked: a template interpolation is real
 * code (`\`${eval("…")}\`` must fail). A small lexer, not a parser — but it tracks regex
 * literals and template nesting so quotes inside them cannot desynchronise the mask
 * (the earlier version could be tricked into masking live code with `/["']/`).
 */
export function maskNonCode(text) {
  // split('') keeps UTF-16 code-unit indices aligned with text[i] below (spread would
  // split surrogate pairs and shift every later index for non-BMP characters).
  const out = text.split('');
  const length = text.length;
  /** Frames: `{ kind: 'template' }` or `{ kind: 'expr', depth }` (`${…}`). */
  const frames = [];
  let mode = 'code'; // code | line | block | single | double | template
  // Whether `/` at this position can start a regex literal (a value was just completed →
  // division; an operator / opening bracket / prefix keyword → regex).
  let regexAllowed = true;
  let index = 0;

  const blank = (from, to) => {
    for (let i = from; i < to && i < length; i += 1) if (text[i] !== '\n') out[i] = ' ';
  };
  const top = () => frames[frames.length - 1];

  while (index < length) {
    const ch = text[index];
    const next = text[index + 1];
    if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      else out[index] = ' ';
      index += 1;
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        out[index] = ' ';
        out[index + 1] = ' ';
        index += 2;
        mode = 'code';
      } else {
        if (ch !== '\n') out[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"';
      if (ch === '\\') {
        blank(index, index + 2);
        index += 2;
        continue;
      }
      if (ch === quote) {
        out[index] = ' ';
        mode = 'code';
        regexAllowed = false;
        index += 1;
        continue;
      }
      if (ch === '\n') {
        // A single/double-quoted string cannot span lines; do not let a malformed string
        // swallow (and hide) the rest of the file.
        mode = 'code';
        index += 1;
        continue;
      }
      out[index] = ' ';
      index += 1;
      continue;
    }
    if (mode === 'template') {
      if (ch === '\\') {
        blank(index, index + 2);
        index += 2;
        continue;
      }
      if (ch === '`') {
        out[index] = ' ';
        frames.pop();
        mode = 'code';
        regexAllowed = false;
        index += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        out[index] = ' ';
        out[index + 1] = ' ';
        frames.push({ kind: 'expr', depth: 0 });
        mode = 'code';
        regexAllowed = true;
        index += 2;
        continue;
      }
      if (ch !== '\n') out[index] = ' ';
      index += 1;
      continue;
    }
    // --- code -----------------------------------------------------------------
    if (ch === '/' && next === '/') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      mode = 'line';
      continue;
    }
    if (ch === '/' && next === '*') {
      out[index] = ' ';
      out[index + 1] = ' ';
      index += 2;
      mode = 'block';
      continue;
    }
    if (ch === "'") {
      out[index] = ' ';
      mode = 'single';
      index += 1;
      continue;
    }
    if (ch === '"') {
      out[index] = ' ';
      mode = 'double';
      index += 1;
      continue;
    }
    if (ch === '`') {
      out[index] = ' ';
      frames.push({ kind: 'template' });
      mode = 'template';
      index += 1;
      continue;
    }
    if (ch === '/' && regexAllowed) {
      const end = regexLiteralEnd(text, index);
      if (end !== -1) {
        blank(index, end);
        index = end;
        regexAllowed = false;
        continue;
      }
    }
    const frame = top();
    if (ch === '}' && frame?.kind === 'expr' && frame.depth === 0) {
      out[index] = ' ';
      frames.pop();
      mode = 'template';
      index += 1;
      continue;
    }
    if (ch === '{') {
      if (frame?.kind === 'expr') frame.depth += 1;
      regexAllowed = true;
      index += 1;
      continue;
    }
    if (ch === '}') {
      if (frame?.kind === 'expr' && frame.depth > 0) frame.depth -= 1;
      // `}` ends an operand (object literal) as often as a block; treating a following
      // `/` as division is the safe choice — otherwise `const x = {} / 2; eval(…)` can
      // be made to look like a regex literal and mask the eval call.
      regexAllowed = false;
      index += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '.') {
      regexAllowed = false;
      index += 1;
      continue;
    }
    if (ch === '+' || ch === '-') {
      if (next === ch) {
        regexAllowed = false;
        index += 2;
        continue;
      }
      regexAllowed = true;
      index += 1;
      continue;
    }
    if (ch === '/' || '([,;:?!&|*%^~<>='.includes(ch)) {
      regexAllowed = true;
      index += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      index += 1;
      continue;
    }
    if (IDENTIFIER_START.test(ch)) {
      let end = index + 1;
      while (end < length && IDENTIFIER_PART.test(text[end])) end += 1;
      regexAllowed = REGEX_PREFIX_KEYWORDS.has(text.slice(index, end));
      index = end;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let end = index + 1;
      while (end < length && /[0-9a-zA-Z_.]/.test(text[end])) end += 1;
      regexAllowed = false;
      index = end;
      continue;
    }
    index += 1;
  }
  return out.join('');
}

function normalizeRelative(filePath) {
  return String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isCodeFile(filePath) {
  const lower = filePath.toLowerCase();
  return CODE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function pushOnce(list, entry) {
  if (
    !list.some((candidate) => candidate.path === entry.path && candidate.message === entry.message)
  ) {
    list.push(entry);
  }
}

/** Skips whitespace and comments (comments are syntax trivia, not part of the argument). */
function skipTrivia(text, start) {
  let index = start;
  for (;;) {
    const ch = text[index];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      index += 1;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index + 2);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    return index;
  }
}

/** A specifier that reaches outside the package (absolute / parent traversal). */
function isEscapingSpecifier(specifier) {
  if (specifier.startsWith('/') || specifier.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return true; // Windows drive path
  return specifier.split(/[\\/]/).includes('..');
}

/**
 * Node loads an extensionless relative import as ESM (format from the nearest
 * package.json), which would let a clean entry pull in unscanned code (`import './chunk'`).
 * The single-file bundle convention has no legitimate need for one; require an extension.
 */
function isExtensionlessRelativeSpecifier(specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const pathPart = specifier.split(/[?#]/)[0] ?? '';
  return path.posix.extname(pathPart) === '';
}

/**
 * One dynamic import call → allowed / rejected. Whitelisted = a single static string
 * literal pointing at a relative path or a bare package specifier (esbuild-bundled);
 * remote schemes, computed specifiers, escaping paths and denied builtins fail.
 */
function checkDynamicImport(text, matchIndex, sourceName, errors) {
  let index = skipTrivia(text, matchIndex + 'import'.length);
  if (text[index] !== '(') return;
  index = skipTrivia(text, index + 1);
  const quote = text[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    errors.push({
      path: sourceName,
      message: `动态 import 不是静态字符串字面量（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  let end = index + 1;
  while (end < text.length && text[end] !== quote) {
    if (text[end] === '\\') {
      // Escaped specifiers (`'\x6eode:child_process'`) are deliberate obfuscation.
      errors.push({
        path: sourceName,
        message: `动态 import 的 specifier 含转义字符（第 ${lineOf(text, matchIndex)} 行）`,
      });
      return;
    }
    if (text[end] === '\n' && quote !== '`') return; // malformed literal
    end += 1;
  }
  if (end >= text.length) return; // Unterminated literal: not a valid dynamic import.
  const specifier = text.slice(index + 1, end).trim();
  // A `+` after the literal means the specifier is concatenated (`'node:' + x`).
  if (text[skipTrivia(text, end + 1)] === '+') {
    errors.push({
      path: sourceName,
      message: `动态 import 使用计算后的 specifier（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  if (specifier === '') return;
  if (quote === '`' && specifier.includes('${')) {
    errors.push({
      path: sourceName,
      message: `动态 import 使用模板插值（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  if (REMOTE_SPECIFIER_PATTERN.test(specifier)) {
    errors.push({
      path: sourceName,
      message: `动态 import 指向远程/非包内资源：${specifier}（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  if (FORBIDDEN_MODULE_TARGETS.has(specifier)) {
    errors.push({
      path: sourceName,
      message: `动态 import 指向受限模块：${specifier}（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  if (isEscapingSpecifier(specifier)) {
    errors.push({
      path: sourceName,
      message: `动态 import 指向包外路径：${specifier}（第 ${lineOf(text, matchIndex)} 行）`,
    });
    return;
  }
  if (isExtensionlessRelativeSpecifier(specifier)) {
    errors.push({
      path: sourceName,
      message: `动态 import 指向无扩展名文件：${specifier}（第 ${lineOf(text, matchIndex)} 行）`,
    });
  }
}

/**
 * Static imports / re-exports (`import … from 'x'`, `import 'x'`, `export … from 'x'`).
 * The regex is matched on raw text (the specifier is a string literal, which the mask
 * blanks), then the keyword position is checked against the mask so a specifier that only
 * appears inside a comment / string does not fail a release.
 */
function checkStaticImports(text, masked, sourceName, errors) {
  STATIC_IMPORT_PATTERN.lastIndex = 0;
  for (
    let match = STATIC_IMPORT_PATTERN.exec(text);
    match !== null;
    match = STATIC_IMPORT_PATTERN.exec(text)
  ) {
    const keywordIndex = match.index;
    if (masked.startsWith('import', keywordIndex) || masked.startsWith('from', keywordIndex)) {
      const specifier = match[2] ?? '';
      if (specifier === '') continue;
      const line = lineOf(text, keywordIndex);
      if (REMOTE_SPECIFIER_PATTERN.test(specifier)) {
        errors.push({
          path: sourceName,
          message: `静态 import 指向远程/非包内资源：${specifier}（第 ${line} 行）`,
        });
        continue;
      }
      if (FORBIDDEN_MODULE_TARGETS.has(specifier)) {
        errors.push({
          path: sourceName,
          message: `静态 import 指向受限模块：${specifier}（第 ${line} 行）`,
        });
        continue;
      }
      if (isEscapingSpecifier(specifier)) {
        errors.push({
          path: sourceName,
          message: `静态 import 指向包外路径：${specifier}（第 ${line} 行）`,
        });
        continue;
      }
      if (isExtensionlessRelativeSpecifier(specifier)) {
        errors.push({
          path: sourceName,
          message: `静态 import 指向无扩展名文件：${specifier}（第 ${line} 行）`,
        });
      }
    }
  }
}

/** Same matching semantics as core's `isHostAllowed` (exact host or `*.domain`). */
export function runtimeScanHostAllowed(host, allow) {
  const candidate = String(host).toLowerCase();
  for (const entry of allow ?? []) {
    const rule = String(entry).trim().toLowerCase();
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2);
      if (domain.length === 0) continue;
      if (candidate.length > domain.length && candidate.endsWith(`.${domain}`)) return true;
      continue;
    }
    if (candidate === rule) return true;
  }
  return false;
}

/**
 * Scans one package view.
 *
 * `files`: `[{ path, data?: Buffer|string, mode?: number, isSymlink?: boolean }]`
 * (`data` is only required for code files). Returns `null` when the manifest has no
 * runtime section (data-only plugins are not scanned here).
 */
export function scanRuntimePackage({ files, manifest }) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.runtime === undefined ||
    manifest.runtime === null
  ) {
    return null;
  }
  const errors = [];
  const warnings = [];
  const allow = Array.isArray(manifest.runtime.network?.allow)
    ? manifest.runtime.network.allow
    : [];
  const entry =
    typeof manifest.runtime.entry === 'string'
      ? manifest.runtime.entry.replace(/\\/g, '/').replace(/^\.\//, '')
      : null;

  // 61 §2：entry 是单文件 ESM。`.js` 的格式由最近 package.json 的 type 决定；没有
  // `"type":"module"` 就是 CommonJS（`module['require']` 等加载面绕过 require 规则），
  // 因此签名侧与安装侧用同一条判定。嵌套 package.json 会改变「最近」判定，拒绝。
  if (entry !== null) {
    const lowerEntry = entry.toLowerCase();
    // 入口必须真实存在且不是符号链接：签名的包若缺 entry，装到客户端才被
    // PLUGIN_INVALID 拒绝（市场发布了永远装不上的版本）。目录扫描 / .kepcup 扫描
    // 共用这一条判定（file 名已按 normalizeRelative 规范化）。
    if (!files.some((file) => normalizeRelative(file.path) === entry && file.isSymlink !== true)) {
      errors.push({
        path: entry,
        message: 'runtime.entry 指向的文件不存在（或为符号链接）',
      });
    }
    if (!lowerEntry.endsWith('.js') && !lowerEntry.endsWith('.mjs')) {
      errors.push({
        path: entry,
        message: 'runtime.entry 必须是 .js / .mjs（ESM 单文件约定）',
      });
    } else if (lowerEntry.endsWith('.js')) {
      const packageJson = files.find(
        (file) => normalizeRelative(file.path) === 'package.json' && file.isSymlink !== true,
      );
      let type;
      if (
        packageJson !== undefined &&
        packageJson.data !== undefined &&
        packageJson.data !== null
      ) {
        try {
          type = JSON.parse(
            Buffer.isBuffer(packageJson.data)
              ? packageJson.data.toString('utf8')
              : String(packageJson.data),
          ).type;
        } catch {
          type = undefined;
        }
      }
      if (type !== 'module') {
        errors.push({
          path: 'package.json',
          message: 'runtime.entry 为 .js 时包内 package.json 必须声明 "type": "module"',
        });
      }
    }
  }
  for (const file of files) {
    const relative = normalizeRelative(file.path);
    if (relative !== 'package.json' && path.posix.basename(relative) === 'package.json') {
      errors.push({ path: relative, message: '不允许嵌套 package.json（会改变模块格式判定）' });
    }
  }

  for (const file of files) {
    const relative = String(file.path ?? '');
    if (relative === '' || relative.endsWith('/')) continue;
    const lower = relative.toLowerCase();
    if (file.isSymlink === true) {
      pushOnce(errors, { path: relative, message: '包内含符号链接' });
      continue;
    }
    if (RUNTIME_SCAN_FORBIDDEN_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      pushOnce(errors, { path: relative, message: 'native / 可执行文件' });
      continue;
    }
    if (typeof file.mode === 'number' && (file.mode & 0o111) !== 0) {
      pushOnce(errors, { path: relative, message: '文件带可执行位' });
      continue;
    }
  }

  for (const file of files) {
    const relative = String(file.path ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    // The declared entry is scanned even without a JS extension: Node can execute an
    // extensionless file, so "entry: main" must not slip past the code rules.
    if (file.isSymlink === true || (!isCodeFile(relative) && relative !== entry)) continue;
    if (file.data === undefined || file.data === null) continue;
    const text = Buffer.isBuffer(file.data) ? file.data.toString('utf8') : String(file.data);
    const sourceName = String(file.path);
    const masked = maskNonCode(text);

    for (const rule of CODE_RULES) {
      const subject = rule.raw === true ? text : masked;
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(subject)) {
        pushOnce(errors, { path: sourceName, message: `代码包含 ${rule.message}` });
      }
    }
    DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
    for (
      let match = DYNAMIC_IMPORT_PATTERN.exec(masked);
      match !== null;
      match = DYNAMIC_IMPORT_PATTERN.exec(masked)
    ) {
      checkDynamicImport(text, match.index, sourceName, errors);
    }
    checkStaticImports(text, masked, sourceName, errors);
    URL_HOST_PATTERN.lastIndex = 0;
    for (
      let match = URL_HOST_PATTERN.exec(text);
      match !== null;
      match = URL_HOST_PATTERN.exec(text)
    ) {
      const rawHost = match[1];
      if (rawHost === undefined || rawHost === '') continue;
      // Strip userinfo / port / query / fragment; keep IPv6 literals bracketed.
      const host = rawHost
        .replace(/^[^@]*@/, '')
        .replace(/[?#].*$/, '')
        .replace(/:\d+$/, '');
      if (host === '' || host.includes('${') || /[[\]%]/.test(host)) continue;
      if (NON_NETWORK_HOSTS.has(host.toLowerCase())) continue;
      if (!runtimeScanHostAllowed(host, allow)) {
        pushOnce(warnings, {
          path: sourceName,
          message: `包内出现白名单外的域名 ${host}（人工复审；如需联网请加入 runtime.network.allow）`,
        });
      }
    }
  }

  const status = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
  return {
    status,
    errors: errors.map((entry) => `${entry.path}: ${entry.message}`),
    warnings: warnings.map((entry) => `${entry.path}: ${entry.message}`),
  };
}

/** Reads the same `.kepcup-ignore` rules `kepcup-app pack` honours (exact or `dir/`). */
async function readIgnoreRules(root) {
  const exact = new Set();
  const prefixes = [];
  let text;
  try {
    text = await readFile(path.join(root, '.kepcup-ignore'), 'utf8');
  } catch {
    return { exact, prefixes };
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const normalized = line.replace(/^\.\//, '').replace(/\/$/, '');
    if (normalized === '' || normalized.includes('\\') || normalized.startsWith('/')) continue;
    if (line.endsWith('/')) prefixes.push(normalized);
    else exact.add(normalized);
  }
  return { exact, prefixes };
}

function ignoredByRules(relative, rules) {
  if (rules.exact.has(relative)) return true;
  return rules.prefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

/**
 * Reads an unpacked plugin directory into the scanner's file view. `entryPath` (the
 * manifest `runtime.entry`) is always read, even when it has no JS extension.
 *
 * Directory scans mirror `kepcup-app pack`: `.git` / `node_modules` / old `.kepcup`
 * files / `.kepcup-ignore` rules are skipped, so build tooling ignored at packaging
 * time does not fail a developer's local scan. Signing scans the `.kepcup` archive
 * itself and does NOT apply ignore rules — what ships is what gets scanned.
 */
export async function readDirectoryFiles(dir, entryPath = null) {
  const files = [];
  const entry =
    typeof entryPath === 'string' ? entryPath.replace(/\\/g, '/').replace(/^\.\//, '') : null;
  const rules = await readIgnoreRules(dir);
  const walk = async (relative) => {
    const absolute = relative === '' ? dir : path.join(dir, ...relative.split('/'));
    const info = await lstat(absolute);
    const name = relative === '' ? path.basename(dir) : relative;
    if (info.isSymbolicLink()) {
      files.push({ path: name, isSymlink: true });
      return;
    }
    if (info.isDirectory()) {
      if (relative !== '' && (name === '.git' || name === 'node_modules')) return;
      for (const child of await readdir(absolute)) {
        await walk(relative === '' ? child : `${relative}/${child}`);
      }
      return;
    }
    if (!info.isFile()) return;
    const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      normalized === '.kepcup-ignore' ||
      normalized === '.DS_Store' ||
      normalized.endsWith('.kepcup') ||
      ignoredByRules(normalized, rules)
    ) {
      return;
    }
    files.push({
      path: name,
      mode: info.mode,
      ...(isCodeFile(normalized) || normalized === entry || normalized === 'package.json'
        ? { data: await readFile(absolute) }
        : {}),
    });
  };
  await walk('');
  return files;
}

async function loadPackageGuard() {
  const dist = path.join(repoRoot, 'packages', 'package-guard', 'dist', 'index.js');
  try {
    return await import(pathToFileURL(dist).href);
  } catch {
    throw new RuntimeScanError(
      'packages/package-guard/dist is not built: run `pnpm --filter @kepcup/package-guard build`',
    );
  }
}

/** Reads a `.kepcup` archive into the scanner's file view (manifest from plugin.json). */
export async function readPackageFiles(archivePath) {
  const guard = await loadPackageGuard();
  const zip = await guard.ZipArchive.open(archivePath, {
    error: (message) => new RuntimeScanError(message),
    label: path.basename(archivePath),
  });
  try {
    const manifestEntry = zip.entries.find((entry) => entry.name === 'plugin.json');
    if (manifestEntry === undefined) throw new RuntimeScanError('包内没有 plugin.json');
    const manifest = JSON.parse((await zip.read(manifestEntry)).toString('utf8'));
    const entryPath =
      typeof manifest?.runtime?.entry === 'string'
        ? manifest.runtime.entry.replace(/\\/g, '/').replace(/^\.\//, '')
        : null;
    const files = [];
    for (const entry of zip.entries) {
      if (entry.isDirectory) continue;
      const normalizedName = entry.name.replace(/^\.\//, '');
      const isEntry = entryPath !== null && normalizedName === entryPath;
      const needsData =
        !entry.isSymlink &&
        (isCodeFile(normalizedName) || isEntry || normalizedName === 'package.json');
      files.push({
        path: entry.name,
        mode: entry.unixMode,
        ...(entry.isSymlink ? { isSymlink: true } : {}),
        ...(needsData ? { data: await zip.read(entry) } : {}),
      });
    }
    return { manifest, files };
  } finally {
    await zip.close();
  }
}

/** CLI entry: scans one directory / package and prints the JSON result. */
export async function run(argv, io = { out: (m) => console.log(m), err: (m) => console.error(m) }) {
  let target = null;
  let asPackage = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir' || arg === '--package') {
      target = argv[++i];
      asPackage = arg === '--package';
      if (target === undefined) throw new RuntimeScanError(`${arg} needs a path`);
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new RuntimeScanError(`unknown argument: ${arg}`);
    }
  }
  if (target === null)
    throw new RuntimeScanError('--dir <plugin-dir> or --package <file.kepcup> is required');
  const absolute = path.resolve(target);
  let view;
  if (asPackage) {
    view = await readPackageFiles(absolute);
  } else {
    const manifestPath = path.join(absolute, 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new RuntimeScanError(
        `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    view = {
      manifest,
      files: await readDirectoryFiles(absolute, manifest?.runtime?.entry),
    };
  }
  const result = scanRuntimePackage({ files: view.files, manifest: view.manifest });
  if (result === null) {
    io.out(
      json
        ? JSON.stringify({ scanned: false })
        : 'not an executable plugin (no runtime section); nothing to scan',
    );
    return 0;
  }
  if (json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    io.out(`runtime scan: ${result.status.toUpperCase()}`);
    for (const error of result.errors) io.err(`  error: ${error}`);
    for (const warning of result.warnings) io.out(`  warn: ${warning}`);
  }
  return result.status === 'fail' ? 1 : 0;
}

async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof RuntimeScanError ? `error: ${error.message}` : 'error: unexpected failure',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  let invoked = pathToFileURL(process.argv[1]).href;
  try {
    invoked = pathToFileURL((await import('node:fs')).realpathSync(process.argv[1])).href;
  } catch {
    // Keep the un-resolved path comparison (same posture as sign-plugin-index.mjs).
  }
  if (import.meta.url === invoked) await main();
}
