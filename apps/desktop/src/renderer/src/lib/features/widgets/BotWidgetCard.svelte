<script lang="ts">
  import { onMount } from 'svelte';
  import { Blocks, Code2, Play, ShieldCheck } from '@lucide/svelte';
  import {
    widgetsUiPosterOutputSchema,
    widgetsUiSourceOutputSchema,
    type WidgetCard,
    type WidgetQueryDef,
  } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { widgetViewer } from './widget-viewer.svelte';
  import { rememberWidgetConsent, widgetConsented } from './consent.svelte';
  import { checkBadge } from './check-status';

  /**
   * 对话里的 Bot 自制交互组件「海报」卡（D81；UX 改版：静态海报 + 点击后覆盖层运行）。
   *
   * 卡片本身不运行任何组件代码：海报区展示版本的自检截图（`widgets.ui.poster` 懒加载，
   * 无截图回退图标占位），点击海报 → 已确认则打开覆盖层（WidgetViewer 挂 WidgetRuntime
   * 真正运行）；未确认 / 带查询未审查时海报不可点，走下方审查态（查看源码含查询 SQL 全文
   * → 「确认并打开」，按「HTML sha256 + 查询摘要」记忆确认，同版本只确认一次）。
   * 运行期的一切（桥 / 资源租约 / 外链与回传确认）都在 WidgetRuntime。
   */
  let { messageId, card }: { messageId: string; card: WidgetCard } = $props();
  const session = getChatSession();

  let posterPng = $state<string | null>(null);
  let posterLoading = $state(true);
  let sourceOpen = $state(false);
  let sourceHtml = $state<string | null>(null);
  let sourceQueries = $state<WidgetQueryDef[]>([]);
  let sourceError = $state(false);
  let sourceLoading = $state(false);
  /** 自检徽标（`legacy` 为 null）与「已知问题」展开态。 */
  const badge = $derived(checkBadge(card.checkStatus));
  let issuesOpen = $state(false);
  /** 查看源码的展示上限：本地库损坏时 html 可能远超 2MB 上限，整段渲染会卡死界面。 */
  const SOURCE_DISPLAY_MAX_CHARS = 20_000;

  /** 带查询模板的版本：本次会话里已展开过源码（SQL 全文）才放行「确认并打开」。 */
  const needsReview = $derived(card.queriesCount > 0 && sourceHtml === null);
  const needsConsent = $derived(!widgetConsented(card));
  /** 审查态未完成（未确认或查询未预审）：海报不可点，确认入口在下方审查块。 */
  const reviewFirst = $derived(needsReview || needsConsent);

  onMount(() => {
    void (async () => {
      try {
        const out = widgetsUiPosterOutputSchema.parse(
          await core.call('widgets.ui.poster', { messageId }),
        );
        posterPng = out.posterPng;
      } catch {
        posterPng = null;
      } finally {
        posterLoading = false;
      }
    })();
  });

  function openRuntime(): void {
    widgetViewer.show(messageId, card, session.conversationId ?? '');
  }

  function handlePosterClick(): void {
    if (reviewFirst) return;
    openRuntime();
  }

  /** 审查块的「确认并打开」：记忆确认（按版本）后立即在覆盖层运行。 */
  function confirmAndOpen(): void {
    rememberWidgetConsent(card);
    openRuntime();
  }

  async function toggleSource(): Promise<void> {
    sourceOpen = !sourceOpen;
    if (sourceOpen && sourceHtml === null && !sourceError) {
      sourceLoading = true;
      try {
        const out = widgetsUiSourceOutputSchema.parse(
          await core.call('widgets.ui.source', { messageId }),
        );
        sourceHtml = out.html;
        sourceQueries = out.queries;
      } catch {
        // 失败不缓存错误文案：收起再展开即重试。
        sourceError = true;
      } finally {
        sourceLoading = false;
      }
    }
  }
</script>

<div
  class="w-full max-w-[85%] overflow-hidden rounded-lg border bg-background/80 text-sm"
  data-testid="bot-widget-card"
