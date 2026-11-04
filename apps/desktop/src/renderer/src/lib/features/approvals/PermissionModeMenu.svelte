<script lang="ts">
  import { Check, ShieldCheck, ShieldOff } from '@lucide/svelte';
  import type { PermissionMode } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 对话级权限级别入口（docs/design/13-permissions.md「权限级别」）。
   *
   * 盾牌按级别着色：默认档绿色、自动授权深橙色、完全控制红色并换成关闭盾牌。
   * 点击后下拉选择三档；提升到自动授权 / 完全控制需要弹框勾选风险。仅内存态，
   * 重启应用回到默认档。
   */
  let { conversationId }: { conversationId: string } = $props();

  type ElevatedMode = Exclude<PermissionMode, 'manual'>;

  const OPTIONS: readonly PermissionMode[] = ['manual', 'auto', 'bypass'];

  const current = $derived(permissions.modeOf(conversationId));
  const mode = $derived(current.mode);
  const forcedByUnattended = $derived(permissions.unattended.enabled);

  const tone = $derived(
    mode === 'bypass'
      ? 'text-red-600 hover:text-red-700 dark:text-red-400'
      : mode === 'auto'
        ? 'text-orange-700 hover:text-orange-800 dark:text-orange-500'
        : 'text-emerald-600 hover:text-emerald-700 dark:text-emerald-400',
  );

  let dialogOpen = $state(false);
  let pending = $state<ElevatedMode | null>(null);
  let acknowledged = $state(false);
  /** 自动关闭档（false = 直到手动关闭）；与小时数分开存，清空输入不会悄悄切档。 */
  let timed = $state(false);
  let hours = $state(4);

  $effect(() => {
    if (conversationId.length > 0) void permissions.loadMode(conversationId);
  });

  function select(next: PermissionMode): void {
    if (next === mode) return;
    if (next === 'manual') {
      void permissions.setMode(conversationId, 'manual');
      return;
    }
    pending = next;
    acknowledged = false;
    timed = false;
    hours = 4;
    dialogOpen = true;
  }

  async function confirm(): Promise<void> {
    if (pending === null || !acknowledged) return;
    // 小时数越界 / 被清空时收敛到合法区间，而不是把 INVALID_INPUT 抛成 toast。
    const resolvedHours = timed ? Math.min(168, Math.max(1, Math.round(Number(hours) || 1))) : null;
    if (await permissions.setMode(conversationId, pending, resolvedHours)) {
      dialogOpen = false;
      pending = null;
    }
  }

  const hoursDisplay = $derived(Number(hours) > 0 ? hours : 4);

  const title = $derived(
    pending === 'bypass' ? t('permissionMode.enableBypassTitle') : t('permissionMode.enableAutoTitle'),
  );
  const body = $derived(
    pending === 'bypass' ? t('permissionMode.enableBypassBody') : t('permissionMode.enableAutoBody'),
  );
  const acknowledgeLabel = $derived(
    pending === 'bypass'
      ? t('permissionMode.acknowledgeBypass')
      : t('permissionMode.acknowledgeAuto'),
  );
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="app-no-drag flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-accent {tone}"
    aria-label={t('permissionMode.aria', {
      mode: t(`permissionMode.${mode}` as 'permissionMode.manual'),
    })}
    title={t('permissionMode.aria', {
      mode: t(`permissionMode.${mode}` as 'permissionMode.manual'),
    })}
    data-testid="permission-mode-menu"
    data-mode={mode}
  >
    {#if mode === 'bypass'}
      <ShieldOff class="size-4" aria-hidden="true" />
    {:else}
      <ShieldCheck class="size-4" aria-hidden="true" />
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-72" align="end" aria-label={t('permissionMode.aria', {
    mode: t(`permissionMode.${mode}` as 'permissionMode.manual'),
  })}>
    {#if forcedByUnattended}
      <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
        {t('permissionMode.unattendedNote')}
      </DropdownMenu.Label>
    {/if}
    {#each OPTIONS as option (option)}
      <DropdownMenu.Item
        class="items-start gap-2 px-2 py-1.5"
        disabled={forcedByUnattended}
        onSelect={() => select(option)}
        data-testid={`permission-mode-item-${option}`}
      >
        {#if option === 'bypass'}
          <ShieldOff class="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        {:else}
          <ShieldCheck
            class="mt-0.5 size-4 shrink-0 {option === 'auto'
              ? 'text-orange-700 dark:text-orange-500'
              : 'text-emerald-600 dark:text-emerald-400'}"
            aria-hidden="true"
          />
        {/if}
        <span class="min-w-0 flex-1">
          <span class="block">{t(`permissionMode.${option}` as 'permissionMode.manual')}</span>
          <span class="block text-xs text-muted-foreground">
            {t(`permissionMode.${option}Desc` as 'permissionMode.manualDesc')}
          </span>
        </span>
        {#if option === mode}
          <Check class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<Dialog bind:open={dialogOpen}>
  <DialogContent class="max-w-md" data-testid="permission-mode-dialog">
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground">{body}</p>
    <label class="flex items-start gap-2 text-sm" data-testid="permission-mode-acknowledge-row">
      <Checkbox bind:checked={acknowledged} data-testid="permission-mode-acknowledge" />
      <span>{acknowledgeLabel}</span>
    </label>
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <label class="flex items-center gap-2">
        <input
          type="radio"
          name="permission-mode-duration"
          checked={!timed}
          onchange={() => (timed = false)}
        />
        {t('permissionMode.untilManual')}
      </label>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          name="permission-mode-duration"
          checked={timed}
          onchange={() => (timed = true)}
        />
        <input
          type="number"
          min="1"
          max="168"
          class="border-input bg-background h-8 w-20 rounded-md border px-2"
          disabled={!timed}
          bind:value={hours}
          data-testid="permission-mode-hours"
        />
        {t('permissionMode.hoursOff', { hours: hoursDisplay })}
      </label>
    </div>
    <DialogFooter>
      <Button variant="outline" onclick={() => (dialogOpen = false)}>{t('common.cancel')}</Button>
      <Button
        variant={pending === 'bypass' ? 'destructive' : 'default'}
        disabled={!acknowledged}
        onclick={() => void confirm()}
        data-testid="permission-mode-confirm"
      >
        {t('permissionMode.confirm')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
