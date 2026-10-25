<script lang="ts">
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { Button } from '$lib/components/ui/button';
  import { getChatSession } from './chat-session-context';

  /**
   * Floating chat banners (read-only, confirm mode, failed run). Shared by the
   * main chat and, later, a card dialog that provides its own session.
   */
  let { topClass }: { topClass: string } = $props();

  const session = getChatSession();
  const current = $derived(session.view);
  const confirmMode = $derived(
    current !== null && permissions.sandbox !== null && !permissions.sandbox.available,
  );
</script>

{#if current && (current.conversation.readOnly || confirmMode || current.failedRun)}
  <div
    class="pointer-events-none absolute inset-x-0 {topClass} z-30 flex flex-col items-center gap-1.5 px-4"
  >
    {#if current.conversation.readOnly}
      <div
        class="pointer-events-auto rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
        data-testid="readonly-banner"
      >
        {t('composer.readOnly')}
      </div>
    {/if}
    {#if confirmMode}
      <div
        class="pointer-events-auto rounded-full border border-amber-500/40 bg-background/95 px-3 py-1 text-xs text-amber-700 shadow-sm backdrop-blur dark:text-amber-400"
        data-testid="confirm-mode-banner"
      >
        {t('chats.confirmModeBanner', { reason: permissions.sandbox?.reason ?? '' })}
      </div>
    {/if}
    {#if current.failedRun && !current.failedRun.setup}
      <div
        class="pointer-events-auto flex items-center gap-2 rounded-full border border-destructive/30 bg-background/95 py-1 pr-1.5 pl-3 text-xs text-destructive shadow-sm backdrop-blur"
        data-testid="run-failed-banner"
      >
        <span
          class="max-w-md min-w-0 truncate"
          title={t('chats.runFailed', { reason: current.failedRun.error ?? '' })}
        >
          {t('chats.runFailed', { reason: current.failedRun.error ?? '' })}
        </span>
        <Button
          variant="outline"
          size="sm"
          class="h-6 rounded-full px-2"
          onclick={() => void session.retryRun(current.failedRun!.id)}
          data-testid="run-retry"
        >
          {t('chats.retry')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 w-6 rounded-full p-0 text-destructive hover:text-destructive"
          aria-label={t('common.close')}
          title={t('common.close')}
          onclick={() => session.dismissFailedRun(current.failedRun!.id)}
          data-testid="run-failed-dismiss"
        >
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    {/if}
  </div>
{/if}
