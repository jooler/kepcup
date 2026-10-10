<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronRight } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    BADGE_TONE_CLASSES,
    appIconSrc,
    appInitial,
    authorizedBotCounts,
    describeLastUsed,
    groupConnectionsByApp,
    statusBadge,
  } from './app-catalog';

  /**
   * 「应用 → 已连接」（D73 §5.9）：目录连接按应用分组，每行一个账号：账号名、状态
   * 徽标、已授权 Bot 数、最近使用；点击进入详情（AppConnectionDetail）。自定义
   * server 的占位连接不在此列（归开发者模式下的自定义 MCP 管理）。
   * `connectorId` 只列该应用（扩展中心「连接」分组的「管理」）。
   */
  let {
    onOpen,
    onGoCatalog,
    connectorId,
  }: {
    onOpen: (connectionId: string) => void;
    /** 空态里「去添加」的跳转；不传则不显示按钮。 */
    onGoCatalog?: (() => void) | undefined;
    connectorId?: string | undefined;
  } = $props();

  const groups = $derived(
    groupConnectionsByApp(appsStore.connections, appsStore.catalog).filter(
      (group) => connectorId === undefined || group.connectorId === connectorId,
    ),
  );
  const botCounts = $derived(authorizedBotCounts(contacts.bots));

  // 「最近使用」的相对时间每分钟刷新一次。
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  function lastUsedText(lastUsedAt: number | null): string {
    const described = describeLastUsed(lastUsedAt, now);
    switch (described.key) {
      case 'apps.lastUsed.never':
      case 'apps.lastUsed.justNow':
        return t(described.key);
      case 'apps.lastUsed.date':
        return t(described.key, { date: described.date });
      default:
        return t(described.key, { n: described.n });
    }
  }
</script>

<div class="space-y-3" data-testid="apps-connected">
  {#if !appsStore.loaded}
    <p class="text-xs text-muted-foreground">{t('apps.catalog.loading')}</p>
  {:else if groups.length === 0}
    <div
      class="space-y-2 rounded-xl border px-4 py-6 text-center"
      data-testid="apps-connected-empty"
    >
      <p class="text-sm text-muted-foreground">{t('apps.connected.empty')}</p>
      {#if onGoCatalog !== undefined}
        <Button
          size="sm"
          variant="secondary"
          onclick={onGoCatalog}
          data-testid="apps-connected-go-catalog"
        >
          {t('apps.connected.goCatalog')}
        </Button>
      {/if}
    </div>
  {:else}
    <p class="text-xs text-muted-foreground">{t('apps.connected.hint')}</p>
    {#each groups as group (group.connectorId)}
      {@const icon = appIconSrc(group.iconDataUri)}
      <div class="rounded-xl border" data-testid={`apps-connected-group-${group.connectorId}`}>
        <div class="flex items-center gap-2.5 border-b px-4 py-2.5">
          {#if icon !== null}
            <img src={icon} alt="" class="size-6 rounded-md" />
          {:else}
            <div
              class="flex size-6 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground"
              aria-hidden="true"
            >
              {appInitial(group.title)}
            </div>
          {/if}
          <span class="text-sm font-medium">{group.title}</span>
          {#if group.needsAttention}
            <Badge
              variant="outline"
              class={`ml-auto text-[10px] ${BADGE_TONE_CLASSES.warn}`}
              data-testid="apps-connected-attention"
            >
              {t('apps.connected.attention')}
            </Badge>
          {/if}
        </div>
        <ul class="divide-y">
          {#each group.connections as connection (connection.id)}
            {@const badge = statusBadge(connection.status)}
            {@const bots = botCounts[connection.id] ?? 0}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50"
                onclick={() => onOpen(connection.id)}
                data-testid={`apps-connection-row-${connection.id}`}
                data-status={connection.status}
              >
                <div class="min-w-0 flex-1 space-y-0.5">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm">
                      {connection.label.length > 0
                        ? connection.label
                        : t('apps.connected.defaultLabel')}
                    </span>
                    <Badge
                      variant={badge.tone === 'ok' ? 'default' : 'outline'}
                      class={`text-[10px] ${BADGE_TONE_CLASSES[badge.tone]}`}
                      data-testid="apps-connection-status"
                    >
                      {t(badge.labelKey)}
                    </Badge>
                  </div>
                  <p class="text-[11px] text-muted-foreground">
                    <span data-testid="apps-connection-bots">
                      {bots > 0
                        ? t('apps.connected.bots', { count: bots })
                        : t('apps.connected.noBots')}
                    </span>
                    · {t('apps.connected.lastUsed', { when: lastUsedText(connection.lastUsedAt) })}
                  </p>
                </div>
                <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>
