<script lang="ts">
  import { errorText, t } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  let dialogOpen = $state(false);
  let acknowledged = $state(false);
  let hours = $state<null | number>(null);
  let enabled = $derived(permissions.unattended.enabled);
  // D73 P2（design 29 §8.3）：污点外发保护开关，默认开。
  let taintGuard = $state(true);
  $effect(() => {
    const settings = settingsStore.settings;
    if (settings) taintGuard = settings.apps.taintGuard;
  });

  async function toggleTaintGuard(checked: boolean): Promise<void> {
    const current = settingsStore.settings;
    if (!current) return;
    try {
      await settingsStore.update({ apps: { ...current.apps, taintGuard: checked } });
    } catch (error) {
      // 保存失败：开关回到已存的值，并提示原因。
      taintGuard = current.apps.taintGuard;
      toast.error(
        errorText(
          (error as { code?: string } | null)?.code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  function openDialog(): void {
    acknowledged = false;
    hours = null;
    dialogOpen = true;
  }

  async function confirmEnable(): Promise<void> {
    const ok = await permissions.enableUnattended(hours);
    if (ok) dialogOpen = false;
  }

  async function disable(): Promise<void> {
    // 关闭确认汇总要让位于设置弹框之上展示：先收起设置弹框再停用。
    shell.closeSettings();
    await permissions.disableUnattended();
  }</script>

<section class="space-y-3" data-testid="settings-unattended">
  <h3 class="text-sm font-medium">{t('unattended.settingsSection')}</h3>
  <div class="flex items-center gap-2" data-testid="unattended-state">
    <Badge variant={enabled ? 'default' : 'outline'} data-testid="unattended-badge">
      {enabled ? t('unattended.statusOn') : t('unattended.statusOff')}
    </Badge>
    {#if enabled}
      <span class="text-xs text-muted-foreground" data-testid="unattended-until">
        {permissions.unattended.until !== null
          ? t('unattended.untilHours', {
              hours: Math.max(
                1,
                Math.round((permissions.unattended.until - Date.now()) / 3_600_000),
              ),
            })
          : t('unattended.untilManual')}
      </span>
      <Button size="sm" variant="outline" onclick={() => void disable()} data-testid="unattended-disable">
        {t('unattended.disable')}
      </Button>
    {:else}
      <Button size="sm" variant="destructive" onclick={openDialog} data-testid="unattended-open-dialog">
        {t('unattended.enable')}
      </Button>
    {/if}
  </div>
  <label class="flex items-start gap-3" data-testid="settings-taint-guard-row">
    <Checkbox
      bind:checked={taintGuard}
      onCheckedChange={(checked) => void toggleTaintGuard(checked === true)}
      data-testid="settings-taint-guard"
    />
    <span class="grid gap-0.5">
      <span class="text-sm font-medium">{t('settings.taintGuard')}</span>
      <span class="text-xs text-muted-foreground">{t('settings.taintGuardHint')}</span>
    </span>
  </label>
</section>

<Dialog bind:open={dialogOpen}>
  <DialogContent class="max-w-md" data-testid="unattended-enable-dialog">
    <DialogHeader>
      <DialogTitle>{t('unattended.enableTitle')}</DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground">{t('unattended.enableBody')}</p>
    <label class="flex items-center gap-2 text-sm" data-testid="unattended-acknowledge-row">
      <Checkbox bind:checked={acknowledged} data-testid="unattended-acknowledge" />
      {t('unattended.acknowledge')}
    </label>
    <div class="flex items-center gap-3 text-sm">
      <label class="flex items-center gap-2">
        <input type="radio" name="unattended-duration" checked={hours === null} onchange={() => (hours = null)} />
        {t('unattended.manualOff')}
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" name="unattended-duration" checked={hours !== null} onchange={() => (hours = hours ?? 4)} />
        <input
          type="number"
          min="1"
          max="168"
          class="border-input bg-background h-8 w-20 rounded-md border px-2"
          disabled={hours === null}
          bind:value={hours}
          data-testid="unattended-hours"
        />
        {t('unattended.hoursOff', { hours: hours ?? 4 })}
      </label>
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={() => (dialogOpen = false)}>{t('contacts.cancel')}</Button>
      <Button
        variant="destructive"
        disabled={!acknowledged}
        onclick={() => void confirmEnable()}
        data-testid="unattended-confirm-enable"
      >
        {t('unattended.confirmEnable')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
