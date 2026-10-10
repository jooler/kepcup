<script lang="ts">
  import type { AppCatalogEntry, AppsDirectoryStatus } from '@kepcup/shared';
  import { ChevronRight, Search, ShieldCheck } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import ConnectAppPanel from './ConnectAppPanel.svelte';
  import {
    CATEGORY_LABEL_KEYS,
    TIER_LABEL_KEYS,
    appIconSrc,
    appInitial,
    catalogAction,
    catalogCategories,
    catalogSections,
    catalogView,
    communityExpanded,
    directoryNoticeKey,
    isVerifiedTier,
    type CategoryFilter,
  } from './app-catalog';

  /**
   * 「应用 → 目录」（D73 §5.9）：发行门禁放行的目录卡片（图标 / 标题 / 简介 / tier），
   * 搜索 + 分类筛选；「连接」在卡片内展开 ConnectAppPanel（同一时刻只展开一张），
   * 授权流程本身由面板呈现。连接完成后 appsStore 刷新目录，已连接账号数随之更新。
   * 扩展中心「连接」分组（X2）复用本组件：传 `onManage` 时已连接的卡片多一个「管理」按钮，
   * 由宿主打开该应用的账号详情。
   */

  let { onManage }: { onManage?: ((connectorId: string) => void) | undefined } = $props();

  let query = $state('');
  let category = $state<CategoryFilter>('all');
  /** 当前展开了连接面板的目录条目。 */
  let openConnectorId = $state<string | null>(null);

  const categories = $derived(catalogCategories(appsStore.catalog));
  const entries = $derived(catalogView(appsStore.catalog, { query, category }));
  // 分级分组（D73 P3 §7.2）：内置在前、已认证带徽标；社区应用单独成组，默认折叠。
  const sections = $derived(catalogSections(entries));
  let communityOpen = $state(false);
  const communityShown = $derived(
    communityExpanded({
      open: communityOpen,
      query,
      mainCount: sections.main.length,
      communityCount: sections.community.length,
    }),
  );
  /** 目录同步降级（验签失败 / 离线）时的一行提示；拿不到状态不打扰用户。 */
  let directoryNotice = $state<ReturnType<typeof directoryNoticeKey>>(null);

  onMount(() => {
    void core
      .call('apps.directory.status')
      .then((status) => {
        directoryNotice = directoryNoticeKey((status as AppsDirectoryStatus).state);
      })
      .catch(() => undefined);
  });

  function toggle(entry: AppCatalogEntry): void {
    openConnectorId = openConnectorId === entry.connectorId ? null : entry.connectorId;
  }
</script>

