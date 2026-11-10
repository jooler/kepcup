<script lang="ts">
  /**
   * D117 组件 tab（docs/design/56 §3，2026-11-06 精简）：原菜单「组件」分组升级
   * 为卡片网格——无分组标题，metadata（版本 / 版本数 / 体积 / 更新时间 / 自检
   * 状态）直接在卡片上，右上「…」下拉只留**删除**（对话框确认）。点击卡片直接
   * 运行组件本体：`widgets.runCard` 构建无消息卡描述符（core 虚拟卡片登记表，
   * iframe 运行时零改动），沿既有 widgetViewer 覆盖层打开；审查门
   * （WIDGET_REVIEW_REQUIRED）与「新窗口打开」在覆盖层里照旧。原组件详情页
   * （BotWidgetDetail，仅比卡片多 metadata 与微应用管理段）已随精简下线。
   */
  import { Blocks, Loader2, MoreHorizontal } from '@lucide/svelte';
  import type { WidgetCard, WidgetsListItem } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { widgetViewer } from '$lib/features/widgets/widget-viewer.svelte';
  import { checkBadge } from '$lib/features/widgets/check-status';
  import { formatBytes } from '$lib/features/settings/mcpb-install';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let {
    botId,
    conversationId = undefined,
    testid = 'bot-widgets-tab',
  }: {
    botId: string;
    /** scope='bot' 组件的运行 anchor（回复与回传落点）；缺省不能运行。 */
    conversationId?: string | undefined;
    testid?: string;
  } = $props();

  let widgets = $state<WidgetsListItem[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  /** 正在运行组件的 id（覆盖层打开前的转圈）。 */
  let runningId = $state<string | null>(null);
  /** 待确认删除的组件（对话框确认）。 */
  let deleteTarget = $state<WidgetsListItem | null>(null);
  let deleting = $state(false);

  $effect(() => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      const result = (await core.call('widgets.list', { botId })) as {
        widgets: WidgetsListItem[];
      };
      widgets = result.widgets;
    } catch {
      // 菜单是辅助入口：拉不到就不显示组件区。
    } finally {
      loaded = true;
      loading = false;
    }
  }

  /** scope='bot' 组件 anchor 当前对话（回复落进去）；会话级组件用它自己的会话。 */
  function anchorOf(entry: WidgetsListItem): string | undefined {
    return entry.scope === 'bot' ? conversationId : (entry.conversationId ?? undefined);
  }

  async function run(entry: WidgetsListItem): Promise<void> {
    const anchor = anchorOf(entry);
    if (anchor === undefined) {
      toast.error(t('widgetsTab.runNoConversation'));
      return;
    }
    runningId = entry.widgetId;
    try {
      const result = (await core.call('widgets.runCard', {
        botId,
        widgetId: entry.widgetId,
        conversationId: anchor,
      })) as { messageId: string; card: WidgetCard };
      widgetViewer.show(result.messageId, result.card, anchor);
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    } finally {
      runningId = null;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (target === null) return;
    deleting = true;
    try {
      const result = (await core.call('widgets.delete', {
        botId,
        widgetId: target.widgetId,
      })) as { ok: boolean };
      if (!result.ok) {
        toast.error(t('widgetsTab.actionFailed'));
        return;
      }
      toast.success(t('widgetsTab.deleted'));
      deleteTarget = null;
      await refresh();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('widgetsTab.actionFailed')),
      );
    } finally {
      deleting = false;
    }
  }

  function whenText(entry: WidgetsListItem): string {
    return new Date(entry.updatedAt).toLocaleString();
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3" data-testid={testid}>
  {#if loading && !loaded}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-loading`}>…</p>
  {:else if widgets.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('widgetsTab.empty')}
    </p>
  {:else}
    <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" data-testid={`${testid}-list`}>
      {#each widgets as entry (entry.widgetId)}
        {@const badge = checkBadge(entry.checkStatus)}
        <div
          class="group relative rounded-xl border p-3 text-sm transition-colors hover:bg-accent/40"
          data-testid={`bot-widget-card-${entry.widgetId}`}
        >
          <button
            type="button"
            class="w-full text-left"
            onclick={() => void run(entry)}
            title={t('widgetsTab.runHint')}
            data-testid={`bot-widget-run-${entry.widgetId}`}
          >
            <div class="flex min-w-0 items-center gap-2 pr-7">
              {#if runningId === entry.widgetId}
                <Loader2 class="size-4 shrink-0 animate-spin text-violet-600" aria-hidden="true" />
              {:else}
                <Blocks class="size-4 shrink-0 text-violet-600" aria-hidden="true" />
              {/if}
              <span class="min-w-0 flex-1 truncate font-medium">{entry.title}</span>
              {#if entry.scope === 'bot'}
                <span
                  class="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs text-violet-700 dark:text-violet-400"
                >
                  {t('widgetsTab.assetBadge')}
                </span>
              {:else}
                <span
                  class="shrink-0 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {t('widgetsTab.conversationScopedBadge')}
                </span>
              {/if}
            </div>
            <!-- metadata（原组件详情页的信息行移到这里，2026-11-06 精简）。 -->
            <p class="mt-1 text-xs text-muted-foreground" data-testid={`bot-widget-meta-${entry.widgetId}`}>
              v{entry.version}
              · {t('widgetsTab.versionCount', { n: entry.versionCount })}
              · {formatBytes(entry.sizeBytes)}
              · {whenText(entry)}{#if entry.queriesCount > 0}
                · {t('widgetsTab.queriesCount', { n: entry.queriesCount })}{/if}{#if badge !== null}
                · <span data-testid={`bot-widget-check-${entry.widgetId}`}>{t(badge.label)}</span
                >{/if}
            </p>
            {#if entry.description !== ''}
              <!-- 底部说明 section（D117）：描述为空整段不渲染。 -->
              <div class="mt-2 border-t pt-2" data-testid={`bot-widget-desc-${entry.widgetId}`}>
                <p class="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
                  {entry.description}
                </p>
              </div>
            {/if}
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="absolute top-2 right-2 flex size-6 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('widgetsTab.moreMenu')}
              title={t('widgetsTab.moreMenu')}
              data-testid={`bot-widget-more-${entry.widgetId}`}
            >
              <MoreHorizontal class="size-4" aria-hidden="true" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content class="min-w-40" align="end">
              <DropdownMenu.Item
                class="text-destructive data-[highlighted]:text-destructive"
                onSelect={() => (deleteTarget = entry)}
                data-testid={`bot-widget-delete-${entry.widgetId}`}
              >
                {t('widgetsTab.delete')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Dialog
  bind:open={() => deleteTarget !== null, (value) => (deleteTarget = value ? deleteTarget : null)}
>
  <DialogContent class="max-w-md" data-testid="bot-widget-delete-dialog">
    <DialogHeader>
      <DialogTitle>
        {t('widgetsTab.deleteTitle', { title: deleteTarget?.title ?? '' })}
      </DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground" data-testid="bot-widget-delete-body">
      {t('widgetsTab.deleteBody')}
    </p>
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (deleteTarget = null)}
        data-testid="bot-widget-delete-cancel"
      >
        {t('common.cancel')}
      </Button>
      <Button
        variant="destructive"
        disabled={deleting}
        onclick={() => void confirmDelete()}
        data-testid="bot-widget-delete-confirm"
      >
        {t('widgetsTab.deleteConfirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