>
  <div class="flex items-center gap-2 px-3 py-2">
    <Blocks class="size-4 shrink-0 text-violet-600" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="truncate font-medium" data-testid="bot-widget-title">{card.title}</p>
      <p class="truncate text-xs text-muted-foreground">
        {#if card.description !== ''}
          {card.description} ·
        {/if}
        {t('botWidget.byBot')} · v{card.version}
      </p>
    </div>
  </div>

  <!-- 海报区：自检截图（或图标占位）。审查态未完成时不可点，确认入口在下方审查块。 -->
  <button
    type="button"
    class="relative block w-full border-t bg-muted/30 {reviewFirst ? 'cursor-not-allowed opacity-60' : ''}"
    onclick={handlePosterClick}
    disabled={reviewFirst}
    aria-label={reviewFirst ? t('botWidget.reviewFirstHint') : t('botWidget.open')}
    title={reviewFirst ? t('botWidget.reviewFirstHint') : t('botWidget.open')}
    data-testid="bot-widget-poster"
  >
    <div class="flex h-52 items-center justify-center overflow-hidden">
      {#if posterLoading}
        <span class="text-xs text-muted-foreground">{t('botWidget.posterLoading')}</span>
      {:else if posterPng !== null}
        <img
          src={`data:image/png;base64,${posterPng}`}
          alt={card.title}
          class="max-h-full max-w-full object-contain"
          data-testid="bot-widget-poster-image"
        />
      {:else}
        <div class="flex flex-col items-center gap-1.5 text-muted-foreground">
          <Blocks class="size-8" aria-hidden="true" />
          <span class="text-xs">{t('botWidget.posterFallback')}</span>
        </div>
      {/if}
    </div>
    {#if !reviewFirst}
      <span
        class="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-[11px] text-foreground shadow-sm"
      >
        <Play class="size-3" aria-hidden="true" />
        {t('botWidget.open')}
      </span>
    {/if}
  </button>

  {#if reviewFirst}
    <div class="border-t px-3 py-2" data-testid="bot-widget-review">
      {#if badge !== null}
        <!-- D87 P3c 自检徽标：只说明它能运行、不代表安全；按版本确认照旧（设计 32 §11.12）。 -->
        <div class="mb-1.5" data-testid="bot-widget-check">
          <span
            class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium {badge.tone}"
            data-testid="bot-widget-check-badge"
            data-status={card.checkStatus}>{t(badge.label)}</span
          >
          {#if card.knownIssues.length > 0}
            <button
              type="button"
              class="ml-1 text-[11px] text-muted-foreground underline underline-offset-2"
              aria-expanded={issuesOpen}
              aria-controls={`known-issues-${messageId}`}
              onclick={() => (issuesOpen = !issuesOpen)}
              data-testid="bot-widget-known-issues-toggle"
            >
              {t(issuesOpen ? 'botWidget.check.hideIssues' : 'botWidget.check.showIssues', {
                n: card.knownIssues.length,
              })}
            </button>
            {#if issuesOpen}
              <ul
                id={`known-issues-${messageId}`}
                class="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground"
                data-testid="bot-widget-known-issues"
              >
                {#each card.knownIssues as issue, index (index)}
                  <li>{issue}</li>
                {/each}
              </ul>
            {/if}
          {/if}
          <p class="mt-1 text-[11px] text-muted-foreground" data-testid="bot-widget-check-note">
            {t('botWidget.check.note')}
          </p>
        </div>
      {/if}
      <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <!-- 声明了查询的版本换专门文案：笼统的「读不到你的其他数据」会与下方查询提示自相矛盾。 -->
        {t(card.queriesCount > 0 ? 'botWidget.reviewNoteQueries' : 'botWidget.reviewNote')}
      </p>
      {#if card.queriesCount > 0}
        <p class="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="bot-widget-queries-note">
          {t('botWidget.queriesNote', { n: card.queriesCount })}
        </p>
      {/if}
      <div class="mt-2 flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => void toggleSource()}
          data-testid="bot-widget-source-toggle"
        >
          <Code2 class="size-3" aria-hidden="true" />
          {sourceOpen ? t('botWidget.sourceHide') : t('botWidget.sourceShow')}
        </Button>
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          onclick={confirmAndOpen}
          disabled={needsReview}
          data-testid="bot-widget-load"
        >
          {t('botWidget.confirmAndOpen')}
        </Button>
      </div>
      {#if needsReview}
        <p class="mt-1 text-xs text-muted-foreground" data-testid="bot-widget-review-first">
          {t('botWidget.reviewQueriesFirst')}
        </p>
      {/if}
      {#if sourceOpen}
        {#if sourceQueries.length > 0}
          <div class="mt-2 rounded bg-muted p-2 text-[11px]" data-testid="bot-widget-queries">
            <p class="mb-1 font-medium">{t('botWidget.queriesTitle')}</p>
            {#each sourceQueries as query (query.name)}
              <div class="mt-1">
                <p class="text-muted-foreground">
                  kepcup.query('{query.name}') →
                </p>
                <pre class="overflow-auto whitespace-pre-wrap leading-relaxed">{query.sql}</pre>
              </div>
            {/each}
          </div>
        {/if}
        <pre
          class="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed"
          data-testid="bot-widget-source"
          >{sourceLoading
            ? t('botWidget.sourceLoading')
            : sourceError
              ? t('botWidget.sourceUnavailable')
              : sourceHtml !== null && sourceHtml.length > SOURCE_DISPLAY_MAX_CHARS
                ? `${sourceHtml.slice(0, SOURCE_DISPLAY_MAX_CHARS)}\n… ${t('botWidget.sourceTruncated')}`
                : (sourceHtml ?? t('botWidget.sourceLoading'))}</pre
        >
      {/if}
    </div>
  {/if}

  <p class="border-t px-3 py-1 text-[11px] text-muted-foreground" data-testid="bot-widget-footer">
    {t('botWidget.capabilities')}
  </p>
</div>
