<script lang="ts">
  import type { LocalConnectorView } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { ChevronRight, Laptop } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';
  import { localSectionVisible, removeImpactKey } from '$lib/features/apps/local-connectors';

  /**
   * 扩展中心 →「连接」→「本机自建」区（设计 29 §17）：Bot 读厂商文档生成、只保存在这台电脑上的
   * 连接。条目**只在这里出现一次**（预置目录网格按 `origin` 过滤掉本机条目）；卡片带「未审核」
   * 徽标、MCP 域名、简介、账号数；「连接」展开同一个 ConnectAppPanel（授权前核对完整授权地址、
   * 首连工具复核都沿用），「管理」进账号详情，「删除」确认后断开该条目的全部账号并移除条目。
   * 区块在开发者模式开启，或已经有本机条目时可见（关闭开发者模式后条目保留，只是不能新增）。
   * 条目没有隐私政策与厂商图标：用中性占位图标。
   */
  let { onManage }: { onManage: (connectorId: string) => void } = $props();

  const views = $derived(appsStore.localConnectors);
  const visible = $derived(
    localSectionVisible({ developerMode: settingsStore.developerMode, count: views.length }),
  );
  let expanded = $state(true);
  /** 当前展开了连接面板的条目。 */
  let openConnectorId = $state<string | null>(null);
  /** 待确认删除的条目。 */
  let removing = $state<LocalConnectorView | null>(null);
  let removeOpen = $state(false);

  $effect(() => {
    appsStore.start();
  });

  // 条目被删（本机或别处）：别留着指向它的展开面板 / 删除确认框。
  $effect(() => {
    if (!appsStore.localLoaded) return;
    const ids = new Set(appsStore.localConnectors.map((item) => item.connectorId));
    // 本地簿记状态的读写不被本 effect 追踪（只跟随本机条目列表）。
    untrack(() => {
      if (openConnectorId !== null && !ids.has(openConnectorId)) openConnectorId = null;
      if (removing !== null && !ids.has(removing.connectorId)) {
        removeOpen = false;
        removing = null;
      }
    });
  });

  function accountsOf(connectorId: string): number {
    return appsStore.connections.filter((connection) => connection.connectorId === connectorId)
      .length;
  }

  function askRemove(view: LocalConnectorView): void {
    removing = view;
    removeOpen = true;
  }

  async function confirmRemove(): Promise<void> {
    const target = removing;
    if (target === null || appsStore.removingLocal[target.connectorId] === true) return;
    try {
      await appsStore.removeLocal(target.connectorId);
      removeOpen = false;
      removing = null;
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      toast.error(
        t('apps.local.remove.failed', {
          error: errorText(code, error instanceof Error ? error.message : String(error)),
        }),
      );
    }
  }
</script>

