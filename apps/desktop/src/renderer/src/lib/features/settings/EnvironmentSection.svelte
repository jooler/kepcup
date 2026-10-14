<script lang="ts">
  import type { EnvInstall, SettingValues } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 环境页的工具链：已安装列表、重新检测、失败项重装、卸载确认。
   * `embedded`：对话内设置卡只露出列表、重新检测、失败项重装。卸载是破坏性操作，
   * 留在设置页。安装仍走原来的环境审批，卡片里不另做安装表单。
   * user-only 没有预填，`prefill` 收下但不用来填任何东西。重新检测或重装成功后 `onSaved`。
   */
  let {
    embedded = false,
    prefill: _prefill = null,
    onSaved,
  }: {
    /** 对话内设置卡。设置页不传。 */
    embedded?: boolean;
    /** 空白卡不采用。保留参数以对齐其它嵌入组件的调用形状。 */
    prefill?: SettingValues | null;
    /** 重新检测或重装成功后通知设置卡结卡。 */
    onSaved?: () => void;
  } = $props();

  let confirmRemove = $state<EnvInstall | null>(null);
  let removeDialogOpen = $state(false);
  let removing = $state(false);
  let checking = $state(false);

  $effect(() => {
    environmentStore.start();
    void environmentStore.refresh();
  });

  function sizeText(bytes: number | null): string {
    if (bytes === null || bytes <= 0) return '—';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
    if (bytes >= 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  function timeText(ms: number | null): string {
    if (ms === null) return '—';
    return new Date(ms).toLocaleString();
  }

  function statusBadge(install: EnvInstall): { label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' } {
    switch (install.status) {
      case 'installed':
        return { label: t('settings.envStatusInstalled'), variant: 'default' };
      case 'installing':
        return { label: t('settings.envStatusInstalling'), variant: 'secondary' };
      case 'failed':
        return { label: t('settings.envStatusFailed'), variant: 'destructive' };
      case 'removed':
        return { label: t('settings.envStatusRemoved'), variant: 'outline' };
    }
  }

  async function recheck(): Promise<void> {
    checking = true;
    try {
      await environmentStore.recheck();
      toast.success(t('settings.envRecheckDone'));
      if (embedded) onSaved?.();
    } catch {
      toast.error(t('settings.envActionFailed'));
    } finally {
      checking = false;
    }
  }

  async function remove(): Promise<void> {
    if (confirmRemove === null) return;
    removing = true;
    try {
      await environmentStore.remove(confirmRemove.id);
      toast.success(t('settings.envRemoved'));
      removeDialogOpen = false;
      confirmRemove = null;
    } catch {
      toast.error(t('settings.envActionFailed'));
    } finally {
      removing = false;
    }
  }

  async function reinstall(install: EnvInstall): Promise<void> {
    try {
      await environmentStore.reinstall(install.id);
      toast.success(t('settings.envReinstallStarted'));
      if (embedded) onSaved?.();
    } catch {
      toast.error(t('settings.envActionFailed'));
    }
  }
</script>

<section
  class="space-y-3"
  data-testid={embedded ? 'environment-toolchains-embedded' : 'settings-environment'}
>
  {#if !embedded}
    <h3 class="text-sm font-medium">{t('settings.envSection')}</h3>
    <p class="text-xs text-muted-foreground">{t('settings.envNote')}</p>
  {/if}

  {#if environmentStore.installs.length === 0 && environmentStore.system.length === 0}
    <p class="text-xs text-muted-foreground" data-testid="environment-empty">
      {t('settings.envEmpty')}
    </p>
  {:else}
    <ul class="space-y-2">
      {#each environmentStore.installs as install (install.id)}
        <li class="rounded-md border px-3 py-2 text-sm" data-testid={`environment-install-${install.item}`}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{install.item} {install.version}</span>
            <Badge variant={statusBadge(install).variant} data-testid={`environment-status-${install.item}`}>
              {statusBadge(install).label}
            </Badge>
            <span class="text-xs text-muted-foreground">{t('settings.envSize')}{sizeText(install.sizeBytes)}</span>
            <span class="text-xs text-muted-foreground">{t('settings.envLastUsed')}{timeText(install.lastUsedAt)}</span>
            <div class="ml-auto flex gap-2">
              {#if install.status === 'failed'}
                <Button size="sm" variant="secondary" onclick={() => void reinstall(install)} data-testid={`environment-reinstall-${install.item}`}>
                  {t('settings.envReinstall')}
                </Button>
              {/if}
              {#if !embedded && (install.status === 'installed' || install.status === 'failed')}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    confirmRemove = install;
                    removeDialogOpen = true;
                  }}
                  data-testid={`environment-remove-${install.item}`}
                >
                  {t('settings.envRemove')}
                </Button>
              {/if}
            </div>
          </div>
          {#if install.status === 'failed' && install.healthy === false}
            <p class="mt-1 text-xs text-destructive">{t('settings.envUnhealthy')}</p>
          {/if}
        </li>
      {/each}
      {#each environmentStore.system as entry (entry.item)}
        <li class="rounded-md border px-3 py-2 text-sm" data-testid={`environment-system-${entry.item}`}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{entry.item}</span>
            <Badge variant={entry.available ? 'default' : 'outline'} data-testid={`environment-system-status-${entry.item}`}>
              {entry.available ? t('settings.envSystemAvailable') : t('settings.envSystemMissing')}
            </Badge>
            <span class="text-xs text-muted-foreground">{entry.detail}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex gap-2">
    <Button size="sm" variant="outline" disabled={checking} onclick={() => void recheck()} data-testid="environment-recheck">
      {checking ? t('settings.envChecking') : t('settings.envRecheck')}
    </Button>
  </div>
</section>

{#if !embedded}
<Dialog bind:open={removeDialogOpen}>
  <DialogContent data-testid="environment-remove-dialog">
    <DialogHeader>
      <DialogTitle>{t('settings.envRemoveTitle', { item: confirmRemove !== null ? `${confirmRemove.item} ${confirmRemove.version}` : '' })}</DialogTitle>
      <DialogDescription>{t('settings.envRemoveBody')}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (removeDialogOpen = false)}>{t('settings.envRemoveCancel')}</Button>
      <Button variant="destructive" disabled={removing} onclick={() => void remove()} data-testid="environment-remove-confirm">
        {t('settings.envRemove')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
{/if}
