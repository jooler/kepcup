<script lang="ts">
  import type { AppCatalogEntry } from '@kepcup/shared';
  import { Search } from '@lucide/svelte';
  import { t } from '$lib/i18n';
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
    catalogView,
    type CategoryFilter,
  } from './app-catalog';

  /**
   * 「应用 → 目录」（D73 §5.9）：发行门禁放行的目录卡片（图标 / 标题 / 简介 / tier），
   * 搜索 + 分类筛选；「连接」在卡片内展开 ConnectAppPanel（同一时刻只展开一张），
   * 授权流程本身由面板呈现。连接完成后 appsStore 刷新目录，已连接账号数随之更新。
   */

  let query = $state('');
  let category = $state<CategoryFilter>('all');
  /** 当前展开了连接面板的目录条目。 */
  let openConnectorId = $state<string | null>(null);

  const categories = $derived(catalogCategories(appsStore.catalog));
  const entries = $derived(catalogView(appsStore.catalog, { query, category }));

  function toggle(entry: AppCatalogEntry): void {
    openConnectorId = openConnectorId === entry.connectorId ? null : entry.connectorId;
  }
</script>

<div class="space-y-3" data-testid="apps-catalog">
  <p class="text-xs text-muted-foreground">{t('apps.catalog.hint')}</p>

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
  {:else if entries.length === 0}
    <p class="text-xs text-muted-foreground" data-testid="apps-catalog-empty">
      {t('apps.catalog.empty')}
    </p>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2">
      {#each entries as entry (entry.connectorId)}
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
                <Badge variant="outline" class="text-[10px]" data-testid="apps-catalog-tier">
                  {t(TIER_LABEL_KEYS[entry.tier])}
                </Badge>
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
      {/each}
    </div>
  {/if}
</div>
