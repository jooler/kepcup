<script lang="ts">
  import { onMount } from 'svelte';
  import { Blocks, Code2, Globe, Play, RefreshCw, Settings2, ShieldCheck, WifiOff } from '@lucide/svelte';
  import {
    MICRO_APP_CAPABILITIES,
    microAppsPreflightOutputSchema,
    widgetsUiPosterOutputSchema,
    widgetsUiSourceOutputSchema,
    type MicroAppsPreflightOutput,
    type WidgetCard,
    type WidgetQueryDef,
  } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { widgetViewer } from './widget-viewer.svelte';
  import { rememberWidgetConsent, widgetConsented } from './consent.svelte';
  import {
    microAppCardConsented,
    rememberMicroAppConsent,
  } from './micro-app-consent.svelte';
  import { checkBadge } from './check-status';

  /**
   * 对话里的 Bot 自制交互组件「海报」卡（D81；UX 改版：静态海报 + 点击后覆盖层运行）。
   *
   * 卡片本身不运行任何组件代码：海报区展示版本的自检截图（`widgets.ui.poster` 懒加载，
   * 无截图回退图标占位），点击海报 → 已确认则打开覆盖层（WidgetViewer 挂 WidgetRuntime
   * 真正运行）；未确认 / 带查询未审查时海报不可点，走下方审查态（查看源码含查询 SQL 全文
   * → 「确认并打开」，按「HTML sha256 + 查询摘要」记忆确认，同版本只确认一次）。
   * 运行期的一切（桥 / 资源租约 / 外链与回传确认）都在 WidgetRuntime。
   *
   * 微应用（D112，设计 55 §5.2）：`card.microApp` 存在时审查态换成微应用确认卡——
   * **网络行单独一行排在最前**（按档位措辞，不折叠）、能力清单（spec 人话）、预计成本
   * 与计费 Bot、能力可用性预检（不可用项标「当前不可用」+ 设置深链，打开前可见）；
   * 确认按**能力面指纹**记忆（同指纹代码更新沿用确认，标「代码已更新，权限未扩大」）。
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

  // --- 微应用（D112）：预检 + 指纹确认 ------------------------------------------
  /** 带 `microApp` 清单才有；预检挂载时懒加载（与海报并行）。 */
  const isMicroApp = $derived(card.microApp !== undefined);
  /** 计费 Bot 的名字（成本行展示用；通讯录未加载 / 已删除时回退 botId）。 */
  const botName = $derived(
    card.botId === null ? null : (contacts.bots.find((bot) => bot.id === card.botId)?.name ?? null),
  );
  let preflight = $state<MicroAppsPreflightOutput | null>(null);
  let preflightFailed = $state(false);
  /** 生效摘要 / 指纹 / bundle：以预检（= 将要运行的版本）为准；预检失败即门控（不能拿
   * 卡片上可能过期的能力面放行——那是能力扩大时唯一会漏的口子）。 */
  const effective = $derived(preflight?.microApp ?? card.microApp);
  const effectiveFingerprint = $derived(preflight?.capabilityFingerprint ?? '');
  const consentState = $derived(
    isMicroApp && effectiveFingerprint !== ''
      ? microAppCardConsented(card, effectiveFingerprint, preflight?.bundleSha256)
      : { ok: false as const },
  );
  /** 同指纹但代码更新（bundle 变）：沿用确认，卡上标「代码已更新，权限未扩大」。 */
  const codeUpdated = $derived(consentState.ok && consentState.codeUpdated);
  /** 有新版本（双指针指向更高版本）：重新打开生效。 */
  const hasNewerVersion = $derived(preflight !== null && preflight.version > card.version);
  const unavailableItems = $derived(
    preflight !== null ? preflight.items.filter((item) => !item.available) : [],
  );
  const capabilityLines = $derived(
    (effective?.permissions ?? [])
      .map((id) => MICRO_APP_CAPABILITIES.find((cap) => cap.id === id))
      .filter((cap) => cap !== undefined),
  );

  /** 带查询模板的版本：本次会话里已展开过源码（SQL 全文）才放行「确认并打开」。 */
  const needsReview = $derived(card.queriesCount > 0 && sourceHtml === null);
  const needsConsent = $derived(
    isMicroApp ? preflightFailed || !consentState.ok : !widgetConsented(card),
  );
  /** 审查态未完成（未确认或查询未预审）：海报不可点，确认入口在下方审查块。 */
  const reviewFirst = $derived(needsReview || needsConsent);

  async function loadPreflight(): Promise<void> {
    preflightFailed = false;
    try {
      preflight = microAppsPreflightOutputSchema.parse(
        await core.call('microApps.preflight', { messageId }),
      );
    } catch {
      preflight = null;
      preflightFailed = true;
    }
  }

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
    if (isMicroApp) void loadPreflight();
  });

  function openRuntime(): void {
    widgetViewer.show(messageId, card, session.conversationId ?? '');
  }

  function handlePosterClick(): void {
    if (reviewFirst) return;
    openRuntime();
  }

  /** 审查块的「确认并打开」：记忆确认（组件按版本 / 微应用按能力面指纹 + 生效 bundle）后立即运行。 */
  function confirmAndOpen(): void {
    if (isMicroApp) {
      if (effectiveFingerprint === '' || preflight === null) return;
      rememberMicroAppConsent(card, effectiveFingerprint, preflight.bundleSha256);
    } else {
      rememberWidgetConsent(card);
    }
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
        {#if isMicroApp}
          {t('botWidget.microApp.kind')} ·
        {/if}
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
      {#if isMicroApp}
        <!-- 微应用确认卡（D112 §5.2）：网络行单独一行、排在能力清单之前、不折叠。
             能力 / 网络 / 成本一律展示**生效版本**（预检摘要），不是发卡时的旧摘要。 -->
        <div class="mb-2 rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1.5" data-testid="bot-widget-microapp">
          <p class="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
            {#if effective!.netMode === 'none'}
              <WifiOff class="size-3.5 shrink-0" aria-hidden="true" />
              {t('botWidget.microApp.netNone')}
            {:else}
              <Globe class="size-3.5 shrink-0" aria-hidden="true" />
              {#if effective!.netMode === 'open'}
                {t('botWidget.microApp.netOpen')}
              {:else}
                {t('botWidget.microApp.netAllowlist', {
                  domains: effective!.netAllowlist.join('、'),
                })}
              {/if}
            {/if}
          </p>
          {#if hasNewerVersion}
            <p class="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="bot-widget-microapp-newer">
              <RefreshCw class="size-3 shrink-0" aria-hidden="true" />
              {t('botWidget.microApp.newerVersion', { version: preflight?.version ?? card.version })}
            </p>
          {/if}
          {#if codeUpdated}
            <p class="mt-1 text-[11px] text-muted-foreground" data-testid="bot-widget-microapp-code-updated">
              {t('botWidget.microApp.codeUpdated')}
            </p>
          {/if}
          <p class="mt-1.5 text-[11px] font-medium">{t('botWidget.microApp.canDo')}</p>
          <ul class="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
            {#each capabilityLines as cap (cap.id)}
              <li>{cap.userLine}</li>
            {/each}
          </ul>
          {#if effective!.maxTokensPerSession !== undefined}
            <p class="mt-1 text-[11px] text-muted-foreground" data-testid="bot-widget-microapp-cost">
              {t('botWidget.microApp.cost', {
                n: effective!.maxTokensPerSession,
                bot: botName ?? card.botId ?? '',
              })}
            </p>
          {/if}
          {#each unavailableItems as item (item.capability)}
            <p class="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400" data-testid="bot-widget-microapp-unavailable">
              <Settings2 class="size-3 shrink-0" aria-hidden="true" />
              {t('botWidget.microApp.unavailable', {
                capability: item.capability,
                reason: item.reason ?? '',
              })}
              {#if item.settingDeepLink !== undefined}
                <button
                  type="button"
                  class="underline underline-offset-2"
                  data-testid="bot-widget-microapp-settings-link"
                  onclick={() =>
                    shell.openSettings(
                      item.settingDeepLink!.section as Parameters<typeof shell.openSettings>[0],
                      item.settingDeepLink!.anchor,
                    )}
                >
                  {t('botWidget.microApp.openSettings')}
                </button>
              {/if}
            </p>
          {/each}
          {#if preflightFailed}
            <p class="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400" data-testid="bot-widget-microapp-preflight-failed">
              {t('botWidget.microApp.preflightFailed')}
              <button
                type="button"
                class="underline underline-offset-2"
                onclick={() => void loadPreflight()}
              >
                {t('botWidget.microApp.preflightRetry')}
              </button>
            </p>
          {:else if preflight === null}
            <p class="mt-1 text-[11px] text-muted-foreground" data-testid="bot-widget-microapp-preflight-loading">
              {t('botWidget.microApp.preflightLoading')}
            </p>
          {/if}
        </div>
      {/if}
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
          disabled={needsReview || (isMicroApp && effectiveFingerprint === '')}
          data-testid="bot-widget-load"
        >
          {t(isMicroApp ? 'botWidget.microApp.confirmAndOpen' : 'botWidget.confirmAndOpen')}
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
