<script lang="ts">
  import { t } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  const active = $derived(permissions.unattended.enabled);

  function jump(conversationId: string | null): void {
    if (conversationId === null) return;
    permissions.summaryOpen = false;
    void chat.select(conversationId);
  }

  // 用户回到窗口时，模式期间有新的自动批准记录则提醒（任务 8）。
  async function onWindowFocus(): Promise<void> {
    if (await permissions.hasUnseenAutoApprovals()) {
      await permissions.remindOnFocus();
    }
  }
</script>

<svelte:window onfocus={onWindowFocus} />

{#if active}
  <div
    class="flex items-center gap-3 border-b border-amber-700/40 bg-amber-500 px-4 py-1.5 text-sm font-medium text-white"
    data-testid="unattended-banner"
  >
    <span class="min-w-0 flex-1">{t('unattended.banner')}</span>
    <Button
      variant="outline"
      size="sm"
      class="h-6 border-white/60 bg-transparent px-2 text-white hover:bg-white/20"
      onclick={() => void permissions.disableUnattended()}
      data-testid="unattended-banner-off"
    >
      {t('unattended.bannerOff')}
    </Button>
  </div>
{/if}

<Dialog
  open={permissions.summaryOpen}
  onOpenChange={(open) => {
    if (!open) permissions.summaryOpen = false;
  }}
>
  <DialogContent class="max-w-lg" data-testid="unattended-summary-dialog">
    <DialogHeader>
      <DialogTitle>{t('unattended.summaryTitle')}</DialogTitle>
    </DialogHeader>
    {#if permissions.summaryItems.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="unattended-summary-empty">
        {t('unattended.summaryEmpty')}
      </p>
    {:else}
      <ul class="max-h-80 space-y-2 overflow-y-auto text-sm" data-testid="unattended-summary-list">
        {#each permissions.summaryItems as item (item.approvalId)}
          <li class="rounded-md border p-2">
            <p class="break-all">{item.detail}</p>
            {#if item.conversationId !== null}
              <Button
                variant="link"
                size="sm"
                class="h-5 px-0 text-xs"
                onclick={() => jump(item.conversationId)}
              >
                {t('unattended.summaryJump')}
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (permissions.summaryOpen = false)}
        data-testid="unattended-summary-close"
      >
        {t('common.close')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