{#if visible}
  <section class="mt-5 space-y-2.5 border-t pt-3" data-testid="local-connectors-section">
    <button
      type="button"
      class="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      aria-expanded={expanded}
      aria-controls="local-connectors-panel"
      onclick={() => (expanded = !expanded)}
      data-testid="local-connectors-toggle"
    >
      <ChevronRight
        class="size-3.5 transition-transform {expanded ? 'rotate-90' : ''}"
        aria-hidden="true"
      />
      {t('apps.local.section.title')}
      <span class="font-normal">（{t('apps.local.section.count', { count: views.length })}）</span>
    </button>
    <div id="local-connectors-panel" class="space-y-2.5" hidden={!expanded}>
      {#if expanded}
        <p class="text-[11px] text-muted-foreground">{t('apps.local.section.hint')}</p>
        {#if views.length === 0}
          <p class="text-xs text-muted-foreground" data-testid="local-connectors-empty">
            {t('apps.local.section.empty')}
          </p>
        {:else}
          <div class="grid gap-3 sm:grid-cols-2" data-testid="local-connectors-list">
            {#each views as view (view.connectorId)}
              {@const open = openConnectorId === view.connectorId}
              {@const accounts = accountsOf(view.connectorId)}
              {@const target = { kind: 'catalog', connectorId: view.connectorId } as const}
              <div
                class="flex flex-col gap-2.5 rounded-xl border px-4 py-3.5 {open
                  ? 'sm:col-span-2'
                  : ''}"
                data-testid={`local-connector-${view.connectorId}`}
                data-origin="local"
              >
                <div class="flex items-start gap-3">
                  <div
                    class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    aria-hidden="true"
                  >
                    <Laptop class="size-4" />
                  </div>
                  <div class="min-w-0 flex-1 space-y-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-sm font-medium" data-testid="local-connector-title">
                        {view.title}
                      </span>
                      <Badge
                        variant="outline"
                        class="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
                        title={t('apps.local.badgeHint')}
                        data-testid="local-connector-badge"
                      >
                        {t('apps.local.badge')}
                      </Badge>
                    </div>
                    <p
                      class="font-mono text-[11px] break-all text-muted-foreground"
                      title={view.mcpUrl}
                      data-testid="local-connector-host-label"
                    >
                      {view.mcpHost}
                    </p>
                    <p class="line-clamp-2 text-xs text-muted-foreground" title={view.description}>
                      {view.description}
                    </p>
                    {#if accounts > 0}
                      <p
                        class="text-[11px] text-emerald-700 dark:text-emerald-400"
                        data-testid="local-connector-accounts"
                      >
                        {t('apps.local.entry.accounts', { count: accounts })}
                      </p>
                    {/if}
                  </div>
                  <div class="flex shrink-0 flex-col items-end gap-1.5">
                    <div class="flex items-center gap-1.5">
                      {#if accounts > 0}
                        <Button
                          size="sm"
                          variant="outline"
                          onclick={() => onManage(view.connectorId)}
                          data-testid={`local-connector-manage-${view.connectorId}`}
                        >
                          {t('apps.local.entry.manage')}
                        </Button>
                      {/if}
                      <Button
                        size="sm"
                        variant={open ? 'ghost' : accounts > 0 ? 'secondary' : 'default'}
                        onclick={() => (openConnectorId = open ? null : view.connectorId)}
                        data-testid={`local-connector-connect-${view.connectorId}`}
                      >
                        {open
                          ? t('apps.catalog.close')
                          : accounts > 0
                            ? t('apps.catalog.connectAnother')
                            : t('apps.catalog.connect')}
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="text-destructive hover:text-destructive"
                      disabled={appsStore.removingLocal[view.connectorId] === true}
                      onclick={() => askRemove(view)}
                      data-testid={`local-connector-delete-${view.connectorId}`}
                    >
                      {appsStore.removingLocal[view.connectorId] === true
                        ? t('apps.local.entry.deleting')
                        : t('apps.local.entry.delete')}
                    </Button>
                  </div>
                </div>
                {#if open}
                  <div class="border-t pt-2.5">
                    <ConnectAppPanel
                      {target}
                      name={view.title}
                      allowDisconnect={false}
                      testid={`local-connector-panel-${view.connectorId}`}
                    />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </section>
{/if}

<Dialog bind:open={removeOpen}>
  <DialogContent data-testid="local-connector-remove-dialog">
    <DialogHeader>
      <DialogTitle>{t('apps.local.remove.title', { name: removing?.title ?? '' })}</DialogTitle>
      <DialogDescription data-testid="local-connector-remove-body">
        {t(removeImpactKey(removing === null ? 0 : accountsOf(removing.connectorId)), {
          count: removing === null ? 0 : accountsOf(removing.connectorId),
        })}
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (removeOpen = false)}>
        {t('apps.local.remove.cancel')}
      </Button>
      <Button
        variant="destructive"
        disabled={removing === null || appsStore.removingLocal[removing.connectorId] === true}
        onclick={() => void confirmRemove()}
        data-testid="local-connector-remove-confirm"
      >
        {t('apps.local.remove.confirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