<div class="space-y-3" data-testid="apps-catalog">
  <p class="text-xs text-muted-foreground">{t('apps.catalog.hint')}</p>
  {#if directoryNotice !== null}
    <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="apps-directory-notice">
      {t(directoryNotice)}
    </p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-48 flex-1">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        class="h-8 pl-8"
        placeholder={t('apps.catalog.search')}
        bind:value={query}
        data-testid="apps-catalog-search"
      />
    </div>
    {#if categories.length > 1}
      <div
        class="flex flex-wrap items-center gap-1"
        role="group"
        data-testid="apps-catalog-filters"
      >
        <button
          type="button"
          aria-pressed={category === 'all'}
          class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {category === 'all'
            ? 'border-foreground/60 bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50'}"
          onclick={() => (category = 'all')}
          data-testid="apps-catalog-filter-all"
        >
          {t('apps.catalog.all')}
        </button>
        {#each categories as item (item)}
          <button
            type="button"
            aria-pressed={category === item}
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {category === item
              ? 'border-foreground/60 bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50'}"
            onclick={() => (category = item)}
            data-testid={`apps-catalog-filter-${item}`}
          >
            {t(CATEGORY_LABEL_KEYS[item])}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if !appsStore.catalogLoaded}
    <p class="text-xs text-muted-foreground">{t('apps.catalog.loading')}</p>
  {:else if appsStore.catalog.length === 0}
    <!-- 目录本身为空（发行构建里还没有任何放行的应用）：与「搜索无结果」区分 -->
    <p class="text-xs text-muted-foreground" data-testid="apps-catalog-none">
      {t('apps.catalog.none')}
    </p>
  {:else if entries.length === 0}
    <p class="text-xs text-muted-foreground" data-testid="apps-catalog-empty">
      {t('apps.catalog.empty')}
    </p>
  {:else}
    {#if sections.main.length > 0}
      <div class="grid gap-3 sm:grid-cols-2" data-testid="apps-catalog-main">
        {#each sections.main as entry (entry.connectorId)}
          {@render card(entry)}
        {/each}
      </div>
    {/if}
    {#if sections.community.length > 0}
      <!-- 社区应用：仅经自动校验、未经 KepCup 人工审核；默认折叠，写入类工具不可「总是允许」 -->
      <section class="space-y-2.5" data-testid="apps-catalog-community">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={communityShown}
          aria-controls="apps-catalog-community-panel"
          onclick={() => (communityOpen = !communityShown)}
          data-testid="apps-catalog-community-toggle"
        >
          <ChevronRight
            class="size-3.5 transition-transform {communityShown ? 'rotate-90' : ''}"
            aria-hidden="true"
          />
          {t('apps.tier.communityGroup', { count: sections.community.length })}
        </button>
        <div id="apps-catalog-community-panel" class="space-y-2.5" hidden={!communityShown}>
          {#if communityShown}
            <p class="text-[11px] text-muted-foreground" data-testid="apps-catalog-community-hint">
              {t('apps.tier.communityHint')}
            </p>
            <div class="grid gap-3 sm:grid-cols-2" data-testid="apps-catalog-community-list">
              {#each sections.community as entry (entry.connectorId)}
                {@render card(entry)}
              {/each}
            </div>
          {/if}
        </div>
      </section>
    {/if}
  {/if}
</div>

{#snippet card(entry: AppCatalogEntry)}
  {@const open = openConnectorId === entry.connectorId}
  {@const target = { kind: 'catalog', connectorId: entry.connectorId } as const}
  {@const action = catalogAction(entry, appsStore.hasActiveFlow(target))}
  {@const icon = appIconSrc(entry.iconDataUri)}
  <div
    class="flex flex-col gap-2.5 rounded-xl border px-4 py-3.5 {open
      ? 'sm:col-span-2'
      : ''} {entry.connectable ? '' : 'opacity-60'}"
    data-testid={`apps-catalog-card-${entry.connectorId}`}
    data-connectable={entry.connectable}
    data-tier={entry.tier}
  >
    <div class="flex items-start gap-3">
      {#if icon !== null}
        <img src={icon} alt="" class="size-9 shrink-0 rounded-lg" />
      {:else}
        <div
          class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium text-muted-foreground"
          aria-hidden="true"
        >
          {appInitial(entry.title)}
        </div>
      {/if}
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-sm font-medium">{entry.title}</span>
          {#if isVerifiedTier(entry.tier)}
            <Badge
              variant="outline"
              class="gap-0.5 border-emerald-500/50 text-[10px] text-emerald-700 dark:text-emerald-400"
              title={t('apps.tier.verifiedHint')}
              data-testid="apps-catalog-verified"
            >
              <ShieldCheck class="size-3" aria-hidden="true" />
              {t('apps.tier.verifiedBadge')}
            </Badge>
          {:else}
            <Badge variant="outline" class="text-[10px]" data-testid="apps-catalog-tier">
              {t(TIER_LABEL_KEYS[entry.tier])}
            </Badge>
          {/if}
          <span class="text-[11px] text-muted-foreground">
            {t(CATEGORY_LABEL_KEYS[entry.category])}
          </span>
        </div>
        <p class="line-clamp-2 text-xs text-muted-foreground" title={entry.description}>
          {entry.description}
        </p>
        {#if entry.connectedAccounts > 0}
          <p
            class="text-[11px] text-emerald-700 dark:text-emerald-400"
            data-testid="apps-catalog-accounts"
          >
            {t('apps.catalog.connectedAccounts', { count: entry.connectedAccounts })}
          </p>
        {/if}
        {#if !entry.connectable && action.reason !== null}
          <p class="text-[11px] text-amber-700 dark:text-amber-400">{action.reason}</p>
        {/if}
      </div>
      {#if onManage !== undefined && entry.connectedAccounts > 0}
        <Button
          size="sm"
          variant="outline"
          class="shrink-0"
          onclick={() => onManage(entry.connectorId)}
          data-testid={`apps-catalog-manage-${entry.connectorId}`}
        >
          {t('apps.catalog.manage')}
        </Button>
      {/if}
      <Button
        size="sm"
        variant={open ? 'ghost' : entry.connectedAccounts > 0 ? 'secondary' : 'default'}
        class="shrink-0"
        disabled={action.disabled && !open}
        title={action.reason ?? undefined}
        onclick={() => toggle(entry)}
        data-testid={`apps-catalog-connect-${entry.connectorId}`}
      >
        {open ? t('apps.catalog.close') : t(action.labelKey)}
      </Button>
    </div>
    {#if open}
      <div class="border-t pt-2.5">
        <ConnectAppPanel
          {target}
          name={entry.title}
          allowDisconnect={false}
          testid={`apps-catalog-panel-${entry.connectorId}`}
        />
      </div>
    {/if}
  </div>
{/snippet}
