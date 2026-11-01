import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

/**
 * 代码档的高亮管线（docs/design/45）：按需加载 shiki 内核 + 单个语言语法，
 * 输出「行 → 带颜色的 token」结构，由 CodeViewer 直接渲染成 span。
 *
 * 为什么不用 `{@html}`：shiki 的 `codeToHtml` 输出 HTML 字符串，渲染端得走
 * `{@html}`（转义靠库）。这里改用 `codeToTokensBase`，token 文本由 Svelte 的
 * 文本插值输出（自动转义），所以文件里写 `<script>` 也不可能被执行。
 */
export interface CodeToken {
  content: string;
  color?: string;
}

export type CodeLine = CodeToken[];

/**
 * 高亮阈值（超出即退化为纯文本）。取值依据：一次打开的文件要同步生成
 * token（每个 token 一个 span），5000 行 / 400k 字符约等于 3000–5000 个
 * span，是 Chromium 里还能一次渲染完的规模；再大就该走纯文本。
 */
export const MAX_HIGHLIGHT_LINES = 5_000;
export const MAX_HIGHLIGHT_CHARS = 400_000;

/** 与渲染时的 `text.split('\n')` 行数一致；空文件也算一行。 */
export function countCodeLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** 是否值得高亮：超大 / 超长的文件直接显示纯文本，避免一次渲染卡住界面。 */
export function shouldHighlightCode(text: string): boolean {
  return text.length <= MAX_HIGHLIGHT_CHARS && countCodeLines(text) <= MAX_HIGHLIGHT_LINES;
}

/** 纯文本兜底：每行一个无颜色 token，与高亮结果结构一致，渲染分支只需一套。 */
export function plainCodeLines(text: string): CodeLine[] {
  return text.split('\n').map((line) => [{ content: line }]);
}

type LanguageModule = { default: LanguageRegistration | LanguageRegistration[] };

/**
 * shiki 语言 id → 语法模块。每个条目都是独立动态 import，Vite 会切成单独的
 * chunk（只有第一次打开该语言的文件时才下载），不会进启动包。
 */
const LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<LanguageModule>>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sass: () => import('shiki/langs/sass.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
};

/** 主题与 streamdown 的代码块一致（github-light / github-dark），配色不打架。 */
export type CodeTheme = 'github-light' | 'github-dark';

/** 缓存上限：够覆盖「同几个文件来回切换」；超出按最久未用淘汰。 */
const CACHE_LIMIT = 24;
const resultCache = new Map<string, CodeLine[]>();

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const languageLoads = new Map<string, Promise<void>>();

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      // 与 streamdown 的代码块相同：JS 正则引擎（无 oniguruma wasm，省 ~600KB），
      // forgiving 让个别语法不受支持时退回近似 token，而不是整个高亮失败。
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighterPromise;
}

async function ensureLanguage(highlighter: HighlighterCore, languageId: string): Promise<void> {
  if (loadedLanguages.has(languageId)) return;
  const loader = LANGUAGE_LOADERS[languageId];
  if (loader === undefined) throw new Error(`unknown language: ${languageId}`);
  let pending = languageLoads.get(languageId);
  if (pending === undefined) {
    pending = loader()
      .then((module) => highlighter.loadLanguage(module.default))
      .then(() => {
        loadedLanguages.add(languageId);
      })
      .finally(() => languageLoads.delete(languageId));
    languageLoads.set(languageId, pending);
  }
  await pending;
}

function cacheKey(languageId: string, theme: CodeTheme, code: string): string {
  return `${theme}\u0000${languageId}\u0000${code}`;
}

function readCache(key: string): CodeLine[] | null {
  const hit = resultCache.get(key);
  if (hit === undefined) return null;
  // 命中即刷新 LRU 顺序。
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit;
}

function writeCache(key: string, lines: CodeLine[]): void {
  resultCache.set(key, lines);
  while (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next();
    if (oldest.done === true) break;
    resultCache.delete(oldest.value);
  }
}

/**
 * 高亮成 token 行；未知语言或语法加载失败返回 `null`（调用方保持纯文本）。
 * 同一「语言 + 主题 + 内容」重复打开走缓存，不再重复 tokenize。
 */
export async function highlightCodeLines(
  code: string,
  languageId: string,
  theme: CodeTheme,
): Promise<CodeLine[] | null> {
  if (!(languageId in LANGUAGE_LOADERS)) return null;
  const key = cacheKey(languageId, theme, code);
  const cached = readCache(key);
  if (cached !== null) return cached;

  try {
    const highlighter = await getHighlighter();
    await ensureLanguage(highlighter, languageId);
    const tokens: ThemedToken[][] = highlighter.codeToTokensBase(code, {
      lang: languageId,
      theme,
    });
    const lines: CodeLine[] = tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: typeof token.color === 'string' ? token.color : undefined,
      })),
    );
    writeCache(key, lines);
    return lines;
  } catch {
    return null;
  }
}
