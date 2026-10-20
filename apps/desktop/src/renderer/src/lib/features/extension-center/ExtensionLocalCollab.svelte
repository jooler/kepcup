<script lang="ts">
  import { onMount } from 'svelte';
  import { Laptop, RefreshCw } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    inkcopCollabEnabled,
    setInkcopCollabEnabled,
  } from '$lib/features/inkcop-collab';

  /**
   * 扩展中心 →「本机应用协作」（契约 v0.2.1）：
   * InkCop 卡片仅启停 + 桥状态；不预置系统 Bot。
   */

  let busy = $state(false);
  let probing = $state(false);
  let online = $state<boolean | null>(null);
  let enableOverride = $state<boolean | null>(null);

  const enabled = $derived(
    enableOverride !== null
      ? enableOverride
      : inkcopCollabEnabled(settingsStore.settings),
  );

  $effect(() => {
    const settings = settingsStore.settings;
    if (settings === null || enableOverride === null) return;
    if (settings.inkcopLocalCollab.enabled === enableOverride) {
      enableOverride = null;
    }
  });

  async function probe(): Promise<void> {
    probing = true;
    try {
      const health = (await core.call('inkcop.health', {})) as {
        online: boolean;
      };
      online = health.online === true;
    } catch {
      online = false;
    } finally {
      probing = false;
    }
  }

  onMount(() => {
    void probe();
  });

  async function toggle(next: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    enableOverride = next;
    try {
      const result = await setInkcopCollabEnabled(next);
      online = result.online;
      if (next && !result.online) {
        toast.message(t('extensionCenter.localCollab.inkcop.offlineToast'));
      } else if (next) {
        toast.success(t('extensionCenter.localCollab.inkcop.enabledToast'));
      }
    } catch (error) {
      enableOverride = null;
      toast.error(
        t('extensionCenter.localCollab.inkcop.toggleFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3" data-testid="extension-local-collab">
  <p class="text-xs text-muted-foreground">{t('extensionCenter.localCollab.hint')}</p>

  <div
    class="flex flex-col gap-3 rounded-xl border px-4 py-3.5"
    data-testid="local-collab-inkcop-card"
  >
    <div class="flex items-start gap-3">
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Laptop class="size-4" />
      </div>
      <div class="min-w-0 flex-1 space-y-1.5">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-sm font-medium">{t('extensionCenter.localCollab.inkcop.title')}</span>
          {#if online === true}
            <Badge
              variant="outline"
              class="border-emerald-500/60 text-[10px] text-emerald-700 dark:text-emerald-400"
              data-testid="local-collab-inkcop-online"
            >
              {t('extensionCenter.localCollab.inkcop.online')}
            </Badge>
          {:else if online === false}
            <Badge
              variant="outline"
              class="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
              data-testid="local-collab-inkcop-offline"
            >
              {t('extensionCenter.localCollab.inkcop.offline')}
            </Badge>
          {/if}
        </div>
        <p class="text-xs text-muted-foreground">
          {t('extensionCenter.localCollab.inkcop.description')}
        </p>
      </div>
    </div>

    <label class="flex items-start gap-3" data-testid="local-collab-inkcop-enable">
      <Checkbox
        checked={enabled}
        disabled={busy}
        onCheckedChange={(checked) => void toggle(checked === true)}
        data-testid="local-collab-inkcop-checkbox"
      />
      <span class="grid gap-0.5">
        <Label class="font-medium">{t('extensionCenter.localCollab.inkcop.enable')}</Label>
        <span class="text-xs text-muted-foreground">
          {t('extensionCenter.localCollab.inkcop.enableHint')}
        </span>
      </span>
    </label>

    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={probing || busy}
        onclick={() => void probe()}
        data-testid="local-collab-inkcop-probe"
      >
        <RefreshCw class="size-3.5 {probing ? 'animate-spin' : ''}" />
        {t('extensionCenter.localCollab.inkcop.probe')}
      </Button>
    </div>
  </div>
</div>
