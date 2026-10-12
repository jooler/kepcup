<script lang="ts">
  import { Blocks, Send } from '@lucide/svelte';
  import type { WidgetsListItem } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { formatBytes } from '$lib/features/settings/mcpb-install';
  import { checkBadge } from '$lib/features/widgets/check-status';

  /**
   * Bot 详情「组件」Tab（D81 P2，design 32 §3）：该 Bot 全部自制交互组件的列表 /
   * 删除，以及跨对话资产（scope='bot'）的「发到当前对话」。删除是两步确认
   * （SchedulesPanel 取消的先例）：级联清 versions / docs / queries，历史卡片
   * 按「版本已不存在」优雅报错。
   */
  let {
    botId,
    conversationId,
    active = true,
  }: {
    botId: string;
    /** 当前对话（「发到当前对话」的目的地；缺省不显示发布按钮）。 */
    conversationId: string | undefined;
    /** bits-ui keeps inactive tab content mounted (hidden): fetch only when visible. */
    active?: boolean;
  } = $props();

  let entries = $state<WidgetsListItem[]>([]);
  let loading = $state(false);
  /** 两步删除：等待确认的组件 id。 */
  let deleteTarget = $state<string | null>(null);
  let deleting = $state(false);
  /** 正在发卡的组件 id（按钮 loading）。 */
  let publishingId = $state<string | null>(null);

  $effect(() => {
    if (active) void refresh();
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      const result = (await core.call('widgets.list', { botId })) as {
        widgets: WidgetsListItem[];
      };
      entries = result.widgets;
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')));
    } finally {
      loading = false;
    }
  }

  const assets = $derived(entries.filter((entry) => entry.scope === 'bot'));
  const conversationScoped = $derived(entries.filter((entry) => entry.scope !== 'bot'));

  async function remove(): Promise<void> {
    const id = deleteTarget;
    if (id === null) return;
    deleting = true;
    try {
      const result = (await core.call('widgets.delete', { botId, widgetId: id })) as { ok: boolean };
      // {ok:false}（并发已删 / botId 不匹配）不是异常，必须显式分辨，不能假报成功。
      if (!result.ok) {
        toast.error(t('widgetsTab.actionFailed'));
        return;
      }
      toast.success(t('widgetsTab.deleted'));
      deleteTarget = null;
      await refresh();
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')));
    } finally {
      deleting = false;
    }
  }

  async function publish(widgetId: string): Promise<void> {
    if (conversationId === undefined) return;
    publishingId = widgetId;
    try {
      const result = (await core.call('widgets.publish', {
        botId,
        widgetId,
        conversationId,
      })) as { ok: boolean; message?: string; cardMessageId?: string };
      // 发卡失败（cardMessageId 缺省）时组件还在、只是对话里没有卡——如实警示，
      // 不与「已发卡」混为一谈（契约同工具路径的「落库成功但发卡失败」）。
      if (!result.ok) {
        toast.error(result.message ?? t('widgetsTab.actionFailed'));
      } else if (result.cardMessageId === undefined) {
        toast.warning(t('widgetsTab.publishCardFailed'));
      } else {
        toast.success(t('widgetsTab.published'));
      }
    } catch (error) {
      toast.error(errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')));
    } finally {
      publishingId = null;
    }
  }

  function whenText(entry: WidgetsListItem): string {
    return new Date(entry.updatedAt).toLocaleString();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid="widgets-tab">
  <div class="flex items-center justify-between gap-2">
    <p class="text-xs text-muted-foreground">{t('widgetsTab.hint')}</p>
    <Button
      size="sm"
      variant="outline"
      disabled={loading}
      onclick={() => void refresh()}
      data-testid="widgets-tab-refresh"
    >
      {t('common.refresh')}
    </Button>
  </div>

  {#if loading && entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="widgets-tab-loading">…</p>
  {:else if entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="widgets-tab-empty">{t('widgetsTab.empty')}</p>
  {:else}
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid="widgets-tab-list">
      {#each assets as entry (entry.widgetId)}
        <li class="rounded-md border p-2 text-sm" data-testid={`widget-item-${entry.widgetId}`}>
          <div class="flex items-center gap-2">
            <Blocks class="size-4 shrink-0 text-violet-600" aria-hidden="true" />
            <p class="min-w-0 flex-1 truncate font-medium" data-testid="widget-title">{entry.title}</p>
            <span
              class="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-400"
              data-testid="widget-scope"
            >
              {t('widgetsTab.assetBadge')}
            </span>
          </div>
          {#if entry.description !== ''}
            <p class="mt-0.5 truncate text-xs text-muted-foreground">{entry.description}</p>
          {/if}
          <p class="mt-0.5 text-xs text-muted-foreground">
            v{entry.version} · {t('widgetsTab.versionCount', { n: entry.versionCount })} ·
            {formatBytes(entry.sizeBytes)} · {whenText(entry)}{#if entry.queriesCount > 0}
              · {t('widgetsTab.queriesCount', { n: entry.queriesCount })}{/if}{#if checkBadge(entry.checkStatus) !== null}
              · <span data-testid={`widget-check-${entry.widgetId}`}
                >{t(checkBadge(entry.checkStatus)!.label)}</span
              >{/if}
          </p>
          <div class="mt-1 flex justify-end gap-1">
            {#if deleteTarget === entry.widgetId}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => (deleteTarget = null)}
                data-testid="widget-delete-dismiss"
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                class="h-6 px-2 text-xs"
                disabled={deleting}
                onclick={() => void remove()}
                data-testid="widget-delete-confirm"
              >
                {t('widgetsTab.deleteConfirm')}
              </Button>
            {:else}
              {#if conversationId !== undefined}
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-6 gap-1 px-2 text-xs"
                  disabled={publishingId !== null}
                  onclick={() => void publish(entry.widgetId)}
                  data-testid={`widget-publish-${entry.widgetId}`}
                >
                  <Send class="size-3" aria-hidden="true" />
                  {t('widgetsTab.publish')}
                </Button>
              {/if}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs text-destructive"
                onclick={() => (deleteTarget = entry.widgetId)}
                data-testid={`widget-delete-${entry.widgetId}`}
              >
                {t('widgetsTab.delete')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
      {#if assets.length > 0 && conversationScoped.length > 0}
        <li class="pt-1 text-xs font-medium text-muted-foreground">{t('widgetsTab.conversationSection')}</li>
      {/if}
      {#each conversationScoped as entry (entry.widgetId)}
        <li class="rounded-md border p-2 text-sm opacity-80" data-testid={`widget-item-${entry.widgetId}`}>
          <div class="flex items-center gap-2">
            <Blocks class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p class="min-w-0 flex-1 truncate font-medium">{entry.title}</p>
          </div>
          <p class="mt-0.5 text-xs text-muted-foreground">
            v{entry.version} · {t('widgetsTab.conversationScopedBadge')} · {formatBytes(entry.sizeBytes)} · {whenText(entry)}
          </p>
          <div class="mt-1 flex justify-end gap-1">
            {#if deleteTarget === entry.widgetId}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => (deleteTarget = null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                class="h-6 px-2 text-xs"
                disabled={deleting}
                onclick={() => void remove()}
                data-testid="widget-delete-confirm"
              >
                {t('widgetsTab.deleteConfirm')}
              </Button>
            {:else}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs text-destructive"
                onclick={() => (deleteTarget = entry.widgetId)}
                data-testid={`widget-delete-${entry.widgetId}`}
              >
                {t('widgetsTab.delete')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
