<script lang="ts">
  import { mode } from 'mode-watcher';
  import { t } from '$lib/i18n';
  import type { CodeLanguage } from './code-language';
  import {
    countCodeLines,
    highlightCodeLines,
    plainCodeLines,
    shouldHighlightCode,
    type CodeLine,
    type CodeTheme,
  } from './code-highlight';

  /**
   * 代码档预览（docs/design/45）：行号 gutter + 按语言高亮 + 不折行横向滚动。
   *
   * 高亮是 async 的（shiki 内核与语法模块都懒加载），未就绪时先渲染同内容的
   * 纯文本，就绪后再替换——不会出现空白或布局跳动。超大文件（阈值见
   * code-highlight.ts）直接停在纯文本并提示一句。
   *
   * 主题跟随应用：与 streamdown 的代码块用同一对主题（github-light /
   * github-dark），明暗切换时重新取 token（结果按主题缓存）。
   */
  let {
    code,
    language,
    fileName,
  }: { code: string; language: CodeLanguage | null; fileName?: string } = $props();

  const theme = $derived<CodeTheme>(mode.current === 'dark' ? 'github-dark' : 'github-light');
  const lineCount = $derived(countCodeLines(code));
  const highlightable = $derived(language !== null && shouldHighlightCode(code));

  let highlighted = $state<CodeLine[] | null>(null);
  /** 高亮失败（语法加载 / tokenize 报错）：停在纯文本，不再显示「正在读取」。 */
  let highlightFailed = $state(false);

  $effect(() => {
    const target = language;
    const text = code;
    const themeName = theme;
    highlighted = null;
    highlightFailed = false;
    if (target === null || !shouldHighlightCode(text)) return;
    let cancelled = false;
    void highlightCodeLines(text, target.id, themeName).then((lines) => {
      if (cancelled) return;
      if (lines === null) highlightFailed = true;
      else highlighted = lines;
    });
    return () => {
      cancelled = true;
    };
  });

  // 未高亮（语言未知 / 超大文件 / 加载中 / 失败）时就是纯文本行，结构一致。
  const lines = $derived(highlighted ?? plainCodeLines(code));
  const lineNumbers = $derived(Array.from({ length: lines.length }, (_, index) => index + 1));
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="code-viewer">
  <div
    class="flex h-8 shrink-0 items-center gap-1.5 border-b px-4 text-[11px] text-muted-foreground"
  >
    <span class="font-mono" data-testid="code-viewer-language">
      {language?.label ?? t('files.kind.code')}
    </span>
    <span class="opacity-50">·</span>
    <span data-testid="code-viewer-lines">{t('files.code.lines', { count: lineCount })}</span>
    {#if !highlightable}
      <span class="ml-auto" data-testid="code-viewer-plain-hint">
        {language === null ? t('files.code.noHighlight') : t('files.code.tooLarge')}
      </span>
    {:else if highlightFailed}
      <span class="ml-auto" data-testid="code-viewer-plain-hint">
        {t('files.code.noHighlight')}
      </span>
    {:else if highlighted === null}
      <span class="ml-auto animate-pulse" data-testid="code-viewer-loading">
        {t('files.loading')}
      </span>
    {/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto" data-testid="code-viewer-scroll">
    {#if highlightable}
      <!-- 行号与代码同一横向滚动容器：gutter 用 sticky 固定在左侧，横向滚动时
           行号不跑掉；两者行高一致靠同一个 leading-5（行号与空行也都给 h-5 /
           min-h-5，否则空行没有行盒、两边错位）。 -->
      <div class="flex w-max min-w-full font-mono text-xs leading-5">
        <div
          class="sticky left-0 z-10 shrink-0 border-r border-border/60 bg-background px-3 py-3 text-right text-muted-foreground/50 tabular-nums select-none"
          aria-hidden="true"
        >
          {#each lineNumbers as lineNumber (lineNumber)}<div class="h-5">{lineNumber}</div>{/each}
        </div>
        <!-- 每行一个 block div（不写进 <pre>）：块级元素之间的空白文本节点会被
             折叠，所以模板缩进不会变出空行；行内用 whitespace-pre 保住空格，
             tab 按 4 列对齐。 -->
        <div class="px-4 py-3" data-testid="code-viewer-code" title={fileName}>
          {#each lines as tokens, index (index)}
            <div class="min-h-5 whitespace-pre [tab-size:4]">
              {#each tokens as token, tokenIndex (tokenIndex)}<span style:color={token.color}
                  >{token.content}</span
                >{/each}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <!-- 未识别语言 / 超大文件：整体一个 <pre>，不逐行建节点（大文件逐行渲染
           反而会卡住）。 -->
      <pre
        class="min-h-full p-6 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        data-testid="code-viewer-plain">{code}</pre>
    {/if}
  </div>
</div>
